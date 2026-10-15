/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DemoApiError, type DemoConflict, type DemoForgeApi, type DemoIntent } from "./client.ts";
import type { CommitInput, DemoGit } from "./git.ts";
import { demoConfigFrom, demoStatus, demoTick, initDemoState, type DemoArtifacts, type DemoDeps, type DemoState } from "./loop.ts";
import { applyEdits, editPaths, replayEdits, seedIntents, solutionFor } from "./scenario.ts";

const { readFileSync, existsSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");

const FORK_TOKEN = "art_v1_forktoken_secret";

interface Fake {
  deps: DemoDeps;
  intents: Map<string, DemoIntent & { repo: string }>;
  conflicts: DemoConflict[];
  repos: Map<string, "ready" | "busy">;
  calls: string[];
  pushes: CommitInput[];
  clock: { t: number };
}

function fake(opts: { pristine?: boolean } = {}): Fake {
  const intents = new Map<string, DemoIntent & { repo: string }>();
  const conflicts: DemoConflict[] = [];
  const repos = new Map<string, "ready" | "busy">([["bookshelf", "ready"]]);
  if (opts.pristine) repos.set("bookshelf-pristine", "ready");
  const calls: string[] = [];
  const pushes: CommitInput[] = [];
  const clock = { t: 1_000_000 };
  let n = 0;
  const api: DemoForgeApi = {
    async createGoal(_repo, _text, _agent) {
      calls.push("goal");
      return { id: `goal-${++n}` };
    },
    async declare(i) {
      calls.push(`declare:${i.title}`);
      const id = `int-${++n}`;
      const state = i.footprint.some((p) => p.startsWith("src/auth/")) ? "awaiting_plan" : "draft";
      const overlaps = [...intents.values()].filter((x) => x.repo === i.repo && x.state !== "abandoned" && x.state !== "landed").filter((x) => x.title.length && i.footprint.includes("src/index.ts") && x.title.includes("metrics"));
      const it = { id, agent: i.agent, state, title: i.title, forkRepo: null, goalId: i.goalId, repo: i.repo };
      intents.set(id, it);
      return { intent: it, overlaps: overlaps.map((o) => ({ intentId: o.id })) };
    },
    async sendNote() {
      calls.push("note");
    },
    async claim(id, agent) {
      const it = intents.get(id);
      if (!it || it.state !== "draft") throw new DemoApiError(409, "intent_not_claimable", "no");
      it.state = "claimed";
      it.agent = agent;
      it.forkRepo = `i-${id}`;
      repos.set(it.forkRepo, "ready");
      return { forkRepo: it.forkRepo, remote: `https://acct.artifacts.test/git/ns/${it.forkRepo}.git`, token: FORK_TOKEN, goalId: it.goalId };
    },
    async reportPush(id) {
      const it = intents.get(id);
      if (it) it.state = "working";
      return { drift: it?.title.includes("page size from 20") ? ["README.md"] : [] };
    },
    async markReady(id) {
      const it = intents.get(id);
      if (it) it.state = "ready";
      return { route: "auto" };
    },
    async abandon(id) {
      const it = intents.get(id);
      if (!it) throw new DemoApiError(404, "forge_not_found", "no");
      it.state = "abandoned";
    },
    async listIntents(repo) {
      return [...intents.values()].filter((i) => i.repo === repo);
    },
    async listConflicts(_repo, state) {
      return conflicts.filter((k) => k.state === state);
    },
    async claimConflict(id) {
      const k = conflicts.find((x) => x.id === id);
      if (!k) throw new DemoApiError(404, "forge_not_found", "no");
      k.state = "claimed";
      const b = intents.get(k.intentB);
      return { intentId: k.intentB, forkRepo: b?.forkRepo ?? "", remote: `https://acct.artifacts.test/git/ns/${b?.forkRepo}.git`, token: FORK_TOKEN };
    },
    async resolveConflict(id) {
      const k = conflicts.find((x) => x.id === id);
      if (k) k.state = "resolved";
      const b = k ? intents.get(k.intentB) : undefined;
      if (b) b.state = "ready";
    },
  };
  const git: DemoGit = {
    async commitAndPush(input) {
      pushes.push(input);
      return { sha: (pushes.length.toString(16) + "a".repeat(40)).slice(0, 40), files: editPaths(input.edits) };
    },
  };
  const artifacts: DemoArtifacts = {
    async status(name) {
      return repos.get(name) ?? "missing";
    },
    async remove(name) {
      calls.push(`delete:${name}`);
      return repos.delete(name);
    },
    async fork(source, target) {
      calls.push(`fork:${source}->${target}`);
      if (!repos.has(source)) throw Object.assign(new Error("nf"), { code: "NOT_FOUND" });
      repos.set(target, "ready");
    },
    async readToken() {
      return "art_v1_readtoken_secret";
    },
  };
  return { deps: { api, git, artifacts, now: () => clock.t }, intents, conflicts, repos, calls, pushes, clock };
}

function cfg(over: Record<string, unknown> = {}) {
  const c = demoConfigFrom({ paceMs: 1000, holdMs: 60_000, ...over }, { repo: "bookshelf" });
  if (!c.ok) throw new Error(c.message);
  return c.config;
}

async function runUntil(state: DemoState, f: Fake, pred: (s: DemoState) => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max && !pred(state); i++) {
    const next = await demoTick(state, f.deps);
    if (next === null) return;
    f.clock.t = Math.max(f.clock.t + 1, next);
  }
}

