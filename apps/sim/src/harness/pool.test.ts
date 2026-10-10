import { describe, expect, it } from "vitest";
import type { ApiErr, ApiResult, ForgeApi } from "./api";
import { classifyError, createHttpForgeApi, parseRetryAfter, pick } from "./api";
import { createGitPusher, redactGitError, type GitPusher, type SimGit } from "./git";
import { DEFAULT_LIMITS, mapLimit, planRun } from "./plan";
import {
  agentFootprint,
  aggregate,
  histQuantile,
  emptyHistogram,
  histRecord,
  initPool,
  runTick,
  snapshot,
  type PoolConfig,
  type PoolDeps,
  type PoolState,
} from "./pool";
import { parseTrailers } from "../../../worker/src/intents-core";

// --- fake Forge API ------------------------------------------------------------

interface FakeOpts {
  latencyMs?: number;
  // Return an error for the n-th call of an op (1-based), else ok.
  failures?: Partial<Record<keyof ForgeApi, Map<number, ApiErr>>>;
}

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function makeFake(clock: ReturnType<typeof fakeClock>, opts: FakeOpts = {}) {
  let inflight = 0;
  let maxInflight = 0;
  const calls: Record<string, number> = {};
  const intents = new Map<string, string>();
  const run = async <T>(op: keyof ForgeApi, value: () => T): Promise<ApiResult<T>> => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    calls[op] = (calls[op] ?? 0) + 1;
    const nth = calls[op];
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(opts.latencyMs ?? 5);
    inflight--;
    const err = opts.failures?.[op]?.get(nth);
    if (err) return err;
    return { ok: true, status: 200, value: value(), ms: opts.latencyMs ?? 5 };
  };
  let n = 0;
  const api: ForgeApi = {
    createGoal: () => run("createGoal", () => ({ id: "g-1" })),
    declareIntent: (i) =>
      run("declareIntent", () => {
        const id = `i-${++n}`;
        intents.set(id, i.agent);
        return { id, overlaps: i.footprint.length > 1 ? 1 : 0 };
      }),
    claimIntent: (i) => run("claimIntent", () => ({ forkRepo: `fork-${i.id}`, remote: `https://git.example/${i.id}.git`, token: "art_v2_secret" })),
    heartbeat: () => run("heartbeat", () => ({ inbox: 0 })),
    whatsHappening: () => run("whatsHappening", () => ({ live: 3 })),
    reportPush: () => run("reportPush", () => ({ drift: 0 })),
    markReady: () => run("markReady", () => ({ risk: 12 })),
  };
  return { api, calls, intents, maxInflight: () => maxInflight };
}

const fakeGit: GitPusher = {
  async pushTinyChange(input) {
    return { sha: `sha-${input.intentId}`.padEnd(40, "0") };
  },
};

function config(over: Partial<PoolConfig> = {}): PoolConfig {
  return {
    runId: "t1",
    poolIndex: 0,
    agents: 20,
    mode: "coordination-only",
    repo: "trunk",
    seed: 7,
    heartbeats: 2,
    rampMs: 0,
    concurrency: 6,
    maxRequestsPerTick: 1000,
    tickBudgetMs: 60_000,
    maxRetries: 2,
    maxRateLimitRetries: 5,
    footprintFiles: 50,
    ...over,
  };
}

async function drain(state: PoolState, deps: PoolDeps, clock: ReturnType<typeof fakeClock>, maxTicks = 200): Promise<number> {
  let ticks = 0;
  for (; ticks < maxTicks; ticks++) {
    const r = await runTick(state, deps);
    if (r.nextAlarmAt === null) break;
    if (r.nextAlarmAt > clock.now()) clock.advance(r.nextAlarmAt - clock.now());
  }
  return ticks;
}

const err = (status: number, code: string, retryAfterMs: number | null = null): ApiErr => ({
  ok: false,
  status,
  ...classifyError(status, { error: code }),
  retryAfterMs,
  ms: 3,
});

