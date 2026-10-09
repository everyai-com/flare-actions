import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  claimGhRunnerJob,
  ghLabelsMatch,
  ghRunnerUsage,
  handleWorkflowJobEvent,
  laneLogDigestText,
  listGhRunnerJobs,
  parseStoredLabels,
  releaseGhRunnerJob,
  runnerManagedLabels,
  runnerModeOn,
  setGhJobLogDigest,
  stampGhRunnerId,
  sweepStaleGhRunnerJobs,
  targetsManagedLabel,
  type GhRunnerJobRow,
  type WorkflowJobPayload,
} from "./ghrunners";

function row(over: Partial<GhRunnerJobRow> = {}): GhRunnerJobRow {
  return {
    id: "101",
    repo: "o/r",
    installation_id: 55,
    run_id: "9",
    run_attempt: 1,
    job_name: "test",
    workflow_name: "ci",
    head_sha: "abc",
    labels: JSON.stringify(["self-hosted", "flare"]),
    status: "queued",
    conclusion: null,
    runner_id: null,
    runner_name: "",
    claimed_at: null,
    claimed_by: "",
    attempts: 0,
    started_at: null,
    completed_at: null,
    log_digest: null,
    created_at: "2026-10-08T10:00:00.000Z",
    updated_at: "2026-10-08T10:00:00.000Z",
    ...over,
  };
}

// Emulates the shared repoAllowSql filter: exact IN binds first, then
// org LIKE patterns (prefix before the trailing %, escapes undone).
function scopeMatch(norm: string, values: unknown[]): (repo: string) => boolean {
  const inMatch = /lower\(repo\) IN \(([^)]*)\)/.exec(norm);
  const exactCount = inMatch ? ((inMatch[1].match(/\?/g) ?? []).length) : 0;
  const likeCount = (norm.match(/lower\(repo\) LIKE \?/g) ?? []).length;
  const exact = (values.slice(0, exactCount) as string[]).map((s) => s.toLowerCase());
  const patterns = values.slice(exactCount, exactCount + likeCount) as string[];
  if (exactCount + likeCount === 0) return () => true;
  return (repo: string) => {
    const low = repo.toLowerCase();
    if (exact.includes(low)) return true;
    return patterns.some((p) => low.startsWith(p.replace(/\\(.)/g, "$1").replace(/%$/, "")));
  };
}