describe("demo loop: scenario data", () => {
  it("bundles all 13 seed intents with reference solutions, in designed order", () => {
    const intents = seedIntents();
    expect(intents).toHaveLength(13);
    expect(intents[0].id).toBe("g1-metrics");
    expect(intents[intents.length - 1].id).toBe("g3-api-key-rotation");
    for (const i of intents) expect(solutionFor(i.id), i.id).not.toBeNull();
    expect(replayEdits("g3-log-latency", "g1-request-id")).not.toBeNull();
  });

  it("every reference solution applies to the real Bookshelf tree (and the replay on top of its peer)", () => {
    const root = join(process.cwd(), "examples", "forge-demo");
    const read = (paths: string[]): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const p of paths) if (existsSync(join(root, p))) out[p] = readFileSync(join(root, p), "utf8");
      return out;
    };
    for (const i of seedIntents()) {
      const edits = solutionFor(i.id)?.edits ?? [];
      expect(() => applyEdits(read(editPaths(edits)), edits), i.id).not.toThrow();
    }
    const first = solutionFor("g1-request-id")?.edits ?? [];
    const replay = replayEdits("g3-log-latency", "g1-request-id") ?? [];
    const trunk = applyEdits(read(editPaths([...first, ...replay])), first);
    expect(() => applyEdits(trunk, replay)).not.toThrow();
  });
});

describe("demo loop: cycle", () => {
  it("snapshots, runs the swarm, replays the conflict, holds, resets from pristine", async () => {
    const f = fake();
    const state = initDemoState(cfg(), f.clock.t);
    // First run: trunk exists, pristine does not -> snapshot.
    await runUntil(state, f, (s) => s.phase === "work");
    expect(f.calls).toContain("fork:bookshelf->bookshelf-pristine");
    expect(f.calls).not.toContain("delete:bookshelf");
    expect(Object.keys(state.goals)).toHaveLength(3);

    await runUntil(state, f, (s) => s.phase === "settle");
    expect(state.counters.declared).toBe(13);
    expect(state.counters.claims).toBe(12);
    expect(state.counters.pushes).toBe(12);
    expect(state.counters.ready).toBe(12);
    expect(state.items.find((i) => i.seedId === "g3-api-key-rotation")?.step).toBe("awaiting_plan");
    expect(f.calls.filter((c) => c === "note").length).toBeGreaterThan(0);
    const drift = f.pushes.find((p) => p.summary.includes("page size from 20"));
    expect(drift?.append?.path).toBe("README.md");
    // Trailers carry intent + agent + goal.
    expect(f.pushes[0].trailers.goal).toMatch(/^goal-/);

    // The train opens the designed textual conflict.
    const a = state.items.find((i) => i.seedId === "g1-request-id")?.intentId ?? "";
    const b = state.items.find((i) => i.seedId === "g3-log-latency")?.intentId ?? "";
    f.conflicts.push({ id: "k1", intentA: a, intentB: b, state: "open", files: ["src/middleware/logging.ts"] });
    f.intents.get(b)!.state = "conflicted";
    await demoTick(state, f.deps);
    expect(state.counters.replays).toBe(1);
    const replay = f.pushes[f.pushes.length - 1];
    expect(replay.cloneUrl).toBe("https://acct.artifacts.test/git/ns/bookshelf.git");
    expect(replay.force).toBe(true);
    expect(replay.pushUrl).toContain(`i-${b}`);

    // Trains land everything -> hold -> reset.
    for (const it of f.intents.values()) if (it.state === "ready") it.state = "landed";
    await runUntil(state, f, (s) => s.phase === "hold");
    expect(state.phase).toBe("hold");
    await runUntil(state, f, (s) => s.phase === "seed" && s.cycle === 1);
    expect(state.cycle).toBe(1);
    expect(f.calls).toContain("delete:bookshelf");
    expect(f.calls).toContain("fork:bookshelf-pristine->bookshelf");
    expect(f.calls.filter((c) => c.startsWith("delete:i-")).length).toBe(12);
    expect([...f.intents.values()].filter((i) => i.state === "awaiting_plan")).toHaveLength(0); // abandoned
    expect(state.forks).toHaveLength(0);
  });

  it("stops cleanly when neither trunk nor pristine exists", async () => {
    const f = fake();
    f.repos.clear();
    const state = initDemoState(cfg(), f.clock.t);
    await runUntil(state, f, () => false, 10);
    expect(state.enabled).toBe(false);
    expect(state.note).toContain("forge:demo");
  });
});