describe("AgentPool logic", () => {
  it("coordination-only: declare + whats_happening + heartbeats, never more than 6 in flight", async () => {
    const clock = fakeClock();
    const fake = makeFake(clock);
    const state = initPool(config({ agents: 40, concurrency: 6 }), clock.now());
    await drain(state, { api: fake.api, git: null, now: clock.now, random: () => 0.5 }, clock);
    const s = snapshot(state);
    expect(s.done).toBe(40);
    expect(s.failed).toBe(0);
    expect(fake.maxInflight()).toBeLessThanOrEqual(6);
    expect(fake.calls).toEqual({ createGoal: 1, declareIntent: 40, whatsHappening: 40, heartbeat: 80 });
    expect(state.counters.intentsDeclared).toBe(40);
    expect(state.counters.claimed).toBe(0);
    expect(s.forks).toEqual([]);
    expect(state.finishedAt).not.toBeNull();
  });

  it("full-git: claim -> git push -> report push -> ready, records forks, drops tokens", async () => {
    const clock = fakeClock();
    const fake = makeFake(clock);
    const state = initPool(config({ mode: "full-git", agents: 10 }), clock.now());
    await drain(state, { api: fake.api, git: fakeGit, now: clock.now, random: () => 0.5 }, clock);
    expect(state.counters.claimed).toBe(10);
    expect(state.counters.gitPushed).toBe(10);
    expect(state.counters.ready).toBe(10);
    expect(state.forks).toHaveLength(10);
    expect(state.agents.every((a) => a.token === null)).toBe(true);
    expect(JSON.stringify(snapshot(state))).not.toContain("art_v2_secret");
  });

  it("backs off on 429 / Artifacts rate limits, counts them, and still finishes", async () => {
    const clock = fakeClock();
    const failures = {
      declareIntent: new Map([
        [1, err(429, "rate_limited", 2_000)],
        [2, err(200, "rateLimited")],
      ]),
    };
    const fake = makeFake(clock, { failures });
    const state = initPool(config({ agents: 3, heartbeats: 0 }), clock.now());
    const t0 = clock.now();
    await drain(state, { api: fake.api, git: null, now: clock.now, random: () => 0.5 }, clock);
    expect(state.counters.rateLimited).toBe(2);
    expect(state.counters.retries).toBe(2);
    expect(snapshot(state).done).toBe(3);
    // Retry-After was honored: the run took at least that long.
    expect(clock.now() - t0).toBeGreaterThanOrEqual(2_000);
    expect(state.counters.errorCodes.rate_limited).toBe(1);
  });

  it("retries 5xx up to maxRetries, then fails the agent; optional steps skip 4xx", async () => {
    const clock = fakeClock();
    const failures = {
      claimIntent: new Map([
        [1, err(503, "unavailable")],
        [2, err(503, "unavailable")],
        [3, err(503, "unavailable")],
      ]),
      heartbeat: new Map([[1, err(409, "not_claimed")]]),
    };
    const fake = makeFake(clock, { failures });
    const coord = initPool(config({ agents: 1, heartbeats: 1 }), clock.now());
    await drain(coord, { api: fake.api, git: null, now: clock.now, random: () => 0.5 }, clock);
    expect(snapshot(coord).done).toBe(1); // heartbeat 409 skipped
    const git = initPool(config({ mode: "full-git", agents: 1, maxRetries: 2 }), clock.now());
    await drain(git, { api: fake.api, git: fakeGit, now: clock.now, random: () => 0.5 }, clock);
    const s = snapshot(git);
    expect(s.failed).toBe(1);
    expect(s.sampleErrors).toEqual(["unavailable"]);
  });

  it("respects the per-tick request budget and resumes on the next alarm", async () => {
    const clock = fakeClock();
    const fake = makeFake(clock);
    const state = initPool(config({ agents: 30, heartbeats: 0, maxRequestsPerTick: 10 }), clock.now());
    const deps = { api: fake.api, git: null, now: clock.now, random: () => 0.5 };
    const first = await runTick(state, deps);
    expect(first.requests).toBeLessThanOrEqual(10);
    expect(first.nextAlarmAt).not.toBeNull();
    await drain(state, deps, clock);
    expect(snapshot(state).done).toBe(30);
  });

  it("ramps agent starts across the window", async () => {
    const clock = fakeClock();
    const state = initPool(config({ agents: 4, rampMs: 4_000 }), clock.now());
    expect(state.agents.map((a) => a.nextAt - clock.now())).toEqual([0, 1000, 2000, 3000]);
  });

  it("footprints are deterministic and overlap across agents", () => {
    const c = config({ footprintFiles: 20 });
    expect(agentFootprint(c, 3)).toEqual(agentFootprint(c, 3));
    const all = Array.from({ length: 40 }, (_, i) => agentFootprint(c, i)).flat();
    expect(new Set(all).size).toBeLessThan(all.length);
  });

  it("aggregates snapshots across pools", async () => {
    const clock = fakeClock();
    const snaps = [];
    for (let p = 0; p < 3; p++) {
      const fake = makeFake(clock);
      const state = initPool(config({ poolIndex: p, agents: 5, heartbeats: 0 }), clock.now());
      await drain(state, { api: fake.api, git: null, now: clock.now, random: () => 0.5 }, clock);
      snaps.push(snapshot(state));
    }
    const s = aggregate("t1", snaps);
    expect(s).toMatchObject({ pools: 3, agents: 15, done: 15, failed: 0, pending: 0, intentsDeclared: 15, measured: true });
    expect(s.ops.declare.requests).toBe(15);
    expect(s.ops.declare.p50Ms).not.toBeNull();
    expect(s.intentsPerSec).not.toBeNull();
  });

  it("histogram quantiles are bucket upper bounds", () => {
    const h = emptyHistogram();
    for (const ms of [1, 10, 10, 10, 100]) histRecord(h, ms);
    const p50 = histQuantile(h, 0.5) ?? 0;
    expect(p50).toBeGreaterThanOrEqual(10);
    expect(p50).toBeLessThan(13);
    expect(histQuantile(emptyHistogram(), 0.5)).toBeNull();
  });
});

