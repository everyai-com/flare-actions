import { describe, expect, it } from "vitest";
import type { Db, JobRow, StaleJobRow } from "./db";
import { requeueStaleJobs } from "./finish";

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "running",
    log: "",
    name: "verify",
    definition: "",
    result: "",
    triage: "",
    labels: "",
    started_at: "2026-10-02T10:00:00.000Z",
    finished_at: null,
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

class MemDb implements Db {
  stale: StaleJobRow[] = [];
  jobs = new Map<string, JobRow>();
  runStatus = new Map<string, string>();
  releaseChanges = 1;

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT j.id, j.run_id, j.name, r.repo, r.sha FROM jobs")) {
            return { results: this.stale as T[] };
          }
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: [...this.jobs.values()].filter((j) => j.run_id === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("UPDATE jobs SET log = COALESCE")) {
            const job = this.jobs.get(values[2] as string);
            if (job) job.log += values[0] as string;
            return {};
          }
          if (norm.startsWith("UPDATE jobs SET status = 'queued'")) {
            const job = this.jobs.get(values[1] as string);
            if (job && job.status === "running" && this.releaseChanges > 0) {
              job.status = "queued";
              job.started_at = null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (norm.startsWith("UPDATE runs SET status")) {
            this.runStatus.set(values[2] as string, values[0] as string);
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("requeueStaleJobs", () => {
  const staleRow: StaleJobRow = {
    id: "job-1",
    run_id: "run-1",
    name: "verify",
    repo: "o/r",
    sha: "abc123",
  };

  it("releases, rolls up, and re-queues stale jobs", async () => {
    const db = new MemDb();
    db.stale = [staleRow];
    db.jobs.set("job-1", jobRow());
    const sent: unknown[] = [];
    const woken: unknown[] = [];
    const out = await requeueStaleJobs(
      db,
      { send: async (m) => void sent.push(m) },
      20,
      (j) => void woken.push(j),
    );
    expect(out).toEqual(["job-1"]);
    expect(db.jobs.get("job-1")?.status).toBe("queued");
    expect(db.jobs.get("job-1")?.log).toContain("no executor heartbeat");
    expect(db.runStatus.get("run-1")).toBe("queued");
    expect(sent).toEqual([{ runId: "run-1", jobId: "job-1", repo: "o/r", sha: "abc123" }]);
    expect(woken).toEqual([{ runId: "run-1", jobId: "job-1" }]);
  });

  it("does nothing when nothing is stale", async () => {
    const db = new MemDb();
    const sent: unknown[] = [];
    expect(await requeueStaleJobs(db, { send: async (m) => void sent.push(m) })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("skips the queue send when the release loses its race", async () => {
    const db = new MemDb();
    db.stale = [staleRow];
    db.jobs.set("job-1", jobRow({ status: "success" }));
    db.releaseChanges = 0;
    const sent: unknown[] = [];
    expect(await requeueStaleJobs(db, { send: async (m) => void sent.push(m) })).toEqual([]);
    expect(sent).toEqual([]);
  });
});