// Routes the SQL ghrunners.ts issues against an in-memory row store.
class GhDb implements Db {
  rows = new Map<string, GhRunnerJobRow>();
  settings = new Map<string, string>();
  // Ids whose conditional claim loses (poller race simulation).
  raced = new Set<string>();
  private changes = 0;

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => ({ results: this.selectAll(norm, values) as T[] }),
        first: async <T,>(): Promise<T | null> => (this.selectFirst(norm, values) as T | null),
        run: async (): Promise<unknown> => {
          this.exec(norm, values);
          return { meta: { changes: this.changes } };
        },
      }),
    };
  }

  private ordered(): GhRunnerJobRow[] {
    return [...this.rows.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  // Copies, like real D1 rows: later UPDATEs must not rewrite a
  // snapshot the caller already holds (the sweep relies on this).
  private selectAll(norm: string, values: unknown[]): GhRunnerJobRow[] {
    const copy = (r: GhRunnerJobRow): GhRunnerJobRow => ({ ...r });
    if (norm.startsWith("SELECT * FROM gh_runner_jobs WHERE status = 'queued'")) {
      const match = scopeMatch(norm, values);
      return this.ordered()
        .filter((r) => r.status === "queued" && match(r.repo))
        .map(copy);
    }
    if (norm.startsWith("SELECT * FROM gh_runner_jobs WHERE status = 'claimed'")) {
      const cutoff = values[0] as string;
      return [...this.rows.values()]
        .filter((r) => r.status === "claimed" && r.claimed_at !== null && r.claimed_at < cutoff)
        .sort((a, b) => (a.claimed_at as string).localeCompare(b.claimed_at as string))
        .map(copy);
    }
    if (norm.startsWith("SELECT * FROM gh_runner_jobs WHERE repo = ?")) {
      return [...this.rows.values()]
        .filter((r) => r.repo === values[0])
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, values[1] as number)
        .map(copy);
    }
    if (norm.startsWith("SELECT * FROM gh_runner_jobs WHERE (lower(repo)")) {
      const match = scopeMatch(norm, values.slice(0, -1));
      const limit = values[values.length - 1] as number;
      return [...this.rows.values()]
        .filter((r) => match(r.repo))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map(copy);
    }
    if (norm.startsWith("SELECT * FROM gh_runner_jobs ORDER BY created_at DESC")) {
      return [...this.rows.values()]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, values[0] as number)
        .map(copy);
    }
    throw new Error(`unrouted all: ${norm}`);
  }

  private selectFirst(norm: string, values: unknown[]): unknown {
    if (norm.startsWith("SELECT value FROM app_settings")) {
      const v = this.settings.get(values[0] as string);
      return v === undefined ? null : { value: v };
    }
    if (norm.startsWith("SELECT * FROM gh_runner_jobs WHERE id = ?")) {
      const found = this.rows.get(values[0] as string);
      return found ? { ...found } : null;
    }
    if (norm.startsWith("SELECT COUNT(*) AS n")) {
      const cutoff = values[0] as string;
      const match = scopeMatch(norm, values.slice(1));
      let n = 0;
      let secs = 0;
      for (const r of this.rows.values()) {
        if (r.status !== "completed" || !r.completed_at || !r.started_at || r.created_at < cutoff) continue;
        if (!match(r.repo)) continue;
        n += 1;
        secs += Math.max(0, (Date.parse(r.completed_at) - Date.parse(r.started_at)) / 1000);
      }
      return { n, secs };
    }
    throw new Error(`unrouted first: ${norm}`);
  }

  private exec(norm: string, values: unknown[]): void {
    this.changes = 0;
    if (norm.startsWith("INSERT OR IGNORE INTO gh_runner_jobs")) {
      const id = values[0] as string;
      if (this.rows.has(id)) return;
      const now = new Date().toISOString();
      this.rows.set(id, {
        id,
        repo: values[1] as string,
        installation_id: values[2] as number,
        run_id: values[3] as string,
        run_attempt: values[4] as number,
        job_name: values[5] as string,
        workflow_name: values[6] as string,
        head_sha: values[7] as string,
        labels: values[8] as string,
        status: "queued",
        conclusion: null,
        runner_id: null,
        runner_name: "",
        claimed_at: null,
        claimed_by: "",
        attempts: 0,
        started_at: null,
        completed_at: null,
        log_digest: null,
        created_at: now,
        updated_at: now,
      });
      this.changes = 1;
      return;
    }
    if (norm.startsWith("UPDATE gh_runner_jobs SET log_digest = ?")) {
      const r = this.rows.get(values[2] as string);
      if (!r) return;
      r.log_digest = values[0] as string;
      r.updated_at = values[1] as string;
      this.changes = 1;
      return;
    }
    if (norm.startsWith("UPDATE gh_runner_jobs SET status = 'running'")) {
      const r = this.rows.get(values[4] as string);
      if (!r || (r.status !== "queued" && r.status !== "claimed")) return;
      r.status = "running";
      r.started_at = r.started_at ?? (values[0] as string);
      r.runner_id = r.runner_id ?? (values[1] as number | null);
      r.runner_name = r.runner_name || (values[2] as string);
      r.updated_at = values[3] as string;
      this.changes = 1;
      return;
    }
    if (norm.startsWith("UPDATE gh_runner_jobs SET status = 'completed'")) {
      const r = this.rows.get(values[3] as string);
      if (!r || r.status === "completed") return;
      r.status = "completed";
      r.conclusion = values[0] as string;
      r.completed_at = values[1] as string;
      r.updated_at = values[2] as string;
      this.changes = 1;
      return;
    }
    if (norm.startsWith("UPDATE gh_runner_jobs SET status = 'claimed'")) {
      const id = values[3] as string;
      const r = this.rows.get(id);
      if (!r || r.status !== "queued" || this.raced.has(id)) return;
      r.status = "claimed";
      r.claimed_by = values[0] as string;
      r.claimed_at = values[1] as string;
      r.attempts += 1;
      r.updated_at = values[2] as string;
      this.changes = 1;
      return;
    }
    if (norm.startsWith("UPDATE gh_runner_jobs SET runner_id = ?")) {
      const r = this.rows.get(values[3] as string);
      if (!r || r.status !== "claimed") return;
      r.runner_id = values[0] as number;
      r.runner_name = values[1] as string;
      r.updated_at = values[2] as string;
      this.changes = 1;
      return;
    }
    if (norm.startsWith("UPDATE gh_runner_jobs SET status = 'queued', claimed_by")) {
      const r = this.rows.get(values[1] as string);
      if (!r || r.status !== "claimed") return;
      r.status = "queued";
      r.claimed_by = "";
      r.claimed_at = null;
      r.runner_id = null;
      r.runner_name = "";
      r.updated_at = values[0] as string;
      this.changes = 1;
      return;
    }
    throw new Error(`unrouted run: ${norm}`);
  }
}