describe("run planning + budget guard", () => {
  const d = { repo: "trunk", runId: "r1" };

  it("refuses large full-git runs without confirm", () => {
    const r = planRun({ mode: "full-git", agents: 2000 }, DEFAULT_LIMITS, d);
    expect(r).toMatchObject({ ok: false, status: 409, code: "confirm_required" });
    const ok = planRun({ mode: "full-git", agents: 2000, confirm: true }, DEFAULT_LIMITS, d);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.plan.pools).toHaveLength(20);
      expect(ok.plan.pools.every((p) => p.agents === 100)).toBe(true);
    }
    expect(planRun({ mode: "full-git", agents: 20_000, confirm: true }, DEFAULT_LIMITS, d).ok).toBe(false);
  });

  it("splits coordination-only runs into 1,000-agent pools", () => {
    const r = planRun({ mode: "coordination-only", agents: 100_000 }, DEFAULT_LIMITS, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.pools).toHaveLength(100);
      expect(r.plan.pools.reduce((s, p) => s + p.agents, 0)).toBe(100_000);
    }
    const odd = planRun({ mode: "coordination-only", agents: 1_500 }, DEFAULT_LIMITS, d);
    if (odd.ok) expect(odd.plan.pools.map((p) => p.agents)).toEqual([1000, 500]);
  });

  it("validates input", () => {
    expect(planRun({ mode: "nope", agents: 5 }, DEFAULT_LIMITS, d).ok).toBe(false);
    expect(planRun({ mode: "full-git", agents: 0 }, DEFAULT_LIMITS, d).ok).toBe(false);
    expect(planRun({ mode: "full-git", agents: 5, run_id: "Bad Id" }, DEFAULT_LIMITS, d).ok).toBe(false);
    expect(planRun({ mode: "full-git", agents: 5, concurrency: 7 }, DEFAULT_LIMITS, d).ok).toBe(false);
  });

  it("mapLimit caps concurrency", async () => {
    let inflight = 0;
    let max = 0;
    const out = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 6, async (i) => {
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight--;
      return i * 2;
    });
    expect(max).toBe(6);
    expect(out[19]).toBe(38);
  });
});

