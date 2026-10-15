// demo-loop: keeps a public Forge repo alive for spectators. One cycle
// replays the scripted Bookshelf scenario (scripts/forge-agents.mjs +
// forge-director stages 1-5) against the real Forge REST API, waits for
// trains to settle, holds the result on screen, then resets trunk from a
// pristine snapshot and starts over.
//
//   reset  -> abandon live intents, delete the forks this loop created,
//             delete trunk, fork the pristine snapshot back to trunk
//   wait   -> the fork finishes (Artifacts forks are asynchronous)
//   seed   -> plan_goal x3 (the seed goals)
//   work   -> one step per tick, round-robin over a window of agents:
//             declare (+ notes to overlaps) -> claim -> clone/apply/commit/
//             push/report_push -> mark_ready. The protected intent stops
//             at awaiting_plan (the inbox's "needs you" item).
//   settle -> replay the designed textual conflict (claim_conflict ->
//             re-derive on trunk -> resolve_conflict); wait for trains
//   hold   -> leave the finished map up for holdMs, then reset
//
// Budget guards: forks/hour and Artifacts ops/hour (estimated per call)
// pause the loop until the window rolls; cycles/day caps the total.
// Every tick is one bounded unit of work, driven by a DO alarm.
// Runtime-free: tests drive demoTick with fakes.

import { DemoApiError, type DemoForgeApi } from "./client.ts";
import { redactError, type DemoGit } from "./git.ts";
import { agentFor, DRIFT_INTENT, DRIFT_PATH, replayEdits, seedGoals, seedIntents, solutionFor } from "./scenario.ts";

export type Phase = "idle" | "reset" | "wait" | "seed" | "work" | "settle" | "hold";
export type Step = "pending" | "declared" | "claimed" | "pushed" | "ready" | "awaiting_plan" | "failed";

export interface DemoConfig {
  repo: string;
  pristine: string;
  crew: number;
  concurrency: number;
  paceMs: number;
  settleMaxMs: number;
  holdMs: number;
  maxForksPerHour: number;
  maxOpsPerHour: number;
  maxCyclesPerDay: number;
}

export const DEFAULT_DEMO_CONFIG: Omit<DemoConfig, "repo" | "pristine"> = {
  crew: 6,
  concurrency: 6,
  paceMs: 5_000,
  settleMaxMs: 20 * 60_000,
  holdMs: 5 * 60_000,
  maxForksPerHour: 40,
  maxOpsPerHour: 800,
  maxCyclesPerDay: 48,
};

export interface WorkItem {
  seedId: string;
  agent: string;
  intentId: string | null;
  step: Step;
  forkRepo: string | null;
  // Fork credentials live only between claim and push (DO storage is
  // private; status() never returns them).
  remote: string | null;
  token: string | null;
  attempts: number;
  error: string | null;
}

export interface DemoState {
  config: DemoConfig;
  enabled: boolean;
  paused: boolean;
  phase: Phase;
  phaseStartedAt: number;
  cycle: number;
  cursor: number;
  goals: Record<string, string>;
  items: WorkItem[];
  forks: string[];
  resolved: string[];
  budget: { hourStart: number; forks: number; ops: number; dayStart: number; cycles: number };
  counters: { cyclesCompleted: number; declared: number; claims: number; pushes: number; ready: number; replays: number; errors: number };
  log: Array<{ at: string; msg: string }>;
  note: string;
}

export interface DemoArtifacts {
  status(name: string): Promise<"ready" | "missing" | "busy">;
  remove(name: string): Promise<boolean>;
  fork(source: string, target: string): Promise<void>;
  readToken(name: string): Promise<string>;
}

