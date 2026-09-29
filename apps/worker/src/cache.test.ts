import { describe, expect, it } from "vitest";
import { CACHE_KEY_RE, cacheObjectKey, handleCacheGet, handleCachePut } from "./cache";

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
});
