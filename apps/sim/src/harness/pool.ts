// AgentPool logic (pure; the Durable Object in pool-do.ts only persists
// state and sets alarms). One pool drives up to a few hundred synthetic
// agents against the real Forge API in bounded ticks:
//
//   - at most `concurrency` requests in flight (Workers allow 6
//     simultaneous outbound connections per invocation),
//   - at most `maxRequestsPerTick` requests and `tickBudgetMs` wall time
//     per alarm (subrequest + duration limits), then the next alarm,
//   - 429 / Artifacts rate-limit errors back the agent off (Retry-After
//     or exponential with jitter) and are counted, never fatal,
//   - 5xx / network errors retry up to `maxRetries`.
//
// Everything counted here is MEASURED against the target deployment.

import type { ApiErr, ApiResult, ForgeApi, ForgeOp } from "./api.ts";
import { FORGE_OPS } from "./api.ts";
import { redactGitError, type GitPusher } from "./git.ts";
import { rngFor, zipf, type Rng } from "../prng.ts";

export type HarnessMode = "coordination-only" | "full-git";
export const HARNESS_MODES: readonly HarnessMode[] = ["coordination-only", "full-git"];

export interface PoolConfig {
  runId: string;
  poolIndex: number;
  agents: number;
  mode: HarnessMode;
  repo: string;
  seed: number;
  heartbeats: number; // coordination-only: heartbeats per agent
  rampMs: number; // spread agent starts over this window
  concurrency: number; // <= 6
  maxRequestsPerTick: number;
  tickBudgetMs: number;
  maxRetries: number;
  maxRateLimitRetries: number;
  footprintFiles: number; // synthetic path universe (Zipf) for overlaps
}

export const POOL_DEFAULTS = {
  heartbeats: 2,
  rampMs: 60_000,
  concurrency: 6,
  maxRequestsPerTick: 400,
  tickBudgetMs: 20_000,
  maxRetries: 4,
  maxRateLimitRetries: 30,
  footprintFiles: 2_000,
} as const;

type Step = "declare" | "claim" | "git_push" | "push" | "ready" | "whats_happening" | "heartbeat" | "done" | "failed";

export interface AgentState {
  i: number;
  step: Step;
  nextAt: number;
  retries: number;
  rateLimitRetries: number;
  heartbeatsLeft: number;
  intentId: string | null;
  forkRepo: string | null;
  remote: string | null;
  token: string | null; // fork-scoped, 1h TTL; never logged or exported
  sha: string | null;
  error: string | null;
}

// Log-bucket latency histogram: mergeable across pools.
export const HIST_BUCKETS = 64;
const HIST_BASE = 1.25;

export interface Histogram {
  counts: number[];
  n: number;
  sumMs: number;
}

export function emptyHistogram(): Histogram {
  return { counts: Array.from({ length: HIST_BUCKETS }, () => 0), n: 0, sumMs: 0 };
}

export function histBucket(ms: number): number {
  if (ms <= 1) return 0;
  return Math.min(HIST_BUCKETS - 1, Math.ceil(Math.log(ms) / Math.log(HIST_BASE)));
}

export function histRecord(h: Histogram, ms: number): void {
  h.counts[histBucket(ms)]++;
  h.n++;
  h.sumMs += ms;
}

// Upper bound of the bucket holding quantile q (ms); null when empty.
export function histQuantile(h: Histogram, q: number): number | null {
  if (h.n === 0) return null;
  const target = Math.max(1, Math.ceil(q * h.n));
  let acc = 0;
  for (let b = 0; b < h.counts.length; b++) {
    acc += h.counts[b];
    if (acc >= target) return Math.round(Math.pow(HIST_BASE, b));
  }
  return Math.round(Math.pow(HIST_BASE, HIST_BUCKETS - 1));
}

export type OpCounts = Record<ForgeOp, number>;

export interface Counters {
  requests: OpCounts;
  ok: OpCounts;
  errors: OpCounts;
  latency: Record<ForgeOp, Histogram>;
  rateLimited: number;
  retries: number;
  errorCodes: Record<string, number>;
  intentsDeclared: number;
  overlapsReported: number;
  claimed: number;
  gitPushed: number;
  ready: number;
  agentsDone: number;
  agentsFailed: number;
}