function queuedPayload(over: Partial<WorkflowJobPayload["workflow_job"]> = {}, top: Partial<WorkflowJobPayload> = {}): WorkflowJobPayload {
  return {
    action: "queued",
    repository: { full_name: "o/r" },
    installation: { id: 55 },
    workflow_job: {
      id: 101,
      run_id: 9,
      run_attempt: 1,
      workflow_name: "ci",
      head_sha: "abc",
      name: "test",
      labels: ["self-hosted", "flare"],
      ...over,
    },
    ...top,
  };
}

describe("label matching", () => {
  it("matches managed labels case-insensitively", () => {
    expect(targetsManagedLabel(["self-hosted", "Flare"], ["flare"])).toBe(true);
    expect(targetsManagedLabel(["ubuntu-latest"], ["flare"])).toBe(false);
    expect(targetsManagedLabel([], ["flare"])).toBe(false);
  });
  it("requires only non-managed, non-reserved labels on the runner", () => {
    expect(ghLabelsMatch(["self-hosted", "linux", "x64", "flare"], [], ["flare"])).toBe(true);
    expect(ghLabelsMatch(["flare", "gpu"], ["gpu"], ["flare"])).toBe(true);
    expect(ghLabelsMatch(["flare", "gpu"], [], ["flare"])).toBe(false);
    expect(ghLabelsMatch(["FLARE", "GPU"], ["gpu"], ["flare"])).toBe(true);
  });
  it("parseStoredLabels tolerates garbage", () => {
    expect(parseStoredLabels(JSON.stringify(["a"]))).toEqual(["a"]);
    expect(parseStoredLabels("nope")).toEqual([]);
    expect(parseStoredLabels(JSON.stringify({}))).toEqual([]);
  });
});

describe("settings helpers", () => {
  it("runnerModeOn defaults off and honors on", async () => {
    const db = new GhDb();
    expect(await runnerModeOn(db)).toBe(false);
    db.settings.set("github_runner_mode", "on");
    expect(await runnerModeOn(db)).toBe(true);
    db.settings.set("github_runner_mode", "bogus");
    expect(await runnerModeOn(db)).toBe(false);
  });
  it("runnerManagedLabels defaults to flare", async () => {
    const db = new GhDb();
    expect(await runnerManagedLabels(db)).toEqual(["flare"]);
    db.settings.set("github_runner_labels", "Flare, gpu");
    expect(await runnerManagedLabels(db)).toEqual(["flare", "gpu"]);
  });
});

