// Train core: the pure rules of Flare Forge trains (docs/COMPETITION-PLAN.md
// §3, docs/FORGE.md "Trains"). A train is a batch of ready intents split
// into footprint-disjoint lanes. Lanes are stacked (lane i is built on
// lane i-1's head) and every lane head is CI-verified as that exact SHA,
// so the longest green prefix can land with zero extra CI; a red lane is
// bisected into child trains and the lanes behind it are requeued.
//
// Runtime-free: no I/O, no clocks, no randomness. train.ts executes these
// decisions against D1 + git; the tests exercise them exhaustively.
import {
  appendTrailers,
  bisect,
  partitionLanes,
  routeLanding,
  type ForgePolicy,
  type Footprint,
  type LandingRoute,
} from "./intents-core";

// Lanes push to fixed, pre-existing refs that are force-updated per train
// (spike S5: isomorphic-git pushing a NEW ref uploads the whole history;
// updating an existing ref sends only the delta). Eight refs cap the
// usable parallelism regardless of policy.max_parallel.
export const MAX_LANE_REFS = 8;
export const LANE_REF_PREFIX = "forge/lane-";

export function laneRef(lane: number): string {
  return `${LANE_REF_PREFIX}${Math.max(0, Math.min(MAX_LANE_REFS - 1, Math.floor(lane)))}`;
}

// ---------------------------------------------------------------------------
// Cutting a train
// ---------------------------------------------------------------------------

export interface TrainCandidate {
  id: string;
  footprint: Footprint;
  // When the intent became ready (ISO); older first.
  readyAt: string;
  // Higher lands first; default 0 (reserved for agent fast lanes).
  priority?: number;
}

// Deterministic queue order: priority DESC, then oldest ready first,
// then id (total order, so equal timestamps never reorder).
export function orderCandidates<T extends TrainCandidate>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    if (a.readyAt !== b.readyAt) return a.readyAt < b.readyAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface TrainPlan<T> {
  // Footprint-disjoint lanes, each in queue order; lane order = order of
  // each lane's oldest member.
  lanes: T[][];
  // Left for a later train (over max_per_train, or lanes past the cap).
  deferred: T[];
}

export function effectiveMaxParallel(policy: ForgePolicy): number {
  return Math.max(1, Math.min(MAX_LANE_REFS, policy.lanes.maxParallel));
}

// Cut one train from the ready queue: order, take max_per_train, then
// partition into lanes and keep at most max_parallel lanes (capped by
// the lane refs). Everything else is deferred, never dropped.
export function planTrain<T extends TrainCandidate>(candidates: readonly T[], policy: ForgePolicy): TrainPlan<T> {
  const ordered = orderCandidates(candidates);
  const cap = Math.max(1, policy.lanes.maxPerTrain);
  const taken = ordered.slice(0, cap);
  const deferred = ordered.slice(cap);
  const lanes = partitionLanes(taken);
  const maxLanes = effectiveMaxParallel(policy);
  const kept = lanes.slice(0, maxLanes);
  for (const lane of lanes.slice(maxLanes)) deferred.push(...lane);
  return { lanes: kept, deferred: orderCandidates(deferred) };
}

// ---------------------------------------------------------------------------
// Deciding a stacked group of lanes
// ---------------------------------------------------------------------------

// green = CI success on the lane's exact head; red = terminal non-success;
// pending = not terminal yet; empty = every intent dropped (no head, no CI).
export type LaneOutcome = "green" | "red" | "pending" | "empty";

export interface StackDecision {
  // Still waiting on a lane that decides the outcome.
  waiting: boolean;
  // Index of the last lane whose head may land (-1 = nothing lands).
  // Every non-empty lane at or before it is green.
  landThrough: number;
  // First red lane (bisect it), or null.
  redLane: number | null;
  // Non-empty lanes after the red lane: their heads include the red
  // lane's changes, so they are requeued without blame.
  requeueLanes: number[];
}

// Lane i's head contains lanes 0..i, so lane i green proves the whole
// prefix green as that exact SHA (invariant 2). Decide as soon as the
// first red lane is terminal or every lane is green.
export function decideStack(outcomes: readonly LaneOutcome[]): StackDecision {
  let landThrough = -1;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o === "empty") continue;
    if (o === "pending") return { waiting: true, landThrough: -1, redLane: null, requeueLanes: [] };
    if (o === "green") {
      landThrough = i;
      continue;
    }
    const requeueLanes: number[] = [];
    for (let j = i + 1; j < outcomes.length; j++) if (outcomes[j] !== "empty") requeueLanes.push(j);
    return { waiting: false, landThrough, redLane: i, requeueLanes };
  }
  return { waiting: false, landThrough, redLane: null, requeueLanes: [] };
}

// ---------------------------------------------------------------------------
// Bisect
// ---------------------------------------------------------------------------

export type BisectStep<T> = { culprit: T } | { halves: [T[], T[]] } | { nothing: true };

// A red lane of one intent names the culprit; a larger lane splits into
// two child trains (left stacked under right, so one CI round tests both
// halves: left red -> recurse left, requeue right; left green + right red
// -> land left, recurse right). Culprit isolated in <= ceil(log2 n) rounds.
export function bisectStep<T>(lane: readonly T[]): BisectStep<T> {
  if (lane.length === 0) return { nothing: true };
  if (lane.length === 1) return { culprit: lane[0] };
  const [left, right] = bisect(lane);
  return { halves: [left, right] };
}

