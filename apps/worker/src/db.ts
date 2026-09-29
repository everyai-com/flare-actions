import { readJobSpec } from "./pipeline";

export interface RunRow {
  id: string;
  repo: string;
  sha: string;
  event: string;
  installation_id: number | null;
  branch: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  run_id: string;
  status: string;
  log: string;
  name: string;
  definition: string;
  result: string;
  triage: string;
  labels: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function setJobTriage(db: Db, id: string, triage: string): Promise<void> {
  await db
    .prepare("UPDATE jobs SET triage = ?, updated_at = ? WHERE id = ?")
    .bind(triage, nowIso(), id)
    .run();
}

export type Db = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(column?: string): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export function nowIso(): string {
  return new Date().toISOString();
}

export const TERMINAL_STATUSES = ["success", "failure", "error", "cancelled", "skipped"];
export const FAILED_STATUSES = ["failure", "error", "cancelled", "skipped"];

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function splitLabels(labels: string): string[] {
  return labels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function createRun(
  db: Db,
  run: { id: string; repo: string; sha: string; event: string; installationId: number | null; branch?: string },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO runs (id, repo, sha, event, installation_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
    )
    .bind(run.id, run.repo, run.sha, run.event, run.installationId, run.branch ?? "", now, now)
    .run();
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

export async function listRuns(db: Db, limit = 50): Promise<RunRow[]> {
  const res = await db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<RunRow>();
  return res.results;
}

export async function updateRunStatus(db: Db, id: string, status: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), id)
    .run();
}

// Recompute a run's status from its jobs: running wins, then queued /
// blocked, then failure, then success; all-skipped/cancelled rolls up
// to cancelled so re-runs and fan-out settle correctly.
export async function rollupRunStatus(db: Db, runId: string): Promise<string> {
  const jobs = await getJobsForRun(db, runId);
  let status = "queued";
  if (jobs.length === 0) {
    status = "queued";
  } else if (jobs.some((j) => j.status === "running")) {
    status = "running";
  } else if (jobs.some((j) => j.status === "queued" || j.status === "blocked")) {
    status = "queued";
  } else if (jobs.some((j) => j.status === "failure" || j.status === "error")) {
    status = "failure";
  } else if (jobs.every((j) => j.status === "cancelled" || j.status === "skipped")) {
    status = "cancelled";
  } else {
    status = "success";
  }
  await updateRunStatus(db, runId, status);
  return status;
}

export async function createJob(
  db: Db,
  id: string,
  runId: string,
  opts?: { name?: string; definition?: string; labels?: string; status?: string },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO jobs (id, run_id, status, log, name, definition, result, labels, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, '', ?, ?, ?)",
    )
    .bind(id, runId, opts?.status ?? "queued", opts?.name ?? "", opts?.definition ?? "", opts?.labels ?? "", now, now)
    .run();
}

export async function getJob(db: Db, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export async function jobExists(db: Db, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM jobs WHERE id = ?").bind(id).first<{ id: string }>();
  return row !== null;
}

export async function getJobsForRun(db: Db, runId: string): Promise<JobRow[]> {
  const res = await db
    .prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at ASC")
    .bind(runId)
    .all<JobRow>();
  return res.results;
}

function labelsMatch(jobLabels: string, runnerLabels: string[]): boolean {
  const need = splitLabels(jobLabels);
  if (need.length === 0) return true;
  return need.every((l) => runnerLabels.includes(l));
}

// Oldest queued job this runner is eligible for: label-less jobs match
// any runner, labeled jobs need every label present on the runner.
export async function nextQueuedJob(
  db: Db,
  runnerLabels: string[] = [],
): Promise<(JobRow & { repo: string; sha: string }) | null> {
  // NOTE: SELECT * relies on the jobs columns existing — ensureSchema /
  // migrations guarantee name/definition/result on every database.
  const res = await db
    .prepare(
      `SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE j.status = 'queued' ORDER BY j.created_at ASC LIMIT 50`,
    )
    .bind()
    .all<JobRow & { repo: string; sha: string }>();
  return res.results.find((j) => labelsMatch(j.labels ?? "", runnerLabels)) ?? null;
}

export async function updateJob(
  db: Db,
  id: string,
  patch: { status?: string; log?: string; result?: string },
): Promise<void> {
  const current = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!current) return;
  const status = patch.status ?? current.status;
  const log = patch.log ?? current.log;
  const result = patch.result ?? current.result;
  const now = nowIso();
  const startedAt = status === "running" && !current.started_at ? now : current.started_at;
  const finishedAt = isTerminal(status) && !current.finished_at ? now : current.finished_at;
  await db
    .prepare("UPDATE jobs SET status = ?, log = ?, result = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?")
    .bind(status, log, result, startedAt, finishedAt, now, id)
    .run();
}

// Scheduler-side transition (blocked -> queued/skipped, group cancels).
export async function setJobStatus(db: Db, id: string, status: string): Promise<void> {
  const current = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!current) return;
  const now = nowIso();
  const finishedAt = isTerminal(status) && !current.finished_at ? now : current.finished_at;
  await db
    .prepare("UPDATE jobs SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?")
    .bind(status, finishedAt, now, id)
    .run();
}

