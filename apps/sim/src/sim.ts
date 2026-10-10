// Deterministic discrete-event simulator for the Forge benchmark
// (COMPETITION-PLAN §5). Three modes over the identical workload:
//
//   baseline: branch + PR. The PR's own CI runs on the branch, a human
//             reviews every PR, then a serial merge queue lands one PR
//             at a time with CI on the exact merged SHA. A PR that
//             textually conflicts with what landed since its base is
//             bounced; the author rebases (redoes part of the work),
//             gets re-approved, and rejoins the back of the queue.
//   trains:   the same PR + review flow, but the queue ships trains:
//             ready changes are batched, split into lanes with the
//             shipped partitionLanes, CI runs once per lane on the
//             combined SHA, and red lanes are bisected with the shipped
//             bisect. Conflicts still bounce to the author. No
//             declare-time overlap information.
//   forge:    full Forge. The declare-time overlap query gives each
//             intent after: edges to the live intents it overlaps; the
//             planner stacks it on their pushed heads (bounded wait) so
//             that overlap never becomes a conflict. Lanes + bisect as
//             in trains; conflicts go to an LLM replay first (Merge-
//             Bench success rate) and escalate to a human only when the
//             replay budget is spent. Review is risk-routed with the
//             shipped scoreRisk + routeLanding (auto / audit sample /
//             human); protected paths need a plan approval up front.
//
// The overlap, lane, bisect and risk logic is the SHIPPED code in
// apps/worker/src/intents-core.ts. The simulator only supplies time and
// randomness.
//
// Everything here is SIMULATED. No number produced by this module is a
// measurement of a real system.

import {
  bisect,
  footprintsOverlap,
  partitionLanes,
  routeLanding,
  scoreRisk,
} from "../../worker/src/intents-core.ts";
import { DEFAULT_CONSTANTS, type DurationDist, type SimConstants } from "./constants.ts";
import { bernoulli, lognormal, percentile, rngFor, type Rng } from "./prng.ts";
import { generateWorkload, type SimIntent, type Workload } from "./workload.ts";

export const MODES = ["baseline", "trains", "forge"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  baseline: "Baseline: branch + PR + serial queue",
  trains: "Forge, trains only",
  forge: "Forge, full",
};

export interface HumanMinutes {
  review: number;
  rereview: number;
  planApproval: number;
  audit: number;
  escalation: number;
}

export interface ModeMetrics {
  mode: Mode;
  agents: number;
  landed: number;
  abandoned: number;
  makespanMin: number;
  landedPerMin: number;
  declareToLandP50Min: number;
  declareToLandP95Min: number;
  // Minutes from the first declare until 80% of ALL agents' intents had
  // landed (NaN if fewer than 80% ever land). Throughput without the
  // long tail of stragglers that `landedPerMin` includes.
  timeTo80PctMin: number;
  conflictsEncountered: number;
  conflictsAvoided: number;
  stackedIntents: number;
  restacks: number;
  replaysAttempted: number;
  replaysSucceeded: number;
  brokenMainMin: number;
  escapedDefects: number;
  humanReviewMin: number;
  human: HumanMinutes;
  routes: { auto: number; audit: number; human: number };
  ciRuns: number;
  trains: number;
  bisections: number;
  flakeReruns: number;
  artifactsOps: number | null;
  artifactsDollars: number | null;
  wallMs: number;
}

// ---------------------------------------------------------------------------
// Event queue: binary min-heap on (time, seq). seq keeps same-time events
// FIFO so runs are deterministic.
// ---------------------------------------------------------------------------

interface Ev {
  t: number;
  seq: number;
  fn: () => void;
}

function less(a: Ev, b: Ev): boolean {
  return a.t < b.t || (a.t === b.t && a.seq < b.seq);
}

export class EventQueue {
  private heap: Ev[] = [];
  private seq = 0;
  now = 0;

  at(t: number, fn: () => void): void {
    const ev: Ev = { t: Math.max(t, this.now), seq: this.seq++, fn };
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p], h[i])) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }

  get size(): number {
    return this.heap.length;
  }

  run(): void {
    const h = this.heap;
    while (h.length > 0) {
      const top = h[0];
      const last = h.pop() as Ev;
      if (h.length > 0) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < h.length && less(h[l], h[m])) m = l;
          if (r < h.length && less(h[r], h[m])) m = r;
          if (m === i) break;
          [h[m], h[i]] = [h[i], h[m]];
          i = m;
        }
      }
      this.now = top.t;
      top.fn();
    }
  }
}

