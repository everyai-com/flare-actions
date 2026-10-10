import {
  appendJobLog,
  buildNeedsContext,
  bumpJobAttempt,
  FAILED_STATUSES,
  getJobsForRun,
  getJobWithRun,
  getSetting,
  hasActiveGroupJob,
  isTerminal,
  listBlockedJobsInRepo,
  listStaleRunningJobs,
  releaseJob,
  rollupRunStatus,
  setJobStatus,
  setJobTriage,
  type Db,
} from "./db";
import { getInstallationToken, mintAppJwt, postCommitStatus } from "./github";
import { readJobSpec, readRetryPolicy } from "./pipeline";
import { jobConditionSatisfied } from "../../../packages/runner-sdk/src/conditions";
import { runTriage, type AiBinding, type TriageStep } from "./triage";
import { SETTING_KEYS } from "./settings";
import type { BasinSink } from "./basin";
import { buildErrorQuery, formatSearchContext, webSearch } from "./websearch";

// Shared post-execution flow for both executors (BYO runners via the
// main worker, managed seats via the seats worker): promote unblocked
// jobs, report commit statuses, store AI triage.

export interface QueueSender {
  send(msg: { runId: string; jobId: string; repo: string; sha: string }, opts?: { delaySeconds?: number }): Promise<unknown>;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

export async function reportGitHubStatus(opts: {
  appId?: string;
  privateKey?: string;
  installationId: number | null;
  repo: string;
  sha: string;
  state: "pending" | "success" | "failure" | "error";
}): Promise<void> {
  try {
    if (!opts.installationId || !opts.appId || !opts.privateKey) {
      log("info", "github status skipped: app credentials not configured");
      return;
    }
    const jwt = await mintAppJwt(opts.appId, opts.privateKey);
    const token = await getInstallationToken(jwt, opts.installationId);
    if (!token) {
      log("warn", "github installation token mint failed");
      return;
    }
    const ok = await postCommitStatus(token, opts.repo, opts.sha, opts.state);
    log("info", "github status posted", { ok, repo: opts.repo, sha: opts.sha, state: opts.state });
  } catch (err) {
    log("error", "github status failed", { error: String(err) });
  }
}

export function parseReportedSteps(result: unknown): TriageStep[] {
  if (typeof result !== "string" || !result) return [];
  try {
    const parsed = JSON.parse(result) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps)) return [];
    const out: TriageStep[] = [];
    for (const s of parsed.steps) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      if (typeof rec.command !== "string" || typeof rec.exitCode !== "number") continue;
      out.push({
        command: rec.command.slice(0, 500),
        exitCode: rec.exitCode,
        output: typeof rec.output === "string" ? rec.output : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function triageAndStore(
  db: Db,
  ai: AiBinding | undefined,
  run: { id: string; repo: string; sha: string },
  jobId: string,
  jobName: string,
  logText: string | undefined,
  result: string | undefined,
  opts: { gatewayId?: string; webSearch?: boolean; model?: string } = {},
): Promise<void> {
  try {
    // Forks without the AI binding simply skip triage.
    if (!ai) return;
    // Env-provided gateway id wins; D1 fills the gap; unset = direct.
    const gatewayId = opts.gatewayId ?? (await getSetting(db, SETTING_KEYS.aiGatewayId)) ?? undefined;
    const model = opts.model ?? (await getSetting(db, SETTING_KEYS.triageModel)) ?? undefined;
    const triageInput = {
      runId: run.id,
      jobId,
      repo: run.repo,
      sha: run.sha,
      jobName,
      steps: parseReportedSteps(result),
      logTail: (logText ?? "").slice(-4000),
    };
    // Grounding is opt-in (search calls bill gateway credits) and needs a
    // gateway; anything missing degrades to ungrounded triage.
    let searchContext: string | undefined;
    const webSearchOn = opts.webSearch ?? ((await getSetting(db, SETTING_KEYS.triageWebSearch)) === "1");
    if (webSearchOn && gatewayId) {
      const query = buildErrorQuery(triageInput);
      if (query) {
        const items = await webSearch(ai, gatewayId, query);
        if (items.length > 0) searchContext = formatSearchContext(items);
      }
    }
    const text = await runTriage(ai, triageInput, { gatewayId, searchContext, model });
    if (!text) return;
    await setJobTriage(db, jobId, text);
  } catch (err) {
    // Triage must never fail a status update.
    console.log(JSON.stringify({ level: "warn", msg: "triage failed", error: String(err) }));
  }
}

// Job-level gate lives in the SDK conditions module (shared with the
// local runner); re-exported here for existing importers.
export { jobConditionSatisfied };

// After any terminal transition: unblock needs-satisfied jobs (oldest
// first so concurrency groups serialize), skip jobs whose needs failed
// (unless their job-level `if` says otherwise), honor group capacity.
// onQueued fires for every newly queued job (seat wake-up hook).
export async function promoteBlockedJobs(
  db: Db,
  queue: QueueSender,
  repo: string,
  onQueued?: (job: { runId: string; jobId: string }) => unknown,
  analytics?: AnalyticsEngineDataset,
  basin?: BasinSink,
  cloud?: { hosted: boolean },
): Promise<string[]> {
  const blocked = await listBlockedJobsInRepo(db, repo);
  const promoted: string[] = [];
  const runJobsCache = new Map<string, { base: string; status: string; result: string | null }[]>();
  for (const job of blocked) {
    const spec = readJobSpec(job.definition, job.name);
    if (spec.needs.length > 0) {
      let siblings = runJobsCache.get(job.run_id);
      if (!siblings) {
        const rows = await getJobsForRun(db, job.run_id);
        siblings = rows.map((r) => ({ base: readJobSpec(r.definition, r.name).base, status: r.status, result: r.result ?? null }));
        runJobsCache.set(job.run_id, siblings);
      }
      const byBase = new Map<string, string[]>();
      for (const s of siblings) byBase.set(s.base, [...(byBase.get(s.base) ?? []), s.status]);
      const needsSettled = spec.needs.every((n) => {
        const statuses = byBase.get(n) ?? [];
        return statuses.length > 0 && statuses.every((st) => isTerminal(st));
      });
      if (!needsSettled) continue;
      const anyFailed = spec.needs.some((n) => (byBase.get(n) ?? []).some((st) => FAILED_STATUSES.includes(st)));
      // The same needs context the executor will see (results + outputs
      // for the declared needs); warnings ride the worker log since the
      // job has no log row yet.
      const needsCtx = buildNeedsContext(
        siblings.map((s) => ({ base: s.base, status: s.status, result: s.result })),
        spec.needs,
      );
      for (const w of needsCtx.warnings) log("warn", "needs context", { runId: job.run_id, jobId: job.id, warning: w });
      if (!jobConditionSatisfied(spec.if, anyFailed, needsCtx.needs)) {
        await setJobStatus(db, job.id, "skipped");
        await rollupRunStatus(db, job.run_id, analytics, basin, cloud);
        runJobsCache.delete(job.run_id);
        continue;
      }
    }
    if (spec.group && (await hasActiveGroupJob(db, repo, spec.group))) continue;
    await setJobStatus(db, job.id, "queued");
    await rollupRunStatus(db, job.run_id, analytics, basin, cloud);
    await queue.send({ runId: job.run_id, jobId: job.id, repo: job.repo, sha: job.sha });
    await onQueued?.({ runId: job.run_id, jobId: job.id });
    promoted.push(job.id);
  }
  return promoted;
}

// Stuck-claim sweeper: live executors heartbeat (BYO runners) or mirror
// progress (seats), so a running job quiet longer than staleMinutes has
// a dead executor — release it for another taker. The conditional
// release wins the race against a just-finished executor: no double run.
export async function requeueStaleJobs(
  db: Db,
  queue: QueueSender,
  staleMinutes = 20,
  onQueued?: (job: { runId: string; jobId: string }) => unknown,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - staleMinutes * 60000).toISOString();
  const stale = await listStaleRunningJobs(db, cutoff);
  const requeued: string[] = [];
  for (const job of stale) {
    await appendJobLog(db, job.id, `[flare] requeued: no executor heartbeat for ${staleMinutes}m+\n`);
    if (!(await releaseJob(db, job.id))) continue;
    await rollupRunStatus(db, job.run_id);
    await queue.send({ runId: job.run_id, jobId: job.id, repo: job.repo, sha: job.sha });
    await onQueued?.({ runId: job.run_id, jobId: job.id });
    requeued.push(job.id);
  }
  return requeued;
}

// Per-job retry policy (`retry: N` in flare.yml): while attempts remain,
// a failed job is requeued for another try instead of going terminal —
// flaky suites stop paging humans. The conditional release means a
// concurrent finish always wins; the attempt stamp is bounded by the
// policy so this can never loop forever.
export async function maybeRetryJob(
  db: Db,
  queue: QueueSender,
  jobId: string,
  onQueued?: (job: { runId: string; jobId: string }) => unknown,
): Promise<boolean> {
  const job = await getJobWithRun(db, jobId);
  if (!job) return false;
  const retryMax = readRetryPolicy(job.definition);
  if (retryMax <= 0 || (job.attempts ?? 0) >= retryMax) return false;
  if (!(await releaseJob(db, jobId, { bill: true }))) return false;
  await bumpJobAttempt(db, jobId);
  await appendJobLog(db, jobId, `[flare] retrying after failure (attempt ${(job.attempts ?? 0) + 2}/${retryMax + 1})\n`);
  await rollupRunStatus(db, job.run_id);
  await queue.send({ runId: job.run_id, jobId, repo: job.repo, sha: job.sha });
  await onQueued?.({ runId: job.run_id, jobId });
  return true;
}