describe("handleWorkflowJobEvent", () => {
  const gate = { modeOn: true, managedLabels: ["flare"] };

  it("inserts queued jobs aimed at a managed label", async () => {
    const db = new GhDb();
    const out = await handleWorkflowJobEvent(db, queuedPayload(), gate);
    expect(out).toEqual({ handled: true, action: "inserted", id: "101" });
    expect(db.rows.get("101")).toMatchObject({ repo: "o/r", status: "queued", installation_id: 55 });
  });
  it("ignores jobs for other runners, mode off, and missing installation", async () => {
    const db = new GhDb();
    expect(await handleWorkflowJobEvent(db, queuedPayload({ labels: ["ubuntu-latest"] }), gate)).toMatchObject({ handled: false });
    expect(await handleWorkflowJobEvent(db, queuedPayload(), { modeOn: false, managedLabels: ["flare"] })).toMatchObject({ handled: false });
    expect(await handleWorkflowJobEvent(db, queuedPayload({}, { installation: undefined }), gate)).toMatchObject({ handled: false });
    expect(await handleWorkflowJobEvent(db, { action: "queued" }, gate)).toMatchObject({ handled: false });
    expect(db.rows.size).toBe(0);
  });
  it("moves queued/claimed rows to running, never resurrects completed ones", async () => {
    const db = new GhDb();
    db.rows.set("101", row({ status: "claimed", runner_id: 77 }));
    const out = await handleWorkflowJobEvent(
      db,
      { action: "in_progress", repository: { full_name: "o/r" }, workflow_job: { id: 101, started_at: "2026-10-08T10:01:00.000Z", runner_id: 77, runner_name: "flare-1" } },
      gate,
    );
    expect(out).toMatchObject({ handled: true, action: "running" });
    expect(db.rows.get("101")).toMatchObject({ status: "running", started_at: "2026-10-08T10:01:00.000Z", runner_id: 77 });

    db.rows.set("102", row({ id: "102", status: "completed" }));
    expect(await handleWorkflowJobEvent(db, { action: "in_progress", repository: { full_name: "o/r" }, workflow_job: { id: 102 } }, gate)).toMatchObject({ handled: false });
    expect(await handleWorkflowJobEvent(db, { action: "in_progress", repository: { full_name: "o/r" }, workflow_job: { id: 999 } }, gate)).toMatchObject({ handled: false });
  });
  it("completes once and reports terminal details for analytics", async () => {
    const db = new GhDb();
    db.rows.set("101", row({ status: "running", started_at: "2026-10-08T10:01:00.000Z", attempts: 1 }));
    const out = await handleWorkflowJobEvent(
      db,
      { action: "completed", repository: { full_name: "o/r" }, workflow_job: { id: 101, conclusion: "success", completed_at: "2026-10-08T10:03:00.000Z" } },
      gate,
    );
    expect(out).toEqual({
      handled: true,
      action: "completed",
      id: "101",
      terminal: { repo: "o/r", runId: "9", jobName: "test", conclusion: "success", durationMs: 120000, attempts: 1, installationId: 55 },
    });
    expect(await handleWorkflowJobEvent(db, { action: "completed", repository: { full_name: "o/r" }, workflow_job: { id: 101 } }, gate)).toMatchObject({ handled: false });
  });
  it("ignores waiting and unknown actions", async () => {
    const db = new GhDb();
    expect(await handleWorkflowJobEvent(db, { ...queuedPayload(), action: "waiting" }, gate)).toMatchObject({ handled: false });
    expect(db.rows.size).toBe(0);
  });
});

describe("claimGhRunnerJob", () => {
  it("claims the oldest label-matching queued job", async () => {
    const db = new GhDb();
    db.rows.set("gpu", row({ id: "gpu", labels: JSON.stringify(["flare", "gpu"]), created_at: "2026-10-08T09:00:00.000Z" }));
    db.rows.set("plain", row({ id: "plain", created_at: "2026-10-08T10:00:00.000Z" }));
    const claimed = await claimGhRunnerJob(db, [], ["flare"], [], "runner-1");
    expect(claimed?.id).toBe("plain");
    expect(claimed).toMatchObject({ status: "claimed", claimed_by: "runner-1", attempts: 1 });
  });
  it("respects the repo allowlist", async () => {
    const db = new GhDb();
    db.rows.set("101", row({ repo: "other/repo" }));
    expect(await claimGhRunnerJob(db, [], ["flare"], ["o/r"], "runner-1")).toBeNull();
    expect(await claimGhRunnerJob(db, [], ["flare"], [], "runner-1")).not.toBeNull();
  });
  it("claims through org/* wildcards", async () => {
    const db = new GhDb();
    db.rows.set("101", row({ id: "101", repo: "acme/web" }));
    db.rows.set("102", row({ id: "102", repo: "acmex/evil", created_at: "2026-10-08T09:00:00.000Z" }));
    expect((await claimGhRunnerJob(db, [], ["flare"], ["acme/*"], "runner-1"))?.id).toBe("101");
    expect(await claimGhRunnerJob(db, [], ["flare"], ["acme/*"], "runner-1")).toBeNull();
  });
  it("a lost claim race falls through to the next job", async () => {
    const db = new GhDb();
    db.rows.set("a", row({ id: "a", created_at: "2026-10-08T09:00:00.000Z" }));
    db.rows.set("b", row({ id: "b", created_at: "2026-10-08T10:00:00.000Z" }));
    db.raced.add("a");
    expect((await claimGhRunnerJob(db, [], ["flare"], [], "runner-1"))?.id).toBe("b");
  });
});