// ---------------------------------------------------------------------------
// Per-run state
// ---------------------------------------------------------------------------

type Status = "waiting" | "working" | "ci" | "review" | "ready" | "parked" | "inflight" | "landed" | "abandoned";

interface Stack {
  p: RunIntent;
  v: number; // predecessor content version this intent is built on
}

interface RunIntent {
  w: SimIntent;
  allFiles: Int32Array; // declared + drift (what the diff really touches)
  status: Status;
  base: number; // time of the trunk snapshot the change is built on
  defect: SimIntent["defect"];
  interaction: boolean;
  version: number; // bumps on every rework/replay (content changed)
  pushed: boolean; // has a pushed head others can stack on
  rebases: number;
  fixes: number;
  conflicts: number;
  replaysThisConflict: number;
  llmReplay: boolean;
  reviewedOnce: boolean;
  landedAt: number;
  readyGen: number;
  // forge planner
  preds: RunIntent[];
  waiters: RunIntent[];
  gateOpen: boolean;
  started: boolean;
  stacks: Stack[];
  // Ready intents stacked on this one, parked until it rides a train.
  parked: RunIntent[];
  priority: boolean; // next ready goes to the front of the queue
}

interface LandEntry {
  t: number;
  it: RunIntent;
  v: number;
}

class Sim {
  readonly q = new EventQueue();
  readonly c: SimConstants;
  readonly mode: Mode;
  readonly items: RunIntent[];
  private readonly fileLands: Array<LandEntry[] | undefined>;
  private readonly inflight: Int32Array;
  private readonly liveByFile = new Map<number, RunIntent>();
  private readonly redIntervals: Array<[number, number]> = [];
  private readonly rng: Record<"ci" | "flake" | "conflict" | "rework" | "route" | "replay" | "cf", Rng>;
  private readyQ: Array<{ it: RunIntent; gen: number }> = [];
  private readyHead = 0;
  // Forge: intents re-derived by a replay keep their place in line.
  private priorityQ: Array<{ it: RunIntent; gen: number }> = [];
  private freeSlots: number;
  private serialQ: RunIntent[] = [];
  private serialHead = 0;
  private serialBusy = false;

  readonly m: ModeMetrics;

  constructor(workload: Workload, mode: Mode, c: SimConstants) {
    this.c = c;
    this.mode = mode;
    this.fileLands = Array.from({ length: workload.fileCount }, () => undefined);
    this.inflight = new Int32Array(workload.fileCount);
    this.freeSlots = c.policy.lanes.maxParallel;
    const s = (label: string): Rng => rngFor(workload.seed, `${mode}:${label}`);
    this.rng = {
      ci: s("ci"),
      flake: s("flake"),
      conflict: s("conflict"),
      rework: s("rework"),
      route: s("route"),
      replay: s("replay"),
      cf: s("counterfactual"),
    };
    this.items = workload.intents.map((w) => ({
      w,
      allFiles: w.driftFiles.length ? Int32Array.from([...w.files, ...w.driftFiles]) : w.files,
      status: "waiting",
      base: 0,
      defect: w.defect,
      interaction: w.interaction,
      version: 0,
      pushed: false,
      rebases: 0,
      fixes: 0,
      conflicts: 0,
      replaysThisConflict: 0,
      llmReplay: false,
      reviewedOnce: false,
      landedAt: Number.NaN,
      readyGen: 0,
      preds: [],
      waiters: [],
      gateOpen: false,
      started: false,
      stacks: [],
      parked: [],
      priority: false,
    }));
    this.m = {
      mode,
      agents: workload.agents,
      landed: 0,
      abandoned: 0,
      makespanMin: 0,
      landedPerMin: 0,
      declareToLandP50Min: Number.NaN,
      declareToLandP95Min: Number.NaN,
      timeTo80PctMin: Number.NaN,
      conflictsEncountered: 0,
      conflictsAvoided: 0,
      stackedIntents: 0,
      restacks: 0,
      replaysAttempted: 0,
      replaysSucceeded: 0,
      brokenMainMin: 0,
      escapedDefects: 0,
      humanReviewMin: 0,
      human: { review: 0, rereview: 0, planApproval: 0, audit: 0, escalation: 0 },
      routes: { auto: 0, audit: 0, human: 0 },
      ciRuns: 0,
      trains: 0,
      bisections: 0,
      flakeReruns: 0,
      artifactsOps: mode === "baseline" ? null : 0,
      artifactsDollars: null,
      wallMs: 0,
    };
  }

