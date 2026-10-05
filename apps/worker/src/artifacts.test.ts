import { describe, expect, it } from "vitest";
import type { Db, JobRow } from "./db";
import {
  ARTIFACT_NAME_RE,
  artifactObjectKey,
  deleteJobArtifacts,
  handleArtifactGet,
  handleArtifactPut,
  listRunArtifacts,
  pruneOldCache,
} from "./artifacts";

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "success",
    log: "",
    name: "verify",
    definition: "",
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: null,
    finished_at: null,
    retained_until: null,
    prior_ms: 0,
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

// Routes jobExists + getJobsForRun against an in-memory table.
class ArtifactsDb implements Db {
  constructor(public jobs: JobRow[]) {}

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: this.jobs.filter((j) => j.run_id === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (norm.startsWith("SELECT id FROM jobs WHERE id")) {
            const job = this.jobs.find((j) => j.id === values[0]);
            return (job ? { id: job.id } : null) as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => ({}),
      }),
    };
  }
}

interface StoredObject {
  data: Uint8Array;
  uploaded: Date;
}

function fakeBucket() {
  const store = new Map<string, StoredObject>();
  const bucket = {
    store,
    put: async (key: string, body: ReadableStream) => {
      store.set(key, { data: new Uint8Array(await new Response(body).arrayBuffer()), uploaded: new Date("2026-10-02T10:00:00.000Z") });
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
        httpEtag: '"etag"',
        writeHttpMetadata: (_h: Headers) => undefined,
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

describe("artifacts", () => {
  it("validates names and object keys", () => {
    expect(ARTIFACT_NAME_RE.test("report.tar.gz")).toBe(true);
    expect(ARTIFACT_NAME_RE.test("read me.txt")).toBe(false);
    expect(ARTIFACT_NAME_RE.test("../escape")).toBe(false);
    expect(ARTIFACT_NAME_RE.test("x".repeat(129))).toBe(false);
    expect(artifactObjectKey("job-1", "a.txt")).toBe("artifacts/job-1/a.txt");
  });

  it("rejects invalid puts before touching storage", async () => {
    const db = new ArtifactsDb([jobRow()]);
    const bucket = fakeBucket();
    const put = (name: string, opts: RequestInit = { method: "PUT", body: "data" }) =>
      handleArtifactPut(bucket as unknown as R2Bucket, db, "job-1", name, new Request("https://x/", opts));

    expect((await put("bad name")).status).toBe(400);
    expect((await handleArtifactPut(undefined, db, "job-1", "a.txt", new Request("https://x/", { method: "PUT", body: "x" }))).status).toBe(501);
    // A bodyless PUT is rejected before any storage write.
    expect((await put("a.txt", { method: "PUT" })).status).toBe(400);
    expect((await handleArtifactPut(bucket as unknown as R2Bucket, db, "missing", "a.txt", new Request("https://x/", { method: "PUT", body: "x" }))).status).toBe(404);
    expect(bucket.store.size).toBe(0);
  });

  it("round-trips a put through get", async () => {
    const db = new ArtifactsDb([jobRow()]);
    const bucket = fakeBucket();
    const put = await handleArtifactPut(
      bucket as unknown as R2Bucket,
      db,
      "job-1",
      "report.txt",
      new Request("https://x/", { method: "PUT", body: "coverage 92%" }),
    );
    expect(put.status).toBe(200);

    const get = await handleArtifactGet(bucket as unknown as R2Bucket, "job-1", "report.txt");
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Disposition")).toBe('attachment; filename="report.txt"');
    expect(await get.text()).toBe("coverage 92%");

    const missing = await handleArtifactGet(bucket as unknown as R2Bucket, "job-1", "nope.txt");
    expect(missing.status).toBe(404);
  });

  it("deleteJobArtifacts removes exactly one job's blobs", async () => {
    const bucket = fakeBucket();
    bucket.store.set("artifacts/job-1/a.txt", { data: new Uint8Array([1]), uploaded: new Date() });
    bucket.store.set("artifacts/job-1/b.txt", { data: new Uint8Array([1]), uploaded: new Date() });
    bucket.store.set("artifacts/job-2/c.txt", { data: new Uint8Array([1]), uploaded: new Date() });
    expect(await deleteJobArtifacts(bucket as unknown as R2Bucket, "job-1")).toBe(2);
    expect(bucket.store.has("artifacts/job-1/a.txt")).toBe(false);
    expect(bucket.store.has("artifacts/job-2/c.txt")).toBe(true);
    expect(await deleteJobArtifacts(bucket as unknown as R2Bucket, "job-1")).toBe(0);
    expect(await deleteJobArtifacts(undefined, "job-1")).toBe(0);
  });

  it("pruneOldCache drops only entries past the cutoff", async () => {
    const bucket = fakeBucket();
    const dayMs = 86400000;
    bucket.store.set("cache/old", { data: new Uint8Array([1]), uploaded: new Date(Date.now() - 100 * dayMs) });
    bucket.store.set("cache/new", { data: new Uint8Array([1]), uploaded: new Date(Date.now() - 2 * dayMs) });
    bucket.store.set("artifacts/job-1/x", { data: new Uint8Array([1]), uploaded: new Date(Date.now() - 100 * dayMs) });
    expect(await pruneOldCache(bucket as unknown as R2Bucket, 90)).toBe(1);
    expect(bucket.store.has("cache/old")).toBe(false);
    expect(bucket.store.has("cache/new")).toBe(true);
    // Artifacts are not cache: the prefix keeps them out of cache pruning.
    expect(bucket.store.has("artifacts/job-1/x")).toBe(true);
    expect(await pruneOldCache(undefined)).toBe(0);
  });

  it("lists a run's artifacts per job; null without a bucket", async () => {
    const db = new ArtifactsDb([
      jobRow({ id: "job-1" }),
      jobRow({ id: "job-2", name: "build" }),
      jobRow({ id: "job-other", run_id: "run-2" }),
    ]);
    const bucket = fakeBucket();
    await bucket.put("artifacts/job-2/lib.tgz", new Blob(["x"]).stream());
    const listed = await listRunArtifacts(bucket as unknown as R2Bucket, db, "run-1");
    expect(listed).toEqual([
      { jobId: "job-2", jobName: "build", name: "lib.tgz", size: 1, uploaded: "2026-10-02T10:00:00.000Z" },
    ]);
    expect(await listRunArtifacts(undefined, db, "run-1")).toBeNull();
  });
});
