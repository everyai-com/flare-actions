// DemoLoop: the singleton Durable Object behind `/demo-loop/*`. It keeps
// the public spectator repo moving by running demo/loop.ts one tick per
// alarm. All behavior lives in the runtime-free loop module; this file
// holds the runtime bindings (isomorphic-git, MemoryFS, Artifacts).

import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "../../worker/src/memory-fs.ts";
import type { SimEnv } from "./env.ts";
import { createDemoForgeApi } from "./demo/client.ts";
import { createDemoGit } from "./demo/git.ts";
import { demoStatus, demoTick, initDemoState, type DemoArtifacts, type DemoConfig, type DemoDeps, type DemoState } from "./demo/loop.ts";

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console[level === "info" ? "log" : level](JSON.stringify({ level, msg, ...fields }));
}

function errCode(err: unknown): string {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
}

export function artifactsAdapter(ns: Artifacts): DemoArtifacts {
  return {
    async status(name) {
      try {
        using repo = await ns.get(name);
        await repo.info();
        return "ready";
      } catch (err) {
        const code = errCode(err);
        if (code === "NOT_FOUND") return "missing";
        if (code.endsWith("_IN_PROGRESS")) return "busy";
        throw err;
      }
    },
    async remove(name) {
      return ns.delete(name);
    },
    async fork(source, target) {
      using repo = await ns.get(source);
      // All refs, not just main: lane refs and the why-notes ref ride along.
      await repo.fork(target, { defaultBranchOnly: false, description: `demo-loop trunk (from ${source})` });
    },
    async readToken(name) {
      using repo = await ns.get(name);
      return (await repo.createToken("read", 600)).plaintext;
    },
  };
}

const KEY = "state";

export class DemoLoop extends DurableObject<SimEnv> {
  private deps(): DemoDeps | null {
    const token = this.env.DEMO_FORGE_TOKEN ?? this.env.FORGE_TOKEN;
    if (!this.env.FORGE_URL || !token || !this.env.DEMO_ARTIFACTS) return null;
    return {
      api: createDemoForgeApi({ baseUrl: this.env.FORGE_URL, token }),
      git: createDemoGit({ git, http, fs: () => new MemoryFS() }),
      artifacts: artifactsAdapter(this.env.DEMO_ARTIFACTS),
      now: () => Date.now(),
    };
  }

  private async load(): Promise<DemoState | null> {
    return (await this.ctx.storage.get<DemoState>(KEY)) ?? null;
  }

  async start(config: DemoConfig): Promise<{ ok: boolean; error?: string; status?: string }> {
    if (!this.deps()) return { ok: false, error: "set FORGE_URL, DEMO_FORGE_TOKEN (or FORGE_TOKEN) and the DEMO_ARTIFACTS binding" };
    const prev = await this.load();
    const state = initDemoState(config, Date.now());
    // Keep fork tracking and counters across restarts so cleanup and
    // budgets survive a re-start.
    if (prev) {
      state.forks = [...new Set([...prev.forks, ...prev.items.map((i) => i.forkRepo).filter((f): f is string => !!f)])];
      state.counters = prev.counters;
      state.budget = prev.budget;
      state.cycle = prev.cycle + 1;
    }
    await this.ctx.storage.put(KEY, state);
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true, status: JSON.stringify(demoStatus(state, Date.now())) };
  }

  async setPaused(paused: boolean): Promise<string> {
    const state = await this.load();
    if (!state) return JSON.stringify(demoStatus(null, Date.now()));
    state.paused = paused;
    state.note = paused ? "paused" : "resumed";
    await this.ctx.storage.put(KEY, state);
    if (paused) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Date.now());
    return JSON.stringify(demoStatus(state, Date.now()));
  }

  async stop(): Promise<string> {
    const state = await this.load();
    if (!state) return JSON.stringify(demoStatus(null, Date.now()));
    state.enabled = false;
    for (const i of state.items) {
      i.token = null;
      i.remote = null;
    }
    state.note = "stopped (POST /demo-loop/start to run again; forks stay tracked for the next reset)";
    await this.ctx.storage.put(KEY, state);
    await this.ctx.storage.deleteAlarm();
    return JSON.stringify(demoStatus(state, Date.now()));
  }

  // Skip to the reset phase now (e.g. after a broken cycle).
  async resetNow(): Promise<string> {
    const state = await this.load();
    if (!state) return JSON.stringify(demoStatus(null, Date.now()));
    state.phase = "reset";
    state.phaseStartedAt = Date.now();
    state.note = "reset requested";
    await this.ctx.storage.put(KEY, state);
    if (state.enabled && !state.paused) await this.ctx.storage.setAlarm(Date.now());
    return JSON.stringify(demoStatus(state, Date.now()));
  }

  async status(): Promise<string> {
    return JSON.stringify(demoStatus(await this.load(), Date.now()));
  }

  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state) return;
    const deps = this.deps();
    if (!deps) {
      state.enabled = false;
      state.note = "stopped: FORGE_URL / DEMO_FORGE_TOKEN / DEMO_ARTIFACTS missing";
      await this.ctx.storage.put(KEY, state);
      return;
    }
    let next: number | null;
    try {
      next = await demoTick(state, deps);
    } catch (err) {
      // demoTick catches its own errors; anything here is a bug. Retry.
      log("error", "demo loop tick failed", { error: String(err).slice(0, 200) });
      next = Date.now() + 30_000;
    }
    await this.ctx.storage.put(KEY, state);
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 500));
  }
}