  run(): ModeMetrics {
    for (const it of this.items) this.q.at(it.w.declareAt, () => this.onDeclare(it));
    this.q.run();
    return this.finish();
  }

  // --- helpers ---------------------------------------------------------------

  private dur(d: DurationDist, rng: Rng): number {
    return lognormal(rng, d.median, d.sigma);
  }

  private ops(n: number): void {
    if (this.m.artifactsOps !== null) this.m.artifactsOps += n;
  }

  private human(kind: keyof HumanMinutes, minutes: number): void {
    this.m.human[kind] += minutes;
    this.m.humanReviewMin += minutes;
  }

  private shared(a: RunIntent, b: RunIntent): number {
    let n = 0;
    for (const f of a.allFiles) if (b.allFiles.includes(f)) n++;
    return n;
  }

  private stackedOn(it: RunIntent, p: RunIntent, v: number): boolean {
    for (const s of it.stacks) if (s.p === p && s.v === v) return true;
    return false;
  }

  // Trunk changes to this intent's files since its base, excluding the
  // landings of predecessors it is stacked on (it already contains them).
  private landedSince(it: RunIntent): number {
    let n = 0;
    for (const f of it.allFiles) {
      const arr = this.fileLands[f];
      if (!arr || arr.length === 0) continue;
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid].t <= it.base) lo = mid + 1;
        else hi = mid;
      }
      if (it.stacks.length === 0) {
        n += arr.length - lo;
        continue;
      }
      for (let i = lo; i < arr.length; i++) if (!this.stackedOn(it, arr[i].it, arr[i].v)) n++;
    }
    return n;
  }

  private conflictDraw(shared: number, rng: Rng = this.rng.conflict): boolean {
    if (shared <= 0) return false;
    return rng.next() < 1 - Math.pow(1 - this.c.pConflictPerSharedFile, shared);
  }

  // Callers release in-flight file marks before abandoning.
  private abandon(it: RunIntent): void {
    it.status = "abandoned";
    it.pushed = false;
    this.m.abandoned++;
    this.releaseLive(it);
    this.unpark(it);
  }

  // --- declare + planner -----------------------------------------------------

  private onDeclare(it: RunIntent): void {
    if (this.mode !== "forge") {
      this.startWork(it);
      return;
    }
    // Declare-time overlap query (the Coordinator's job): the latest live
    // intent on each declared file becomes a predecessor (after: edge),
    // confirmed with the shipped footprintsOverlap.
    const cands = new Set<RunIntent>();
    for (const f of it.w.files) {
      const live = this.liveByFile.get(f);
      if (live) cands.add(live);
    }
    for (const p of cands) {
      if (!footprintsOverlap(it.w.footprint, p.w.footprint)) continue;
      it.preds.push(p);
      p.waiters.push(it);
    }
    for (const f of it.w.files) this.liveByFile.set(f, it);
    const openGate = (): void => {
      it.gateOpen = true;
      if (this.predsSatisfied(it)) {
        this.startWork(it);
        return;
      }
      this.q.at(this.q.now + this.c.afterWaitMaxMin, () => this.startWork(it));
    };
    if (it.w.protectedHit) {
      // Protected path: awaiting_plan until a human approves the plan.
      this.human("planApproval", this.c.planApprovalMin);
      this.q.at(this.q.now + it.w.planLatency, openGate);
    } else {
      openGate();
    }
  }

  private predsSatisfied(it: RunIntent): boolean {
    for (const p of it.preds) {
      if (p.status === "landed" || p.status === "abandoned" || p.pushed) continue;
      return false;
    }
    return true;
  }

  private notifyWaiters(p: RunIntent): void {
    for (const w of p.waiters) {
      if (!w.started && w.gateOpen && this.predsSatisfied(w)) this.startWork(w);
    }
  }

  private startWork(it: RunIntent): void {
    if (it.started) return;
    const t = this.q.now;
    it.started = true;
    it.status = "working";
    it.base = t;
    this.ops(this.c.opsPerIntent);
    if (this.mode === "forge" && it.preds.length) {
      for (const p of it.preds) {
        if (p.status === "abandoned") continue;
        if (p.status !== "landed") {
          if (!p.pushed) continue; // not ready in time: edge dropped
          it.stacks.push({ p, v: p.version });
        }
        // This overlap can no longer become a conflict between the two.
        // Counted as avoided only when the same per-shared-file draw says
        // it would have conflicted had both worked from the same base.
        if (this.conflictDraw(this.shared(it, p), this.rng.cf)) this.m.conflictsAvoided++;
      }
      if (it.stacks.length) this.m.stackedIntents++;
    }
    this.q.at(t + it.w.workMin, () => this.onWorkDone(it));
  }

  private onWorkDone(it: RunIntent): void {
    if (it.status === "abandoned") return;
    it.pushed = true;
    if (this.mode === "forge") this.notifyWaiters(it);
    this.branchCi(it);
  }

  // The change's own CI (branch / fork) before review or ready.
  private branchCi(it: RunIntent): void {
    it.status = "ci";
    this.m.ciRuns++;
    const d = this.dur(this.c.ci, this.rng.ci);
    const flake = bernoulli(this.rng.flake, this.c.pFlake);
    this.q.at(this.q.now + d, () => {
      if (it.defect === "caught") {
        this.fix(it, "defect");
        return;
      }
      if (flake) {
        this.m.flakeReruns++;
        this.branchCi(it);
        return;
      }
      this.postVerify(it);
    });
  }

  private postVerify(it: RunIntent): void {
    if (this.mode === "forge") {
      this.routeAndReady(it);
      return;
    }
    it.status = "review";
    const first = !it.reviewedOnce;
    it.reviewedOnce = true;
    if (first) this.human("review", this.c.reviewMin);
    else this.human("rereview", this.c.rereviewMin);
    const latency = first ? it.w.reviewLatency : this.dur(this.c.rereviewLatency, this.rng.rework);
    this.q.at(this.q.now + latency, () => {
      if (this.mode === "baseline") this.serialEnqueue(it);
      else this.toReady(it);
    });
  }

  // Forge: score risk with the shipped scorer and route the landing.
  private routeAndReady(it: RunIntent): void {
    const { risk } = scoreRisk({
      footprint: it.w.footprint,
      actualFootprint: it.w.actualFootprint,
      policy: this.c.policy,
      llmReplay: it.llmReplay,
      weakEvidence: it.w.weakEvidence,
      reviewerDisagrees: it.w.reviewerDisagrees,
    });
    const route = routeLanding(risk, this.c.policy, this.rng.route.next());
    this.m.routes[route]++;
    if (route === "human") {
      it.status = "review";
      const first = !it.reviewedOnce;
      it.reviewedOnce = true;
      this.human(first ? "review" : "rereview", first ? this.c.reviewMin : this.c.rereviewMin);
      const latency = first ? it.w.reviewLatency : this.dur(this.c.rereviewLatency, this.rng.rework);
      this.q.at(this.q.now + latency, () => this.toReady(it));
      return;
    }
    // The audit sample is reviewed after the fact: minutes, never a block.
    if (route === "audit") this.human("audit", this.c.auditMin);
    this.toReady(it);
  }

  // --- rework paths ------------------------------------------------------------

  // Author rebases onto current trunk and redoes part of the work, then
  // re-runs CI and goes back through review (baselines) or routing.
  private rework(it: RunIntent, escalated: boolean): void {
    const t = this.q.now;
    it.status = "working";
    it.pushed = false;
    it.version++;
    it.base = t;
    if (escalated) it.llmReplay = false;
    this.ops(this.c.opsPerExtraPush);
    this.q.at(t + it.w.workMin * this.c.reworkFactor, () => this.onWorkDone(it));
  }

  private fix(it: RunIntent, kind: "defect" | "interaction"): void {
    it.fixes++;
    if (it.fixes > this.c.maxFixes) {
      this.abandon(it);
      return;
    }
    if (kind === "defect") it.defect = "none";
    else it.interaction = false;
    this.rework(it, false);
  }

  private onConflict(it: RunIntent): void {
    this.m.conflictsEncountered++;
    it.conflicts++;
    if (it.conflicts > this.c.maxConflicts) {
      this.abandon(it);
      return;
    }
    if (this.mode !== "forge") {
      it.rebases++;
      if (it.rebases > this.c.maxRebases) this.abandon(it);
      else this.rework(it, false);
      return;
    }
    it.replaysThisConflict = 0;
    this.replayOrEscalate(it);
  }

  // A stacked predecessor changed (reworked, replayed, failed or was
  // abandoned) after this intent was built on it: re-derive on top of
  // its current head (or trunk) with the same replay machinery.
  private onRestack(it: RunIntent): void {
    this.m.restacks++;
    it.stacks = it.stacks.filter((s) => {
      if (s.p.status === "landed") return s.p.version === s.v;
      if (s.p.status === "abandoned" || !s.p.pushed) return false;
      s.v = s.p.version;
      return true;
    });
    it.replaysThisConflict = 0;
    this.replayOrEscalate(it);
  }

  private replayOrEscalate(it: RunIntent): void {
    const t = this.q.now;
    if (it.replaysThisConflict < this.c.policy.replay.maxAttempts) {
      it.replaysThisConflict++;
      it.status = "working";
      it.pushed = false;
      this.m.replaysAttempted++;
      const d = this.dur(this.c.replay, this.rng.replay);
      const ok = this.rng.replay.next() < this.c.replaySuccess;
      this.q.at(t + d, () => {
        if (!ok) {
          this.replayOrEscalate(it);
          return;
        }
        this.m.replaysSucceeded++;
        it.llmReplay = true;
        it.priority = true;
        it.version++;
        it.base = t; // re-derived on trunk as of the replay start
        this.ops(this.c.opsPerExtraPush);
        // A replay must pass CI like any other change.
        this.onWorkDone(it);
      });
      return;
    }
    // Replay budget spent: escalate to a human; the author reworks.
    this.human("escalation", this.c.escalationMin);
    it.rebases++;
    if (it.rebases > this.c.maxRebases) {
      this.abandon(it);
      return;
    }
    this.rework(it, true);
  }

  // --- baseline: serial queue ----------------------------------------------------

  private serialEnqueue(it: RunIntent): void {
    it.status = "ready";
    this.serialQ.push(it);
    if (!this.serialBusy) this.serialServe();
  }

  private serialServe(): void {
    if (this.serialHead > 4096 && this.serialHead * 2 > this.serialQ.length) {
      this.serialQ = this.serialQ.slice(this.serialHead);
      this.serialHead = 0;
    }
    if (this.serialHead >= this.serialQ.length) {
      this.serialBusy = false;
      return;
    }
    this.serialBusy = true;
    const it = this.serialQ[this.serialHead++];
    const t = this.q.now;
    if (this.conflictDraw(this.landedSince(it))) {
      this.onConflict(it);
      this.q.at(t + this.c.mergeMin, () => this.serialServe());
      return;
    }
    // Branch updated onto current main, then CI on that exact SHA.
    it.base = t;
    it.status = "inflight";
    this.m.ciRuns++;
    const d = this.dur(this.c.ci, this.rng.ci);
    const flake = bernoulli(this.rng.flake, this.c.pFlake);
    this.q.at(t + d, () => {
      if (!flake && !it.interaction) {
        this.q.at(this.q.now + this.c.mergeMin, () => {
          this.land(it);
          this.serialServe();
        });
        return;
      }
      if (it.interaction) this.fix(it, "interaction");
      else {
        this.m.flakeReruns++;
        // Kicked out of the queue; re-added at the back.
        this.q.at(this.q.now, () => this.serialEnqueue(it));
      }
      this.serialServe();
    });
  }

  // --- trains (trains + forge) -------------------------------------------------

  private toReady(it: RunIntent): void {
    it.status = "ready";
    it.readyGen++;
    if (it.priority) {
      it.priority = false;
      this.priorityQ.push({ it, gen: it.readyGen });
    } else this.readyQ.push({ it, gen: it.readyGen });
    this.tryCut();
  }

  private tryCut(): void {
    while (this.freeSlots > 0) {
      if (!this.cut(this.freeSlots)) return;
    }
  }

  // A stacked intent can ride a train only behind its predecessor: the
  // predecessor has landed, or was taken earlier in this same cut.
  private stackBlocker(it: RunIntent, taken: Set<RunIntent>): RunIntent | null {
    for (const s of it.stacks) {
      if (s.p.status === "landed" || s.p.status === "abandoned") continue;
      if (!taken.has(s.p)) return s.p;
    }
    return null;
  }

  private isBusy(it: RunIntent): boolean {
    for (const f of it.allFiles) if (this.inflight[f] > 0) return true;
    return false;
  }

  // Release intents parked behind `p` back to the ready queue.
  private unpark(p: RunIntent): void {
    const parked = p.parked;
    p.parked = [];
    for (const b of parked) if (b.status === "parked") this.toReady(b);
  }

  // Cut up to k lanes from the ready queue. Returns false when nothing
  // could be cut.
  private cut(k: number): boolean {
    const maxPer = this.c.policy.lanes.maxPerTrain;
    const cap = k * maxPer;
    const taken = new Set<RunIntent>();
    const candidates: RunIntent[] = [];
    const fromParked = new Set<RunIntent>();
    // Take an intent, then the intents parked behind it (stacked on it),
    // so a stack rides the same train in order.
    const take = (it: RunIntent): void => {
      taken.add(it);
      candidates.push(it);
      const parked = it.parked;
      it.parked = [];
      for (const b of parked) {
        if (b.status !== "parked") continue;
        if (candidates.length >= cap || this.isBusy(b)) {
          it.parked.push(b);
          continue;
        }
        const blocker = this.stackBlocker(b, taken);
        if (blocker) {
          blocker.parked.push(b);
          continue;
        }
        b.status = "ready";
        fromParked.add(b);
        take(b);
      }
    };
    let scanned = 0;
    this.priorityQ = this.priorityQ.filter((e) => e.gen === e.it.readyGen && e.it.status === "ready");
    const pn = this.priorityQ.length;
    for (let j = 0; j < pn + this.readyQ.length - this.readyHead && scanned < this.c.cutScanLimit; j++) {
      if (candidates.length >= cap) break;
      const e = j < pn ? this.priorityQ[j] : this.readyQ[this.readyHead + j - pn];
      if (e.gen !== e.it.readyGen || e.it.status !== "ready" || taken.has(e.it)) continue;
      scanned++;
      if (this.isBusy(e.it)) continue;
      const blocker = this.stackBlocker(e.it, taken);
      if (blocker) {
        // Park behind the predecessor; it re-enters with it (or when the
        // predecessor lands or is abandoned).
        e.it.status = "parked";
        blocker.parked.push(e.it);
        continue;
      }
      take(e.it);
    }
    if (candidates.length === 0) return false;

    // The shipped lane partitioner: connected components of the overlap
    // graph (on the diff's real footprint), members in queue order.
    const comps = partitionLanes(candidates.map((it) => ({ id: it.w.id, footprint: it.w.actualFootprint, it })));
    const lanes: RunIntent[][] = Array.from({ length: Math.min(k, comps.length) }, () => []);
    for (const comp of comps) {
      // Overlapping intents share a lane (sequential merge); a component
      // never splits across lanes. Oversized components ship their first
      // maxPerTrain members; the rest stay ready.
      const size = Math.min(comp.length, maxPer);
      let best: RunIntent[] | null = null;
      for (const lane of lanes) {
        if (lane.length + size > maxPer) continue;
        if (!best || lane.length < best.length) best = lane;
      }
      if (!best) continue;
      for (const x of comp.slice(0, size)) best.push(x.it);
    }
    let started = 0;
    for (const lane of lanes) {
      if (lane.length === 0) continue;
      this.startLane(lane);
      started++;
    }
    // Un-shipped intents pulled from a parking spot need a queue entry.
    for (const it of fromParked) {
      if (it.status !== "ready") continue;
      it.readyGen++;
      this.readyQ.push({ it, gen: it.readyGen });
    }
    while (this.readyHead < this.readyQ.length) {
      const e = this.readyQ[this.readyHead];
      if (e.gen === e.it.readyGen && e.it.status === "ready") break;
      this.readyHead++;
    }
    if (this.readyHead > 4096 && this.readyHead * 2 > this.readyQ.length) {
      this.readyQ = this.readyQ.slice(this.readyHead);
      this.readyHead = 0;
    }
    return started > 0;
  }

  private markInflight(it: RunIntent, delta: number): void {
    for (const f of it.allFiles) this.inflight[f] += delta;
  }

  private startLane(items: RunIntent[]): void {
    this.freeSlots--;
    this.m.trains++;
    const t = this.q.now;
    for (const it of items) {
      it.status = "inflight";
      this.markInflight(it, 1);
    }
    // Merge step: sequential merge in lane order onto trunk. A textual
    // conflict (against trunk since base, or an earlier item in this
    // lane) drops the item; so does a stale stack.
    const merged: RunIntent[] = [];
    const mergedSet = new Set<RunIntent>();
    const bounced: Array<{ it: RunIntent; restack: boolean }> = [];
    for (const it of items) {
      this.ops(this.c.opsPerLaneItem);
      let stale = false;
      for (const s of it.stacks) {
        if (s.p.status === "landed") {
          if (s.p.version !== s.v) stale = true;
        } else if (!mergedSet.has(s.p) || s.p.version !== s.v) stale = true;
      }
      if (stale) {
        bounced.push({ it, restack: true });
        continue;
      }
      let shared = this.landedSince(it);
      for (const m of merged) if (!this.stackedOn(it, m, m.version)) shared += this.shared(it, m);
      if (this.conflictDraw(shared)) {
        bounced.push({ it, restack: false });
        continue;
      }
      merged.push(it);
      mergedSet.add(it);
    }
    const mergedAt = t + this.c.trainMergeBaseMin + this.c.trainMergePerItemMin * items.length;
    this.q.at(mergedAt, () => {
      for (const b of bounced) {
        this.markInflight(b.it, -1);
        if (b.restack) this.onRestack(b.it);
        else this.onConflict(b.it);
      }
      if (merged.length === 0) {
        this.freeSlots++;
        this.tryCut();
        return;
      }
      const plan = this.planCi(merged, this.q.now);
      // An item stacked on one that fails in this lane cannot land.
      const failed = new Set(plan.fails.map((f) => f.it));
      const dependentFails: Array<{ it: RunIntent; at: number }> = [];
      for (const l of plan.lands) {
        const keep: RunIntent[] = [];
        for (const it of l.items) {
          if (it.stacks.some((s) => failed.has(s.p))) {
            failed.add(it);
            dependentFails.push({ it, at: l.at });
          } else keep.push(it);
        }
        l.items = keep;
      }
      for (const l of plan.lands) {
        if (l.items.length === 0) continue;
        this.q.at(l.at, () => {
          this.ops(this.c.opsPerLaneLand);
          for (const it of l.items) this.land(it);
        });
      }
      for (const f of plan.fails) {
        this.q.at(f.at, () => {
          this.markInflight(f.it, -1);
          if (f.it.interaction) this.fix(f.it, "interaction");
          else {
            this.m.flakeReruns++;
            this.toReady(f.it);
          }
        });
      }
      for (const f of dependentFails) {
        this.q.at(f.at, () => {
          this.markInflight(f.it, -1);
          this.onRestack(f.it);
        });
      }
      this.q.at(plan.end, () => {
        this.freeSlots++;
        this.tryCut();
      });
    });
  }

  // CI on the lane's exact combined SHA; a red run is bisected with the
  // shipped bisect() and both halves re-run in parallel. Outcomes are
  // drawn up front (the lane is isolated: nothing else touching its
  // files can enter a train while it is in flight). Right halves land
  // only after the left half resolves, preserving lane order.
  private planCi(
    set: RunIntent[],
    t: number,
  ): { lands: Array<{ items: RunIntent[]; at: number }>; fails: Array<{ it: RunIntent; at: number }>; end: number } {
    this.m.ciRuns++;
    const done = t + this.dur(this.c.ci, this.rng.ci);
    const flake = bernoulli(this.rng.flake, this.c.pFlake);
    const red = flake || set.some((it) => it.interaction);
    if (!red) return { lands: [{ items: set, at: done }], fails: [], end: done };
    if (set.length === 1) return { lands: [], fails: [{ it: set[0], at: done }], end: done };
    this.m.bisections++;
    const [left, right] = bisect(set);
    const l = this.planCi(left, done);
    const r = right.length ? this.planCi(right, done) : { lands: [], fails: [], end: done };
    const rLands = r.lands.map((x) => ({ items: x.items, at: Math.max(x.at, l.end) }));
    let end = Math.max(l.end, r.end);
    for (const x of rLands) end = Math.max(end, x.at);
    return { lands: [...l.lands, ...rLands], fails: [...l.fails, ...r.fails], end };
  }

  // --- landing -------------------------------------------------------------------

  private land(it: RunIntent): void {
    const t = this.q.now;
    if (it.status === "inflight" && this.mode !== "baseline") this.markInflight(it, -1);
    it.status = "landed";
    it.landedAt = t;
    this.m.landed++;
    for (const f of it.allFiles) {
      const e: LandEntry = { t, it, v: it.version };
      const arr = this.fileLands[f];
      if (arr) arr.push(e);
      else this.fileLands[f] = [e];
    }
    if (it.defect === "escaped") {
      this.m.escapedDefects++;
      this.redIntervals.push([t, t + this.c.mttrMin]);
    }
    this.releaseLive(it);
    this.unpark(it);
  }

  // Terminal intents leave the live overlap index and release waiters.
  private releaseLive(it: RunIntent): void {
    if (this.mode !== "forge") return;
    for (const f of it.w.files) if (this.liveByFile.get(f) === it) this.liveByFile.delete(f);
    this.notifyWaiters(it);
  }

  private finish(): ModeMetrics {
    const m = this.m;
    const lat: number[] = [];
    const landTimes: number[] = [];
    let first = Infinity;
    let last = 0;
    for (const it of this.items) {
      if (it.w.declareAt < first) first = it.w.declareAt;
      if (it.status === "landed") {
        lat.push(it.landedAt - it.w.declareAt);
        landTimes.push(it.landedAt);
        if (it.landedAt > last) last = it.landedAt;
      }
    }
    lat.sort((a, b) => a - b);
    m.declareToLandP50Min = percentile(lat, 0.5);
    m.declareToLandP95Min = percentile(lat, 0.95);
    m.makespanMin = lat.length ? last - first : 0;
    landTimes.sort((a, b) => a - b);
    const need = Math.ceil(0.8 * this.items.length);
    if (need > 0 && landTimes.length >= need) m.timeTo80PctMin = landTimes[need - 1] - first;
    m.landedPerMin = m.makespanMin > 0 ? m.landed / m.makespanMin : 0;
    m.brokenMainMin = unionLength(this.redIntervals);
    if (m.artifactsOps !== null) m.artifactsDollars = (m.artifactsOps / 1000) * this.c.dollarsPer1kOps;
    return m;
  }
}

