import { ACTIONS_LIST_USD_PER_MIN } from "./cost";
import { getSetting, nowIso, repoAllowSql, type Db } from "./db";
import { parseGithubRunnerLabels, parseGithubRunnerMode, SETTING_KEYS } from "./settings";

// GitHub runner mode (`runs-on: flare`): GitHub keeps orchestrating and
// Flare registers one ephemeral JIT self-hosted runner per job. Rows in
// `gh_runner_jobs` mirror the workflow_job webhook lifecycle (queued →
// claimed → running → completed); a claim mints the JIT config at claim
// time (1h TTL) and stores the runner id so a stale claim can delete the
// orphaned runner before requeueing. Off by default. Runtime-free and
// fake-Db testable; index.ts owns HTTP, auth, and GitHub API calls.

export interface WorkflowJobPayload {
  action?: string;
  repository?: { full_name?: string };
  installation?: { id?: number };
  workflow_job?: {
    id?: number;
    run_id?: number;
    run_attempt?: number;
    workflow_name?: string | null;
    head_sha?: string | null;
    name?: string;
    labels?: unknown;
    conclusion?: string | null;
    runner_id?: number | null;
    runner_name?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
  };
}

export interface GhRunnerJobRow {
  id: string;
  repo: string;
  installation_id: number | null;
  run_id: string;
  run_attempt: number;
  job_name: string;
  workflow_name: string;
  head_sha: string;
  labels: string;
  status: string;
  conclusion: string | null;
  runner_id: number | null;
  runner_name: string;
  claimed_at: string | null;
  claimed_by: string;
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WorkflowJobOutcome =
  | { handled: false; reason: string }
  | { handled: true; action: "inserted" | "running" | "completed"; id: string; terminal?: GhJobTerminal };

export interface GhJobTerminal {
  repo: string;
  runId: string;
  jobName: string;
  conclusion: string;
  durationMs: number;
  attempts: number;
}

// Labels GitHub injects around the meaningful ones (`runs-on:
// [self-hosted, linux, x64, flare]`). Neither claim matching nor the JIT
// request treats these as capabilities the runner must declare.
export const RESERVED_RUNNER_LABELS = new Set([
  "self-hosted",
  "linux",
  "windows",
  "macos",
  "x64",
  "x86",
  "arm64",
  "aarch64",
]);

function lower(labels: string[]): string[] {
  return labels.map((l) => l.toLowerCase());
}

// Case-insensitive: GitHub routes labels without regard to case, and
// the managed set is already normalized by parseGithubRunnerLabels.
export function targetsManagedLabel(jobLabels: string[], managedLabels: string[]): boolean {
  const have = new Set(lower(jobLabels));
  return lower(managedLabels).some((m) => have.has(m));
}

// Every job label beyond the managed + reserved sets must be declared
// by the runner (a `runs-on: [flare, gpu]` job needs a gpu runner).
export function ghLabelsMatch(jobLabels: string[], runnerLabels: string[], managedLabels: string[]): boolean {
  const managed = new Set(lower(managedLabels));
  const have = new Set(lower(runnerLabels));
  for (const label of lower(jobLabels)) {
    if (managed.has(label) || RESERVED_RUNNER_LABELS.has(label)) continue;
    if (!have.has(label)) return false;
  }
  return true;
}

export function parseStoredLabels(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

export async function runnerModeOn(db: Db): Promise<boolean> {
  const parsed = parseGithubRunnerMode(await getSetting(db, SETTING_KEYS.githubRunnerMode));
  return !("error" in parsed) && parsed.mode === "on";
}

export async function runnerManagedLabels(db: Db): Promise<string[]> {
  const parsed = parseGithubRunnerLabels(await getSetting(db, SETTING_KEYS.githubRunnerLabels));
  return "labels" in parsed ? parsed.labels : ["flare"];
}

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export async function handleWorkflowJobEvent(
  db: Db,
  payload: WorkflowJobPayload,
  opts: { modeOn: boolean; managedLabels: string[] },
): Promise<WorkflowJobOutcome> {
  const action = payload.action ?? "";
  const wj = payload.workflow_job;
  const repo = payload.repository?.full_name ?? "";
  if (!wj || typeof wj.id !== "number" || !repo) return { handled: false, reason: "missing workflow_job" };
  const id = String(wj.id);
  const now = nowIso();

  if (action === "queued") {
    if (!opts.modeOn) return { handled: false, reason: "runner mode off" };
    const rawLabels = Array.isArray(wj.labels) ? wj.labels : [];
    const labels = rawLabels.filter((l): l is string => typeof l === "string");
    if (!targetsManagedLabel(labels, opts.managedLabels)) return { handled: false, reason: "no managed label" };
    const installationId = payload.installation?.id;
    if (typeof installationId !== "number") return { handled: false, reason: "no installation" };
    await db
      .prepare(
        `INSERT OR IGNORE INTO gh_runner_jobs
         (id, repo, installation_id, run_id, run_attempt, job_name, workflow_name, head_sha, labels, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .bind(
        id,
        repo,
        installationId,
        typeof wj.run_id === "number" ? String(wj.run_id) : "",
        typeof wj.run_attempt === "number" ? wj.run_attempt : 1,
        asString(wj.name, 200) || "job",
        asString(wj.workflow_name, 200),
        asString(wj.head_sha, 64),
        JSON.stringify(labels.slice(0, 20)),
        now,
        now,
      )
      .run();
    return { handled: true, action: "inserted", id };
  }

  if (action === "in_progress") {
    // Only rows we own move; a redelivered event after completion is a
    // no-op, never a resurrection.
    const res = (await db
      .prepare(
        `UPDATE gh_runner_jobs SET status = 'running',
         started_at = COALESCE(started_at, ?),
         runner_id = COALESCE(runner_id, ?), runner_name = COALESCE(NULLIF(runner_name, ''), ?),
         updated_at = ? WHERE id = ? AND status IN ('queued', 'claimed')`,
      )
      .bind(
        asString(wj.started_at, 32) || now,
        typeof wj.runner_id === "number" ? wj.runner_id : null,
        asString(wj.runner_name, 200),
        now,
        id,
      )
      .run()) as { meta?: { changes?: number } };
    if ((res?.meta?.changes ?? 0) === 0) return { handled: false, reason: "unknown or already terminal" };
    return { handled: true, action: "running", id };
  }

  if (action === "completed") {
    const row = await db.prepare("SELECT * FROM gh_runner_jobs WHERE id = ?").bind(id).first<GhRunnerJobRow>();
    if (!row || row.status === "completed") return { handled: false, reason: "unknown or already terminal" };
    const completedAt = asString(wj.completed_at, 32) || now;
    await db
      .prepare("UPDATE gh_runner_jobs SET status = 'completed', conclusion = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status != 'completed'")
      .bind(asString(wj.conclusion, 32) || "unknown", completedAt, now, id)
      .run();
    const startMs = row.started_at ? Date.parse(row.started_at) : Number.NaN;
    const endMs = Date.parse(completedAt);
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : 0;
    return {
      handled: true,
      action: "completed",
      id,
      terminal: {
        repo: row.repo,
        runId: row.run_id,
        jobName: row.job_name,
        conclusion: asString(wj.conclusion, 32) || "unknown",
        durationMs,
        attempts: row.attempts,
      },
    };
  }

  // `waiting` and any future actions: acknowledged, never stored.
  return { handled: false, reason: `ignored action: ${action || "missing"}` };
}

export async function getGhRunnerJob(db: Db, id: string): Promise<GhRunnerJobRow | null> {
  return db.prepare("SELECT * FROM gh_runner_jobs WHERE id = ?").bind(id).first<GhRunnerJobRow>();
}

// Oldest-first scan of queued rows (bounded like claimNextJob's window);
// the conditional UPDATE makes the win atomic across racing pollers.
export async function claimGhRunnerJob(
  db: Db,
  runnerLabels: string[],
  managedLabels: string[],
  allowedRepos: string[],
  claimedBy: string,
): Promise<GhRunnerJobRow | null> {
  const scope = repoAllowSql(allowedRepos, "repo");
  const repoFilter = scope.clause ? ` AND ${scope.clause}` : "";
  const rows = await db
    .prepare(`SELECT * FROM gh_runner_jobs WHERE status = 'queued'${repoFilter} ORDER BY created_at ASC, id ASC LIMIT 200`)
    .bind(...scope.binds)
    .all<GhRunnerJobRow>();
  for (const row of rows.results) {
    if (!ghLabelsMatch(parseStoredLabels(row.labels), runnerLabels, managedLabels)) continue;
    const now = nowIso();
    const res = (await db
      .prepare("UPDATE gh_runner_jobs SET status = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
      .bind(claimedBy, now, now, row.id)
      .run()) as { meta?: { changes?: number } };
    if ((res?.meta?.changes ?? 0) === 0) continue;
    const claimed = await getGhRunnerJob(db, row.id);
    if (claimed) return claimed;
  }
  return null;
}

// Stamp the minted JIT runner so a stale claim can delete the orphaned
// registration before requeueing. Conditional: a concurrent terminal
// event (GitHub assigned the job elsewhere) wins over the stamp.
export async function stampGhRunnerId(db: Db, id: string, runnerId: number, runnerName: string): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE gh_runner_jobs SET runner_id = ?, runner_name = ?, updated_at = ? WHERE id = ? AND status = 'claimed'")
    .bind(runnerId, runnerName.slice(0, 200), nowIso(), id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

// Release back to queued (GitHub API failure, stale claim). Conditional
// so a concurrent in_progress/completed wins the finish race.
export async function releaseGhRunnerJob(db: Db, id: string): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE gh_runner_jobs SET status = 'queued', claimed_by = '', claimed_at = NULL, runner_id = NULL, runner_name = '', updated_at = ? WHERE id = ? AND status = 'claimed'")
    .bind(nowIso(), id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

// Claims that never went `running` (machine died before start) go back
// to queued after the TTL. The release wins the race first; only then
// does the caller delete the orphaned JIT runner (a live job's runner
// must never be deleted). Bounded 50/pass.
export async function sweepStaleGhRunnerJobs(
  db: Db,
  ttlMinutes: number,
  onStale?: (row: GhRunnerJobRow) => Promise<void>,
): Promise<{ swept: number }> {
  const cutoff = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
  const rows = await db
    .prepare("SELECT * FROM gh_runner_jobs WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ? ORDER BY claimed_at ASC LIMIT 50")
    .bind(cutoff)
    .all<GhRunnerJobRow>();
  let swept = 0;
  for (const row of rows.results) {
    if (!(await releaseGhRunnerJob(db, row.id))) continue;
    if (onStale) await onStale(row);
    swept += 1;
  }
  return { swept };
}

export interface GhRunnerUsage {
  jobs: number;
  computeMinutes: number;
  actionsListUsd: number;
}

export async function ghRunnerUsage(db: Db, days: number, allowedRepos: string[] = []): Promise<GhRunnerUsage> {
  const cutoff = new Date(Date.now() - Math.max(1, Math.min(days, 365)) * 86_400_000).toISOString();
  const scope = repoAllowSql(allowedRepos, "repo");
  const filter = scope.clause ? ` AND ${scope.clause}` : "";
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(strftime('%s', completed_at) - strftime('%s', started_at)), 0) AS secs
       FROM gh_runner_jobs WHERE status = 'completed' AND completed_at IS NOT NULL AND started_at IS NOT NULL AND created_at >= ?${filter}`,
    )
    .bind(cutoff, ...scope.binds)
    .first<{ n: number; secs: number }>();
  const computeMinutes = Math.round((((row?.secs ?? 0) / 60) || 0) * 1000) / 1000;
  return {
    jobs: row?.n ?? 0,
    computeMinutes,
    actionsListUsd: Math.round(computeMinutes * ACTIONS_LIST_USD_PER_MIN * 10000) / 10000,
  };
}

export async function listGhRunnerJobs(
  db: Db,
  opts: { repo?: string; limit?: number; allowedRepos?: string[] } = {},
): Promise<GhRunnerJobRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const allowed = opts.allowedRepos ?? [];
  // Repo-scoped tokens only list their repos (empty = all).
  const scope = repoAllowSql(allowed, "repo");
  const scopeFilter = !opts.repo && scope.clause ? ` WHERE ${scope.clause}` : "";
  if (opts.repo) {
    const rows = await db
      .prepare("SELECT * FROM gh_runner_jobs WHERE repo = ? ORDER BY created_at DESC LIMIT ?")
      .bind(opts.repo, limit)
      .all<GhRunnerJobRow>();
    return rows.results;
  }
  const rows = await db
    .prepare(`SELECT * FROM gh_runner_jobs${scopeFilter} ORDER BY created_at DESC LIMIT ?`)
    .bind(...scope.binds, limit)
    .all<GhRunnerJobRow>();
  return rows.results;
}
