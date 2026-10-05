// CI analytics, cold path: the same lifecycle events as analytics.ts
// (Analytics Engine = hot metrics) also stream to a Basin Pipeline
// stream when the operator binds one, landing as Apache Iceberg rows
// in R2 for long-term retention and Basin SQL.
//
// Basin is a paid-plan product, so the binding is never committed:
// forks without a `CI_EVENTS` stream binding skip silently, exactly
// like a missing Analytics Engine dataset. Emission rides
// ctx.waitUntil (Pipeline.send is a promise, unlike AE's sync
// buffer), so every emitter takes a BasinSink built at a site that
// has a waitUntil in scope.
//
// Event schema v1 (append-only — new fields are added, never
// renamed; docs/ANALYTICS.md shows the Basin SQL queries):
//   v, event, repo, run_id, job, status, trigger, executor,
//   duration_ms, count, attempts, ts (ISO timestamp)

import type { Pipeline, PipelineRecord } from "cloudflare:pipelines";

export interface CiEvent extends PipelineRecord {
  v: 1;
  event: string;
  repo: string;
  run_id: string;
  job: string;
  status: string;
  trigger: string;
  executor: string;
  duration_ms: number;
  count: number;
  attempts: number;
  ts: string;
}

export interface BasinSink {
  stream: Pipeline<CiEvent> | undefined;
  waitUntil: (promise: Promise<unknown>) => void;
}

// The binding is operator-provisioned (see docs/ANALYTICS.md), so it
// is read defensively off env instead of the generated Env type:
// absent = no Basin account, skip without failing the request.
export function basinSink(
  env: unknown,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
): BasinSink | undefined {
  const stream = (env as { CI_EVENTS?: Pipeline<CiEvent> }).CI_EVENTS;
  if (!stream) return undefined;
  return { stream, waitUntil: (p) => ctx.waitUntil(p) };
}

function base(
  event: string,
  e: { repo: string; runId: string },
): CiEvent {
  return {
    v: 1,
    event,
    repo: e.repo.slice(0, 200),
    run_id: e.runId,
    job: "",
    status: "",
    trigger: "",
    executor: "",
    duration_ms: 0,
    count: 0,
    attempts: 0,
    ts: new Date().toISOString(),
  };
}

export function basinRunDispatched(e: { repo: string; runId: string; event: string; jobCount: number }): CiEvent {
  const rec = base("run.dispatched", e);
  rec.trigger = e.event.slice(0, 50);
  rec.count = e.jobCount;
  return rec;
}

export function basinRunTerminal(e: {
  repo: string;
  runId: string;
  event: string;
  status: string;
  durationMs: number;
  jobCount: number;
}): CiEvent {
  const rec = base("run.terminal", e);
  rec.trigger = e.event.slice(0, 50);
  rec.status = e.status;
  rec.duration_ms = Math.max(0, Math.round(e.durationMs));
  rec.count = e.jobCount;
  return rec;
}

export function basinJobTerminal(e: {
  repo: string;
  runId: string;
  jobName: string;
  status: string;
  durationMs: number;
  executor: string;
  attempts: number;
}): CiEvent {
  const rec = base("job.terminal", e);
  rec.job = e.jobName.slice(0, 200);
  rec.status = e.status;
  rec.executor = e.executor.slice(0, 20);
  rec.duration_ms = Math.max(0, Math.round(e.durationMs));
  rec.attempts = e.attempts;
  return rec;
}

// Best-effort send: never throws, never rejects, no-ops without a
// bound stream. Delivery is at-least-once (same as AE); Basin SQL
// queries dedupe terminal events by run_id (see docs).
export function sendBasin(sink: BasinSink | undefined, event: CiEvent): void {
  if (!sink?.stream) return;
  try {
    sink.waitUntil(sink.stream.send([event]).then(
      () => undefined,
      () => undefined,
    ));
  } catch {
    // Analytics must never break CI.
  }
}