function opCounts(): OpCounts {
  return Object.fromEntries(FORGE_OPS.map((o) => [o, 0])) as OpCounts;
}

export function emptyCounters(): Counters {
  return {
    requests: opCounts(),
    ok: opCounts(),
    errors: opCounts(),
    latency: Object.fromEntries(FORGE_OPS.map((o) => [o, emptyHistogram()])) as Record<ForgeOp, Histogram>,
    rateLimited: 0,
    retries: 0,
    errorCodes: {},
    intentsDeclared: 0,
    overlapsReported: 0,
    claimed: 0,
    gitPushed: 0,
    ready: 0,
    agentsDone: 0,
    agentsFailed: 0,
  };
}

export function mergeCounters(into: Counters, from: Counters): Counters {
  for (const o of FORGE_OPS) {
    into.requests[o] += from.requests[o] ?? 0;
    into.ok[o] += from.ok[o] ?? 0;
    into.errors[o] += from.errors[o] ?? 0;
    const a = into.latency[o];
    const b = from.latency[o];
    if (b) {
      for (let i = 0; i < HIST_BUCKETS; i++) a.counts[i] += b.counts[i] ?? 0;
      a.n += b.n;
      a.sumMs += b.sumMs;
    }
  }
  for (const [k, v] of Object.entries(from.errorCodes)) into.errorCodes[k] = (into.errorCodes[k] ?? 0) + v;
  into.rateLimited += from.rateLimited;
  into.retries += from.retries;
  into.intentsDeclared += from.intentsDeclared;
  into.overlapsReported += from.overlapsReported;
  into.claimed += from.claimed;
  into.gitPushed += from.gitPushed;
  into.ready += from.ready;
  into.agentsDone += from.agentsDone;
  into.agentsFailed += from.agentsFailed;
  return into;
}

export interface PoolState {
  config: PoolConfig;
  goalId: string | null;
  goalTried: number;
  agents: AgentState[];
  counters: Counters;
  forks: string[]; // created by this pool's claims (cleanup list)
  startedAt: number;
  firstOkAt: number | null;
  lastOkAt: number | null;
  finishedAt: number | null;
  stopped: boolean;
}

export interface PoolDeps {
  api: ForgeApi;
  git: GitPusher | null;
  now: () => number;
  random: () => number; // jitter
}

export function initPool(config: PoolConfig, now: number): PoolState {
  const agents: AgentState[] = [];
  for (let i = 0; i < config.agents; i++) {
    agents.push({
      i,
      step: "declare",
      nextAt: now + (config.agents > 1 ? Math.floor((config.rampMs * i) / config.agents) : 0),
      retries: 0,
      rateLimitRetries: 0,
      heartbeatsLeft: config.heartbeats,
      intentId: null,
      forkRepo: null,
      remote: null,
      token: null,
      sha: null,
      error: null,
    });
  }
  return {
    config,
    goalId: null,
    goalTried: 0,
    agents,
    counters: emptyCounters(),
    forks: [],
    startedAt: now,
    firstOkAt: null,
    lastOkAt: null,
    finishedAt: null,
    stopped: false,
  };
}

export function agentName(config: PoolConfig, i: number): string {
  return `sim-${config.runId}-p${config.poolIndex}-a${i}`.slice(0, 64);
}

// Deterministic per-agent footprint (1-3 files, Zipf over a synthetic
// tree) so the coordinator sees realistic overlap.
export function agentFootprint(config: PoolConfig, i: number): string[] {
  const rng: Rng = rngFor(config.seed, `fp:${config.poolIndex}:${i}`);
  const z = footprintZipf(config.footprintFiles);
  const n = 1 + Math.floor(rng.next() * 3);
  const out = new Set<string>();
  for (let k = 0; k < n * 4 && out.size < n; k++) {
    const f = z.sample(rng);
    out.add(`sim/m${Math.floor(f / 20)}/f${f % 20}.ts`);
  }
  return [...out].sort();
}

// Isolate-level memo of the Zipf CDF (pure function of n; safe to share).
const zipfMemo = new Map<number, ReturnType<typeof zipf>>();
function footprintZipf(n: number): ReturnType<typeof zipf> {
  let z = zipfMemo.get(n);
  if (!z) {
    z = zipf(n, 0.9);
    zipfMemo.set(n, z);
  }
  return z;
}

