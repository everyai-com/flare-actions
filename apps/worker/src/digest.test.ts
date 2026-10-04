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
    status: "failure",
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:01:30.000Z",
    ...over,
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
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:01:00.000Z",
    ...over,
  };
}

class DigestDb implements Db {
  constructor(
    public run: RunRow | null,
    public jobs: JobRow[] = [],
  ) {}

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
});
