// Cost attribution: compute minutes consumed per run plus what the same
// minutes would cost at GitHub Actions list price, so the 10x gap is a
// number on every run instead of a marketing claim.

// GitHub Team plan, Linux, list price at the time of writing.
export const ACTIONS_LIST_USD_PER_MIN = 0.008;

export interface CostJobInput {
  status: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobDuration {
  durationMs: number | null;
}

export function jobDurationMs(job: CostJobInput): number | null {
  if (!job.started_at || !job.finished_at) return null;
  const ms = Date.parse(job.finished_at) - Date.parse(job.started_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms;
}

export interface RunCostSummary {
  jobs: number;
  finishedJobs: number;
  durationMs: number;
  computeMinutes: number;
  actionsListUsd: number;
}

export function summarizeRunCost(jobs: CostJobInput[]): RunCostSummary {
  let durationMs = 0;
  let finishedJobs = 0;
  for (const job of jobs) {
    const d = jobDurationMs(job);
    if (d !== null) {
      durationMs += d;
      finishedJobs += 1;
    }
  }
  const computeMinutes = durationMs / 60000;
  return {
    jobs: jobs.length,
    finishedJobs,
    durationMs,
    computeMinutes: Math.round(computeMinutes * 1000) / 1000,
    actionsListUsd: Math.round(computeMinutes * ACTIONS_LIST_USD_PER_MIN * 10000) / 10000,
  };
}
