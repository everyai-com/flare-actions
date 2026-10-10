// Train core: the pure rules of Flare Forge trains (docs/COMPETITION-PLAN.md
// §3, docs/FORGE.md "Trains"). A train group is a batch of ready intents
// split into footprint-disjoint lanes. Lanes are stacked (lane i is built
// on lane i-1's head) and every lane head is CI-verified as that exact
// SHA, so the longest green prefix can land with zero extra CI; a red
// lane is bisected into child trains and the lanes behind it are
// requeued.
//
// Speculative stacked trains (Zuul dependent pipeline / Uber SubmitQueue
// speculation): up to `lanes.speculation_depth` groups may be in flight
// at once. Each new group is cut on top of the in-flight chain's
// speculative head (assuming everything ahead of it passes), so the
// active lanes always form ONE linear chain: main <- g0 lanes <- g1
// lanes <- ... Every lane is still verified as its exact SHA; main
// fast-forwards only through a contiguous green prefix of the chain
// (invariant 2), and a red lane invalidates every lane behind it in
// every descendant group (requeued without blame, then rebuilt).
//
// Runtime-free: no I/O, no clocks, no randomness. train.ts executes these
// decisions against D1 + git; the simulator (apps/sim) and the property
// tests drive the same functions through `SpeculativeChain`.
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
// updating an existing ref sends only the delta). The pool is sized for
// speculation_depth x max_parallel (default 4 x 8 = 32) and is created
// once at repo bootstrap; the Worker never creates a ref. A train holds
// its slot (its `lane` column) until it leaves the active set.
export const MAX_LANE_REFS = 32;
export const LANE_REF_PREFIX = "forge/lane-";

export function laneRef(slot: number): string {
  return `${LANE_REF_PREFIX}${Math.max(0, Math.min(MAX_LANE_REFS - 1, Math.floor(slot)))}`;
}

// Every lane ref of the pool, in `refs/heads/...` form (bootstrap
// creates exactly these, all pointing at main).
export function laneRefPool(): string[] {
  return Array.from({ length: MAX_LANE_REFS }, (_, i) => `refs/heads/${laneRef(i)}`);
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
  // Left for a later train (over max_per_train, or no lane available).
  deferred: T[];
}

// Lanes per group: policy max_parallel, capped by the ref pool.
export function effectiveMaxParallel(policy: ForgePolicy): number {
  return Math.max(1, Math.min(MAX_LANE_REFS, policy.lanes.maxParallel));
}

// Groups in flight at once (1 = no speculation, one group at a time).
export const MAX_SPECULATION_DEPTH = 8;

export function effectiveSpeculationDepth(policy: ForgePolicy): number {
  const d = Math.floor(policy.lanes.speculationDepth);
  return Number.isFinite(d) ? Math.max(1, Math.min(MAX_SPECULATION_DEPTH, d)) : 1;
}

// Lane slots usable at once across every in-flight group: depth x
// max_parallel, capped by the ref pool.
export function lanePoolSize(policy: ForgePolicy): number {
  return Math.max(1, Math.min(MAX_LANE_REFS, effectiveMaxParallel(policy) * effectiveSpeculationDepth(policy)));
}

// The lowest `want` slots in [0, pool) not held by an active train,
// ascending (so lane order within a group = slot order).
export function freeSlots(used: readonly number[], pool: number, want: number): number[] {
  const taken = new Set(used);
  const out: number[] = [];
  for (let s = 0; s < pool && out.length < want; s++) if (!taken.has(s)) out.push(s);
  return out;
}

export interface CutCapacity {
  // Lane slots the next group may take (empty = no cut now).
  slots: number[];
  // True when the group would be stacked on an in-flight group.
  speculative: boolean;
}

// What the next cut may take, given the groups already in flight and the
// slots they hold: a free speculation level and at least one free ref.
export function cutCapacity(policy: ForgePolicy, activeGroups: number, usedSlots: readonly number[]): CutCapacity {
  const speculative = activeGroups > 0;
  if (activeGroups >= effectiveSpeculationDepth(policy)) return { slots: [], speculative };
  return { slots: freeSlots(usedSlots, lanePoolSize(policy), effectiveMaxParallel(policy)), speculative };
}