describe("HTTP Forge API", () => {
  it("calls the /v1/forge routes with auth and parses snake or camel responses", async () => {
    const seen: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/intents")) return Response.json({ intent: { id: "i-9" }, overlaps: [{}, {}] });
      if (url.endsWith("/claim")) return Response.json({ fork_repo: "i-9", fork_remote: "https://x/i-9.git", token: "t" });
      if (url.includes("/whats-happening")) return Response.json({ intents: [{}, {}, {}] });
      if (url.endsWith("/ready")) return Response.json({ intent: { risk: 7 } });
      return Response.json({ id: "g-1" });
    }) as typeof fetch;
    const api = createHttpForgeApi({ baseUrl: "https://forge.example/", token: "tok", fetch: fetchImpl });
    const d = await api.declareIntent({ repo: "r", goalId: "g-1", agent: "a", title: "t", reasoning: "", accept: "", footprint: ["x.ts"] });
    expect(d).toMatchObject({ ok: true, value: { id: "i-9", overlaps: 2 } });
    expect(seen[0]).toMatchObject({ url: "https://forge.example/v1/forge/intents", method: "POST", auth: "Bearer tok" });
    expect(seen[0].body).toMatchObject({ goal_id: "g-1", footprint: { paths: ["x.ts"] } });
    expect(await api.claimIntent({ id: "i-9", agent: "a" })).toMatchObject({ ok: true, value: { forkRepo: "i-9", remote: "https://x/i-9.git" } });
    expect(await api.whatsHappening({ repo: "r", paths: ["a", "b"], agent: "a" })).toMatchObject({ ok: true, value: { live: 3 } });
    expect(seen[2].url).toBe("https://forge.example/v1/forge/whats-happening?repo=r&paths=a%2Cb");
    expect(await api.markReady({ id: "i-9", agent: "a" })).toMatchObject({ ok: true, value: { risk: 7 } });
  });

  it("classifies 429, rate-limit codes, 5xx and network errors", async () => {
    const fetch429 = (async () =>
      new Response(JSON.stringify({ error: "too_many" }), { status: 429, headers: { "Retry-After": "3" } })) as unknown as typeof fetch;
    const api = createHttpForgeApi({ baseUrl: "https://f", token: "t", fetch: fetch429 });
    expect(await api.heartbeat({ id: "i", agent: "a" })).toMatchObject({ ok: false, status: 429, rateLimited: true, retryAfterMs: 3000 });
    expect(classifyError(400, { code: "rateLimited" })).toMatchObject({ rateLimited: true, retryable: true });
    expect(classifyError(503, null)).toMatchObject({ code: "http_503", rateLimited: false, retryable: true });
    expect(classifyError(404, { error: "intent_not_found" })).toMatchObject({ retryable: false });
    const boom = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const api2 = createHttpForgeApi({ baseUrl: "https://f", token: "t", fetch: boom });
    expect(await api2.markReady({ id: "i", agent: "a" })).toMatchObject({ ok: false, status: 0, code: "network", retryable: true });
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(pick({ a: { b: 1 } }, ["x", "a.b"])).toBe(1);
  });
});

describe("git pusher", () => {
  it("clones, commits with Flare trailers, and pushes with the fork token", async () => {
    const calls: string[] = [];
    let message = "";
    let auth = "";
    const written: Record<string, string> = {};
    const git: SimGit = {
      clone: async (o) => {
        calls.push(`clone ${o.url} depth=${o.depth}`);
        auth = o.onAuth().password;
      },
      add: async (o) => {
        calls.push(`add ${o.filepath}`);
      },
      commit: async (o) => {
        message = o.message;
        calls.push("commit");
        return "f".repeat(40);
      },
      push: async (o) => {
        calls.push(`push ${o.ref}`);
      },
    };
    const fs = {
      promises: {
        mkdir: async () => undefined,
        writeFile: async (p: string, d: string) => {
          written[p] = d;
        },
      },
    };
    const pusher = createGitPusher({ git, http: {} as never, fs: () => fs as never });
    const out = await pusher.pushTinyChange({
      remote: "https://x/i-1.git",
      token: "art_v2_tok",
      agent: "sim-a",
      intentId: "i-1",
      goalId: "g-1",
      path: "sim/m1/f2.ts",
      content: "// hi\n",
    });
    expect(out.sha).toBe("f".repeat(40));
    expect(calls).toEqual(["clone https://x/i-1.git depth=1", "add sim/m1/f2.ts", "commit", "push main"]);
    expect(auth).toBe("art_v2_tok");
    expect(written["/w/sim/m1/f2.ts"]).toBe("// hi\n");
    expect(parseTrailers(message)).toMatchObject({ intent: "i-1", agent: "sim-a", goal: "g-1" });
  });

  it("redacts tokens from git errors", () => {
    expect(redactGitError(new Error("push https://x:art_v2_abc@h/r failed art_v2_abc"))).not.toContain("art_v2_abc");
  });
});
