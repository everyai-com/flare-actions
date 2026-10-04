// Source dispatch: agents upload a gzipped tarball of the working tree
// (no commit, no push) and dispatch a run against it. This is the one
// thing a forge-hosted CI structurally cannot do — GitHub requires a
// pushed commit to run anything.
//
// Blobs live under sources/<id> in R2, are readable only with run scope,
// expire with the run (and after 7 days regardless), and extraction
// guards against traversal on both executors.

export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_AGE_MS = 7 * 86400000;
export const SOURCE_ID_RE = /^[a-f0-9-]{36}$/;
const SOURCE_PREFIX = "sources/";

export function sourceObjectKey(id: string): string {
  return `${SOURCE_PREFIX}${id}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleSourcePut(bucket: R2Bucket | undefined, request: Request): Promise<Response> {
  if (!bucket) return json({ error: "source storage not configured" }, 501);
  const declared = request.headers.get("content-length");
  if (!declared || !/^\d+$/.test(declared)) {
    return json({ error: "content-length is required for source uploads" }, 411);
  }
  const size = Number(declared);
  if (size < 1 || size > MAX_SOURCE_BYTES) {
    return json({ error: `source must be 1 byte - ${MAX_SOURCE_BYTES} bytes` }, 413);
  }
  if (!request.body) return json({ error: "empty body" }, 400);
  const id = crypto.randomUUID();
  await bucket.put(sourceObjectKey(id), request.body, {
    httpMetadata: { contentType: "application/gzip" },
  });
  return json({ id }, 201);
}

export async function handleSourceGet(bucket: R2Bucket | undefined, id: string): Promise<Response> {
  if (!bucket) return json({ error: "source storage not configured" }, 501);
  if (!SOURCE_ID_RE.test(id)) return json({ error: "invalid source id" }, 400);
  const obj = await bucket.get(sourceObjectKey(id));
  if (!obj) return json({ error: "source not found (expired or already consumed)" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store" },
  });
}

export async function deleteSource(bucket: R2Bucket | undefined, id: string): Promise<void> {
  if (!bucket || !SOURCE_ID_RE.test(id)) return;
  try {
    await bucket.delete(sourceObjectKey(id));
  } catch {
    // Best-effort retention.
  }
}

// Sources are throwaway: sweeps delete them once their run is pruned and
// unconditionally after MAX_SOURCE_AGE_MS, so abandoned uploads cannot
// grow storage without bound.
export async function pruneOldSources(bucket: R2Bucket | undefined, limit = 500): Promise<number> {
  if (!bucket) return 0;
  try {
    const cutoff = Date.now() - MAX_SOURCE_AGE_MS;
    const listed = await bucket.list({ prefix: SOURCE_PREFIX, limit });
    const stale = listed.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
    if (stale.length === 0) return 0;
    await bucket.delete(stale);
    return stale.length;
  } catch {
    return 0;
  }
}