// Total length covered by a set of [start, end) intervals.
export function unionLength(intervals: ReadonlyArray<readonly [number, number]>): number {
  const iv = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = 0;
  let curE = -Infinity;
  for (const [s, e] of iv) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) curE = e;
  }
  if (curE > curS) total += curE - curS;
  return total;
}

export interface SimOptions {
  agents: number;
  seed: number;
  modes?: readonly Mode[];
  constants?: Partial<SimConstants>;
  now?: () => number; // wall clock for wallMs (injectable for tests)
}

export interface SimResult {
  agents: number;
  seed: number;
  fileCount: number;
  overlapAtDeclare: number;
  modes: ModeMetrics[];
}

export function simulateMode(workload: Workload, mode: Mode, c: SimConstants, now: () => number = Date.now): ModeMetrics {
  const t0 = now();
  const m = new Sim(workload, mode, c).run();
  m.wallMs = now() - t0;
  return m;
}

export function simulate(opts: SimOptions): SimResult {
  const c: SimConstants = { ...DEFAULT_CONSTANTS, ...opts.constants };
  const workload = generateWorkload(opts.agents, opts.seed, c);
  const modes = opts.modes ?? MODES;
  return {
    agents: opts.agents,
    seed: opts.seed,
    fileCount: workload.fileCount,
    overlapAtDeclare: workload.overlapAtDeclare,
    modes: modes.map((mode) => simulateMode(workload, mode, c, opts.now)),
  };
}
