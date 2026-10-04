import { getJobsForRun, getRun, isTerminal, type Db, type JobRow, type RunRow } from "./db";

// Blocking wait: the agent-native answer to poll loops. Holds the
// request server-side until the run reaches a terminal status or the
// budget runs out, so a client (MCP tool, CLI, script) gets the result
// in one call instead of sleeping between polls.
//
// Awaiting timers costs no CPU in Workers; each poll is one D1 read.
// Timeout is clamped to 90s — beyond that, clients should re-call
// (the run payload includes `timedOut` so they know to).

export interface WaitResult {
  run: RunRow;
  jobs: JobRow[];
  timedOut: boolean;
  waitedMs: number;
}

export async function waitForRunTerminal(
  db: Db,
  runId: string,
  opts?: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<WaitResult | null> {
  const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 30000, 0), 90000);
  const pollMs = Math.max(opts?.pollMs ?? 1000, 1);
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  let run = await getRun(db, runId);
  if (!run) return null;
  while (!isTerminal(run.status) && Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const next = await getRun(db, runId);
    if (!next) return null;
    run = next;
  }
  const jobs = await getJobsForRun(db, runId);
  return { run, jobs, timedOut: !isTerminal(run.status), waitedMs: Date.now() - started };
}