describe("demo loop: guards", () => {
  it("fork budget parks the loop until the hour rolls", async () => {
    const f = fake({ pristine: true });
    const state = initDemoState(cfg({ maxForksPerHour: 2 }), f.clock.t);
    let parked = 0;
    for (let i = 0; i < 200 && !parked; i++) {
      const next = await demoTick(state, f.deps);
      if (next !== null && next - f.clock.t > 30 * 60_000) parked = next;
      else f.clock.t = Math.max(f.clock.t + 1, next ?? f.clock.t + 1);
    }
    expect(state.counters.claims).toBe(2);
    expect(parked).toBe(state.budget.hourStart + 3_600_000);
    expect(state.note).toContain("budget");
  });

  it("ops budget, pause and disable stop work", async () => {
    const f = fake({ pristine: true });
    const state = initDemoState(cfg({ maxOpsPerHour: 10 }), f.clock.t);
    state.budget.ops = 10;
    expect(await demoTick(state, f.deps)).toBe(state.budget.hourStart + 3_600_000);
    state.budget.ops = 0;
    state.paused = true;
    expect(await demoTick(state, f.deps)).toBeNull();
    state.paused = false;
    state.enabled = false;
    expect(await demoTick(state, f.deps)).toBeNull();
  });

  it("daily cycle cap holds the finished map", async () => {
    const f = fake({ pristine: true });
    const state = initDemoState(cfg({ maxCyclesPerDay: 1 }), f.clock.t);
    state.budget.cycles = 1;
    const next = await demoTick(state, f.deps);
    expect(next).toBe(state.budget.dayStart + 86_400_000);
    expect(f.calls).toHaveLength(0);
  });

  it("status never carries fork credentials", async () => {
    const f = fake({ pristine: true });
    const state = initDemoState(cfg(), f.clock.t);
    await runUntil(state, f, (s) => s.items.some((i) => i.step === "claimed"));
    expect(state.items.some((i) => i.token === FORK_TOKEN)).toBe(true);
    const text = JSON.stringify(demoStatus(state, f.clock.t));
    expect(text).not.toContain(FORK_TOKEN);
    expect(text).not.toContain("art_v1_");
    expect(text).not.toContain("acct.artifacts.test");
  });

  it("validates config", () => {
    expect(demoConfigFrom({ repo: "../x" }, { repo: "b" }).ok).toBe(false);
    expect(demoConfigFrom({ pristine: "b" }, { repo: "b" }).ok).toBe(false);
    expect(demoConfigFrom({ paceMs: 5 }, { repo: "b" }).ok).toBe(false);
    const ok = demoConfigFrom({}, { repo: "bookshelf" });
    expect(ok.ok && ok.config.pristine).toBe("bookshelf-pristine");
  });
});
