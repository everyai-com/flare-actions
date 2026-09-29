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
