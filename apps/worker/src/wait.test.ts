import { describe, expect, it } from "vitest";
import type { Db, JobRow, RunRow } from "./db";
import { waitForRunTerminal } from "./wait";

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    repo: "o/r",
    sha: "abc123",
    event: "dispatch",
    installation_id: null,
    branch: "main",
    source: null,
    pr_number: null,
    pr_comment_id: null,
    heal_branch: null,
    heal_pr_url: null,
    status: "queued",
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

class WaitDb implements Db {
  jobs: JobRow[] = [];
  runReads = 0;

  constructor(public run: RunRow | null) {}

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
          if (norm.startsWith("SELECT * FROM runs WHERE id")) {
            this.runReads += 1;
            return this.run as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => ({}),
      }),
    };
  }
}

describe("waitForRunTerminal", () => {
  it("returns immediately for an already-terminal run", async () => {
    const db = new WaitDb(runRow({ status: "success" }));
    const sleeps: number[] = [];
    const out = await waitForRunTerminal(db, "run-1", { sleep: async (ms) => void sleeps.push(ms) });
    expect(out?.timedOut).toBe(false);
    expect(out?.run.status).toBe("success");
    expect(sleeps).toEqual([]);
    expect(db.runReads).toBe(1);
  });

  it("polls until the run turns terminal", async () => {
    const db = new WaitDb(runRow({ status: "queued" }));
    let sleeps = 0;
    const out = await waitForRunTerminal(db, "run-1", {
      timeoutMs: 5000,
      pollMs: 10,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 3) db.run = { ...(db.run as RunRow), status: "failure" };
      },
    });
    expect(out?.timedOut).toBe(false);
    expect(out?.run.status).toBe("failure");
    expect(sleeps).toBe(3);
  });

  it("stops at the timeout and reports timedOut", async () => {
    const db = new WaitDb(runRow({ status: "running" }));
    const out = await waitForRunTerminal(db, "run-1", { timeoutMs: 5, pollMs: 1 });
    expect(out?.timedOut).toBe(true);
    expect(out?.run.status).toBe("running");
    expect(out?.waitedMs).toBeGreaterThanOrEqual(5);
  });

  it("returns null for a missing run", async () => {
    expect(await waitForRunTerminal(new WaitDb(null), "nope")).toBeNull();
  });
});
