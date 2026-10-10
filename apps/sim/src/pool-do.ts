// Durable Objects for the live harness. AgentPool persists a pool's state
// (chunked, so 1,000-agent pools stay under per-value limits) and drives
// it from alarms; all behavior lives in the runtime-free harness/pool.ts.
// SimRegistry is a singleton list of runs.

import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "../../worker/src/memory-fs.ts";
import type { SimEnv } from "./env.ts";
import { createHttpForgeApi } from "./harness/api.ts";
import { createGitPusher } from "./harness/git.ts";
import { mapLimit } from "./harness/plan.ts";
import {
  initPool,
  runTick,
  snapshot,
  type AgentState,
  type PoolConfig,
  type PoolDeps,
  type PoolSnapshot,
  type PoolState,
} from "./harness/pool.ts";

const CHUNK = 200;

type PoolMeta = Omit<PoolState, "agents"> & { agentChunks: number };

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console[level === "info" ? "log" : level](JSON.stringify({ level, msg, ...fields }));
}

export class AgentPool extends DurableObject<SimEnv> {
  private async load(): Promise<PoolState | null> {
    const meta = await this.ctx.storage.get<PoolMeta>("meta");
    if (!meta) return null;
    const keys = Array.from({ length: meta.agentChunks }, (_, i) => `agents:${i}`);
    const chunks = keys.length ? await this.ctx.storage.get<AgentState[]>(keys) : new Map<string, AgentState[]>();
    const agents: AgentState[] = [];
    for (const k of keys) agents.push(...(chunks.get(k) ?? []));
    const { agentChunks: _chunks, ...rest } = meta;
    return { ...rest, agents };
  }

  private async save(state: PoolState): Promise<void> {
    const { agents, ...rest } = state;
    const entries: Record<string, unknown> = {};
    const chunks = Math.ceil(agents.length / CHUNK);
    for (let i = 0; i < chunks; i++) entries[`agents:${i}`] = agents.slice(i * CHUNK, (i + 1) * CHUNK);
    entries.meta = { ...rest, agentChunks: chunks } satisfies PoolMeta;
    await this.ctx.storage.put(entries);
  }

  private deps(mode: PoolConfig["mode"]): PoolDeps | null {
    if (!this.env.FORGE_URL || !this.env.FORGE_TOKEN) return null;
    return {
      api: createHttpForgeApi({ baseUrl: this.env.FORGE_URL, token: this.env.FORGE_TOKEN }),
      git: mode === "full-git" ? createGitPusher({ git, http, fs: () => new MemoryFS() }) : null,
      now: () => Date.now(),
      random: () => Math.random(),
    };
  }

  async start(config: PoolConfig): Promise<{ ok: boolean; error?: string }> {
    if (await this.ctx.storage.get("meta")) return { ok: false, error: "pool already started" };
    await this.save(initPool(config, Date.now()));
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true };
  }

  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state || state.stopped || state.finishedAt !== null) return;
    const deps = this.deps(state.config.mode);
    if (!deps) {
      log("error", "sim pool missing FORGE_URL/FORGE_TOKEN", { run: state.config.runId, pool: state.config.poolIndex });
      state.stopped = true;
      await this.save(state);
      return;
    }
    let next: number | null = null;
    try {
      const r = await runTick(state, deps);
      next = r.nextAlarmAt;
    } catch (err) {
      // runTick handles API errors itself; anything here is a bug. Keep
      // the pool alive and retry shortly.
      log("error", "sim pool tick failed", { run: state.config.runId, pool: state.config.poolIndex, error: String(err).slice(0, 200) });
      next = Date.now() + 5_000;
    }
    await this.save(state);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async snapshot(): Promise<PoolSnapshot | null> {
    const state = await this.load();
    return state ? snapshot(state) : null;
  }

  async stop(): Promise<boolean> {
    const state = await this.load();
    if (!state) return false;
    state.stopped = true;
    for (const a of state.agents) a.token = null;
    await this.save(state);
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  // Delete the forks this pool created (Artifacts namespace `flare-sim`).
  async cleanup(): Promise<{ deleted: number; missing: number; failed: number; remaining: number }> {
    const state = await this.load();
    if (!state) return { deleted: 0, missing: 0, failed: 0, remaining: 0 };
    const artifacts = this.env.ARTIFACTS;
    if (!artifacts) return { deleted: 0, missing: 0, failed: state.forks.length, remaining: state.forks.length };
    let deleted = 0;
    let missing = 0;
    let failed = 0;
    const keep: string[] = [];
    await mapLimit(state.forks, 6, async (name) => {
      try {
        if (await artifacts.delete(name)) deleted++;
        else missing++;
      } catch (err) {
        failed++;
        keep.push(name);
        log("warn", "sim fork delete failed", { fork: name, error: String(err).slice(0, 200) });
      }
    });
    state.forks = keep;
    await this.save(state);
    return { deleted, missing, failed, remaining: keep.length };
  }
}

export interface RunMeta {
  runId: string;
  mode: PoolConfig["mode"];
  agents: number;
  pools: number;
  repo: string;
  createdAt: string;
}

export class SimRegistry extends DurableObject<SimEnv> {
  async add(meta: RunMeta): Promise<boolean> {
    const key = `run:${meta.runId}`;
    if (await this.ctx.storage.get(key)) return false;
    await this.ctx.storage.put(key, meta);
    return true;
  }

  async get(runId: string): Promise<RunMeta | null> {
    return (await this.ctx.storage.get<RunMeta>(`run:${runId}`)) ?? null;
  }

  async list(): Promise<RunMeta[]> {
    const map = await this.ctx.storage.list<RunMeta>({ prefix: "run:", limit: 200 });
    return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
