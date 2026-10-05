// R2-backed build cache: runners PUT tarballs under content keys and
// GET them back on later runs. Zero egress inside Cloudflare.

export const CACHE_KEY_RE = /^[\w][\w.\-/]{0,199}$/;
export const MAX_CACHE_BYTES = 512 * 1024 * 1024;

export function cacheObjectKey(key: string): string {
  return `cache/${key}`;
}

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

export async function handleCacheGet(bucket: R2Bucket | undefined, key: string): Promise<Response> {
  if (!CACHE_KEY_RE.test(key)) return json({ error: "invalid cache key" }, 400);
  if (!bucket) return json({ error: "cache storage not configured" }, 501);
  const obj = await bucket.get(cacheObjectKey(key));
  if (!obj) return json({ error: "cache miss" }, 404);
  const headers = new Headers({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
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
