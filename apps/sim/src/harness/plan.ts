// Run planning + the budget guard for the live harness. Pure: validates
// a start request and splits it into per-pool configs. full-git runs
// create one Artifacts fork per agent (real cost), so they are refused
// above `maxFullGitAgents` unless the caller passes `confirm: true`.

import { HARNESS_MODES, POOL_DEFAULTS, type HarnessMode, type PoolConfig } from "./pool.ts";

export interface RunLimits {
  maxFullGitAgents: number; // above this, full-git needs confirm
  hardMaxFullGitAgents: number; // never above this
  maxCoordinationAgents: number;
  maxPools: number;
  agentsPerPoolFullGit: number;
  agentsPerPoolCoordination: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxFullGitAgents: 1_000,
  hardMaxFullGitAgents: 10_000,
  maxCoordinationAgents: 200_000,
  maxPools: 1_000,
  agentsPerPoolFullGit: 100,
  agentsPerPoolCoordination: 1_000,
};

export interface RunPlan {
  runId: string;
  mode: HarnessMode;
  agents: number;
  repo: string;
  pools: PoolConfig[];
}

export type PlanResult = { ok: true; plan: RunPlan } | { ok: false; status: number; code: string; message: string };

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function intField(v: unknown, dflt: number, min: number, max: number): number | null {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

export function planRun(body: unknown, limits: RunLimits, defaults: { repo: string; runId: string }): PlanResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const bad = (message: string): PlanResult => ({ ok: false, status: 400, code: "invalid_request", message });
  const mode = b.mode;
  if (typeof mode !== "string" || !(HARNESS_MODES as readonly string[]).includes(mode)) {
    return bad(`mode must be one of ${HARNESS_MODES.join(", ")}`);
  }
  const m = mode as HarnessMode;
  const cap = m === "full-git" ? limits.hardMaxFullGitAgents : limits.maxCoordinationAgents;
  const agents = intField(b.agents, 0, 1, cap);
  if (agents === null || agents < 1) return bad(`agents must be an integer 1-${cap} for ${m}`);
  if (m === "full-git" && agents > limits.maxFullGitAgents && b.confirm !== true) {
    return {
      ok: false,
      status: 409,
      code: "confirm_required",
      message:
        `full-git with ${agents} agents creates ${agents} Artifacts forks (real cost). ` +
        `Above ${limits.maxFullGitAgents} agents, resend with "confirm": true (CLI: --confirm).`,
    };
  }
  const runId = typeof b.run_id === "string" ? b.run_id : defaults.runId;
  if (!RUN_ID_RE.test(runId)) return bad("run_id must match [a-z0-9-]{1,24}");
  const repo = typeof b.repo === "string" ? b.repo : defaults.repo;
  if (!REPO_RE.test(repo)) return bad("repo must be an Artifacts repo name");
  const heartbeats = intField(b.heartbeats, POOL_DEFAULTS.heartbeats, 0, 20);
  const rampSeconds = intField(b.ramp_seconds, POOL_DEFAULTS.rampMs / 1000, 0, 3600);
  const seed = intField(b.seed, 7, 0, 2 ** 31 - 1);
  const concurrency = intField(b.concurrency, POOL_DEFAULTS.concurrency, 1, 6);
  if (heartbeats === null || rampSeconds === null || seed === null || concurrency === null) {
    return bad("heartbeats 0-20, ramp_seconds 0-3600, seed >= 0, concurrency 1-6");
  }
  const perPool = m === "full-git" ? limits.agentsPerPoolFullGit : limits.agentsPerPoolCoordination;
  const poolCount = Math.ceil(agents / perPool);
  if (poolCount > limits.maxPools) return bad(`needs ${poolCount} pools; max ${limits.maxPools}`);
  const pools: PoolConfig[] = [];
  for (let p = 0; p < poolCount; p++) {
    const n = Math.min(perPool, agents - p * perPool);
    pools.push({
      runId,
      poolIndex: p,
      agents: n,
      mode: m,
      repo,
      seed,
      heartbeats,
      rampMs: rampSeconds * 1000,
      concurrency,
      maxRequestsPerTick: POOL_DEFAULTS.maxRequestsPerTick,
      tickBudgetMs: POOL_DEFAULTS.tickBudgetMs,
      maxRetries: POOL_DEFAULTS.maxRetries,
      maxRateLimitRetries: POOL_DEFAULTS.maxRateLimitRetries,
      footprintFiles: POOL_DEFAULTS.footprintFiles,
    });
  }
  return { ok: true, plan: { runId, mode: m, agents, repo, pools } };
}

// Bounded fan-out: run `fn` over items with at most `limit` in flight
// (Workers: 6 simultaneous outbound connections per invocation).
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return out;
}