export interface DemoDeps {
  api: DemoForgeApi;
  git: DemoGit;
  artifacts: DemoArtifacts;
  now: () => number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIVE = new Set(["draft", "awaiting_plan", "claimed", "working", "ready", "in_train", "conflicted", "replaying", "bisected", "expired"]);
const BUSY = new Set(["ready", "in_train", "conflicted", "replaying", "bisected"]);
const DONE_STEPS = new Set<Step>(["ready", "awaiting_plan", "failed"]);
const MAX_ATTEMPTS = 3;
const PER_TICK = 20;

export function initDemoState(config: DemoConfig, now: number): DemoState {
  return {
    config,
    enabled: true,
    paused: false,
    phase: "reset",
    phaseStartedAt: now,
    cycle: 0,
    cursor: 0,
    goals: {},
    items: [],
    forks: [],
    resolved: [],
    budget: { hourStart: now, forks: 0, ops: 0, dayStart: now, cycles: 0 },
    counters: { cyclesCompleted: 0, declared: 0, claims: 0, pushes: 0, ready: 0, replays: 0, errors: 0 },
    log: [],
    note: "starting",
  };
}

export function demoConfigFrom(input: unknown, defaults: { repo: string }): { ok: true; config: DemoConfig } | { ok: false; message: string } {
  const b = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const repo = typeof b.repo === "string" && b.repo ? b.repo : defaults.repo;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(repo)) return { ok: false, message: "repo must be an Artifacts repo name" };
  const pristine = typeof b.pristine === "string" && b.pristine ? b.pristine : `${repo}-pristine`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(pristine) || pristine === repo) return { ok: false, message: "pristine must be a different Artifacts repo name" };
  const config: DemoConfig = { repo, pristine, ...DEFAULT_DEMO_CONFIG };
  const ints: Array<[keyof typeof DEFAULT_DEMO_CONFIG, number, number]> = [
    ["crew", 1, 13],
    ["concurrency", 1, 13],
    ["paceMs", 1_000, 120_000],
    ["settleMaxMs", 60_000, 3 * HOUR],
    ["holdMs", 0, 3 * HOUR],
    ["maxForksPerHour", 1, 500],
    ["maxOpsPerHour", 10, 10_000],
    ["maxCyclesPerDay", 1, 500],
  ];
  for (const [k, min, max] of ints) {
    const v = b[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return { ok: false, message: `${k} must be an integer ${min}-${max}` };
    config[k] = v;
  }
  return { ok: true, config };
}

function say(state: DemoState, now: number, msg: string): void {
  state.note = msg;
  state.log.push({ at: new Date(now).toISOString(), msg: msg.slice(0, 240) });
  if (state.log.length > 40) state.log.splice(0, state.log.length - 40);
}

function enter(state: DemoState, phase: Phase, now: number, msg: string): void {
  state.phase = phase;
  state.phaseStartedAt = now;
  say(state, now, msg);
}

function rollBudget(state: DemoState, now: number): void {
  if (now - state.budget.hourStart >= HOUR) {
    state.budget.hourStart = now;
    state.budget.forks = 0;
    state.budget.ops = 0;
  }
  if (now - state.budget.dayStart >= DAY) {
    state.budget.dayStart = now;
    state.budget.cycles = 0;
  }
}

function ops(state: DemoState, n: number): void {
  state.budget.ops += n;
}

// Public view: no fork credentials, ever.
export function demoStatus(state: DemoState | null, now: number): Record<string, unknown> {
  if (!state) return { enabled: false, phase: "idle", note: "not started (POST /demo-loop/start)" };
  const steps: Record<string, number> = {};
  for (const i of state.items) steps[i.step] = (steps[i.step] ?? 0) + 1;
  return {
    enabled: state.enabled,
    paused: state.paused,
    repo: state.config.repo,
    pristine: state.config.pristine,
    phase: state.phase,
    phaseForSeconds: Math.round((now - state.phaseStartedAt) / 1000),
    cycle: state.cycle,
    note: state.note,
    steps,
    items: state.items.map((i) => ({ seedId: i.seedId, agent: i.agent, intentId: i.intentId, step: i.step, forkRepo: i.forkRepo, error: i.error })),
    budget: {
      forksThisHour: state.budget.forks,
      maxForksPerHour: state.config.maxForksPerHour,
      artifactsOpsThisHour: state.budget.ops,
      maxOpsPerHour: state.config.maxOpsPerHour,
      cyclesToday: state.budget.cycles,
      maxCyclesPerDay: state.config.maxCyclesPerDay,
    },
    counters: state.counters,
    config: state.config,
    log: state.log.slice(-15),
  };
}

// One bounded unit of work. Returns the next alarm time, or null to stop
// (disabled, paused, or the daily cycle cap reached).
export async function demoTick(state: DemoState, deps: DemoDeps): Promise<number | null> {
  const now = deps.now();
  if (!state.enabled || state.paused) return null;
  rollBudget(state, now);
  const c = state.config;
  if (state.budget.ops >= c.maxOpsPerHour) {
    say(state, now, `budget: ${state.budget.ops}/${c.maxOpsPerHour} Artifacts ops this hour; waiting for the window`);
    return state.budget.hourStart + HOUR;
  }
  try {
    switch (state.phase) {
      case "idle":
        return null;
      case "reset":
        return await tickReset(state, deps, now);
      case "wait":
        return await tickWait(state, deps, now);
      case "seed":
        return await tickSeed(state, deps, now);
      case "work":
        return await tickWork(state, deps, now);
      case "settle":
        return await tickSettle(state, deps, now);
      case "hold":
        return tickHold(state, now);
    }
  } catch (err) {
    state.counters.errors++;
    say(state, now, `${state.phase}: ${redactError(err)}`);
    return now + Math.max(c.paceMs, 15_000);
  }
  return now + c.paceMs;
}