export function maxBisectRounds(n: number): number {
  return n <= 1 ? 0 : Math.ceil(Math.log2(n));
}

// Pure model of a train's life used by property tests and docs: lanes
// are stacked; CI on a lane head is red iff the stack through it holds a
// culprit. Returns which ids land, fail, or are requeued (the requeued
// ones would ride a later train), plus the CI rounds spent.
export interface SimulationResult {
  landed: string[];
  failed: string[];
  requeued: string[];
  rounds: number;
}

export function simulateTrain(lanes: readonly (readonly string[])[], culprits: ReadonlySet<string>): SimulationResult {
  const out: SimulationResult = { landed: [], failed: [], requeued: [], rounds: 0 };
  let group: string[][] = lanes.map((l) => [...l]);
  // Bounded: each round either finishes or halves the red set.
  for (let guard = 0; group.length > 0 && guard < 64; guard++) {
    out.rounds += 1;
    let poisoned = false;
    const outcomes: LaneOutcome[] = group.map((lane) => {
      if (lane.length === 0) return "empty";
      if (lane.some((id) => culprits.has(id))) poisoned = true;
      return poisoned ? "red" : "green";
    });
    const d = decideStack(outcomes);
    for (let i = 0; i <= d.landThrough; i++) out.landed.push(...group[i]);
    for (const j of d.requeueLanes) out.requeued.push(...group[j]);
    if (d.redLane === null) break;
    const step = bisectStep(group[d.redLane]);
    if ("culprit" in step) {
      out.failed.push(step.culprit);
      break;
    }
    if ("nothing" in step) break;
    group = [step.halves[0], step.halves[1]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Landing gate + review routing
// ---------------------------------------------------------------------------

// Deterministic audit roll in [0, 1) from the intent id (FNV-1a), so a
// re-evaluated intent always routes the same way.
export function auditRoll(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // murmur3 fmix32 avalanche: FNV's high bits are weak on similar ids.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

export interface LandingGate {
  route: LandingRoute;
  // True when the intent must stay out of trains (human route, no approval).
  held: boolean;
}

// 'human' routed intents never ride a train until a human approves the
// landing; 'audit' and 'auto' ride now (audit is reviewed after landing).
export function landingGate(risk: number, policy: ForgePolicy, id: string, approved: boolean): LandingGate {
  const route = routeLanding(risk, policy, auditRoll(id));
  return { route, held: route === "human" && !approved };
}

// ---------------------------------------------------------------------------
// Squashed commit message + deterministic identity
// ---------------------------------------------------------------------------

export const REASONING_SUMMARY_CHARS = 600;

export interface SquashInput {
  intentId: string;
  title: string;
  reasoning: string;
  agent: string;
  goalId: string | null;
  session: string;
}

// One squashed commit per intent: title, a bounded reasoning summary,
// then Flare trailers (goal/intent/agent/session).
export function squashMessage(input: SquashInput): string {
  const title = input.title.replace(/[\r\n]+/g, " ").trim().slice(0, 200) || `intent ${input.intentId.slice(0, 8)}`;
  let summary = input.reasoning.trim();
  if (summary.length > REASONING_SUMMARY_CHARS) summary = `${summary.slice(0, REASONING_SUMMARY_CHARS - 1).trimEnd()}…`;
  const body = summary ? `${title}\n\n${summary}` : title;
  return appendTrailers(body, {
    goal: input.goalId ?? "",
    intent: input.intentId,
    agent: input.agent,
    session: input.session,
  });
}

// Git identity for agent commits: the agent slug under a reserved domain.
export function agentIdentity(agent: string): { name: string; email: string } {
  const slug = agent.replace(/[^\w.-]/g, "").slice(0, 40) || "agent";
  return { name: slug, email: `${slug}@agents.flare.invalid` };
}

export const TRAIN_COMMITTER = { name: "Flare Train", email: "train@flare.invalid" } as const;

// Commit timestamps derive from the train's creation time, so a retried
// build step reproduces byte-identical commits (same SHAs, idempotent
// pushes) instead of minting new ones.
export function trainTimestamp(createdAtIso: string): number {
  const ms = Date.parse(createdAtIso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// ---------------------------------------------------------------------------
// Fetch depth + polling backoff
// ---------------------------------------------------------------------------

// Shallow fetches deepen until every intent's base commit is present
// (merge bases must be reachable); bounded, never unbounded history.
export const FETCH_DEPTHS = [50, 200, 1000] as const;

export function nextFetchDepth(current: number | null): number | null {
  if (current === null) return FETCH_DEPTHS[0];
  for (const d of FETCH_DEPTHS) if (d > current) return d;
  return null;
}

// CI wait backoff: 10s, 20s, 40s ... capped at 2 min; at most
// MAX_CI_POLLS polls (~1h) before the train is declared stuck.
export const MAX_CI_POLLS = 40;

export function pollBackoffSeconds(poll: number): number {
  return Math.min(120, 10 * 2 ** Math.max(0, Math.min(10, poll)));
}

// Bounded train rounds per Workflow instance: bisect rounds for a full
// train plus a few rebuilds when main moved under a green train.
export const MAX_REBUILDS = 3;

export function maxTrainRounds(policy: ForgePolicy): number {
  return maxBisectRounds(policy.lanes.maxPerTrain) + MAX_REBUILDS + 2;
}