describe("stamp + release + sweep", () => {
  it("stamps only claimed rows and releases only claimed rows", async () => {
    const db = new GhDb();
    db.rows.set("101", row({ status: "claimed" }));
    expect(await stampGhRunnerId(db, "101", 77, "flare-1")).toBe(true);
    expect(db.rows.get("101")).toMatchObject({ runner_id: 77, runner_name: "flare-1" });
    expect(await stampGhRunnerId(db, "101", 78, "x")).toBe(true);
    db.rows.set("102", row({ id: "102", status: "running" }));
    expect(await stampGhRunnerId(db, "102", 78, "x")).toBe(false);
    expect(await releaseGhRunnerJob(db, "102")).toBe(false);
    expect(await releaseGhRunnerJob(db, "101")).toBe(true);
    expect(db.rows.get("101")).toMatchObject({ status: "queued", runner_id: null, claimed_by: "" });
  });
  it("sweeps only stale claims and notifies per swept row", async () => {
    const db = new GhDb();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const fresh = new Date().toISOString();
    db.rows.set("stale", row({ id: "stale", status: "claimed", claimed_at: old, runner_id: 77 }));
    db.rows.set("fresh", row({ id: "fresh", status: "claimed", claimed_at: fresh }));
    db.rows.set("run", row({ id: "run", status: "running", claimed_at: old }));
    const seen: string[] = [];
    const out = await sweepStaleGhRunnerJobs(db, 15, async (r) => { seen.push(`${r.id}:${r.runner_id}`); });
    expect(out).toEqual({ swept: 1 });
    expect(seen).toEqual(["stale:77"]);
    expect(db.rows.get("stale")?.status).toBe("queued");
    expect(db.rows.get("fresh")?.status).toBe("claimed");
    expect(db.rows.get("run")?.status).toBe("running");
  });
});

describe("usage + list", () => {
  it("sums completed durations into compute minutes + list price", async () => {
    const db = new GhDb();
    const now = new Date().toISOString();
    db.rows.set("a", row({ id: "a", status: "completed", started_at: "2026-10-08T10:00:00.000Z", completed_at: "2026-10-08T10:02:00.000Z", created_at: now }));
    db.rows.set("b", row({ id: "b", status: "running", created_at: now }));
    expect(await ghRunnerUsage(db, 30)).toEqual({ jobs: 1, computeMinutes: 2, actionsListUsd: 0.016 });
    expect(await ghRunnerUsage(db, 30, ["other/repo"])).toEqual({ jobs: 0, computeMinutes: 0, actionsListUsd: 0 });
  });
  it("lists newest-first with repo filter and clamped limit", async () => {
    const db = new GhDb();
    db.rows.set("a", row({ id: "a", created_at: "2026-10-08T09:00:00.000Z" }));
    db.rows.set("b", row({ id: "b", repo: "other/repo", created_at: "2026-10-08T10:00:00.000Z" }));
    expect((await listGhRunnerJobs(db, {})).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await listGhRunnerJobs(db, { repo: "o/r", limit: 500 })).map((r) => r.id)).toEqual(["a"]);
    expect((await listGhRunnerJobs(db, { allowedRepos: ["o/r"] })).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("lane log digests", () => {
  it("keeps error lines plus the tail, bounded", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `2026-10-08T10:00:${String(i).padStart(2, "0")}Z ok ${i}`);
    lines[5] = "2026-10-08T10:00:05Z Error: boom";
    lines[6] = "2026-10-08T10:00:05Z Error: boom";
    const digest = laneLogDigestText(lines.join("\n"));
    expect(digest).toContain("Error: boom");
    expect(digest.match(/Error: boom/g)).toHaveLength(1);
    expect(digest).toContain("--- tail ---");
    expect(digest).toContain("ok 49");
    expect(digest).not.toContain("ok 0\n");
    expect(digest.length).toBeLessThanOrEqual(4096);
  });

  it("stores the digest on the lane job row", async () => {
    const db = new GhDb();
    db.rows.set("101", row({ status: "completed" }));
    await setGhJobLogDigest(db, "101", "Error: boom\n--- tail ---\nok");
    expect(db.rows.get("101")?.log_digest).toBe("Error: boom\n--- tail ---\nok");
  });
});