// Cut one train group from the ready queue: order, take max_per_train,
// partition into overlap components (a component never splits:
// overlapping intents merge sequentially in one lane), then pack the
// components into at most `maxLanes` lanes, least-full first. Nothing is
// dropped: whatever does not fit is deferred in queue order.
export function planTrain<T extends TrainCandidate>(
  candidates: readonly T[],
  policy: ForgePolicy,
  opts: { maxLanes?: number } = {},
): TrainPlan<T> {
  const ordered = orderCandidates(candidates);
  const want = opts.maxLanes === undefined ? effectiveMaxParallel(policy) : Math.floor(opts.maxLanes);
  const maxLanes = Math.max(0, Math.min(effectiveMaxParallel(policy), want));
  if (maxLanes === 0) return { lanes: [], deferred: ordered };
  const cap = Math.max(1, policy.lanes.maxPerTrain);
  const taken = ordered.slice(0, cap);
  const deferred = ordered.slice(cap);
  const comps = partitionLanes(taken);
  const lanes: T[][] = Array.from({ length: Math.min(maxLanes, comps.length) }, () => []);
  for (const comp of comps) {
    let best = 0;
    for (let i = 1; i < lanes.length; i++) if (lanes[i].length < lanes[best].length) best = i;
    lanes[best].push(...comp);
  }
  return { lanes, deferred };
}

// ---------------------------------------------------------------------------
// Deciding a stacked group / a speculative chain of groups
// ---------------------------------------------------------------------------

// green = CI success on the lane's exact head; red = terminal non-success;
// pending = not terminal yet (or not built yet); empty = every intent
// dropped (no head, no CI).
export type LaneOutcome = "green" | "red" | "pending" | "empty";

export interface StackDecision {
  // Still waiting on a lane that decides the rest.
  waiting: boolean;
  // Index of the last lane whose head may land now (-1 = nothing lands).
  // Every non-empty lane at or before it is green.
  landThrough: number;
  // First red lane (bisect it), or null.
  redLane: number | null;
  // Non-empty lanes after the red lane: their heads include the red
  // lane's changes, so they are requeued without blame.
  requeueLanes: number[];
}

// Chain decision over every active lane in chain order (group, then
// lane). Lands the longest contiguous green prefix NOW, even while lanes
// behind it are pending: each lane head is an exact, verified SHA whose
// ancestors are exactly the lanes before it, so fast-forwarding to it
// never needs the speculation further down. The first red lane (with
// everything before it green) is bisected and every non-empty lane
// behind it, in any descendant group, is invalidated.
export function decideChain(outcomes: readonly LaneOutcome[]): StackDecision {
  let landThrough = -1;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o === "empty") continue;
    if (o === "pending") return { waiting: true, landThrough, redLane: null, requeueLanes: [] };
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

// Single-group decision that waits for the whole stack (the
// pre-speculation rule; kept for simulateTrain and its tests).
export function decideStack(outcomes: readonly LaneOutcome[]): StackDecision {
  const d = decideChain(outcomes);
  return d.waiting ? { waiting: true, landThrough: -1, redLane: null, requeueLanes: [] } : d;
}