async function tickReset(state: DemoState, deps: DemoDeps, now: number): Promise<number> {
  const c = state.config;
  if (state.budget.cycles >= c.maxCyclesPerDay) {
    say(state, now, `daily cap: ${state.budget.cycles}/${c.maxCyclesPerDay} cycles; the finished map stays up until the day rolls`);
    return state.budget.dayStart + DAY;
  }
  // 1. Abandon every live intent (any agent: the loop's runner token can
  //    act as each owner by name).
  const live = (await deps.api.listIntents(c.repo)).filter((i) => LIVE.has(i.state));
  ops(state, 1);
  if (live.length) {
    for (const i of live.slice(0, PER_TICK)) {
      if (i.forkRepo && !state.forks.includes(i.forkRepo) && /^i-/.test(i.forkRepo)) state.forks.push(i.forkRepo);
      await deps.api.abandon(i.id, i.agent || "demo-loop").catch((e: unknown) => {
        if (!(e instanceof DemoApiError && (e.code === "stale_state" || e.code === "forge_not_found"))) throw e;
      });
    }
    say(state, now, `reset: abandoned ${Math.min(live.length, PER_TICK)} of ${live.length} live intent(s)`);
    return now + 1_000;
  }
  // 2. Delete the forks this loop created (tracked durably).
  if (state.forks.length) {
    const batch = state.forks.splice(0, PER_TICK);
    for (const f of batch) {
      ops(state, 1);
      await deps.artifacts.remove(f).catch(() => false);
    }
    say(state, now, `reset: deleted ${batch.length} fork repo(s), ${state.forks.length} left`);
    return now + 1_000;
  }
  // 3. Trunk from the pristine snapshot. First run: the operator just
  //    bootstrapped trunk (npm run forge:demo), so snapshot it instead.
  const [pristine, trunk] = await Promise.all([deps.artifacts.status(c.pristine), deps.artifacts.status(c.repo)]);
  ops(state, 2);
  if (pristine === "busy" || trunk === "busy") {
    say(state, now, "reset: waiting for a fork in progress");
    return now + 5_000;
  }
  if (pristine === "missing") {
    if (trunk === "missing") {
      state.enabled = false;
      enter(state, "idle", now, `stopped: neither ${c.repo} nor ${c.pristine} exists; bootstrap trunk with npm run forge:demo -- --repo ${c.repo}, then start again`);
      return now;
    }
    await deps.artifacts.fork(c.repo, c.pristine);
    ops(state, 1);
    enter(state, "wait", now, `snapshot: forking ${c.repo} -> ${c.pristine} (first run)`);
    return now + 5_000;
  }
  if (trunk === "ready") await deps.artifacts.remove(c.repo);
  await deps.artifacts.fork(c.pristine, c.repo);
  ops(state, 2);
  enter(state, "wait", now, `reset: trunk ${c.repo} re-forked from ${c.pristine}`);
  return now + 5_000;
}

async function tickWait(state: DemoState, deps: DemoDeps, now: number): Promise<number> {
  const c = state.config;
  const [pristine, trunk] = await Promise.all([deps.artifacts.status(c.pristine), deps.artifacts.status(c.repo)]);
  ops(state, 2);
  if (pristine === "ready" && trunk === "ready") {
    enter(state, "seed", now, "trunk ready");
    return now + 1_000;
  }
  if (now - state.phaseStartedAt > 10 * 60_000) {
    enter(state, "reset", now, `wait: ${c.repo}=${trunk} ${c.pristine}=${pristine} after 10 min; retrying reset`);
    return now + 30_000;
  }
  return now + 5_000;
}

async function tickSeed(state: DemoState, deps: DemoDeps, now: number): Promise<number> {
  const c = state.config;
  state.goals = {};
  for (const g of seedGoals()) {
    state.goals[g.id] = (await deps.api.createGoal(c.repo, g.text, "planner")).id;
  }
  state.items = seedIntents().map((it, n) => ({
    seedId: it.id,
    agent: agentFor(n, c.crew),
    intentId: null,
    step: "pending",
    forkRepo: null,
    remote: null,
    token: null,
    attempts: 0,
    error: null,
  }));
  state.cursor = 0;
  state.resolved = [];
  enter(state, "work", now, `cycle ${state.cycle}: ${seedGoals().length} goals, ${state.items.length} intents for ${c.crew} agents`);
  return now + c.paceMs;
}

