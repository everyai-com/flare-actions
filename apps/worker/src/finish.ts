import {
  FAILED_STATUSES,
  getJobsForRun,
  hasActiveGroupJob,
  listBlockedJobsInRepo,
  rollupRunStatus,
  setJobStatus,
  setJobTriage,
  type Db,
} from "./db";
import { getInstallationToken, mintAppJwt, postCommitStatus } from "./github";
import { readJobSpec } from "./pipeline";
import { runTriage, type AiBinding, type TriageStep } from "./triage";

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
  run: { repo: string; sha: string },
  jobId: string,
  jobName: string,
  logText: string | undefined,
  result: string | undefined,
): Promise<void> {
  try {
    // Forks without the AI binding simply skip triage.
    if (!ai) return;
    const text = await runTriage(ai, {
      repo: run.repo,
      sha: run.sha,
      jobName,
      steps: parseReportedSteps(result),
      logTail: (logText ?? "").slice(-4000),
    });
    if (!text) return;
    await setJobTriage(db, jobId, text);
  } catch (err) {
    // Triage must never fail a status update.
    console.log(JSON.stringify({ level: "warn", msg: "triage failed", error: String(err) }));
  }
}

// After any terminal transition: unblock needs-satisfied jobs (oldest
// first so concurrency groups serialize), skip jobs whose needs failed.
// onQueued fires for every newly queued job (seat wake-up hook).
export async function promoteBlockedJobs(
  db: Db,
  queue: QueueSender,
  repo: string,
  onQueued?: (job: { runId: string; jobId: string }) => unknown,
): Promise<string[]> {
  const blocked = await listBlockedJobsInRepo(db, repo);
  const promoted: string[] = [];
  const runJobsCache = new Map<string, { base: string; status: string }[]>();
  for (const job of blocked) {
    const spec = readJobSpec(job.definition, job.name);
    if (spec.needs.length > 0) {
      let siblings = runJobsCache.get(job.run_id);
      if (!siblings) {
        const rows = await getJobsForRun(db, job.run_id);
        siblings = rows.map((r) => ({ base: readJobSpec(r.definition, r.name).base, status: r.status }));
        runJobsCache.set(job.run_id, siblings);
      }
      const byBase = new Map<string, string[]>();
      for (const s of siblings) byBase.set(s.base, [...(byBase.get(s.base) ?? []), s.status]);
      if (spec.needs.some((n) => (byBase.get(n) ?? []).some((st) => FAILED_STATUSES.includes(st)))) {
        await setJobStatus(db, job.id, "skipped");
        await rollupRunStatus(db, job.run_id);
        runJobsCache.delete(job.run_id);
        continue;
      }
      const satisfied = spec.needs.every((n) => {
        const statuses = byBase.get(n) ?? [];
        return statuses.length > 0 && statuses.every((st) => st === "success");
      });
      if (!satisfied) continue;
    }
    if (spec.group && (await hasActiveGroupJob(db, repo, spec.group))) continue;
    await setJobStatus(db, job.id, "queued");
    await rollupRunStatus(db, job.run_id);
    await queue.send({ runId: job.run_id, jobId: job.id, repo: job.repo, sha: job.sha });
    await onQueued?.({ runId: job.run_id, jobId: job.id });
    promoted.push(job.id);
  }
  return promoted;
}
