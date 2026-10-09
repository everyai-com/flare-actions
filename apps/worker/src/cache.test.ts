import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  CACHE_KEY_RE,
  cacheObjectKey,
  cacheScope,
  cacheStatsDay,
  findCachePrefixHit,
  getCacheStats,
  handleCacheGet,
  handleCachePut,
  listCacheEntries,
  parseRestoreKeysParam,
  pickNewestCacheHit,
  pruneCacheStats,
  purgeCachePrefix,
  recordCacheOutcome,
  summarizeCacheStats,
} from "./cache";

describe("cache", () => {
  it("validates keys", () => {
    expect(CACHE_KEY_RE.test("node-abc123")).toBe(true);
    expect(CACHE_KEY_RE.test("org/repo/main")).toBe(true);
    expect(CACHE_KEY_RE.test("../escape")).toBe(false);
    expect(CACHE_KEY_RE.test("")).toBe(false);
    expect(cacheObjectKey("k")).toBe("cache/k");
  });

  it("returns 501 without a bucket", async () => {
    const put = await handleCachePut(undefined, "k", new Request("https://x/", { method: "PUT", body: "data" }));
    expect(put.status).toBe(501);
    const get = await handleCacheGet(undefined, "k");
    expect(get.status).toBe(501);
  });

  it("round-trips through a fake bucket", async () => {
    const store = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, body: ReadableStream) => {
        store.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
      },
      get: async (key: string) => {
        const v = store.get(key);
        if (!v) return null;
        return {
          body: new ReadableStream({
            start(c) {
              c.enqueue(v);
              c.close();
            },
          }),
          httpEtag: '"etag"',
          writeHttpMetadata: (_h: Headers) => undefined,
        };
      },
    };
    const put = await handleCachePut(
      bucket as unknown as R2Bucket,
      "k",
      new Request("https://x/", { method: "PUT", body: "data" }),
    );
    expect(put.status).toBe(200);
    const get = await handleCacheGet(bucket as unknown as R2Bucket, "k");
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("data");
    const miss = await handleCacheGet(bucket as unknown as R2Bucket, "other");
    expect(miss.status).toBe(404);
  });

  it("lists and purges entries under a prefix", async () => {
    const store = new Map<string, { size: number; uploaded: Date }>([
      ["cache/node-aaa", { size: 10, uploaded: new Date("2026-10-01T00:00:00.000Z") }],
      ["cache/node-bbb", { size: 20, uploaded: new Date("2026-10-02T00:00:00.000Z") }],
      ["cache/go-ccc", { size: 30, uploaded: new Date("2026-10-03T00:00:00.000Z") }],
    ]);
    const bucket = {
      list: async (opts: { prefix?: string; limit?: number; cursor?: string }) => {
        const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
        const start = opts.cursor ? Number(opts.cursor) : 0;
        const slice = keys.slice(start, start + (opts.limit ?? 1000));
        return {
          objects: slice.map((key) => ({ key, size: store.get(key)?.size ?? 0, uploaded: store.get(key)?.uploaded ?? new Date() })),
          truncated: start + slice.length < keys.length,
          cursor: String(start + slice.length),
        };
      },
      delete: async (keys: string[]) => {
        for (const k of (Array.isArray(keys) ? keys : [keys]) as string[]) store.delete(k);
      },
    } as unknown as R2Bucket;
    const entries = await listCacheEntries(bucket, "node-", 100);
    expect(entries?.map((e) => e.key)).toEqual(["node-aaa", "node-bbb"]);
    expect(entries?.[0]).toMatchObject({ size: 10, uploaded: "2026-10-01T00:00:00.000Z" });
    const purged = await purgeCachePrefix(bucket, "node-", 100);
    expect(purged).toEqual({ deleted: 2, truncated: false });
    expect([...store.keys()]).toEqual(["cache/go-ccc"]);
    expect(await listCacheEntries(undefined, "", 10)).toBeNull();
    expect(await purgeCachePrefix(undefined, "")).toBeNull();
  });
});