function nextItem(state: DemoState): WorkItem | null {
  const open = state.items.filter((i) => !DONE_STEPS.has(i.step));
  if (!open.length) return null;
  const window = open.slice(0, state.config.concurrency);
  const item = window[state.cursor % window.length];
  state.cursor = (state.cursor + 1) % Math.max(1, window.length);
  return item;
}

async function tickWork(state: DemoState, deps: DemoDeps, now: number): Promise<number> {
  const c = state.config;
  const item = nextItem(state);
  if (!item) {
    const counts = state.items.reduce<Record<string, number>>((a, i) => ((a[i.step] = (a[i.step] ?? 0) + 1), a), {});
    enter(state, "settle", now, `all agents done (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}); trains landing`);
    return now + c.paceMs;
  }
  const seed = seedIntents().find((s) => s.id === item.seedId);
  if (!seed) {
    item.step = "failed";
    item.error = "unknown seed intent";
    return now + 1_000;
  }
  try {
    await advance(state, deps, item, seed, now);
    item.error = null;
  } catch (err) {
    item.attempts++;
    item.error = redactError(err);
    state.counters.errors++;
    const fatal = err instanceof DemoApiError && ["lease_lost", "not_owner", "intent_not_claimable", "goal_closed"].includes(err.code);
    if (fatal || item.attempts >= MAX_ATTEMPTS) {
      item.step = "failed";
      item.token = null;
      say(state, now, `${item.agent} gave up on ${item.seedId}: ${item.error}`);
    } else {
      say(state, now, `${item.agent} ${item.seedId} retry ${item.attempts}: ${item.error}`);
    }
  }
  // Rate-limited by the fork budget? Sleep until the hour rolls.
  if (state.budget.forks >= c.maxForksPerHour && state.items.some((i) => i.step === "declared")) {
    say(state, now, `budget: ${state.budget.forks}/${c.maxForksPerHour} forks this hour; waiting for the window`);
    return state.budget.hourStart + HOUR;
  }
  return now + c.paceMs;
}

async function advance(state: DemoState, deps: DemoDeps, item: WorkItem, seed: ReturnType<typeof seedIntents>[number], now: number): Promise<void> {
  const c = state.config;
  switch (item.step) {
    case "pending": {
      const d = await deps.api.declare({
        repo: c.repo,
        goalId: state.goals[seed.goal] ?? null,
        agent: item.agent,
        title: seed.title,
        reasoning: seed.reasoning,
        accept: seed.accept,
        footprint: seed.footprint,
      });
      item.intentId = d.intent.id;
      item.step = d.intent.state === "awaiting_plan" ? "awaiting_plan" : "declared";
      state.counters.declared++;
      for (const o of d.overlaps.slice(0, 2)) {
        await deps.api
          .sendNote(o.intentId, d.intent.id, item.agent, `${item.agent} on "${seed.title}" also touches ${seed.footprint.join(", ")}: ${seed.reasoning.split(". ")[0]}. I will keep to my own region; ping me if you change its shape.`)
          .catch(() => undefined);
      }
      say(state, now, `${item.agent} declared ${seed.id}${d.overlaps.length ? ` (overlaps ${d.overlaps.length})` : ""}${item.step === "awaiting_plan" ? " — protected path, waits for a human" : ""}`);
      return;
    }
    case "declared": {
      if (state.budget.forks >= c.maxForksPerHour) return;
      if (!item.intentId) throw new Error("no intent id");
      const claim = await deps.api.claim(item.intentId, item.agent);
      state.budget.forks++;
      ops(state, 2);
      item.forkRepo = claim.forkRepo;
      item.remote = claim.remote;
      item.token = claim.token;
      if (claim.forkRepo && !state.forks.includes(claim.forkRepo)) state.forks.push(claim.forkRepo);
      item.step = "claimed";
      state.counters.claims++;
      say(state, now, `${item.agent} claimed ${seed.id} -> fork ${claim.forkRepo}`);
      return;
    }
    case "claimed": {
      if (!item.intentId || !item.remote || !item.token) {
        // Credentials lost (e.g. a restart mid-cycle): re-claim.
        item.step = "declared";
        return;
      }
      const solution = solutionFor(seed.id);
      if (!solution) throw new Error(`no reference solution for ${seed.id}`);
      const pushed = await deps.git.commitAndPush({
        cloneUrl: item.remote,
        cloneToken: item.token,
        pushUrl: item.remote,
        pushToken: item.token,
        force: false,
        edits: solution.edits,
        append: seed.id === DRIFT_INTENT ? { path: DRIFT_PATH, text: `\n<!-- ${seed.id}: page-size note for the mobile client -->\n` } : undefined,
        summary: seed.title,
        body: seed.reasoning,
        trailers: { intent: item.intentId, agent: item.agent, goal: state.goals[seed.goal], session: item.forkRepo ?? undefined },
      });
      ops(state, 2);
      const rep = await deps.api.reportPush(item.intentId, item.agent, pushed.sha);
      item.token = null;
      item.remote = null;
      item.step = "pushed";
      state.counters.pushes++;
      say(state, now, `${item.agent} pushed ${seed.id} ${pushed.sha.slice(0, 10)}${rep.drift.length ? ` DRIFT ${rep.drift.join(",")}` : ""}`);
      return;
    }
    case "pushed": {
      if (!item.intentId) throw new Error("no intent id");
      const r = await deps.api.markReady(item.intentId, item.agent);
      item.step = "ready";
      state.counters.ready++;
      say(state, now, `${item.agent} marked ${seed.id} ready (route ${r.route})`);
      return;
    }
    default:
      return;
  }
}

