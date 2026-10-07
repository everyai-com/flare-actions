import { emitRunTerminal, runDurationMs } from "./analytics";
import { basinRunTerminal, sendBasin, type BasinSink } from "./basin";
import { readJobSpec } from "./pipeline";
import { ACTIONS_LIST_USD_PER_MIN } from "./cost";
import { labelsMatch, splitLabels } from "./fairness";
import { deleteJobLogIndex } from "./search";

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
  heal_branch: string | null;
  heal_pr_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface HealClaimRow {
  run_id: string;
  job_id: string;
  status: string;
  branch: string | null;
  pr_url: string | null;
  created_at: string;
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
  retained_until: string | null;
  prior_ms: number;
  created_at: string;
  updated_at: string;
}

// Retain-on-failure: a failed seat kept alive for debugging records its
// destroy deadline on the job row (NULL clears). Discovery for the
// dashboard, digest, and CLI; the seat DO alarm enforces the deadline.
export async function markJobRetained(db: Db, id: string, untilIso: string | null): Promise<void> {
  await db.prepare("UPDATE jobs SET retained_until = ?, updated_at = ? WHERE id = ?").bind(untilIso, nowIso(), id).run();
}

export interface SeatSnapshotRow {
  image: string;
  repo: string;
  snapshot_id: string;
  job_id: string;
  created_at: string;
  last_used_at: string;
}

export async function getSeatSnapshot(db: Db, image: string, repo: string): Promise<SeatSnapshotRow | null> {
  return db
    .prepare("SELECT * FROM seat_snapshots WHERE image = ? AND repo = ?")
    .bind(image, repo)
    .first<SeatSnapshotRow>();
}

export async function saveSeatSnapshot(
  db: Db,
  input: { image: string; repo: string; snapshotId: string; jobId: string },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO seat_snapshots (image, repo, snapshot_id, job_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(image, repo) DO UPDATE SET snapshot_id = excluded.snapshot_id, job_id = excluded.job_id, created_at = excluded.created_at, last_used_at = excluded.last_used_at",
    )
    .bind(input.image, input.repo, input.snapshotId, input.jobId, now, now)
    .run();
}

export async function touchSeatSnapshot(db: Db, image: string, repo: string): Promise<void> {
  await db.prepare("UPDATE seat_snapshots SET last_used_at = ? WHERE image = ? AND repo = ?").bind(nowIso(), image, repo).run();
}

export async function deleteSeatSnapshot(db: Db, image: string, repo: string): Promise<void> {
  await db.prepare("DELETE FROM seat_snapshots WHERE image = ? AND repo = ?").bind(image, repo).run();
}

// Snapshots idle past the platform 30-day TTL are already gone server-side;
// prune their rows so boots never chase ghosts. Bounded per pass.
export async function pruneSeatSnapshots(db: Db, beforeIso: string, limit = 200): Promise<number> {
  const res = (await db
    .prepare("DELETE FROM seat_snapshots WHERE last_used_at < ? LIMIT ?")
    .bind(beforeIso, limit)
    .run()) as { meta?: { changes?: number } };
  return res?.meta?.changes ?? 0;
}

export interface EgressRow {
  job_id: string;
  run_id: string;
  host: string;
  req_bytes: number;
  resp_bytes: number;
}

// One row per (job, host); a re-recorded job replaces its rows. Hosts are
// capped so a chatty sandbox cannot blow D1's bound-parameter budget.
export const MAX_EGRESS_HOSTS = 100;

export async function saveJobEgress(
  db: Db,
  jobId: string,
  runId: string,
  rows: { host: string; reqBytes: number; respBytes: number }[],
): Promise<void> {
  await db.prepare("DELETE FROM job_egress WHERE job_id = ?").bind(jobId).run();
  const capped = rows.slice(0, MAX_EGRESS_HOSTS);
  for (let i = 0; i < capped.length; i += 10) {
    const chunk = capped.slice(i, i + 10);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const binds: (string | number)[] = [];
    for (const r of chunk) binds.push(jobId, runId, r.host.slice(0, 255), Math.floor(r.reqBytes), Math.floor(r.respBytes));
    await db.prepare(`INSERT INTO job_egress (job_id, run_id, host, req_bytes, resp_bytes) VALUES ${placeholders}`).bind(...binds).run();
  }
}

