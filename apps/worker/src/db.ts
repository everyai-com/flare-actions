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

// Atomic claim: exactly one executor (runner or seat) wins a job. The
// conditional UPDATE plus the changed-row check close the read-then-act
// race between concurrent pollers.
export async function claimJob(db: Db, id: string): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'")
    .bind(nowIso(), nowIso(), id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

// Append one line to a job's log without touching its status.
// Seats mirror progress here so a crash or release never leaves a
// blank log: the row always shows how far execution got.
export async function appendJobLog(db: Db, id: string, text: string): Promise<void> {
  await db
    .prepare("UPDATE jobs SET log = COALESCE(log, '') || ?, updated_at = ? WHERE id = ?")
    .bind(text, nowIso(), id)
    .run();
}

// Release a job back to the queue (seat fallback: something this
// executor can't do — a BYO runner may still take it). True when the
// job was actually running (a concurrent finish wins the race).
export async function releaseJob(db: Db, id: string): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE jobs SET status = 'queued', started_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(nowIso(), id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

// Executor heartbeat: proves a running job still has a live executor.
export async function touchJob(db: Db, id: string): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE jobs SET updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(nowIso(), id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

export interface StaleJobRow {
  id: string;
  run_id: string;
  name: string;
  repo: string;
  sha: string;
}

// Jobs claimed running but quiet past the cutoff: no heartbeat, no
// progress log, no status. Bounded per pass.
export async function listStaleRunningJobs(db: Db, cutoffIso: string, limit = 50): Promise<StaleJobRow[]> {
  const res = await db
    .prepare(
      `SELECT j.id, j.run_id, j.name, r.repo, r.sha FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE j.status = 'running' AND j.updated_at < ? ORDER BY j.updated_at ASC LIMIT ?`,
    )
    .bind(cutoffIso, limit)
    .all<StaleJobRow>();
  return res.results;
}

// Poll-and-claim loop: walk matching queued jobs oldest-first until one
// claim wins or candidates run out.
export async function claimNextJob(
  db: Db,
  runnerLabels: string[] = [],
): Promise<(JobRow & { repo: string; sha: string }) | null> {
  const res = await db
    .prepare(
      `SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE j.status = 'queued' ORDER BY j.created_at ASC LIMIT 10`,
    )
    .bind()
    .all<JobRow & { repo: string; sha: string }>();
  for (const job of res.results) {
    if (!labelsMatch(job.labels ?? "", runnerLabels)) continue;
    if (await claimJob(db, job.id)) return { ...job, status: "running" };
  }
  return null;
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

export interface SessionRow {
  id: string;
  // The login: a GitHub username or an email address depending on kind.
  github_user: string;
  kind: string;
  is_admin: number;
  created_at: string;
  expires_at: string;
}

export async function createSession(
  db: Db,
  session: { id: string; githubUser: string; kind?: string; isAdmin: boolean; expiresAt: string },
): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, github_user, kind, is_admin, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(session.id, session.githubUser, session.kind ?? "github", session.isAdmin ? 1 : 0, nowIso(), session.expiresAt)
    .run();
}

export async function getSession(db: Db, id: string): Promise<SessionRow | null> {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function deleteUserSessions(db: Db, kind: string, login: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE kind = ? AND github_user = ?").bind(kind, login).run();
}

export interface UserRow {
  email: string;
  password_hash: string;
  is_admin: number;
  created_at: string;
}

export async function createUser(db: Db, user: { email: string; passwordHash: string; isAdmin: boolean }): Promise<void> {
  await db
    .prepare("INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.email, user.passwordHash, user.isAdmin ? 1 : 0, nowIso())
    .run();
}

export async function getUser(db: Db, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export async function deleteUser(db: Db, email: string): Promise<void> {
  await db.prepare("DELETE FROM users WHERE email = ?").bind(email).run();
}

export async function listUsers(db: Db): Promise<UserRow[]> {
  const res = await db.prepare("SELECT * FROM users ORDER BY created_at ASC").bind().all<UserRow>();
  return res.results;
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

export interface RepoSecretRow {
  repo: string;
  name: string;
  iv: string;
  ciphertext: string;
  updated_at: string;
}

export async function setRepoSecret(
  db: Db,
  repo: string,
  name: string,
  iv: string,
  ciphertext: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO repo_secrets (repo, name, iv, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo, name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
    )
    .bind(repo, name, iv, ciphertext, nowIso())
    .run();
}

export async function deleteRepoSecret(db: Db, repo: string, name: string): Promise<boolean> {
  const res = (await db
    .prepare("DELETE FROM repo_secrets WHERE repo = ? AND name = ?")
    .bind(repo, name)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

// Most recent App installation seen for a repo (dispatch uses it to
// resolve branches on private repos the App can read).
export async function latestInstallationId(db: Db, repo: string): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT installation_id FROM runs WHERE repo = ? AND installation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(repo)
    .first<{ installation_id: number | null }>();
  return row?.installation_id ?? null;
}

export async function listRepoSecretNames(db: Db, repo: string): Promise<string[]> {
  const res = await db
    .prepare("SELECT name FROM repo_secrets WHERE repo = ? ORDER BY name ASC")
    .bind(repo)
    .all<{ name: string }>();
  return res.results.map((r) => r.name);
}

export async function getRepoSecretRows(db: Db, repo: string): Promise<RepoSecretRow[]> {
  const res = await db
    .prepare("SELECT repo, name, iv, ciphertext, updated_at FROM repo_secrets WHERE repo = ?")
    .bind(repo)
    .all<RepoSecretRow>();
  return res.results;
}

// Retention janitor: drop runs (and their jobs — D1 does not enforce
// ON DELETE CASCADE without PRAGMA foreign_keys) older than maxAgeDays.
// Bounded per pass so a huge backlog never blows a request budget.
export async function pruneOldRuns(db: Db, maxAgeDays = 90, limit = 500): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  const stale = await db
    .prepare("SELECT id FROM runs WHERE created_at < ? AND status IN ('success','failure','error','cancelled','skipped') ORDER BY created_at ASC LIMIT ?")
    .bind(cutoff, limit)
    .all<{ id: string }>();
  for (const row of stale.results) {
    await db.prepare("DELETE FROM jobs WHERE run_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM runs WHERE id = ?").bind(row.id).run();
  }
  return stale.results.length;
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