async function tickSettle(state: DemoState, deps: DemoDeps, now: number): Promise<number> {
  const c = state.config;
  const bySeed = new Map(state.items.filter((i) => i.intentId).map((i) => [i.intentId as string, i.seedId]));
  const open = await deps.api.listConflicts(c.repo, "open");
  ops(state, 1);
  for (const k of open) {
    if (state.resolved.includes(k.id)) continue;
    const bSeed = bySeed.get(k.intentB);
    const aSeed = bySeed.get(k.intentA);
    const edits = bSeed && aSeed ? replayEdits(bSeed, aSeed) : null;
    if (!edits || !bSeed || !aSeed) continue;
    state.resolved.push(k.id);
    const r = await deps.api.claimConflict(k.id, "resolver");
    if (!r.remote || !r.token) throw new Error("claim_conflict returned no replay remote/token");
    // Re-derive on the CURRENT trunk (same host, trunk repo name).
    const trunkRemote = r.remote.replace(/\/[^/]+\.git$/, `/${c.repo}.git`);
    const readToken = await deps.artifacts.readToken(c.repo);
    const seed = seedIntents().find((s) => s.id === bSeed);
    const pushed = await deps.git.commitAndPush({
      cloneUrl: trunkRemote,
      cloneToken: readToken,
      pushUrl: r.remote,
      pushToken: r.token,
      force: true,
      edits,
      summary: `${seed?.title ?? bSeed} (replayed on ${aSeed})`,
      body: `${seed?.reasoning ?? ""}\nReplayed on the new trunk with ${aSeed}'s change in place.`,
      trailers: { intent: r.intentId, agent: "resolver", goal: seed ? state.goals[seed.goal] : undefined, session: r.forkRepo },
    });
    ops(state, 4);
    await deps.api.resolveConflict(k.id, "resolver", pushed.sha);
    state.counters.replays++;
    say(state, now, `resolver replayed ${bSeed} on ${aSeed} (${pushed.sha.slice(0, 10)}); it rides the next train`);
    return now + c.paceMs;
  }
  const intents = await deps.api.listIntents(c.repo);
  ops(state, 1);
  const moving = intents.filter((i) => BUSY.has(i.state)).length;
  const landed = intents.filter((i) => i.state === "landed").length;
  if (moving === 0 || now - state.phaseStartedAt > c.settleMaxMs) {
    enter(state, "hold", now, `settled: ${landed} landed, ${moving} still moving; holding for ${Math.round(c.holdMs / 60_000)} min`);
    return now + Math.max(1_000, c.holdMs);
  }
  state.note = `settling: ${landed} landed, ${moving} moving`;
  return now + 10_000;
}

function tickHold(state: DemoState, now: number): number | null {
  const c = state.config;
  // Hold time is measured from entering hold.
  if (now - state.phaseStartedAt < c.holdMs) return state.phaseStartedAt + c.holdMs;
  state.counters.cyclesCompleted++;
  state.budget.cycles++;
  state.cycle++;
  enter(state, "reset", now, `cycle ${state.cycle}: resetting`);
  return now + 1_000;
}