export async function getRunEgress(db: Db, runId: string): Promise<EgressRow[]> {
  const res = await db
    .prepare("SELECT * FROM job_egress WHERE run_id = ? ORDER BY resp_bytes DESC LIMIT 500")
    .bind(runId)
    .all<EgressRow>();
  return res.results;
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

export { labelsMatch, splitLabels };

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

export async function listRuns(
  db: Db,
  limit = 50,
  offset = 0,
  allowedRepos: string[] = [],
): Promise<RunRow[]> {
  const filter = allowedRepos.length > 0 ? ` WHERE repo IN (${allowedRepos.map(() => "?").join(", ")})` : "";
  const res = await db
    .prepare(`SELECT * FROM runs${filter} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...allowedRepos, limit, offset)
    .all<RunRow>();
  return res.results;
}

export async function updateRunStatus(db: Db, id: string, status: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), id)
    .run();
}

// Self-heal bookkeeping (see heal.ts). The claim is the dedupe: one
// row per run, claimed atomically, so concurrent failure callbacks
// cannot open duplicate heal PRs.
export async function claimHealAttempt(db: Db, runId: string, jobId: string): Promise<boolean> {
  const res = (await db
    .prepare("INSERT OR IGNORE INTO heal_claims (run_id, job_id, status, created_at) VALUES (?, ?, 'pending', ?)")
    .bind(runId, jobId, nowIso())
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

export async function listPendingHealClaims(db: Db, limit = 2): Promise<HealClaimRow[]> {
  const res = await db
    .prepare("SELECT * FROM heal_claims WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
    .bind(limit)
    .all<HealClaimRow>();
  return res.results;
}

export async function setHealClaimResult(
  db: Db,
  runId: string,
  status: "done" | "failed" | "skipped",
  branch?: string,
  prUrl?: string,
): Promise<void> {
  await db
    .prepare("UPDATE heal_claims SET status = ?, branch = ?, pr_url = ? WHERE run_id = ?")
    .bind(status, branch ?? null, prUrl ?? null, runId)
    .run();
}

export async function setRunHeal(db: Db, runId: string, branch: string, prUrl: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET heal_branch = ?, heal_pr_url = ?, updated_at = ? WHERE id = ?")
    .bind(branch, prUrl, nowIso(), runId)
    .run();
}

// Recompute a run's status from its jobs: running wins, then queued /
// blocked, then failure, then success; all-skipped/cancelled rolls up
// to cancelled so re-runs and fan-out settle correctly.
export async function rollupRunStatus(
  db: Db,
  runId: string,
  analytics?: AnalyticsEngineDataset,
  basin?: BasinSink,
): Promise<string> {
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
  // At-least-once run.terminal event (queries dedupe by run_id): only
  // terminal rollups pay the extra read, and only when bound. The
  // Basin copy rides the same read so the hot and cold paths agree.
  if ((analytics || basin) && isTerminal(status)) {
    const run = await getRun(db, runId).catch(() => null);
    if (run) {
      if (analytics) {
        emitRunTerminal(analytics, {
          repo: run.repo,
          runId,
          event: run.event,
          status,
          durationMs: runDurationMs(jobs),
          jobCount: jobs.length,
        });
      }
      if (basin) {
        sendBasin(basin, basinRunTerminal({
          repo: run.repo,
          runId,
          event: run.event,
          status,
          durationMs: runDurationMs(jobs),
          jobCount: jobs.length,
        }));
      }
    }
  }
  return status;
}

export async function createJob(
  db: Db,
  id: string,
  runId: string,
  opts?: { name?: string; definition?: string; labels?: string; status?: string; priority?: number; priorMs?: number },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO jobs (id, run_id, status, log, name, definition, result, labels, priority, prior_ms, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, '', ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      runId,
      opts?.status ?? "queued",
      opts?.name ?? "",
      opts?.definition ?? "",
      opts?.labels ?? "",
      opts?.priority ?? 0,
      opts?.priorMs ?? 0,
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

export type JobWithSource = JobRow & { repo: string; sha: string; source: string | null; branch: string | null };

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
  allowedRepos: string[] = [],
  opts: { fairSharePerRepo?: number } = {},
): Promise<JobWithSource | null> {
  // Artifacts runs execute seats-only (BYO runners check out from GitHub
  // and cannot reach Artifacts remotes), so both scans below exclude
  // event 'artifacts' in SQL. Seats claim their woken jobs by id.
  const noArtifacts = `AND r.event != 'artifacts'`;
  // Repo-scoped tokens only claim jobs from their repos (empty = all).
  const repoFilter = allowedRepos.length > 0 ? ` AND r.repo IN (${allowedRepos.map(() => "?").join(", ")})` : "";
  // Fair share: skip repos already at their running cap so one tenant's
  // burst cannot starve the shared poll pool. Best-effort snapshot —
  // concurrent claims can still overrun by a job, which is fine.
  const cap = opts.fairSharePerRepo ?? 0;
  const runningByRepo = new Map<string, number>();
  if (cap > 0) {
    const counts = await db
      .prepare("SELECT r.repo AS repo, COUNT(*) AS c FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.status = 'running' GROUP BY r.repo")
      .bind()
      .all<{ repo: string; c: number }>();
    for (const row of counts.results) runningByRepo.set(row.repo, row.c);
  }
  let afterPriority = 0;
  let afterPriorMs = 0;
  let afterCreated: string | null = null;
  let afterId = "";
  let scanned = 0;
  while (scanned < CLAIM_MAX_SCAN) {
    const res: { results: JobWithSource[] } =
      afterCreated === null
        ? await db
            .prepare(
              `SELECT j.*, r.repo, r.sha, r.source, r.branch FROM jobs j JOIN runs r ON r.id = j.run_id
               WHERE j.status = 'queued'${repoFilter} ${noArtifacts} ORDER BY j.priority DESC, j.prior_ms DESC, j.created_at ASC, j.id ASC LIMIT ?`,
            )
            .bind(...allowedRepos, CLAIM_PAGE_SIZE)
            .all<JobWithSource>()
        : await db
            .prepare(
              `SELECT j.*, r.repo, r.sha, r.source, r.branch FROM jobs j JOIN runs r ON r.id = j.run_id
               WHERE j.status = 'queued'${repoFilter} ${noArtifacts} AND (j.priority < ? OR (j.priority = ? AND (j.prior_ms < ? OR (j.prior_ms = ? AND (j.created_at > ? OR (j.created_at = ? AND j.id > ?))))))
               ORDER BY j.priority DESC, j.prior_ms DESC, j.created_at ASC, j.id ASC LIMIT ?`,
            )
            .bind(...allowedRepos, afterPriority, afterPriority, afterPriorMs, afterPriorMs, afterCreated, afterCreated, afterId, CLAIM_PAGE_SIZE)
            .all<JobWithSource>();
    if (res.results.length === 0) return null;
    for (const job of res.results) {
      if (!labelsMatch(job.labels ?? "", runnerLabels)) continue;
      if (cap > 0 && (runningByRepo.get(job.repo) ?? 0) >= cap) continue;
      if (await claimJob(db, job.id)) return { ...job, status: "running" };
    }
    const last = res.results[res.results.length - 1];
    afterPriority = last.priority ?? 0;
    afterPriorMs = last.prior_ms ?? 0;
    afterCreated = last.created_at;
    afterId = last.id;
    scanned += res.results.length;
  }
  return null;
}

export interface QueuedJobRow {
  id: string;
  run_id: string;
  name: string;
  priority: number;
  prior_ms: number;
  labels: string;
  created_at: string;
  repo: string;
}

// The live queue in claim order (priority, longest-predicted, oldest).
// Powers the admin queue view and the fairness simulator's input.
export async function listQueuedJobs(db: Db, limit = 200): Promise<QueuedJobRow[]> {
  const res = await db
    .prepare(
      `SELECT j.id, j.run_id, j.name, j.priority, j.prior_ms, j.labels, j.created_at, r.repo FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE j.status = 'queued' ORDER BY j.priority DESC, j.prior_ms DESC, j.created_at ASC, j.id ASC LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<QueuedJobRow>();
  return res.results;
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
  // The retry re-indexes on completion; drop the stale slice now so a
  // search during the re-run doesn't surface the previous attempt.
  await deleteJobLogIndex(db, jobId);
  return { ...job, status: "queued" };
}

// Cancel queued/running/blocked jobs in a concurrency group, scoped to
// one repo and excluding the run that is fanning out now.
export async function cancelGroupJobs(
  db: Db,
  repo: string,
  group: string,
  excludeRunId: string,
  analytics?: AnalyticsEngineDataset,
  basin?: BasinSink,
): Promise<string[]> {
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
    await rollupRunStatus(db, job.run_id, analytics, basin);
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
  repos: string;
  created_at: string;
  revoked_at: string | null;
}

export interface TokenPublic {
  id: string;
  name: string;
  scopes: string;
  repos: string;
  created_at: string;
  revoked_at: string | null;
}

export async function createToken(
  db: Db,
  token: { id: string; name: string; tokenHash: string; scopes: string; repos: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO api_tokens (id, name, token_hash, scopes, repos, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(token.id, token.name, token.tokenHash, token.scopes, token.repos, nowIso())
    .run();
}

export async function listTokens(db: Db): Promise<TokenPublic[]> {
  const res = await db
    .prepare("SELECT id, name, scopes, repos, created_at, revoked_at FROM api_tokens ORDER BY created_at DESC")
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

export async function setUserPassword(db: Db, email: string, passwordHash: string): Promise<boolean> {
  const res = (await db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").bind(passwordHash, email).run()) as {
    meta?: { changes?: number };
  };
  return (res?.meta?.changes ?? 0) > 0;
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
    await db.prepare("DELETE FROM test_results WHERE run_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM test_reports WHERE run_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM job_egress WHERE run_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM log_fts WHERE run_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM jobs WHERE run_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM runs WHERE id = ?").bind(row.id).run();
  }
  return { runs: stale.results.length, jobIds, sources };
}

// Explicit run cancellation: stop everything not yet executing. Running
// jobs have no interrupt channel and finish naturally (their reports
// still apply); queued/blocked jobs are cancelled and roll up.
export async function cancelQueuedJobs(db: Db, runId: string): Promise<number> {
  const now = nowIso();
  const res = (await db
    .prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'blocked')")
    .bind(now, now, runId)
    .run()) as { meta?: { changes?: number } };
  return res?.meta?.changes ?? 0;
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

export interface MonitorRow {
  id: string;
  name: string;
  repo: string;
  branch: string;
  job: string;
  trigger: string;
  result: string;
  consecutive: number;
  duration_seconds: number;
  log_pattern: string;
  webhook_url: string;
  enabled: number;
  muted_until: string | null;
  streak: number;
  last_fired_at: string | null;
  created_at: string;
}

export interface MonitorInput {
  id: string;
  name: string;
  repo: string;
  branch: string;
  job: string;
  trigger: string;
  result: string;
  consecutive: number;
  durationSeconds: number;
  logPattern: string;
  webhookUrl: string;
}

export async function createMonitor(db: Db, m: MonitorInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO monitors (id, name, repo, branch, job, trigger, result, consecutive, duration_seconds,
        log_pattern, webhook_url, enabled, muted_until, streak, last_fired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, NULL, ?)`,
    )
    .bind(
      m.id,
      m.name,
      m.repo,
      m.branch,
      m.job,
      m.trigger,
      m.result,
      m.consecutive,
      m.durationSeconds,
      m.logPattern,
      m.webhookUrl,
      nowIso(),
    )
    .run();
}

export async function listMonitors(db: Db): Promise<MonitorRow[]> {
  const res = await db.prepare("SELECT * FROM monitors ORDER BY created_at ASC").bind().all<MonitorRow>();
  return res.results;
}

export async function getMonitor(db: Db, id: string): Promise<MonitorRow | null> {
  return db.prepare("SELECT * FROM monitors WHERE id = ?").bind(id).first<MonitorRow>();
}

export async function deleteMonitor(db: Db, id: string): Promise<boolean> {
  await db.prepare("DELETE FROM monitor_fires WHERE monitor_id = ?").bind(id).run();
  const res = (await db.prepare("DELETE FROM monitors WHERE id = ?").bind(id).run()) as {
    meta?: { changes?: number };
  };
  return (res?.meta?.changes ?? 0) > 0;
}

export async function setMonitorEnabled(db: Db, id: string, enabled: boolean): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE monitors SET enabled = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

export async function setMonitorMutedUntil(db: Db, id: string, mutedUntil: string | null): Promise<boolean> {
  const res = (await db.prepare("UPDATE monitors SET muted_until = ? WHERE id = ?").bind(mutedUntil, id).run()) as {
    meta?: { changes?: number };
  };
  return (res?.meta?.changes ?? 0) > 0;
}

export async function setMonitorStreak(db: Db, id: string, streak: number): Promise<void> {
  await db.prepare("UPDATE monitors SET streak = ? WHERE id = ?").bind(streak, id).run();
}

// Stamped on every fire so dashboards can show recency; the streak
// resets separately so one streak pages exactly once.
export async function touchMonitorFired(db: Db, id: string): Promise<void> {
  await db.prepare("UPDATE monitors SET last_fired_at = ?, streak = 0 WHERE id = ?").bind(nowIso(), id).run();
}

export async function hasMonitorFired(db: Db, monitorId: string, jobId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT monitor_id FROM monitor_fires WHERE monitor_id = ? AND job_id = ?")
    .bind(monitorId, jobId)
    .first<{ monitor_id: string }>();
  return row !== null;
}

export async function recordMonitorFire(db: Db, monitorId: string, jobId: string): Promise<void> {
  await db
    .prepare("INSERT INTO monitor_fires (monitor_id, job_id, fired_at) VALUES (?, ?, ?) ON CONFLICT(monitor_id, job_id) DO NOTHING")
    .bind(monitorId, jobId, nowIso())
    .run();
}

export async function pruneMonitorFires(db: Db, maxAgeDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  const res = (await db.prepare("DELETE FROM monitor_fires WHERE fired_at < ?").bind(cutoff).run()) as {
    meta?: { changes?: number };
  };
  return res?.meta?.changes ?? 0;
}

export interface RunningJobRow {
  id: string;
  run_id: string;
  name: string;
  repo: string;
  branch: string;
  started_at: string | null;
}

export interface TestReportRow {
  job_id: string;
  run_id: string;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  total: number;
  duration_ms: number;
  truncated: number;
  created_at: string;
}

export interface TestCaseInput {
  suite: string;
  name: string;
  classname: string;
  status: string;
  durationMs: number | null;
  message: string;
}

// Re-upload replaces: one summary row per job, cases deleted first so
// a shrinking suite leaves no ghosts. Chunked multi-row inserts keep
// each statement under D1's bound-parameter limit.
export async function saveTestReport(
  db: Db,
  input: {
    jobId: string;
    runId: string;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
    total: number;
    durationMs: number;
    truncated: boolean;
    cases: TestCaseInput[];
  },
): Promise<void> {
  await db.prepare("DELETE FROM test_results WHERE job_id = ?").bind(input.jobId).run();
  await db
    .prepare(
      `INSERT INTO test_reports (job_id, run_id, passed, failed, errors, skipped, total, duration_ms, truncated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET run_id = excluded.run_id, passed = excluded.passed,
       failed = excluded.failed, errors = excluded.errors, skipped = excluded.skipped, total = excluded.total,
       duration_ms = excluded.duration_ms, truncated = excluded.truncated, created_at = excluded.created_at`,
    )
    .bind(
      input.jobId,
      input.runId,
      input.passed,
      input.failed,
      input.errors,
      input.skipped,
      input.total,
      input.durationMs,
      input.truncated ? 1 : 0,
      nowIso(),
    )
    .run();
  const cols = "(job_id, run_id, suite, name, classname, status, duration_ms, message)";
  for (let i = 0; i < input.cases.length; i += 10) {
    const chunk = input.cases.slice(i, i + 10);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values: (string | number | null)[] = [];
    for (const c of chunk) {
      values.push(input.jobId, input.runId, c.suite, c.name, c.classname, c.status, c.durationMs, c.message);
    }
    await db.prepare(`INSERT INTO test_results ${cols} VALUES ${placeholders}`).bind(...values).run();
  }
}

export interface RunTestJobSummary extends TestReportRow {
  job_name: string;
}

export async function getRunTestJobs(db: Db, runId: string): Promise<RunTestJobSummary[]> {
  const res = await db
    .prepare(
      `SELECT r.job_id, r.run_id, r.passed, r.failed, r.errors, r.skipped, r.total, r.duration_ms,
       r.truncated, r.created_at, j.name AS job_name
       FROM test_reports r JOIN jobs j ON j.id = r.job_id WHERE r.run_id = ? ORDER BY j.name ASC`,
    )
    .bind(runId)
    .all<RunTestJobSummary>();
  return res.results;
}

export interface FailingTestRow {
  job_id: string;
  job_name: string;
  suite: string;
  name: string;
  classname: string;
  status: string;
  message: string;
}

export async function listFailingTests(db: Db, runId: string, limit = 50): Promise<FailingTestRow[]> {
  const res = await db
    .prepare(
      `SELECT t.job_id, j.name AS job_name, t.suite, t.name, t.classname, t.status, t.message
       FROM test_results t JOIN jobs j ON j.id = t.job_id
       WHERE t.run_id = ? AND t.status IN ('failed', 'error') ORDER BY t.id ASC LIMIT ?`,
    )
    .bind(runId, Math.max(1, Math.min(limit, 200)))
    .all<FailingTestRow>();
  return res.results;
}

export async function deleteJobTestData(db: Db, jobId: string): Promise<void> {
  await db.prepare("DELETE FROM test_results WHERE job_id = ?").bind(jobId).run();
  await db.prepare("DELETE FROM test_reports WHERE job_id = ?").bind(jobId).run();
}

export interface UsageStats {
  days: number;
  runs: number;
  runsByStatus: Record<string, number>;
  jobs: number;
  computeMinutes: number;
  actionsListUsd: number;
  topRepos: { repo: string; jobs: number; computeMinutes: number }[];
}

// Billing-workflow aggregation: run/job counts plus finished-job
// compute minutes over a trailing window, token-scoped like listRuns.
export async function usageStats(db: Db, days: number, allowedRepos: string[] = []): Promise<UsageStats> {
  const cutoff = new Date(Date.now() - Math.max(1, Math.min(days, 365)) * 86400000).toISOString();
  const filter = allowedRepos.length > 0 ? ` AND repo IN (${allowedRepos.map(() => "?").join(", ")})` : "";
  const runRows = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM runs WHERE created_at >= ?${filter} GROUP BY status`)
    .bind(cutoff, ...allowedRepos)
    .all<{ status: string; n: number }>();
  const runsByStatus: Record<string, number> = {};
  let runs = 0;
  for (const r of runRows.results) {
    runsByStatus[r.status] = r.n;
    runs += r.n;
  }
  const jobFilter = allowedRepos.length > 0 ? ` AND r.repo IN (${allowedRepos.map(() => "?").join(", ")})` : "";
  const jobRows = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(strftime('%s', j.finished_at) - strftime('%s', j.started_at)), 0) AS secs
       FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE r.created_at >= ? AND j.finished_at IS NOT NULL AND j.started_at IS NOT NULL${jobFilter}`,
    )
    .bind(cutoff, ...allowedRepos)
    .first<{ n: number; secs: number }>();
  const jobs = jobRows?.n ?? 0;
  const computeMinutes = Math.round(((jobRows?.secs ?? 0) / 60) * 1000) / 1000;
  const topRows = await db
    .prepare(
      `SELECT r.repo AS repo, COUNT(*) AS n, COALESCE(SUM(strftime('%s', j.finished_at) - strftime('%s', j.started_at)), 0) AS secs
       FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE r.created_at >= ? AND j.finished_at IS NOT NULL AND j.started_at IS NOT NULL${jobFilter}
       GROUP BY r.repo ORDER BY secs DESC LIMIT 10`,
    )
    .bind(cutoff, ...allowedRepos)
    .all<{ repo: string; n: number; secs: number }>();
  return {
    days,
    runs,
    runsByStatus,
    jobs,
    computeMinutes,
    actionsListUsd: Math.round(computeMinutes * ACTIONS_LIST_USD_PER_MIN * 10000) / 10000,
    topRepos: topRows.results.map((r) => ({ repo: r.repo, jobs: r.n, computeMinutes: Math.round((r.secs / 60) * 1000) / 1000 })),
  };
}

// Duration-monitor candidates: running jobs in one repo whose clock
// started before the cutoff. Bounded per pass.
export async function listLongRunningJobs(db: Db, repo: string, cutoffIso: string, limit = 50): Promise<RunningJobRow[]> {
  const res = await db
    .prepare(
      `SELECT j.id, j.run_id, j.name, r.repo, r.branch, j.started_at FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE r.repo = ? AND j.status = 'running' AND j.started_at IS NOT NULL AND j.started_at < ?
       ORDER BY j.started_at ASC LIMIT ?`,
    )
    .bind(repo, cutoffIso, limit)
    .all<RunningJobRow>();
  return res.results;
}