// In-memory cache_stats table behind the Db surface: routes only the
// SQL the stats functions issue.
class StatsDb implements Db {
  rows = new Map<string, { day: string; scope: string; hits: number; misses: number }>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          if (norm.startsWith("SELECT scope, SUM(hits)")) {
            const since = values[0] as string;
            const limit = values[1] as number;
            const byScope = new Map<string, { hits: number; misses: number }>();
            for (const r of this.rows.values()) {
              if (r.day < since) continue;
              const acc = byScope.get(r.scope) ?? { hits: 0, misses: 0 };
              acc.hits += r.hits;
              acc.misses += r.misses;
              byScope.set(r.scope, acc);
            }
            const out = [...byScope]
              .map(([scope, acc]) => ({ scope, hits: acc.hits, misses: acc.misses }))
              .sort((a, b) => b.hits + b.misses - (a.hits + a.misses))
              .slice(0, limit);
            return { results: out as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async (): Promise<unknown> => {
          if (norm.startsWith("INSERT INTO cache_stats")) {
            const [day, scope, hits, misses] = values as [string, string, number, number];
            const key = `${day}|${scope}`;
            const row = this.rows.get(key) ?? { day, scope, hits: 0, misses: 0 };
            row.hits += hits;
            row.misses += misses;
            this.rows.set(key, row);
            return {};
          }
          if (norm.startsWith("DELETE FROM cache_stats")) {
            const before = values[0] as string;
            let changes = 0;
            for (const [key, row] of [...this.rows]) {
              if (row.day < before && changes < 500) {
                this.rows.delete(key);
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("cache stats", () => {
  it("scopes keys by their static prefix", () => {
    expect(cacheScope("node-modules")).toBe("node");
    expect(cacheScope("node-expr")).toBe("node");
    expect(cacheScope("org/repo/main")).toBe("org");
    expect(cacheScope("plain")).toBe("plain");
    expect(cacheScope("")).toBe("other");
    expect(cacheScope("x".repeat(100))).toBe("x".repeat(64));
  });

  it("rolls day rows into overall + per-scope hit rates", () => {
    const out = summarizeCacheStats([
      { scope: "node", hits: 9, misses: 1 },
      { scope: "node", hits: 1, misses: 0 },
      { scope: "go", hits: 1, misses: 3 },
    ]);
    expect(out.days).toBe(7);
    expect(out.hits).toBe(11);
    expect(out.misses).toBe(4);
    expect(out.hitRate).toBeCloseTo(11 / 15, 6);
    expect(out.scopes.map((s) => s.scope)).toEqual(["node", "go"]);
    expect(out.scopes[0]).toMatchObject({ hits: 10, misses: 1, hitRate: 10 / 11 });
  });

  it("reports zeros with no rows", () => {
    expect(summarizeCacheStats([])).toEqual({ days: 7, hits: 0, misses: 0, hitRate: 0, scopes: [] });
  });

  it("records one counter row per day and scope", async () => {
    const db = new StatsDb();
    await recordCacheOutcome(db, "node-modules", true, "2026-10-07");
    await recordCacheOutcome(db, "node-expr", false, "2026-10-07");
    await recordCacheOutcome(db, "node-modules", true, "2026-10-08");
    expect(db.rows.get("2026-10-07|node")).toMatchObject({ hits: 1, misses: 1 });
    expect(db.rows.get("2026-10-08|node")).toMatchObject({ hits: 1, misses: 0 });
    expect(db.rows.size).toBe(2);
  });

  it("serves the trailing window oldest-day-inclusive", async () => {
    const db = new StatsDb();
    const today = cacheStatsDay();
    const old = cacheStatsDay(new Date(Date.now() - 30 * 86_400_000));
    await recordCacheOutcome(db, "node-a", true, today);
    await recordCacheOutcome(db, "go-b", true, old);
    const stats = await getCacheStats(db);
    expect(stats.days).toBe(7);
    expect(stats.hits).toBe(1);
    expect(stats.scopes.map((s) => s.scope)).toEqual(["node"]);
  });

  it("prunes rows past retention", async () => {
    const db = new StatsDb();
    await recordCacheOutcome(db, "node-a", true, "2026-01-01");
    await recordCacheOutcome(db, "node-a", true, cacheStatsDay());
    expect(await pruneCacheStats(db, "2026-06-01")).toBe(1);
    expect(db.rows.size).toBe(1);
  });

  it("picks the newest listing entry with lexicographic ties", () => {
    expect(pickNewestCacheHit([])).toBe(null);
    const d = (s: string) => new Date(s);
    expect(
      pickNewestCacheHit([
        { key: "cache/node-old", uploaded: d("2026-10-01T00:00:00.000Z") },
        { key: "cache/node-new", uploaded: d("2026-10-02T00:00:00.000Z") },
      ]),
    ).toBe("node-new");
    expect(
      pickNewestCacheHit([
        { key: "cache/node-b", uploaded: d("2026-10-02T00:00:00.000Z") },
        { key: "cache/node-a", uploaded: d("2026-10-02T00:00:00.000Z") },
      ]),
    ).toBe("node-a");
  });

  it("validates repeated restore_key params", () => {
    expect(parseRestoreKeysParam(new URLSearchParams())).toEqual({ keys: [] });
    expect(parseRestoreKeysParam(new URLSearchParams("restore_key=a&restore_key=b"))).toEqual({ keys: ["a", "b"] });
    expect(parseRestoreKeysParam(new URLSearchParams("restore_key="))).toEqual({ error: "invalid restore_key" });
    expect(parseRestoreKeysParam(new URLSearchParams("restore_key=../x"))).toEqual({ error: "invalid restore_key" });
    const many = new URLSearchParams(Array.from({ length: 11 }, (_, i) => ["restore_key", `p${i}`]));
    expect(parseRestoreKeysParam(many)).toEqual({ error: "at most 10 restore_key params" });
  });

  it("falls back through restore-keys in order and names the match", async () => {
    const blobs = new Map<string, string>([
      ["cache/exact", "exact-blob"],
      ["cache/prefix-old", "old-blob"],
      ["cache/prefix-new", "new-blob"],
      ["cache/other-x", "other-blob"],
    ]);
    const uploaded = new Map<string, string>([
      ["cache/prefix-old", "2026-10-01T00:00:00.000Z"],
      ["cache/prefix-new", "2026-10-03T00:00:00.000Z"],
      ["cache/other-x", "2026-10-04T00:00:00.000Z"],
    ]);
    const bucket = {
      get: async (key: string) => {
        const v = blobs.get(key);
        if (!v) return null;
        return { body: v, httpEtag: '"e"', writeHttpMetadata: (_h: Headers) => undefined };
      },
      list: async (opts: { prefix: string; limit: number }) => ({
        objects: [...blobs.keys()]
          .filter((k) => k.startsWith(opts.prefix))
          .slice(0, opts.limit)
          .map((key) => ({ key, uploaded: new Date(uploaded.get(key) ?? "2026-10-02T00:00:00.000Z") })),
      }),
    } as unknown as R2Bucket;
    // Exact hit serves exact even when prefixes would also match.
    const exact = await handleCacheGet(bucket, "exact", ["prefix-"]);
    expect(exact.status).toBe(200);
    expect(exact.headers.get("X-Flare-Cache-Key")).toBe("exact");
    expect(await exact.text()).toBe("exact-blob");
    // Exact miss: newest under the first matching prefix (other-x is
    // newer but its prefix comes second).
    const via = await handleCacheGet(bucket, "missing", ["prefix-", "other-"]);
    expect(via.status).toBe(200);
    expect(via.headers.get("X-Flare-Cache-Key")).toBe("prefix-new");
    expect(await via.text()).toBe("new-blob");
    // Total miss stays a 404.
    expect((await handleCacheGet(bucket, "missing", ["nope-"])).status).toBe(404);
    expect(await findCachePrefixHit(bucket, "prefix-")).toBe("prefix-new");
    expect(await findCachePrefixHit(bucket, "nope-")).toBe(null);
  });
});
