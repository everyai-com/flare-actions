// CI analytics: best-effort datapoints to Workers Analytics Engine.
// Emission is fire-and-forget (the binding buffers client-side) and
// guarded: forks without the dataset binding skip silently, and a
// throwing binding never fails a request.
//
// Event schema v1 (append-only — new fields go in higher slots, the
// documented queries in docs/ANALYTICS.md depend on these positions):
//   index1: event ("run.dispatched" | "run.terminal" | "job.terminal")
//   blob1: repo (owner/name)
//   blob2: run_id
//   blob3: job name (job.terminal) else ""
//   blob4: status (terminal events) else ""
//   blob5: trigger event (run events: push, dispatch, schedule, ...) else ""
//   blob6: executor ("runner" | "seat", job.terminal) else ""
//   double1: job count (run.dispatched) | duration ms (terminal events)
//   double2: job count (run.terminal) | attempts used (job.terminal)
//
// Delivery is at-least-once: a redelivered terminal transition emits
// twice. Durations derive from stamped row timestamps (stable across
// duplicates), and run-level queries dedupe by run_id (see docs).

export const ANALYTICS_EVENT_DISPATCHED = "run.dispatched";
export const ANALYTICS_EVENT_RUN_TERMINAL = "run.terminal";
export const ANALYTICS_EVENT_JOB_TERMINAL = "job.terminal";
// Runner mode (`runs-on: flare`): GitHub orchestrates, Flare supplies an
// ephemeral JIT runner. A separate event (not job.terminal) so runner-mode
// minutes never pollute Flare-orchestrated job stats. Same blob layout as
// job.terminal; blob6 is always "github-jit".
export const ANALYTICS_EVENT_GHA_JOB = "gha.job.completed";

function blob(value: string): string {
  return value.slice(0, 200);
}

function num(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function emit(
  ds: AnalyticsEngineDataset | undefined,
  event: string,
  blobs: string[],
  doubles: number[],
): void {
  if (!ds) return;
  try {
    ds.writeDataPoint({ indexes: [event], blobs, doubles });
  } catch {
    // Analytics must never break CI.
  }
}

export function emitRunDispatched(
  ds: AnalyticsEngineDataset | undefined,
  e: { repo: string; runId: string; event: string; jobCount: number },
): void {
  emit(ds, ANALYTICS_EVENT_DISPATCHED, [blob(e.repo), blob(e.runId), "", "", blob(e.event), ""], [num(e.jobCount), 0]);
}

export function emitRunTerminal(
  ds: AnalyticsEngineDataset | undefined,
  e: { repo: string; runId: string; event: string; status: string; durationMs: number; jobCount: number },
): void {
  emit(
    ds,
    ANALYTICS_EVENT_RUN_TERMINAL,
    [blob(e.repo), blob(e.runId), "", blob(e.status), blob(e.event), ""],
    [num(e.durationMs), num(e.jobCount)],
  );
}

export function emitGhaJobCompleted(
  ds: AnalyticsEngineDataset | undefined,
  e: { repo: string; runId: string; jobName: string; conclusion: string; durationMs: number; attempts: number },
): void {
  emit(
    ds,
    ANALYTICS_EVENT_GHA_JOB,
    [blob(e.repo), blob(e.runId), blob(e.jobName), blob(e.conclusion), "", "github-jit"],
    [num(e.durationMs), num(e.attempts)],
  );
}

export function emitJobTerminal(
  ds: AnalyticsEngineDataset | undefined,
  e: { repo: string; runId: string; jobName: string; status: string; durationMs: number; executor: string; attempts: number },
): void {
  emit(
    ds,
    ANALYTICS_EVENT_JOB_TERMINAL,
    [blob(e.repo), blob(e.runId), blob(e.jobName), blob(e.status), "", blob(e.executor)],
    [num(e.durationMs), num(e.attempts)],
  );
}

// Run wall time from stamped job timestamps (stable: finished_at is
// stamped once via COALESCE, so redelivered rollups agree). Jobs that
// never started carry no signal and are skipped; 0 when nothing ran.
export function runDurationMs(jobs: { started_at: string | null; finished_at: string | null }[]): number {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const job of jobs) {
    if (!job.started_at || !job.finished_at) continue;
    const s = Date.parse(job.started_at);
    const f = Date.parse(job.finished_at);
    if (!Number.isFinite(s) || !Number.isFinite(f) || f < s) continue;
    if (s < start) start = s;
    if (f > end) end = f;
  }
  if (start === Number.POSITIVE_INFINITY || end === 0) return 0;
  return Math.max(0, end - start);
}
