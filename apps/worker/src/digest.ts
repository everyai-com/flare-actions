import { getJobsForRun, getRun, getRunEgress, type Db } from "./db";
import { jobDurationMs } from "./cost";

// Token-efficient run digest for agents: failures first-class, bounded
// output tails, no full logs. This is the payload an agent should feed
// back into its context loop — typically 1-3 KB instead of megabytes.

export interface DigestStep {
  command: string;
  exitCode: number;
  durationMs: number;
  outputTail: string;
}

export interface DigestJob {
  id: string;
  name: string;
  status: string;
  durationMs: number | null;
  stepCount: number;
  failing?: DigestStep;
  triage?: string;
  // Retain-on-failure: the failed seat container is still alive for
  // debugging until this deadline (absent when not retained).
  retainedUntil?: string;
}

export interface DigestEgress {
  reqBytes: number;
  respBytes: number;
  // Top hosts by download bytes (bounded); r2:<area> rows are measured
  // seat transfers, (interface) is the container NIC delta.
  topHosts: { host: string; reqBytes: number; respBytes: number }[];
}

export interface RunDigest {
  runId: string;
  repo: string;
  sha: string;
  branch: string;
  event: string;
  status: string;
  durationMs: number | null;
  totalJobs: number;
  failedJobs: number;
  jobs: DigestJob[];
  egress?: DigestEgress;
}

const FAILED_STATUSES = ["failure", "error", "cancelled"];

export function parseDigestSteps(result: string): DigestStep[] {
  try {
    const parsed = JSON.parse(result) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps)) return [];
    const out: DigestStep[] = [];
    for (const s of parsed.steps) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      if (typeof rec.command !== "string" || typeof rec.exitCode !== "number") continue;
      out.push({
        command: rec.command.slice(0, 300),
        exitCode: rec.exitCode,
        durationMs: typeof rec.durationMs === "number" ? rec.durationMs : 0,
        outputTail: typeof rec.output === "string" ? rec.output.slice(-500) : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function buildRunDigest(db: Db, runId: string): Promise<RunDigest | null> {
  const run = await getRun(db, runId);
  if (!run) return null;
  const jobs = await getJobsForRun(db, runId);
  const digestJobs: DigestJob[] = jobs.map((j) => {
    const steps = parseDigestSteps(j.result);
    const failing = steps.find((s) => s.exitCode !== 0);
    const job: DigestJob = {
      id: j.id,
      name: j.name,
      status: j.status,
      durationMs: jobDurationMs(j),
      stepCount: steps.length,
    };
    if (failing) job.failing = failing;
    if (j.triage) job.triage = j.triage.slice(0, 800);
    if (j.retained_until) job.retainedUntil = j.retained_until;
    return job;
  });
  const egressRows = await getRunEgress(db, runId);
  const egress: DigestEgress | undefined =
    egressRows.length > 0
      ? {
          reqBytes: egressRows.reduce((n, r) => n + r.req_bytes, 0),
          respBytes: egressRows.reduce((n, r) => n + r.resp_bytes, 0),
          topHosts: egressRows.slice(0, 10).map((r) => ({ host: r.host, reqBytes: r.req_bytes, respBytes: r.resp_bytes })),
        }
      : undefined;
  const a = Date.parse(run.created_at);
  const b = Date.parse(run.updated_at);
  const durationMs = Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
  return {
    runId: run.id,
    repo: run.repo,
    sha: run.sha,
    branch: run.branch,
    event: run.event,
    status: run.status,
    durationMs,
    totalJobs: digestJobs.length,
    failedJobs: digestJobs.filter((j) => FAILED_STATUSES.includes(j.status)).length,
    jobs: digestJobs,
    ...(egress ? { egress } : {}),
  };
}
