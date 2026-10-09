import { describe, expect, it } from "vitest";
import type { Db, JobRow, RunRow } from "./db";
import { buildRunDigest, parseDigestSteps } from "./digest";

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    repo: "o/r",
    sha: "abcdef1234567890",
    event: "dispatch",
    installation_id: null,
    branch: "main",
    source: null,
    pr_number: null,
    pr_comment_id: null,
    heal_branch: null,
    heal_pr_url: null, agent: "",
    status: "failure",
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:01:30.000Z",
    ...over,
    pipeline_source: over.pipeline_source ?? "",
    changed_files: over.changed_files ?? "",
    profile: over.profile ?? null,
  };
}

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "failure",
    log: "full log that should not appear in the digest",
    name: "test",
    definition: "",
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: "2026-10-02T10:00:10.000Z",
    finished_at: "2026-10-02T10:01:00.000Z",
    retained_until: null,
    prior_ms: 0,
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:01:00.000Z",
    ...over,
  };
}

class DigestDb implements Db {
  constructor(
    public run: RunRow | null,
    public jobs: JobRow[] = [],
    public egress: { job_id: string; run_id: string; host: string; req_bytes: number; resp_bytes: number }[] = [],
    public selections: { job_id: string; run_id: string; mode: string; reason: string; selected_count: number; skipped_count: number }[] = [],
  ) {}

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: this.jobs.filter((j) => j.run_id === values[0]) as T[] };
          }
          if (norm.startsWith("SELECT * FROM job_egress WHERE run_id")) {
            return { results: this.egress.filter((e) => e.run_id === values[0]) as T[] };
          }
          if (norm.startsWith("SELECT * FROM test_selections WHERE run_id")) {
            return { results: this.selections.filter((s) => s.run_id === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (norm.startsWith("SELECT * FROM runs WHERE id")) return this.run as T | null;
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => ({}),
      }),
    };
  }
}

describe("parseDigestSteps", () => {
  it("caps command and output and skips junk", () => {
    const steps = parseDigestSteps(
      JSON.stringify({
        steps: [
          { command: "c".repeat(400), exitCode: 1, durationMs: 5, output: "A".repeat(600) + "TAIL" },
          { command: 42, exitCode: 0 },
          "junk",
        ],
      }),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].command).toHaveLength(300);
    expect(steps[0].outputTail).toHaveLength(500);
    expect(steps[0].outputTail.endsWith("TAIL")).toBe(true);
    expect(parseDigestSteps("not json")).toEqual([]);
  });
});

describe("buildRunDigest", () => {
  it("builds a compact failures-first digest", async () => {
    const failed = jobRow({
      result: JSON.stringify({
        steps: [
          { command: "npm ci", exitCode: 0, durationMs: 3000, output: "ok" },
          { command: "npm test", exitCode: 1, durationMs: 1200, output: "A".repeat(600) + "BOOM" },
        ],
      }),
      triage: "Cause: flaky suite. Fix: rerun.",
    });
    const passed = jobRow({ id: "job-2", name: "lint", status: "success", result: JSON.stringify({ steps: [{ command: "lint", exitCode: 0 }] }) });
    const digest = await buildRunDigest(new DigestDb(runRow(), [failed, passed]), "run-1");
    expect(digest?.status).toBe("failure");
    expect(digest?.durationMs).toBe(90000);
    expect(digest?.totalJobs).toBe(2);
    expect(digest?.failedJobs).toBe(1);
    expect(digest?.jobs[0].stepCount).toBe(2);
    expect(digest?.jobs[0].failing?.command).toBe("npm test");
    expect(digest?.jobs[0].failing?.exitCode).toBe(1);
    expect(digest?.jobs[0].failing?.outputTail.endsWith("BOOM")).toBe(true);
    expect(digest?.jobs[0].triage).toBe("Cause: flaky suite. Fix: rerun.");
    expect(digest?.jobs[1].failing).toBeUndefined();
    expect(JSON.stringify(digest)).not.toContain("full log");
  });

  it("returns null for a missing run", async () => {
    expect(await buildRunDigest(new DigestDb(null), "nope")).toBeNull();
  });

  it("carries retain deadlines and an egress summary", async () => {
    const failed = jobRow({ retained_until: "2026-10-02T10:31:00.000Z" });
    const digest = await buildRunDigest(
      new DigestDb(runRow(), [failed], [
        { job_id: "job-1", run_id: "run-1", host: "r2:cache", req_bytes: 13, resp_bytes: 7 },
        { job_id: "job-1", run_id: "run-1", host: "(interface)", req_bytes: 7000, resp_bytes: 4000 },
      ]),
      "run-1",
    );
    expect(digest?.jobs[0].retainedUntil).toBe("2026-10-02T10:31:00.000Z");
    expect(digest?.egress).toEqual({
      reqBytes: 7013,
      respBytes: 4007,
      topHosts: [
        { host: "r2:cache", reqBytes: 13, respBytes: 7 },
        { host: "(interface)", reqBytes: 7000, respBytes: 4000 },
      ],
    });
  });

  it("omits egress when no rows exist", async () => {
    const digest = await buildRunDigest(new DigestDb(runRow(), [jobRow()]), "run-1");
    expect(digest?.egress).toBeUndefined();
    expect(digest?.jobs[0].retainedUntil).toBeUndefined();
  });

  it("carries the heal branch and PR when a heal landed", async () => {
    const healed = runRow({ heal_branch: "flare-heal/abc123", heal_pr_url: "https://github.com/o/r/pull/7" });
    const digest = await buildRunDigest(new DigestDb(healed, [jobRow()]), "run-1");
    expect(digest?.heal).toEqual({ branch: "flare-heal/abc123", prUrl: "https://github.com/o/r/pull/7" });
    const plain = await buildRunDigest(new DigestDb(runRow(), [jobRow()]), "run-1");
    expect(plain?.heal).toBeUndefined();
  });

  it("carries per-job selection outcomes and a run rollup", async () => {
    const digest = await buildRunDigest(
      new DigestDb(runRow(), [jobRow()], [], [
        { job_id: "job-1", run_id: "run-1", mode: "select", reason: "2/10 tests affected", selected_count: 2, skipped_count: 8 },
      ]),
      "run-1",
    );
    expect(digest?.jobs[0].selection).toEqual({ mode: "select", reason: "2/10 tests affected", selected: 2, skipped: 8 });
    expect(digest?.testSelection).toEqual({ jobs: 1, selected: 2, skipped: 8 });
    const plain = await buildRunDigest(new DigestDb(runRow(), [jobRow()]), "run-1");
    expect(plain?.testSelection).toBeUndefined();
    expect(plain?.jobs[0].selection).toBeUndefined();
  });

});