function nextStep(config: PoolConfig, a: AgentState): Step {
  switch (a.step) {
    case "declare":
      return config.mode === "full-git" ? "claim" : "whats_happening";
    case "whats_happening":
      return a.heartbeatsLeft > 0 ? "heartbeat" : "done";
    case "heartbeat":
      return a.heartbeatsLeft > 0 ? "heartbeat" : "done";
    case "claim":
      return "git_push";
    case "git_push":
      return "push";
    case "push":
      return "ready";
    default:
      return "done";
  }
}

// Optional steps never fail the agent on a non-retryable error.
const OPTIONAL: ReadonlySet<Step> = new Set<Step>(["whats_happening", "heartbeat"]);

function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(60_000, 1_000 * Math.pow(2, Math.min(attempt, 6)));
  return Math.round(base / 2 + random() * (base / 2));
}

function record(state: PoolState, op: ForgeOp, r: ApiResult<unknown>, now: number): void {
  const c = state.counters;
  c.requests[op]++;
  histRecord(c.latency[op], r.ms);
  if (r.ok) {
    c.ok[op]++;
    if (state.firstOkAt === null) state.firstOkAt = now;
    state.lastOkAt = now;
  } else {
    c.errors[op]++;
    c.errorCodes[r.code] = (c.errorCodes[r.code] ?? 0) + 1;
    if (r.rateLimited) c.rateLimited++;
  }
}

function onError(state: PoolState, a: AgentState, err: ApiErr, deps: PoolDeps): void {
  const now = deps.now();
  if (err.rateLimited) {
    a.rateLimitRetries++;
    state.counters.retries++;
    if (a.rateLimitRetries > state.config.maxRateLimitRetries) return fail(state, a, `rate_limited:${err.code}`);
    a.nextAt = now + (err.retryAfterMs ?? backoffMs(a.rateLimitRetries, deps.random));
    return;
  }
  if (err.retryable && a.retries < state.config.maxRetries) {
    a.retries++;
    state.counters.retries++;
    a.nextAt = now + backoffMs(a.retries, deps.random);
    return;
  }
  if (OPTIONAL.has(a.step)) {
    advance(state, a, now);
    return;
  }
  fail(state, a, err.code);
}

function fail(state: PoolState, a: AgentState, error: string): void {
  a.step = "failed";
  a.error = error.slice(0, 160);
  a.token = null;
  state.counters.agentsFailed++;
}

function advance(state: PoolState, a: AgentState, now: number): void {
  if (a.step === "heartbeat") a.heartbeatsLeft--;
  a.step = nextStep(state.config, a);
  a.retries = 0;
  a.nextAt = now;
  if (a.step === "done") {
    a.token = null;
    state.counters.agentsDone++;
  }
}

