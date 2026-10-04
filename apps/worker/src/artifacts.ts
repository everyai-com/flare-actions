import { getJobsForRun, jobExists, type Db } from "./db";

// R2-backed job artifacts: runners PUT files per job; anyone with read
// scope can download them or list a run's artifacts.

export const ARTIFACT_NAME_RE = /^[\w.-]{1,128}$/;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export function artifactObjectKey(jobId: string, name: string): string {
  return `artifacts/${jobId}/${name}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleArtifactPut(
  bucket: R2Bucket | undefined,
  db: Db,
  jobId: string,
  name: string,
  request: Request,
): Promise<Response> {
  if (!ARTIFACT_NAME_RE.test(name)) return json({ error: "invalid artifact name" }, 400);
  if (!bucket) return json({ error: "artifact storage not configured" }, 501);
  if (!(await jobExists(db, jobId))) return json({ error: "job not found" }, 404);
  if (!request.body) return json({ error: "empty body" }, 400);
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_ARTIFACT_BYTES) return json({ error: "artifact too large" }, 413);
  await bucket.put(artifactObjectKey(jobId, name), request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return json({ ok: true, jobId, name });
}

export async function handleArtifactGet(
  bucket: R2Bucket | undefined,
  jobId: string,
  name: string,
): Promise<Response> {
  if (!ARTIFACT_NAME_RE.test(name)) return json({ error: "invalid artifact name" }, 400);
  if (!bucket) return json({ error: "artifact storage not configured" }, 501);
  const obj = await bucket.get(artifactObjectKey(jobId, name));
  if (!obj) return json({ error: "artifact not found" }, 404);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${name}"`,
  });
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

export interface RunArtifact {
  jobId: string;
  jobName: string;
  name: string;
  size: number;
  uploaded: string;
}

export async function listRunArtifacts(
  bucket: R2Bucket | undefined,
  db: Db,
  runId: string,
): Promise<RunArtifact[] | null> {
  if (!bucket) return null;
  const jobs = await getJobsForRun(db, runId);
  const out: RunArtifact[] = [];
  for (const job of jobs) {
    const listed = await bucket.list({ prefix: `artifacts/${job.id}/` });
    for (const obj of listed.objects) {
      out.push({
        jobId: job.id,
        jobName: job.name,
        name: obj.key.slice(`artifacts/${job.id}/`.length),
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
      });
    }
  }
  return out;
}

// Delete every artifact under a (pruned) job's prefix. Best-effort by
// contract: a storage hiccup must never fail the retention sweep.
export async function deleteJobArtifacts(bucket: R2Bucket | undefined, jobId: string): Promise<number> {
  if (!bucket) return 0;
  try {
    const listed = await bucket.list({ prefix: `artifacts/${jobId}/` });
    if (listed.objects.length === 0) return 0;
    await bucket.delete(listed.objects.map((o) => o.key));
    return listed.objects.length;
  } catch {
    return 0;
  }
}

// Cache retention: keys embed lockfile hashes, so old entries are dead
// weight. Bounded per pass; entries younger than the cutoff stay.
export async function pruneOldCache(
  bucket: R2Bucket | undefined,
  olderThanDays = 90,
  limit = 1000,
): Promise<number> {
  if (!bucket) return 0;
  try {
    const cutoff = Date.now() - olderThanDays * 86400000;
    const listed = await bucket.list({ prefix: "cache/", limit });
    const stale = listed.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
    if (stale.length === 0) return 0;
    await bucket.delete(stale);
    return stale.length;
  } catch {
    return 0;
  }
}
