import { describe, expect, it } from "vitest";
import { CACHE_KEY_RE, cacheObjectKey, handleCacheGet, handleCachePut, listCacheEntries, purgeCachePrefix } from "./cache";

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