async function runStep(state: PoolState, a: AgentState, deps: PoolDeps): Promise<void> {
  const cfg = state.config;
  const agent = agentName(cfg, a.i);
  const fp = agentFootprint(cfg, a.i);
  switch (a.step) {
    case "declare": {
      const r = await deps.api.declareIntent({
        repo: cfg.repo,
        goalId: state.goalId,
        agent,
        title: `sim ${cfg.runId} agent ${cfg.poolIndex}.${a.i}`,
        reasoning: "Synthetic load from the Forge bench harness (apps/sim). Not a real change.",
        accept: "sim: no-op",
        footprint: fp,
      });
      record(state, "declare", r, deps.now());
      if (!r.ok) return onError(state, a, r, deps);
      a.intentId = r.value.id;
      state.counters.intentsDeclared++;
      state.counters.overlapsReported += r.value.overlaps;
      return advance(state, a, deps.now());
    }
    case "whats_happening": {
      const r = await deps.api.whatsHappening({ repo: cfg.repo, paths: fp, agent });
      record(state, "whats_happening", r, deps.now());
      if (!r.ok) return onError(state, a, r, deps);
      return advance(state, a, deps.now());
    }
    case "heartbeat": {
      const r = await deps.api.heartbeat({ id: a.intentId ?? "", agent });
      record(state, "heartbeat", r, deps.now());
      if (!r.ok) return onError(state, a, r, deps);
      return advance(state, a, deps.now());
    }
    case "claim": {
      const r = await deps.api.claimIntent({ id: a.intentId ?? "", agent });
      record(state, "claim", r, deps.now());
      if (!r.ok) return onError(state, a, r, deps);
      a.forkRepo = r.value.forkRepo;
      a.remote = r.value.remote;
      a.token = r.value.token;
      if (!state.forks.includes(r.value.forkRepo)) state.forks.push(r.value.forkRepo);
      state.counters.claimed++;
      return advance(state, a, deps.now());
    }
    case "git_push": {
      if (!deps.git || !a.remote || !a.token) return fail(state, a, "git_unavailable");
      const t0 = deps.now();
      try {
        const out = await deps.git.pushTinyChange({
          remote: a.remote,
          token: a.token,
          agent,
          intentId: a.intentId ?? "",
          goalId: state.goalId,
          path: fp[0],
          content: `// ${agent} ${cfg.runId}\n`,
        });
        record(state, "git_push", { ok: true, status: 200, value: null, ms: deps.now() - t0 }, deps.now());
        a.sha = out.sha;
        state.counters.gitPushed++;
        return advance(state, a, deps.now());
      } catch (err) {
        const msg = redactGitError(err);
        const rateLimited = /rate[\s_-]?limit|429/i.test(msg);
        const e: ApiErr = {
          ok: false,
          status: rateLimited ? 429 : 0,
          code: rateLimited ? "git_rate_limited" : "git_error",
          rateLimited,
          retryable: true,
          retryAfterMs: null,
          ms: deps.now() - t0,
        };
        record(state, "git_push", e, deps.now());
        return onError(state, a, e, deps);
      }
    }
    case "push": {
      const r = await deps.api.reportPush({ id: a.intentId ?? "", agent, sha: a.sha ?? "", files: [fp[0]] });
      record(state, "push", r, deps.now());
      if (!r.ok) return onError(state, a, r, deps);
      return advance(state, a, deps.now());
    }
    case "ready": {
      const r = await deps.api.markReady({ id: a.intentId ?? "", agent });
      record(state, "ready", r, deps.now());
      if (!r.ok) return onError(state, a, r, deps);
      state.counters.ready++;
      return advance(state, a, deps.now());
    }
    default:
      return;
  }
}

function isTerminal(a: AgentState): boolean {
  return a.step === "done" || a.step === "failed";
}

export interface TickResult {
  requests: number;
  nextAlarmAt: number | null; // null = pool finished (or stopped)
}

// One alarm's worth of work. Mutates `state`.
export async function runTick(state: PoolState, deps: PoolDeps): Promise<TickResult> {
  const cfg = state.config;
  const start = deps.now();
  let requests = 0;
  if (state.stopped || state.finishedAt !== null) return { requests, nextAlarmAt: null };
  // One goal per pool, so the dashboard groups each pool's intents.
  if (state.goalId === null && state.goalTried < 3) {
    state.goalTried++;
    const r = await deps.api.createGoal({
      repo: cfg.repo,
      text: `Forge bench ${cfg.runId}, pool ${cfg.poolIndex} (${cfg.mode}, synthetic)`,
      agent: agentName(cfg, 0),
    });
    record(state, "goal", r, deps.now());
    requests++;
    if (r.ok) state.goalId = r.value.id;
    else if (r.rateLimited) return { requests, nextAlarmAt: deps.now() + (r.retryAfterMs ?? backoffMs(state.goalTried, deps.random)) };
  }
  const limit = Math.max(1, Math.min(6, cfg.concurrency));
  while (requests < cfg.maxRequestsPerTick && deps.now() - start < cfg.tickBudgetMs) {
    const now = deps.now();
    const due: AgentState[] = [];
    for (const a of state.agents) {
      if (!isTerminal(a) && a.nextAt <= now) due.push(a);
    }
    if (due.length === 0) break;
    due.sort((x, y) => x.nextAt - y.nextAt || x.i - y.i);
    const batch = due.slice(0, Math.min(limit, cfg.maxRequestsPerTick - requests));
    requests += batch.length;
    await Promise.all(batch.map((a) => runStep(state, a, deps)));
  }
  let next = Infinity;
  for (const a of state.agents) if (!isTerminal(a)) next = Math.min(next, a.nextAt);
  if (next === Infinity) {
    state.finishedAt = deps.now();
    return { requests, nextAlarmAt: null };
  }
  return { requests, nextAlarmAt: Math.max(next, deps.now()) };
}