// Chain contiguity: every built lane must sit on the lane before it
// (base = previous head). The first lane whose base is not the previous
// head (a lane ahead was aborted by a sweep, a failed dispatch or a lost
// race) breaks the chain: it and every lane behind it carry commits that
// would land unverified, so they are invalidated. Returns that index, or
// null when the chain is intact.
export function chainBreak(lanes: ReadonlyArray<{ baseSha: string; headSha: string }>): number | null {
  for (let i = 1; i < lanes.length; i++) {
    if (lanes[i].baseSha.toLowerCase() !== lanes[i - 1].headSha.toLowerCase()) return i;
  }
  return null;
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
// Speculative chain (pure state machine)
// ---------------------------------------------------------------------------

// One lane of the chain. `parent` is the lane (id) this lane's head is
// stacked on, or the landed lane main pointed at when it was cut (-1 =
// the initial main): the stand-in for "base SHA" in the pure model.
export interface ChainLane<T> {
  id: number;
  group: number;
  slot: number;
  items: T[];
  outcome: LaneOutcome;
  parent: number;
  // Bisect bookkeeping: depth below the lane first cut, and that lane's
  // size (culprit isolation is bounded by ceil(log2 rootSize)).
  bisectDepth: number;
  rootSize: number;
}

export interface ChainStep<T> {
  // Lanes landed by this step, in order; main now points at the last.
  landed: ChainLane<T>[];
  red: ChainLane<T> | null;
  // A red single-intent lane names its culprit.
  culprit: T | null;
  // Lanes behind the red lane (any group): requeued without blame.
  invalidated: ChainLane<T>[];
  // Bisect children of the red lane: a new group at the chain head
  // (left stacked under right).
  children: ChainLane<T>[];
  waiting: boolean;
}

// The speculative pipeline the Worker runs over D1 rows, as a pure,
// in-memory state machine. The simulator drives it with simulated time;
// the property tests drive it with random CI orders. Landing enforces
// the exact-SHA rule: a lane may land only when its parent is what main
// points at (CAS); `unverifiedLands` counts violations and must stay 0.
export class SpeculativeChain<T> {
  readonly policy: ForgePolicy;
  lanes: ChainLane<T>[] = [];
  // Lane id main points at (-1 = initial main).
  tip = -1;
  unverifiedLands = 0;
  private nextId = 0;
  private nextGroup = 1;

  constructor(policy: ForgePolicy) {
    this.policy = policy;
  }

  get groups(): number {
    return new Set(this.lanes.map((l) => l.group)).size;
  }

  capacity(): CutCapacity {
    return cutCapacity(this.policy, this.groups, this.lanes.map((l) => l.slot));
  }

  private head(): number {
    return this.lanes.length ? this.lanes[this.lanes.length - 1].id : this.tip;
  }

  // Append a group on the chain head. Lanes past the free slots are not
  // added (callers plan with capacity().slots.length).
  addGroup(itemLanes: readonly T[][], bisectOf: ChainLane<T> | null = null): ChainLane<T>[] {
    const lanesIn = itemLanes.filter((l) => l.length > 0);
    const slots = bisectOf
      ? freeSlots(this.lanes.map((l) => l.slot), MAX_LANE_REFS, lanesIn.length)
      : this.capacity().slots;
    const group = this.nextGroup++;
    const out: ChainLane<T>[] = [];
    for (let i = 0; i < lanesIn.length && i < slots.length; i++) {
      const lane: ChainLane<T> = {
        id: this.nextId++,
        group,
        slot: slots[i],
        items: [...lanesIn[i]],
        outcome: "pending",
        parent: this.head(),
        bisectDepth: bisectOf ? bisectOf.bisectDepth + 1 : 0,
        rootSize: bisectOf ? bisectOf.rootSize : lanesIn[i].length,
      };
      this.lanes.push(lane);
      out.push(lane);
    }
    return out;
  }

  get(id: number): ChainLane<T> | null {
    return this.lanes.find((l) => l.id === id) ?? null;
  }

  // Items ahead of (and including) lane `id` that are still unlanded:
  // exactly what that lane's head contains on top of main.
  prefixItems(id: number): T[] {
    const out: T[] = [];
    for (const l of this.lanes) {
      out.push(...l.items);
      if (l.id === id) return out;
    }
    return out;
  }

  // Remove items from a lane before it is built (merge conflict, stale
  // stack). A lane left with nothing is dropped and the lanes stacked on
  // it re-point at its parent (they will be built on that head).
  dropItems(id: number, drop: (item: T) => boolean): void {
    const lane = this.get(id);
    if (!lane) return;
    lane.items = lane.items.filter((x) => !drop(x));
    if (lane.items.length) return;
    this.lanes = this.lanes.filter((l) => l.id !== id);
    for (const l of this.lanes) if (l.parent === id) l.parent = lane.parent;
  }

  setOutcome(id: number, outcome: LaneOutcome): void {
    const lane = this.get(id);
    if (lane) lane.outcome = outcome;
  }

  // Apply decideChain: land the green prefix (CAS-checked), bisect the
  // first red lane, invalidate everything behind it.
  decide(): ChainStep<T> {
    const d = decideChain(this.lanes.map((l) => l.outcome));
    const step: ChainStep<T> = { landed: [], red: null, culprit: null, invalidated: [], children: [], waiting: d.waiting };
    for (let i = 0; i <= d.landThrough; i++) {
      const lane = this.lanes[i];
      if (lane.outcome !== "green") continue;
      if (lane.parent !== this.tip) this.unverifiedLands++;
      this.tip = lane.id;
      step.landed.push(lane);
    }
    const rest = this.lanes.slice(d.landThrough + 1);
    if (d.redLane === null) {
      this.lanes = rest;
      return step;
    }
    const red = this.lanes[d.redLane];
    step.red = red;
    step.invalidated = d.requeueLanes.map((j) => this.lanes[j]);
    this.lanes = [];
    const b = bisectStep(red.items);
    if ("culprit" in b) step.culprit = b.culprit;
    else if ("halves" in b) step.children = this.addGroup(b.halves, red);
    return step;
  }
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
