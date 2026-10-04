import { describe, expect, it } from "vitest";
import { deleteSource, handleSourceGet, handleSourcePut, pruneOldSources, sourceObjectKey } from "./sources";

interface StoredObject {
  data: Uint8Array;
  uploaded: Date;
}

function fakeBucket() {
  const store = new Map<string, StoredObject>();
  const bucket = {
    store,
    put: async (key: string, body: ReadableStream) => {
      store.set(key, { data: new Uint8Array(await new Response(body).arrayBuffer()), uploaded: new Date() });
    },
    get: async (key: string) => {
      const v = store.get(key);
      if (!v) return null;
      return {
        body: new ReadableStream({
          start(c) {
            c.enqueue(v.data);
            c.close();
          },
        }),
      };
    },
    list: async ({ prefix, limit }: { prefix: string; limit?: number }) => ({
      objects: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, limit ?? Number.MAX_SAFE_INTEGER)
        .map(([key, v]) => ({ key, size: v.data.byteLength, uploaded: v.uploaded })),
    }),
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  };
  return bucket;
}

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("sources", () => {
  it("uploads with a declared size and returns a uuid id", async () => {
    const bucket = fakeBucket();
    const put = await handleSourcePut(
      bucket as unknown as R2Bucket,
      new Request("https://x/v1/source", { method: "POST", body: "tar-bytes", headers: { "content-length": "9" } }),
    );
    expect(put.status).toBe(201);
    const { id } = (await put.json()) as { id: string };
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(bucket.store.get(sourceObjectKey(id))?.data.byteLength).toBe(9);
  });

  it("requires content-length, a bucket, and a body", async () => {
    const bucket = fakeBucket();
    expect((await handleSourcePut(undefined, new Request("https://x/v1/source", { method: "POST", body: "x" }))).status).toBe(501);
    // Stream bodies have no declared length.
    const stream = new Request("https://x/v1/source", {
      method: "POST",
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await handleSourcePut(bucket as unknown as R2Bucket, stream)).status).toBe(411);
  });

  it("round-trips a download and validates ids", async () => {
    const bucket = fakeBucket();
    bucket.store.set(sourceObjectKey(UUID), { data: new TextEncoder().encode("hello"), uploaded: new Date() });
    const get = await handleSourceGet(bucket as unknown as R2Bucket, UUID);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("hello");
    expect((await handleSourceGet(bucket as unknown as R2Bucket, "not-an-id")).status).toBe(400);
    expect((await handleSourceGet(bucket as unknown as R2Bucket, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).status).toBe(404);
    expect((await handleSourceGet(undefined, UUID)).status).toBe(501);
  });

  it("deletes and prunes only expired sources", async () => {
    const bucket = fakeBucket();
    const day = 86400000;
    bucket.store.set(sourceObjectKey(UUID), { data: new Uint8Array([1]), uploaded: new Date(Date.now() - 10 * day) });
    bucket.store.set(sourceObjectKey("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), { data: new Uint8Array([1]), uploaded: new Date() });
    expect(await pruneOldSources(bucket as unknown as R2Bucket)).toBe(1);
    expect(bucket.store.has(sourceObjectKey(UUID))).toBe(false);
    expect(bucket.store.has(sourceObjectKey("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))).toBe(true);
    await deleteSource(bucket as unknown as R2Bucket, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(bucket.store.size).toBe(0);
    await deleteSource(undefined, UUID);
    await deleteSource(bucket as unknown as R2Bucket, "bad-id"); // no-op
  });
});
