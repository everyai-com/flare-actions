// R2-backed build cache: runners PUT tarballs under content keys and
// GET them back on later runs. Zero egress inside Cloudflare.
import type { Db } from "./db";
import {
  CACHE_KEY_RE as PARITY_CACHE_KEY_RE,
  MAX_RESTORE_KEYS,
  cacheObjectKey as parityCacheObjectKey,
  isValidCacheKey,
  isValidRestoreKey,
} from "../../../packages/runner-sdk/src/parity.ts";

export const CACHE_KEY_RE = PARITY_CACHE_KEY_RE;
export const MAX_CACHE_BYTES = 512 * 1024 * 1024;

export function cacheObjectKey(key: string): string {
  return parityCacheObjectKey(key);
}

export { isValidCacheKey };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleCachePut(bucket: R2Bucket | undefined, key: string, request: Request): Promise<Response> {
  if (!CACHE_KEY_RE.test(key)) return json({ error: "invalid cache key" }, 400);
  if (!bucket) return json({ error: "cache storage not configured" }, 501);
  if (!request.body) return json({ error: "empty body" }, 400);
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_CACHE_BYTES) return json({ error: "cache object too large" }, 413);
  await bucket.put(cacheObjectKey(key), request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return json({ ok: true, key });
}

export async function handleCacheGet(
  bucket: R2Bucket | undefined,
  key: string,
  restoreKeys: string[] = [],
): Promise<Response> {
  if (!CACHE_KEY_RE.test(key)) return json({ error: "invalid cache key" }, 400);
  if (!bucket) return json({ error: "cache storage not configured" }, 501);
  let matched = key;
  let obj = await bucket.get(cacheObjectKey(key));
  // Exact miss: walk the restore-key prefixes in order (GitHub
  // semantics), newest entry under each prefix wins.
  for (const prefix of restoreKeys) {
    if (obj) break;
    const hit = await findCachePrefixHit(bucket, prefix);
    if (hit) {
      matched = hit;
      obj = await bucket.get(cacheObjectKey(hit));
    }
  }
  if (!obj) return json({ error: "cache miss" }, 404);
  const headers = new Headers({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  // Runners log which entry actually restored (exact vs prefix).
  headers.set("X-Flare-Cache-Key", matched);
  return new Response(obj.body, { headers });
}

// Repeated `?restore_key=` params off the cache GET route. Same cap
// and charset as the YAML key so hand-built URLs cannot scan wider
// than a pipeline can.
export function parseRestoreKeysParam(params: URLSearchParams): { keys: string[] } | { error: string } {
  const keys = params.getAll("restore_key");
  if (keys.length > MAX_RESTORE_KEYS) return { error: `at most ${MAX_RESTORE_KEYS} restore_key params` };
  for (const k of keys) {
    if (!isValidRestoreKey(k)) return { error: "invalid restore_key" };
  }
  return { keys };
}

// Newest entry of a listing, or null. Full R2 object keys in, cache
// key out; ties break lexicographically so two executors racing the
// same prefix restore the same entry. Shared by the /v1/cache lane
// (findCachePrefixHit) and seats (direct list + this reducer).
export function pickNewestCacheHit(objects: { key: string; uploaded: Date }[]): string | null {
  let best: { key: string; uploaded: number } | null = null;
  for (const obj of objects) {
    const uploaded = obj.uploaded.getTime();
    if (!best || uploaded > best.uploaded || (uploaded === best.uploaded && obj.key < best.key)) {
      best = { key: obj.key, uploaded };
    }
  }
  return best ? best.key.slice("cache/".length) : null;
}

// Newest entry whose key starts with prefix, or null. One bounded
// list call (1000 objects).
export async function findCachePrefixHit(bucket: R2Bucket, prefix: string): Promise<string | null> {
  const listed = await bucket.list({ prefix: `cache/${prefix}`, limit: 1000 });
  return pickNewestCacheHit(listed.objects);
}

export interface CacheEntry {
  key: string;
  size: number;
  uploaded: string;
}

// Admin listing: newest-first scan under a prefix, bounded per call.
// Keys are opaque content hashes, so listing leaks no repo internals;
// still admin-only because purge shares the surface.
export async function listCacheEntries(
  bucket: R2Bucket | undefined,
  prefix: string,
  limit: number,
): Promise<CacheEntry[] | null> {
  if (!bucket) return null;
  const out: CacheEntry[] = [];
  let cursor: string | undefined;
  const want = Math.max(1, Math.min(limit, 500));
  for (let pages = 0; pages < 5 && out.length < want; pages++) {
    const listed = await bucket.list({ prefix: `cache/${prefix}`, limit: Math.min(1000, want - out.length), cursor });
    for (const obj of listed.objects) {
      out.push({ key: obj.key.slice("cache/".length), size: obj.size, uploaded: obj.uploaded.toISOString() });
      if (out.length >= want) break;
    }
    if (listed.truncated && listed.cursor) cursor = listed.cursor;
    else break;
  }
  return out;
}

// Admin purge: delete every entry under a prefix, bounded per call
// (huge prefixes take repeated calls; the response says so).
export async function purgeCachePrefix(
  bucket: R2Bucket | undefined,
  prefix: string,
  limit = 1000,
): Promise<{ deleted: number; truncated: boolean } | null> {
  if (!bucket) return null;
  let deleted = 0;
  let truncated = false;
  let cursor: string | undefined;
  const want = Math.max(1, Math.min(limit, 1000));
  for (let pages = 0; pages < 10; pages++) {
    const listed = await bucket.list({ prefix: `cache/${prefix}`, limit: Math.min(100, want - deleted), cursor });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((o) => o.key));
      deleted += listed.objects.length;
    }
    if (deleted >= want) {
      truncated = listed.truncated;
      break;
    }
    if (listed.truncated && listed.cursor) cursor = listed.cursor;
    else break;
  }
  return { deleted, truncated };
}

