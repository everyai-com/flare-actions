// Hourly per-job-name runtime priors. Each finished job folds its
// duration into an exponential moving average keyed by
// (repo, name, UTC hour); fan-out stamps the lookup onto the job row
// as prior_ms, and claims order longest-predicted-first within a
// priority (LPT: minimizes wide-fan-out tail latency). Unknown jobs
// stamp 0 and keep today's oldest-first order among themselves.
import type { Db } from "./db";

const PRIOR_EMA_ALPHA = 0.25;
const PRIOR_MAX_SAMPLE_MS = 24 * 3600 * 1000;

export function priorHour(atIso: string): number {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return new Date().getUTCHours();
  return new Date(t).getUTCHours();
}

export async function recordRuntimePrior(
  db: Db,
  input: { repo: string; name: string; finishedAt: string; durationMs: number },
): Promise<void> {
  if (!input.repo || !input.name) return;
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > PRIOR_MAX_SAMPLE_MS) return;
  const hour = priorHour(input.finishedAt);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO job_runtime_priors (repo, name, hour, samples, avg_ms, updated_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(repo, name, hour) DO UPDATE SET
         samples = samples + 1,
         avg_ms = CAST(avg_ms * (1.0 - ?) + excluded.avg_ms * ? AS INTEGER),
         updated_at = excluded.updated_at`,
    )
    .bind(input.repo, input.name, hour, Math.round(input.durationMs), now, PRIOR_EMA_ALPHA, PRIOR_EMA_ALPHA)
    .run();
}

// Hour-bucket first, repo+name fallback across hours (most samples
// wins), 0 when never seen.
export async function lookupPriorMs(db: Db, repo: string, name: string, atIso?: string): Promise<number> {
  if (!repo || !name) return 0;
  const row = await db
    .prepare(
      `SELECT avg_ms FROM job_runtime_priors WHERE repo = ? AND name = ?
       ORDER BY CASE WHEN hour = ? THEN 0 ELSE 1 END, samples DESC LIMIT 1`,
    )
    .bind(repo, name, priorHour(atIso ?? new Date().toISOString()))
    .first<{ avg_ms: number }>();
  return row && Number.isFinite(row.avg_ms) && row.avg_ms > 0 ? Math.floor(row.avg_ms) : 0;
}
