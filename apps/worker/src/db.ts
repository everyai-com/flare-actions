import { readJobSpec } from "./pipeline";

export interface RunRow {
  id: string;
  repo: string;
  sha: string;
  event: string;
  installation_id: number | null;
  branch: string;
  source: string | null;
  pr_number: number | null;
  pr_comment_id: number | null;
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
  priority: number;
  attempts: number;
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
  run: {
    id: string;
    repo: string;
    sha: string;
    event: string;
    installationId: number | null;
    branch?: string;
    source?: string | null;
    prNumber?: number | null;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO runs (id, repo, sha, event, installation_id, branch, source, pr_number, pr_comment_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', ?, ?)",
    )
    .bind(
      run.id,
      run.repo,
      run.sha,
      run.event,
      run.installationId,
      run.branch ?? "",
      run.source ?? null,
      run.prNumber ?? null,
      now,
      now,
    )
    .run();
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

export async function listRuns(db: Db, limit = 50, offset = 0): Promise<RunRow[]> {
  const res = await db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
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
  opts?: { name?: string; definition?: string; labels?: string; status?: string; priority?: number },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO jobs (id, run_id, status, log, name, definition, result, labels, priority, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, '', ?, ?, ?, ?)",
    )
    .bind(
      id,
      runId,
      opts?.status ?? "queued",
      opts?.name ?? "",
      opts?.definition ?? "",
      opts?.labels ?? "",
      opts?.priority ?? 0,
      now,
      now,
    )
    .run();
}

export async function getJob(db: Db, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export type JobWithRun = JobRow & { repo: string; sha: string };

export async function getJobWithRun(db: Db, id: string): Promise<JobWithRun | null> {
  return db
    .prepare("SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.id = ?")
    .bind(id)
    .first<JobWithRun>();
}

// Retry accounting: attempts counts retries already used.
export async function bumpJobAttempt(db: Db, id: string): Promise<void> {
  await db.prepare("UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
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

const ADMIN_CLAIM_KEY = "admin_claim";

// One winner, ever. Admin claimers (email bootstrap, first GitHub
// login) race across two kinds; each does a read-then-write that two
// concurrent first requests can both pass. This marker insert is the
// single atomic gate: exactly one caller ever gets true.
export async function claimAdminMarker(db: Db): Promise<boolean> {
  const res = (await db
    .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO NOTHING")
    .bind(ADMIN_CLAIM_KEY, nowIso())
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

// Roll back a won claim whose account write failed, so a transient
// error cannot brick a fresh deploy into an unclaimable state.
export async function releaseAdminMarker(db: Db): Promise<void> {
  await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(ADMIN_CLAIM_KEY).run();
}

export async function isAdminMarkerClaimed(db: Db): Promise<boolean> {
  const row = await db.prepare("SELECT key FROM app_settings WHERE key = ?").bind(ADMIN_CLAIM_KEY).first<{ key: string }>();
  return row !== null;
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

const CLAIM_PAGE_SIZE = 25;
// Bounded per poll: enough to look past a backlog of label-mismatched
// jobs without letting one poll walk an unbounded queue.
const CLAIM_MAX_SCAN = 200;

// Webhook idempotency: GitHub retries (and manual redeliveries) carry the
// same X-GitHub-Delivery UUID. First claim wins; a duplicate is a no-op.
export async function claimWebhookDelivery(db: Db, id: string): Promise<boolean> {
  const res = (await db
    .prepare("INSERT INTO webhook_deliveries (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(id, nowIso())
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

export async function pruneWebhookDeliveries(db: Db, maxAgeHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
  const res = (await db.prepare("DELETE FROM webhook_deliveries WHERE created_at < ?").bind(cutoff).run()) as {
    meta?: { changes?: number };
  };
  return res?.meta?.changes ?? 0;
}

// One PR comment per run, updated in place as the run progresses.
export async function setRunPrComment(db: Db, runId: string, commentId: number): Promise<void> {
  await db.prepare("UPDATE runs SET pr_comment_id = ? WHERE id = ?").bind(commentId, runId).run();
}

export type JobWithSource = JobRow & { repo: string; sha: string; source: string | null };

// Poll-and-claim loop: walk matching queued jobs highest-priority-first
// (then oldest-first) until one claim wins or the scan budget runs out.
// Keyset pagination on (priority, created_at, id) instead of OFFSET:
// concurrent claims above the cursor cannot cause a job to be skipped,
// and a fixed window (the old LIMIT 10) could starve every runner
// behind jobs only other labels can take. Priority lets an agent's
// verify loop jump ahead of batch work.
export async function claimNextJob(
  db: Db,
  runnerLabels: string[] = [],
): Promise<JobWithSource | null> {
  let afterPriority = 0;
  let afterCreated: string | null = null;
  let afterId = "";
  let scanned = 0;
  while (scanned < CLAIM_MAX_SCAN) {
    const res: { results: JobWithSource[] } =
      afterCreated === null
        ? await db
            .prepare(
              `SELECT j.*, r.repo, r.sha, r.source FROM jobs j JOIN runs r ON r.id = j.run_id
               WHERE j.status = 'queued' ORDER BY j.priority DESC, j.created_at ASC, j.id ASC LIMIT ?`,
            )
            .bind(CLAIM_PAGE_SIZE)
            .all<JobWithSource>()
        : await db
            .prepare(
              `SELECT j.*, r.repo, r.sha, r.source FROM jobs j JOIN runs r ON r.id = j.run_id
               WHERE j.status = 'queued' AND (j.priority < ? OR (j.priority = ? AND (j.created_at > ? OR (j.created_at = ? AND j.id > ?))))
               ORDER BY j.priority DESC, j.created_at ASC, j.id ASC LIMIT ?`,
            )
            .bind(afterPriority, afterPriority, afterCreated, afterCreated, afterId, CLAIM_PAGE_SIZE)
            .all<JobWithSource>();
    if (res.results.length === 0) return null;
    for (const job of res.results) {
      if (!labelsMatch(job.labels ?? "", runnerLabels)) continue;
      if (await claimJob(db, job.id)) return { ...job, status: "running" };
    }
    const last = res.results[res.results.length - 1];
    afterPriority = last.priority ?? 0;
    afterCreated = last.created_at;
    afterId = last.id;
    scanned += res.results.length;
  }
  return null;
}

// Executor status report. The conditional UPDATE requires the row to
// still be `running`, so a late report from an execution superseded by
// a re-run or a stale requeue cannot flip the new queued row terminal
// (the re-run would otherwise silently lose its result). Returns false
// when the report was dropped.
export async function updateRunningJob(
  db: Db,
  id: string,
  patch: { status: string; log?: string; result?: string },
): Promise<boolean> {
  const now = nowIso();
  const finishedAt = isTerminal(patch.status) ? now : null;
  const res = (await db
    .prepare(
      `UPDATE jobs SET status = ?, log = COALESCE(?, log), result = COALESCE(?, result),
         finished_at = COALESCE(finished_at, ?), updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(patch.status, patch.log ?? null, patch.result ?? null, finishedAt, now, id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
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
      "UPDATE jobs SET status = 'queued', log = '', result = '', triage = '', attempts = 0, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
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
// Job ids and source ids come back so the caller can delete the matching
// R2 artifacts and source tarballs.
export async function pruneOldRuns(
  db: Db,
  maxAgeDays = 90,
  limit = 500,
): Promise<{ runs: number; jobIds: string[]; sources: string[] }> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  const stale = await db
    .prepare("SELECT id, source FROM runs WHERE created_at < ? AND status IN ('success','failure','error','cancelled','skipped') ORDER BY created_at ASC LIMIT ?")
    .bind(cutoff, limit)
    .all<{ id: string; source: string | null }>();
  const jobIds: string[] = [];
  const sources: string[] = [];
  for (const row of stale.results) {
    const jobs = await db
      .prepare("SELECT id FROM jobs WHERE run_id = ?")
      .bind(row.id)
      .all<{ id: string }>();
    for (const job of jobs.results) jobIds.push(job.id);
    if (row.source) sources.push(row.source);
    await db.prepare("DELETE FROM jobs WHERE run_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM runs WHERE id = ?").bind(row.id).run();
  }
  return { runs: stale.results.length, jobIds, sources };
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

export interface ScheduleRow {
  id: string;
  repo: string;
  ref: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

export async function createSchedule(db: Db, s: { id: string; repo: string; ref: string; cron: string }): Promise<void> {
  await db
    .prepare("INSERT INTO schedules (id, repo, ref, cron, enabled, last_run_at, created_at) VALUES (?, ?, ?, ?, 1, NULL, ?)")
    .bind(s.id, s.repo, s.ref, s.cron, nowIso())
    .run();
}

export async function listSchedules(db: Db): Promise<ScheduleRow[]> {
  const res = await db.prepare("SELECT * FROM schedules ORDER BY created_at ASC").bind().all<ScheduleRow>();
  return res.results;
}

export async function deleteSchedule(db: Db, id: string): Promise<boolean> {
  const res = (await db.prepare("DELETE FROM schedules WHERE id = ?").bind(id).run()) as {
    meta?: { changes?: number };
  };
  return (res?.meta?.changes ?? 0) > 0;
}

export async function setScheduleEnabled(db: Db, id: string, enabled: boolean): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE schedules SET enabled = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

// Stamped after every dispatch attempt (success or failure) so a broken
// schedule cannot hot-loop every cron tick.
export async function touchScheduleRun(db: Db, id: string): Promise<void> {
  await db.prepare("UPDATE schedules SET last_run_at = ? WHERE id = ?").bind(nowIso(), id).run();
}