// What a pool exports (no tokens).
export interface PoolSnapshot {
  runId: string;
  poolIndex: number;
  mode: HarnessMode;
  agents: number;
  done: number;
  failed: number;
  counters: Counters;
  forks: string[];
  startedAt: number;
  firstOkAt: number | null;
  lastOkAt: number | null;
  finishedAt: number | null;
  stopped: boolean;
  sampleErrors: string[];
}

export function snapshot(state: PoolState): PoolSnapshot {
  const errs = new Set<string>();
  for (const a of state.agents) if (a.error && errs.size < 5) errs.add(a.error);
  return {
    runId: state.config.runId,
    poolIndex: state.config.poolIndex,
    mode: state.config.mode,
    agents: state.config.agents,
    done: state.agents.filter((a) => a.step === "done").length,
    failed: state.agents.filter((a) => a.step === "failed").length,
    counters: state.counters,
    forks: state.forks,
    startedAt: state.startedAt,
    firstOkAt: state.firstOkAt,
    lastOkAt: state.lastOkAt,
    finishedAt: state.finishedAt,
    stopped: state.stopped,
    sampleErrors: [...errs],
  };
}

export interface RunSummary {
  runId: string;
  measured: true;
  pools: number;
  agents: number;
  done: number;
  failed: number;
  pending: number;
  forks: number;
  durationMs: number | null;
  intentsDeclared: number;
  intentsPerSec: number | null;
  overlapsReported: number;
  claimed: number;
  gitPushed: number;
  ready: number;
  requests: number;
  rateLimited: number;
  retries: number;
  errorCodes: Record<string, number>;
  ops: Record<ForgeOp, { requests: number; ok: number; errors: number; p50Ms: number | null; p95Ms: number | null; meanMs: number | null }>;
  sampleErrors: string[];
}

export function aggregate(runId: string, snaps: readonly PoolSnapshot[]): RunSummary {
  const c = emptyCounters();
  let agents = 0;
  let done = 0;
  let failed = 0;
  let forks = 0;
  let first: number | null = null;
  let last: number | null = null;
  const errs: string[] = [];
  for (const s of snaps) {
    mergeCounters(c, s.counters);
    agents += s.agents;
    done += s.done;
    failed += s.failed;
    forks += s.forks.length;
    if (s.firstOkAt !== null) first = first === null ? s.firstOkAt : Math.min(first, s.firstOkAt);
    if (s.lastOkAt !== null) last = last === null ? s.lastOkAt : Math.max(last, s.lastOkAt);
    for (const e of s.sampleErrors) if (errs.length < 10 && !errs.includes(e)) errs.push(e);
  }
  const durationMs = first !== null && last !== null ? Math.max(1, last - first) : null;
  const ops = Object.fromEntries(
    FORGE_OPS.map((o) => {
      const h = c.latency[o];
      return [
        o,
        {
          requests: c.requests[o],
          ok: c.ok[o],
          errors: c.errors[o],
          p50Ms: histQuantile(h, 0.5),
          p95Ms: histQuantile(h, 0.95),
          meanMs: h.n ? Math.round(h.sumMs / h.n) : null,
        },
      ];
    }),
  ) as RunSummary["ops"];
  let requests = 0;
  for (const o of FORGE_OPS) requests += c.requests[o];
  return {
    runId,
    measured: true,
    pools: snaps.length,
    agents,
    done,
    failed,
    pending: agents - done - failed,
    forks,
    durationMs,
    intentsDeclared: c.intentsDeclared,
    intentsPerSec: durationMs ? Math.round((c.intentsDeclared / durationMs) * 1000 * 100) / 100 : null,
    overlapsReported: c.overlapsReported,
    claimed: c.claimed,
    gitPushed: c.gitPushed,
    ready: c.ready,
    requests,
    rateLimited: c.rateLimited,
    retries: c.retries,
    errorCodes: c.errorCodes,
    ops,
    sampleErrors: errs,
  };
}