// Shared-warm-cache stats ("one cache, ten agents"): every cache GET
// records its hit/miss outcome as one daily-aggregate counter upsert —
// bounded D1 writes, no per-event rows. Scopes group keys by their
// static prefix so `node-modules` and `node-expr` report as one scope.
export const CACHE_STATS_DAYS = 7;
export const CACHE_STATS_SCOPE_LIMIT = 50;
export const CACHE_STATS_RETENTION_DAYS = 90;

// Scope = key prefix before the first "/" or "-", truncated so one
// hostile key cannot widen rows. Empty input buckets to "other".
export function cacheScope(key: string): string {
  const first = key.split("/")[0] ?? "";
  const scope = (first.split("-")[0] ?? "").slice(0, 64);
  return scope || "other";
}

export interface CacheScopeStat {
  scope: string;
  hits: number;
  misses: number;
  hitRate: number;
}

export interface CacheStats {
  days: number;
  hits: number;
  misses: number;
  hitRate: number;
  scopes: CacheScopeStat[];
}

export interface CacheStatsRow {
  scope: string;
  hits: number;
  misses: number;
}

// Pure: roll per-scope day rows into the trailing-window payload the
// endpoint serves (scopes busiest first, hit rates 0-1).
export function summarizeCacheStats(rows: CacheStatsRow[], days = CACHE_STATS_DAYS): CacheStats {
  const byScope = new Map<string, { hits: number; misses: number }>();
  for (const row of rows) {
    const scope = row.scope || "other";
    const acc = byScope.get(scope) ?? { hits: 0, misses: 0 };
    acc.hits += Math.max(0, row.hits);
    acc.misses += Math.max(0, row.misses);
    byScope.set(scope, acc);
  }
  const rate = (hits: number, misses: number): number => (hits + misses === 0 ? 0 : hits / (hits + misses));
  const scopes: CacheScopeStat[] = [...byScope]
    .map(([scope, acc]) => ({ scope, hits: acc.hits, misses: acc.misses, hitRate: rate(acc.hits, acc.misses) }))
    .sort((a, b) => b.hits + b.misses - (a.hits + a.misses) || (a.scope < b.scope ? -1 : 1));
  const hits = scopes.reduce((n, s) => n + s.hits, 0);
  const misses = scopes.reduce((n, s) => n + s.misses, 0);
  return { days, hits, misses, hitRate: rate(hits, misses), scopes: scopes.slice(0, CACHE_STATS_SCOPE_LIMIT) };
}

export function cacheStatsDay(when = new Date()): string {
  return when.toISOString().slice(0, 10);
}

// One upsert per cache GET: the day/scope row's hit or miss counter
// increments atomically, so concurrent executors never lose outcomes.
export async function recordCacheOutcome(db: Db, key: string, hit: boolean, day = cacheStatsDay()): Promise<void> {
  const scope = cacheScope(key);
  const hits = hit ? 1 : 0;
  const misses = hit ? 0 : 1;
  await db
    .prepare(
      "INSERT INTO cache_stats (day, scope, hits, misses) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(day, scope) DO UPDATE SET hits = cache_stats.hits + excluded.hits, misses = cache_stats.misses + excluded.misses",
    )
    .bind(day, scope, hits, misses)
    .run();
}

// Trailing-window rollup: one grouped read over the daily rows, busiest
// scopes first. Best-effort like every stats read.
export async function getCacheStats(db: Db, days = CACHE_STATS_DAYS): Promise<CacheStats> {
  const since = cacheStatsDay(new Date(Date.now() - (days - 1) * 86_400_000));
  const res = await db
    .prepare(
      "SELECT scope, SUM(hits) AS hits, SUM(misses) AS misses FROM cache_stats WHERE day >= ? " +
        "GROUP BY scope ORDER BY SUM(hits) + SUM(misses) DESC LIMIT ?",
    )
    .bind(since, CACHE_STATS_SCOPE_LIMIT)
    .all<{ scope: string; hits: number; misses: number }>();
  return summarizeCacheStats(
    res.results.map((r) => ({ scope: r.scope, hits: r.hits ?? 0, misses: r.misses ?? 0 })),
    days,
  );
}

// Retention: drop daily rows past the window. Bounded per pass, called
// from the webhook prune sweep next to the other retention chores.
export async function pruneCacheStats(
  db: Db,
  beforeDay = cacheStatsDay(new Date(Date.now() - CACHE_STATS_RETENTION_DAYS * 86_400_000)),
): Promise<number> {
  const res = (await db.prepare("DELETE FROM cache_stats WHERE day < ? LIMIT 500").bind(beforeDay).run()) as {
    meta?: { changes?: number };
  };
  return res?.meta?.changes ?? 0;
}