// Reset a job for re-run: history is cleared so the retry reads clean.
export async function rerunJob(db: Db, jobId: string): Promise<(JobRow & { repo: string; sha: string }) | null> {
  const job = await db
    .prepare("SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.id = ?")
    .bind(jobId)
    .first<JobRow & { repo: string; sha: string }>();
  if (!job) return null;
  if (job.status === "queued" || job.status === "running" || job.status === "blocked") return job;
  await db
    .prepare(
      "UPDATE jobs SET status = 'queued', log = '', result = '', triage = '', started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(nowIso(), jobId)
    .run();
  return { ...job, status: "queued" };
}

// Cancel queued/running/blocked jobs in a concurrency group, scoped to
// one repo and excluding the run that is fanning out now.
export async function cancelGroupJobs(db: Db, repo: string, group: string, excludeRunId: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT j.* FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE r.repo = ? AND j.status IN ('queued', 'running', 'blocked') AND r.id != ?`,
    )
    .bind(repo, excludeRunId)
    .all<JobRow>();
  const cancelled: string[] = [];
  for (const job of res.results) {
    if (readJobSpec(job.definition, job.name).group !== group) continue;
    await setJobStatus(db, job.id, "cancelled");
    await rollupRunStatus(db, job.run_id);
    cancelled.push(job.id);
  }
  return cancelled;
}

export async function hasActiveGroupJob(db: Db, repo: string, group: string): Promise<boolean> {
  const res = await db
    .prepare(
      `SELECT j.definition, j.name FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE r.repo = ? AND j.status IN ('queued', 'running')`,
    )
    .bind(repo)
    .all<{ definition: string; name: string }>();
  return res.results.some((j) => readJobSpec(j.definition, j.name).group === group);
}

export async function listBlockedJobsInRepo(db: Db, repo: string): Promise<(JobRow & { repo: string; sha: string })[]> {
  const res = await db
    .prepare(
      `SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE r.repo = ? AND j.status = 'blocked' ORDER BY j.created_at ASC`,
    )
    .bind(repo)
    .all<JobRow & { repo: string; sha: string }>();
  return res.results;
}

export interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

export interface TokenPublic {
  id: string;
  name: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

export async function createToken(
  db: Db,
  token: { id: string; name: string; tokenHash: string; scopes: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO api_tokens (id, name, token_hash, scopes, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .bind(token.id, token.name, token.tokenHash, token.scopes, nowIso())
    .run();
}

export async function listTokens(db: Db): Promise<TokenPublic[]> {
  const res = await db
    .prepare("SELECT id, name, scopes, created_at, revoked_at FROM api_tokens ORDER BY created_at DESC")
    .bind()
    .all<TokenPublic>();
  return res.results;
}

export async function findLiveToken(db: Db, tokenHash: string): Promise<TokenRow | null> {
  return db
    .prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(tokenHash)
    .first<TokenRow>();
}

export async function revokeToken(db: Db, id: string): Promise<boolean> {
  const current = await db.prepare("SELECT id FROM api_tokens WHERE id = ?").bind(id).first<{ id: string }>();
  if (!current) return false;
  await db
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(nowIso(), id)
    .run();
  return true;
}

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, value, nowIso())
    .run();
}

export async function audit(db: Db, actor: string, action: string, target = ""): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (id, actor, action, target, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actor, action, target, nowIso())
    .run();
}

export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  created_at: string;
}

export async function listAudit(db: Db, limit = 100): Promise<AuditRow[]> {
  const res = await db
    .prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<AuditRow>();
  return res.results;
}

export interface FlakyRow {
  job: string;
  runs: number;
  failures: number;
  rate: number;
}

// Per-job failure rates over the trailing window, worst first. Only
// terminal jobs count; matrix cells roll up under their base name.
export async function flakyStats(db: Db, repo: string, days: number): Promise<FlakyRow[]> {
  const clamped = Math.min(365, Math.max(1, Math.floor(days) || 30));
  const cutoff = new Date(Date.now() - clamped * 86400 * 1000).toISOString();
  const res = await db
    .prepare(
      `SELECT j.name, j.definition, j.status FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE r.repo = ? AND j.created_at > ?`,
    )
    .bind(repo, cutoff)
    .all<{ name: string; definition: string; status: string }>();
  const byJob = new Map<string, { runs: number; failures: number }>();
  for (const row of res.results) {
    if (!isTerminal(row.status)) continue;
    const base = readJobSpec(row.definition, row.name).base;
    const entry = byJob.get(base) ?? { runs: 0, failures: 0 };
    entry.runs += 1;
    if (FAILED_STATUSES.includes(row.status)) entry.failures += 1;
    byJob.set(base, entry);
  }
  return [...byJob.entries()]
    .map(([job, s]) => ({ job, runs: s.runs, failures: s.failures, rate: s.failures / s.runs }))
    .sort((a, b) => b.rate - a.rate || b.runs - a.runs);
}

export async function latestRunStatus(db: Db, repo: string, branch?: string): Promise<string | null> {
  const row = branch
    ? await db
        .prepare("SELECT status FROM runs WHERE repo = ? AND branch = ? ORDER BY created_at DESC LIMIT 1")
        .bind(repo, branch)
        .first<{ status: string }>()
    : await db
        .prepare("SELECT status FROM runs WHERE repo = ? ORDER BY created_at DESC LIMIT 1")
        .bind(repo)
        .first<{ status: string }>();
  return row?.status ?? null;
}
