import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  jobSetFingerprint,
  pairClaimKey,
  pairDedupeBlocker,
  resolvePairDedupe,
  type DedupeJob,
  type PairDedupeInput,
} from "./event-dedupe";

interface RunRow {
  id: string;
  repo: string;
  sha: string;
  branch: string;
  event: string;
  status: string;
  pr_number: number | null;
  pipeline_source: string;
  profile: string | null;
  created_at: string;
}

// Routes exactly the SQL event-dedupe issues; anything else throws.
class PairDb implements Db {
  deliveries = new Set<string>();
  runs: RunRow[] = [];
  jobs: { run_id: string; name: string; definition: string }[] = [];
  // Called on each twin lookup (lets a test land the winner's row late).
  onLookup: (() => void) | null = null;

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          if (norm.startsWith("SELECT id, event, status, pr_number, pipeline_source, profile FROM runs")) {
            this.onLookup?.();
            const [repo, sha, branch] = values as string[];
            const rows = this.runs
              .filter(
                (r) =>
                  r.repo === repo &&
                  r.sha === sha &&
                  r.branch === branch &&
                  (r.event === "push" || r.event === "pull_request") &&
                  r.status !== "cancelled",
              )
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
              .slice(0, 5);
            return { results: rows as unknown as T[] };
          }
          if (norm.startsWith("SELECT name, definition FROM jobs WHERE run_id")) {
            return { results: this.jobs.filter((j) => j.run_id === values[0]) as unknown as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async (): Promise<unknown> => {
          if (norm.startsWith("INSERT INTO webhook_deliveries")) {
            const id = values[0] as string;
            if (this.deliveries.has(id)) return { meta: { changes: 0 } };
            this.deliveries.add(id);
            return { meta: { changes: 1 } };
          }
          if (norm.startsWith("UPDATE runs SET pr_number = ? WHERE id = ? AND pr_number IS NULL")) {
            const run = this.runs.find((r) => r.id === values[1]);
            if (!run || run.pr_number !== null) return { meta: { changes: 0 } };
            run.pr_number = values[0] as number;
            return { meta: { changes: 1 } };
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }

  addRun(row: Partial<RunRow> & { id: string; event: string }, jobs: DedupeJob[]): void {
    this.runs.push({
      repo: "o/r",
      sha: "abc123",
      branch: "feat",
      status: "running",
      pr_number: null,
      pipeline_source: "flare",
      profile: null,
      created_at: new Date().toISOString(),
      ...row,
    });
    for (const j of jobs) this.jobs.push({ run_id: row.id, ...j });
  }
}

const def = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ steps: [{ run: "npm test" }], base: "test", ...extra });

const JOBS: DedupeJob[] = [
  { name: "lint", definition: def({ base: "lint" }) },
  { name: "test", definition: def() },
];

function input(over: Partial<PairDedupeInput> = {}): PairDedupeInput {
  return {
    repo: "o/r",
    sha: "abc123",
    branch: "feat",
    event: "pull_request",
    prNumber: 7,
    pipelineSource: "flare",
    profile: null,
    jobs: JOBS,
    ...over,
  };
}

const noSleep = { sleep: async () => undefined, waitAttempts: 3 };

async function claimFor(db: PairDb, jobs: DedupeJob[] = JOBS, branch = "feat"): Promise<void> {
  const fp = await jobSetFingerprint({ pipelineSource: "flare", profile: null, jobs });
  db.deliveries.add(pairClaimKey("o/r", "abc123", branch, fp));
}

describe("pairDedupeBlocker", () => {
  it("allows plain job sets", () => {
    expect(pairDedupeBlocker(JOBS)).toBeNull();
  });

  it("blocks event-dependent jobs", () => {
    expect(pairDedupeBlocker([])).toBe("no jobs");
    expect(pairDedupeBlocker([{ name: "t", definition: def({ testSelection: { enabled: true } }) }])).toMatch(/test selection/);
    expect(pairDedupeBlocker([{ name: "t", definition: def({ browserChecks: [{ name: "home", url: "https://x" }] }) }])).toMatch(
      /browser checks/,
    );
    expect(pairDedupeBlocker([{ name: "t", definition: JSON.stringify({ steps: [{ run: "echo $FLARE_CHANGED_FILES" }] }) }])).toMatch(
      /FLARE_CHANGED_FILES/,
    );
    expect(pairDedupeBlocker([{ name: "t", definition: "{nope" }])).toMatch(/unparseable/);
  });
});

describe("jobSetFingerprint", () => {
  it("is order-insensitive and sensitive to source, profile, and definitions", async () => {
    const a = await jobSetFingerprint({ pipelineSource: "flare", profile: null, jobs: JOBS });
    expect(await jobSetFingerprint({ pipelineSource: "flare", profile: null, jobs: [...JOBS].reverse() })).toBe(a);
    expect(await jobSetFingerprint({ pipelineSource: "actions", profile: null, jobs: JOBS })).not.toBe(a);
    expect(await jobSetFingerprint({ pipelineSource: "flare", profile: "pr", jobs: JOBS })).not.toBe(a);
    expect(await jobSetFingerprint({ pipelineSource: "flare", profile: null, jobs: JOBS.slice(0, 1) })).not.toBe(a);
  });
});

describe("resolvePairDedupe", () => {
  it("runs the first event of a pair and holds the claim", async () => {
    const db = new PairDb();
    const out = await resolvePairDedupe({ db, ...noSleep }, input({ event: "push", prNumber: null }));
    expect(out.action).toBe("run");
    expect(out.action === "run" && out.claimKey).toMatch(/^pair:o\/r@abc123:feat:/);
  });

  it("skips a pull_request whose push twin exists and stamps the PR number", async () => {
    const db = new PairDb();
    await claimFor(db);
    db.addRun({ id: "push-run", event: "push" }, JOBS);
    const out = await resolvePairDedupe({ db, ...noSleep }, input());
    expect(out).toEqual({ action: "skip", runId: "push-run", runEvent: "push", runStatus: "running", stampedPr: true });
    expect(db.runs[0].pr_number).toBe(7);
  });

  it("skips a push whose pull_request twin exists (vice versa), without touching pr_number", async () => {
    const db = new PairDb();
    await claimFor(db);
    db.addRun({ id: "pr-run", event: "pull_request", pr_number: 7 }, JOBS);
    const out = await resolvePairDedupe({ db, ...noSleep }, input({ event: "push", prNumber: null }));
    expect(out).toMatchObject({ action: "skip", runId: "pr-run", runEvent: "pull_request", stampedPr: false });
  });

  it("waits for the winner's run row when the claim is held but the row is not visible yet", async () => {
    const db = new PairDb();
    await claimFor(db);
    let lookups = 0;
    db.onLookup = () => {
      lookups += 1;
      if (lookups === 2) db.addRun({ id: "push-run", event: "push" }, JOBS);
    };
    const out = await resolvePairDedupe({ db, ...noSleep }, input());
    expect(out).toMatchObject({ action: "skip", runId: "push-run" });
    expect(lookups).toBe(2);
  });

  it("fails open when the claim is held but no twin ever appears", async () => {
    const db = new PairDb();
    await claimFor(db);
    const out = await resolvePairDedupe({ db, ...noSleep }, input());
    expect(out).toMatchObject({ action: "run" });
    expect(out.action === "run" && out.claimKey).toBeFalsy();
  });

  it("does not pair two runs of the same event (a re-push keeps running)", async () => {
    const db = new PairDb();
    await claimFor(db);
    db.addRun({ id: "push-1", event: "push" }, JOBS);
    const out = await resolvePairDedupe({ db, ...noSleep }, input({ event: "push", prNumber: null }));
    expect(out).toMatchObject({ action: "run", reason: "claim held by a same-event run" });
  });

  it("runs both when the job sets differ (e.g. a pull_request-only workflow)", async () => {
    const db = new PairDb();
    const pushJobs = JOBS.slice(0, 1);
    await claimFor(db, pushJobs);
    db.addRun({ id: "push-run", event: "push" }, pushJobs);
    // The PR expands to an extra pull_request-only job: different
    // fingerprint, different claim — it wins its own claim and runs.
    const out = await resolvePairDedupe({ db, ...noSleep }, input());
    expect(out.action).toBe("run");
    expect(db.runs[0].pr_number).toBeNull();
  });

  it("never pairs against a cancelled twin, another branch, or event-dependent jobs", async () => {
    const db = new PairDb();
    await claimFor(db);
    db.addRun({ id: "push-run", event: "push", status: "cancelled" }, JOBS);
    expect((await resolvePairDedupe({ db, ...noSleep }, input())).action).toBe("run");

    const other = new PairDb();
    other.addRun({ id: "push-main", event: "push", branch: "main" }, JOBS);
    expect((await resolvePairDedupe({ db: other, ...noSleep }, input())).action).toBe("run");

    const sel = new PairDb();
    const selJobs = [{ name: "t", definition: def({ testSelection: { enabled: true } }) }];
    sel.addRun({ id: "push-run", event: "push" }, selJobs);
    const out = await resolvePairDedupe({ db: sel, ...noSleep }, input({ jobs: selJobs }));
    expect(out).toMatchObject({ action: "run", reason: expect.stringMatching(/test selection/) });
    expect(sel.deliveries.size).toBe(0);
  });

  it("ignores events outside the pair", async () => {
    const db = new PairDb();
    expect(await resolvePairDedupe({ db, ...noSleep }, input({ event: "schedule" }))).toMatchObject({ action: "run" });
    expect(db.deliveries.size).toBe(0);
  });
});
