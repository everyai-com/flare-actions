import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, footprintsOverlap, parseTrailers, type ForgePolicy } from "./intents-core";
import {
  ABANDONED_TRAIN_MS,
  maxCiWaitMs,
  agentIdentity,
  auditRoll,
  bisectStep,
  chainBreak,
  cutCapacity,
  decideChain,
  decideStack,
  effectiveMaxParallel,
  effectiveSpeculationDepth,
  freeSlots,
  lanePoolSize,
  laneRefPool,
  SpeculativeChain,
  FETCH_DEPTHS,
  landingGate,
  laneRef,
  MAX_LANE_REFS,
  maxBisectRounds,
  maxTrainRounds,
  nextFetchDepth,
  orderCandidates,
  planTrain,
  pollBackoffSeconds,
  simulateTrain,
  squashMessage,
  trainTimestamp,
  type ChainLane,
  type LaneOutcome,
  type TrainCandidate,
} from "./train-core";

function policy(over: Partial<ForgePolicy["lanes"]> = {}, rest: Partial<ForgePolicy> = {}): ForgePolicy {
  return { ...DEFAULT_POLICY, ...rest, lanes: { ...DEFAULT_POLICY.lanes, ...over } };
}

function cand(id: string, paths: string[], readyAt = "2026-10-10T00:00:00.000Z", priority?: number): TrainCandidate {
  return { id, footprint: { paths }, readyAt, ...(priority === undefined ? {} : { priority }) };
}

// Deterministic PRNG for property tests (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("lane refs", () => {
  it("names fixed, bounded refs", () => {
    expect(laneRef(0)).toBe("forge/lane-0");
    expect(laneRef(7)).toBe("forge/lane-7");
    expect(laneRef(31)).toBe("forge/lane-31");
    expect(laneRef(99)).toBe(`forge/lane-${MAX_LANE_REFS - 1}`);
    expect(laneRefPool().length).toBe(32);
    expect(laneRefPool()[0]).toBe("refs/heads/forge/lane-0");
    expect(laneRef(-3)).toBe("forge/lane-0");
  });

  it("caps parallelism by the lane refs", () => {
    expect(effectiveMaxParallel(policy({ maxParallel: 64 }))).toBe(MAX_LANE_REFS);
    expect(effectiveMaxParallel(policy({ maxParallel: 3 }))).toBe(3);
  });
});

describe("orderCandidates", () => {
  it("orders priority desc, then oldest ready, then id", () => {
    const out = orderCandidates([
      cand("c", ["a"], "2026-01-02"),
      cand("b", ["a"], "2026-01-01"),
      cand("a", ["a"], "2026-01-02"),
      cand("z", ["a"], "2026-01-09", 5),
    ]);
    expect(out.map((c) => c.id)).toEqual(["z", "b", "a", "c"]);
  });

  it("is a total order: any permutation sorts identically", () => {
    const r = rng(7);
    const base = Array.from({ length: 30 }, (_, i) => cand(`i${i}`, ["x"], `2026-01-0${1 + Math.floor(r() * 3)}`, Math.floor(r() * 3)));
    const want = orderCandidates(base).map((c) => c.id);
    for (let k = 0; k < 20; k++) {
      const shuffled = [...base].sort(() => r() - 0.5);
      expect(orderCandidates(shuffled).map((c) => c.id)).toEqual(want);
    }
  });
});

describe("planTrain", () => {
  it("puts disjoint intents in separate lanes and overlapping ones together", () => {
    const plan = planTrain(
      [cand("a", ["src/a.ts"], "1"), cand("b", ["src/b.ts"], "2"), cand("c", ["src/a.ts"], "3"), cand("d", ["docs/**"], "4")],
      DEFAULT_POLICY,
    );
    expect(plan.lanes.map((l) => l.map((c) => c.id))).toEqual([["a", "c"], ["b"], ["d"]]);
    expect(plan.deferred).toEqual([]);
  });

  it("packs components into max_parallel lanes, defers past max_per_train, never drops", () => {
    const items = Array.from({ length: 10 }, (_, i) => cand(`i${i}`, [`f${i}`], `t${i}`));
    const plan = planTrain(items, policy({ maxPerTrain: 6, maxParallel: 4 }));
    expect(plan.lanes.map((l) => l.map((c) => c.id))).toEqual([["i0", "i4"], ["i1", "i5"], ["i2"], ["i3"]]);
    expect(plan.deferred.map((c) => c.id)).toEqual(["i6", "i7", "i8", "i9"]);
  });

  it("honors a lane cap from free slots (0 = defer everything)", () => {
    const items = Array.from({ length: 5 }, (_, i) => cand(`i${i}`, [`f${i}`], `t${i}`));
    expect(planTrain(items, DEFAULT_POLICY, { maxLanes: 2 }).lanes.map((l) => l.length)).toEqual([3, 2]);
    const none = planTrain(items, DEFAULT_POLICY, { maxLanes: 0 });
    expect(none.lanes).toEqual([]);
    expect(none.deferred.length).toBe(5);
  });

  it("property: lanes are pairwise disjoint, within caps, and partition the input", () => {
    const r = rng(42);
    const dirs = ["src/a", "src/b", "src/c", "lib", "docs", "test"];
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(r() * 40);
      const items = Array.from({ length: n }, (_, i) => {
        const k = 1 + Math.floor(r() * 2);
        const paths = Array.from({ length: k }, () => `${dirs[Math.floor(r() * dirs.length)]}/${r() < 0.2 ? "**" : `f${Math.floor(r() * 4)}.ts`}`);
        return cand(`i${i}`, paths, `2026-01-01T00:00:${String(Math.floor(r() * 60)).padStart(2, "0")}Z`);
      });
      const p = policy({ maxPerTrain: 1 + Math.floor(r() * 30), maxParallel: 1 + Math.floor(r() * 10) });
      const plan = planTrain(items, p);
      const seen = [...plan.lanes.flat(), ...plan.deferred].map((c) => c.id).sort();
      expect(seen).toEqual(items.map((c) => c.id).sort());
      expect(plan.lanes.flat().length).toBeLessThanOrEqual(p.lanes.maxPerTrain);
      expect(plan.lanes.length).toBeLessThanOrEqual(effectiveMaxParallel(p));
      for (let x = 0; x < plan.lanes.length; x++) {
        expect(plan.lanes[x].length).toBeGreaterThan(0);
        for (let y = x + 1; y < plan.lanes.length; y++) {
          for (const a of plan.lanes[x]) for (const b of plan.lanes[y]) expect(footprintsOverlap(a.footprint, b.footprint)).toBe(false);
        }
      }
      // Determinism: same input in any order -> same plan.
      const again = planTrain([...items].reverse(), p);
      expect(again.lanes.map((l) => l.map((c) => c.id))).toEqual(plan.lanes.map((l) => l.map((c) => c.id)));
    }
  });
});

describe("decideStack", () => {
  const cases: Array<[LaneOutcome[], { waiting: boolean; landThrough: number; redLane: number | null; requeueLanes: number[] }]> = [
    [[], { waiting: false, landThrough: -1, redLane: null, requeueLanes: [] }],
    [["green"], { waiting: false, landThrough: 0, redLane: null, requeueLanes: [] }],
    [["green", "green", "green"], { waiting: false, landThrough: 2, redLane: null, requeueLanes: [] }],
    [["red"], { waiting: false, landThrough: -1, redLane: 0, requeueLanes: [] }],
    [["green", "red", "green"], { waiting: false, landThrough: 0, redLane: 1, requeueLanes: [2] }],
    [["green", "red", "pending"], { waiting: false, landThrough: 0, redLane: 1, requeueLanes: [2] }],
    [["pending", "red"], { waiting: true, landThrough: -1, redLane: null, requeueLanes: [] }],
    [["green", "pending", "green"], { waiting: true, landThrough: -1, redLane: null, requeueLanes: [] }],
    [["empty", "green", "empty"], { waiting: false, landThrough: 1, redLane: null, requeueLanes: [] }],
    [["red", "empty", "green"], { waiting: false, landThrough: -1, redLane: 0, requeueLanes: [2] }],
    [["empty", "empty"], { waiting: false, landThrough: -1, redLane: null, requeueLanes: [] }],
  ];
  it.each(cases)("%j", (outcomes, want) => {
    expect(decideStack(outcomes)).toEqual(want);
  });

  it("exhaustive over 4 lanes: never lands past a red or pending lane", () => {
    const vals: LaneOutcome[] = ["green", "red", "pending", "empty"];
    for (let code = 0; code < 4 ** 4; code++) {
      const o = [0, 1, 2, 3].map((i) => vals[Math.floor(code / 4 ** i) % 4]);
      const d = decideStack(o);
      const firstBad = o.findIndex((x) => x === "red" || x === "pending");
      if (d.waiting) {
        expect(o[firstBad]).toBe("pending");
        continue;
      }
      for (let i = 0; i <= d.landThrough; i++) expect(o[i] === "green" || o[i] === "empty").toBe(true);
      if (d.landThrough >= 0) expect(o[d.landThrough]).toBe("green");
      if (d.redLane !== null) {
        expect(d.redLane).toBe(firstBad);
        expect(o[d.redLane]).toBe("red");
        expect(d.requeueLanes.every((j) => j > (d.redLane ?? 0) && o[j] !== "empty")).toBe(true);
      } else {
        expect(firstBad).toBe(-1);
      }
    }
  });
});

describe("bisect", () => {
  it("names the culprit of a singleton and halves larger lanes", () => {
    expect(bisectStep([])).toEqual({ nothing: true });
    expect(bisectStep(["a"])).toEqual({ culprit: "a" });
    expect(bisectStep(["a", "b", "c"])).toEqual({ halves: [["a", "b"], ["c"]] });
  });

  it("round bound is ceil(log2 n)", () => {
    expect([1, 2, 3, 4, 5, 8, 9, 50].map(maxBisectRounds)).toEqual([0, 1, 2, 2, 3, 3, 4, 6]);
  });

  it("single culprit: isolated within ceil(log2 n) bisect rounds, every innocent lands or is requeued, none fail", () => {
    for (let n = 1; n <= 64; n++) {
      const ids = Array.from({ length: n }, (_, i) => `i${i}`);
      for (let c = 0; c < n; c++) {
        const sim = simulateTrain([ids], new Set([ids[c]]));
        expect(sim.failed).toEqual([ids[c]]);
        // round 1 is the original lane; the rest are bisect rounds
        expect(sim.rounds - 1).toBeLessThanOrEqual(maxBisectRounds(n));
        expect([...sim.landed, ...sim.requeued, ...sim.failed].sort()).toEqual([...ids].sort());
        expect(new Set([...sim.landed, ...sim.requeued, ...sim.failed]).size).toBe(n);
      }
    }
  });

  it("property: with any culprit set, only culprits fail and replaying requeues converges", () => {
    const r = rng(1234);
    for (let trial = 0; trial < 300; trial++) {
      const nLanes = 1 + Math.floor(r() * 4);
      let counter = 0;
      const lanes = Array.from({ length: nLanes }, () => Array.from({ length: 1 + Math.floor(r() * 9) }, () => `i${counter++}`));
      const all = lanes.flat();
      const culprits = new Set(all.filter(() => r() < 0.15));
      const landed = new Set<string>();
      const failed = new Set<string>();
      let queue: string[][] = lanes;
      for (let train = 0; train < 200 && queue.length; train++) {
        const sim = simulateTrain(queue, culprits);
        sim.landed.forEach((x) => landed.add(x));
        sim.failed.forEach((x) => failed.add(x));
        expect(sim.failed.every((x) => culprits.has(x))).toBe(true);
        queue = sim.requeued.length ? [sim.requeued] : [];
      }
      expect(queue).toEqual([]);
      expect([...failed].sort()).toEqual([...culprits].sort());
      expect([...landed].sort()).toEqual(all.filter((x) => !culprits.has(x)).sort());
    }
  });

  it("all green lands every lane in one round", () => {
    expect(simulateTrain([["a", "b"], ["c"]], new Set())).toEqual({ landed: ["a", "b", "c"], failed: [], requeued: [], rounds: 1 });
  });

  it("red middle lane: prefix lands, lanes behind requeue", () => {
    const sim = simulateTrain([["a"], ["b"], ["c"]], new Set(["b"]));
    expect(sim).toEqual({ landed: ["a"], failed: ["b"], requeued: ["c"], rounds: 1 });
  });
});

describe("landing gate", () => {
  it("routes deterministically and holds human-routed intents until approved", () => {
    const p = policy({}, { autoLandMaxRisk: 30, auditSample: 0.05 });
    expect(auditRoll("abc")).toBe(auditRoll("abc"));
    expect(auditRoll("abc")).toBeGreaterThanOrEqual(0);
    expect(auditRoll("abc")).toBeLessThan(1);
    expect(landingGate(80, p, "x", false)).toEqual({ route: "human", held: true });
    expect(landingGate(80, p, "x", true)).toEqual({ route: "human", held: false });
    const low = landingGate(5, p, "x", false);
    expect(low.held).toBe(false);
    expect(["auto", "audit"]).toContain(low.route);
  });

  it("audit roll is roughly uniform", () => {
    let under = 0;
    for (let i = 0; i < 4000; i++) if (auditRoll(`intent-${i}`) < 0.25) under += 1;
    expect(under / 4000).toBeGreaterThan(0.2);
    expect(under / 4000).toBeLessThan(0.3);
  });
});

describe("squash message + identity", () => {
  it("carries title, bounded reasoning and parseable trailers", () => {
    const msg = squashMessage({ intentId: "int-1", title: "Add rate limit", reasoning: "Because bursts.\nLong.".repeat(200), agent: "claude-1", goalId: "goal-9", session: "i-int1" });
    expect(msg.startsWith("Add rate limit\n\nBecause bursts.")).toBe(true);
    expect(msg.length).toBeLessThan(1000);
    expect(parseTrailers(msg)).toEqual({ goal: "goal-9", intent: "int-1", agent: "claude-1", session: "i-int1" });
  });

  it("omits an empty goal and collapses multi-line titles", () => {
    const msg = squashMessage({ intentId: "i", title: "a\nb", reasoning: "", agent: "x", goalId: null, session: "s" });
    expect(msg.split("\n")[0]).toBe("a b");
    expect(parseTrailers(msg)?.goal).toBeUndefined();
  });

  it("agent identity is sanitized", () => {
    expect(agentIdentity("claude 1/<x>")).toEqual({ name: "claude1x", email: "claude1x@agents.flare.invalid" });
    expect(agentIdentity("")).toEqual({ name: "agent", email: "agent@agents.flare.invalid" });
  });

  it("timestamps derive from the train row", () => {
    expect(trainTimestamp("2026-10-10T00:00:01.500Z")).toBe(Date.parse("2026-10-10T00:00:01Z") / 1000);
    expect(trainTimestamp("nope")).toBe(0);
  });
});

describe("bounds", () => {
  it("fetch depth deepens then stops", () => {
    const seq: Array<number | null> = [nextFetchDepth(null)];
    while (seq[seq.length - 1] !== null) seq.push(nextFetchDepth(seq[seq.length - 1]));
    expect(seq).toEqual([...FETCH_DEPTHS, null]);
  });

  it("poll backoff grows and caps", () => {
    expect([0, 1, 2, 3, 4, 20].map(pollBackoffSeconds)).toEqual([10, 20, 40, 80, 120, 120]);
  });

  it("the cron treats trains as abandoned only after the Workflow's full CI wait (review #13)", () => {
    expect(maxCiWaitMs()).toBe((10 + 20 + 40 + 80 + 36 * 120) * 1000);
    expect(ABANDONED_TRAIN_MS).toBeGreaterThan(maxCiWaitMs());
  });

  it("round budget covers a full bisect plus rebuilds", () => {
    expect(maxTrainRounds(DEFAULT_POLICY)).toBe(maxBisectRounds(50) + 5);
  });
});

describe("speculation capacity", () => {
  it("pool = depth x max_parallel, capped by the ref pool", () => {
    expect(lanePoolSize(DEFAULT_POLICY)).toBe(32);
    expect(lanePoolSize(policy({ maxParallel: 8, speculationDepth: 1 }))).toBe(8);
    expect(lanePoolSize(policy({ maxParallel: 32, speculationDepth: 4 }))).toBe(32);
    expect(effectiveSpeculationDepth(policy({ speculationDepth: 0 }))).toBe(1);
    expect(effectiveSpeculationDepth(policy({ speculationDepth: 99 }))).toBe(8);
  });

  it("free slots are the lowest unused, ascending", () => {
    expect(freeSlots([0, 2], 6, 3)).toEqual([1, 3, 4]);
    expect(freeSlots([0, 1, 2], 3, 2)).toEqual([]);
  });

  it("a cut needs a free speculation level and a free ref", () => {
    const p = policy({ maxParallel: 2, speculationDepth: 2 });
    expect(cutCapacity(p, 0, [])).toEqual({ slots: [0, 1], speculative: false });
    expect(cutCapacity(p, 1, [0, 1])).toEqual({ slots: [2, 3], speculative: true });
    expect(cutCapacity(p, 2, [0, 1, 2, 3]).slots).toEqual([]);
    expect(cutCapacity(policy({ speculationDepth: 1 }), 1, [0]).slots).toEqual([]);
  });
});

describe("decideChain", () => {
  it("lands the green prefix while lanes behind are pending", () => {
    expect(decideChain(["green", "green", "pending", "green"])).toEqual({ waiting: true, landThrough: 1, redLane: null, requeueLanes: [] });
    expect(decideStack(["green", "green", "pending", "green"])).toEqual({ waiting: true, landThrough: -1, redLane: null, requeueLanes: [] });
  });

  it("exhaustive over 5 lanes: prefix-only landing, red invalidates everything behind", () => {
    const vals: LaneOutcome[] = ["green", "red", "pending", "empty"];
    for (let code = 0; code < 4 ** 5; code++) {
      const o = [0, 1, 2, 3, 4].map((i) => vals[Math.floor(code / 4 ** i) % 4]);
      const d = decideChain(o);
      const firstBad = o.findIndex((x) => x === "red" || x === "pending");
      const limit = firstBad === -1 ? o.length : firstBad;
      for (let i = 0; i <= d.landThrough; i++) expect(o[i] === "green" || o[i] === "empty").toBe(true);
      expect(d.landThrough).toBeLessThan(limit);
      expect(d.landThrough).toBe(o.slice(0, limit).lastIndexOf("green"));
      if (d.waiting) expect(o[firstBad]).toBe("pending");
      if (d.redLane !== null) {
        expect(d.redLane).toBe(firstBad);
        expect(d.requeueLanes).toEqual(o.map((x, j) => (j > firstBad && x !== "empty" ? j : -1)).filter((j) => j >= 0));
      }
    }
  });

  it("chainBreak finds the first lane not stacked on its predecessor", () => {
    expect(chainBreak([])).toBeNull();
    expect(chainBreak([{ baseSha: "m", headSha: "a" }, { baseSha: "A", headSha: "b" }])).toBeNull();
    expect(chainBreak([{ baseSha: "m", headSha: "a" }, { baseSha: "a", headSha: "b" }, { baseSha: "x", headSha: "c" }])).toBe(2);
  });
});

// Random speculative pipelines: cut whenever capacity allows, finish CI
// in random order (red iff the lane's head contains a culprit), decide
// after every result. Checks every invariant at every step.
function runPipeline(seed: number, p: ForgePolicy, n: number, culpritRate: number): { maxGroups: number; speculativeLands: number } {
  const r = rng(seed);
  const ids = Array.from({ length: n }, (_, i) => `i${String(i).padStart(4, "0")}`);
  const fp = new Map(ids.map((id) => [id, [`f${Math.floor(r() * 12)}.ts`]]));
  const culprits = new Set(ids.filter(() => r() < culpritRate));
  const chain = new SpeculativeChain<string>(p);
  let queue = [...ids];
  const landed: string[] = [];
  const failed: string[] = [];
  const seenLanded = new Set<string>();
  let maxGroups = 0;
  let speculativeLands = 0;
  for (let guard = 0; guard < 20000 && (queue.length || chain.lanes.length); guard++) {
    for (;;) {
      const cap = chain.capacity();
      if (!cap.slots.length || !queue.length) break;
      const plan = planTrain(queue.map((id) => cand(id, fp.get(id) ?? [], id)), p, { maxLanes: cap.slots.length });
      const added = chain.addGroup(plan.lanes.map((l) => l.map((c) => c.id)));
      expect(added.length).toBe(plan.lanes.length);
      queue = plan.deferred.map((c) => c.id);
    }
    maxGroups = Math.max(maxGroups, chain.groups);
    expect(chain.groups).toBeLessThanOrEqual(effectiveSpeculationDepth(p));
    expect(new Set(chain.lanes.map((l) => l.slot)).size).toBe(chain.lanes.length);
    // the chain is linear: every lane is stacked on the one before it
    chain.lanes.forEach((l, i) => expect(l.parent).toBe(i === 0 ? chain.tip : chain.lanes[i - 1].id));
    const pending = chain.lanes.filter((l) => l.outcome === "pending");
    if (!pending.length) break;
    const pick = pending[Math.floor(r() * pending.length)];
    chain.setOutcome(pick.id, chain.prefixItems(pick.id).some((x) => culprits.has(x)) ? "red" : "green");
    const before = [...chain.lanes];
    const step = chain.decide();
    // landed lanes: a contiguous green prefix of the chain, culprit-free
    step.landed.forEach((l, i) => {
      expect(l).toBe(before[i]);
      expect(l.outcome).toBe("green");
      if (l.group !== before[0].group) speculativeLands++;
      for (const x of l.items) {
        expect(culprits.has(x)).toBe(false);
        expect(seenLanded.has(x)).toBe(false);
        seenLanded.add(x);
        landed.push(x);
      }
    });
    if (step.red) {
      const ri = before.indexOf(step.red);
      expect(ri).toBe(step.landed.length);
      // invalidation cascades to every lane behind the red one, any group
      expect(step.invalidated).toEqual(before.slice(ri + 1));
      expect(step.red.items.some((x) => culprits.has(x))).toBe(true);
      if (step.culprit !== null) {
        expect(culprits.has(step.culprit)).toBe(true);
        expect(step.red.bisectDepth).toBeLessThanOrEqual(maxBisectRounds(step.red.rootSize));
        failed.push(step.culprit);
      }
      for (const c of step.children) expect(c.bisectDepth).toBeLessThanOrEqual(maxBisectRounds(c.rootSize));
      // requeued without blame, keeping their place in line
      queue = [...step.invalidated.flatMap((l) => l.items), ...queue].sort();
    }
  }
  expect(chain.unverifiedLands).toBe(0);
  expect(queue).toEqual([]);
  expect(chain.lanes).toEqual([]);
  // nothing lost, nothing double-landed, only culprits fail
  expect([...failed].sort()).toEqual([...culprits].sort());
  expect([...landed].sort()).toEqual(ids.filter((x) => !culprits.has(x)));
  return { maxGroups, speculativeLands };
}

describe("SpeculativeChain", () => {
  it("group 2 is cut on in-flight group 1 and lands right after it", () => {
    const p = policy({ maxParallel: 2, speculationDepth: 2 });
    const c = new SpeculativeChain<string>(p);
    const g1 = c.addGroup([["a"], ["b"]]);
    const g2 = c.addGroup([["c"]]);
    expect(g2[0].parent).toBe(g1[1].id);
    expect(g2[0].slot).toBe(2);
    expect(c.capacity().slots).toEqual([]);
    c.setOutcome(g2[0].id, "green");
    expect(c.decide()).toMatchObject({ landed: [], waiting: true });
    c.setOutcome(g1[0].id, "green");
    expect(c.decide().landed.map((l) => l.items)).toEqual([["a"]]);
    c.setOutcome(g1[1].id, "green");
    expect(c.decide().landed.map((l) => l.items)).toEqual([["b"], ["c"]]);
    expect(c.tip).toBe(g2[0].id);
    expect(c.unverifiedLands).toBe(0);
  });

  it("group 1 red: descendants are invalidated (requeued without blame) and the red lane bisects", () => {
    const c = new SpeculativeChain<string>(policy({ maxParallel: 1, speculationDepth: 3 }));
    const [g1] = c.addGroup([["a", "bad"]]);
    const [g2] = c.addGroup([["c"]]);
    const [g3] = c.addGroup([["d"]]);
    c.setOutcome(g3.id, "red"); // its head contains g1's culprit
    c.setOutcome(g2.id, "red");
    expect(c.decide().waiting).toBe(true);
    c.setOutcome(g1.id, "red");
    const step = c.decide();
    expect(step.red?.id).toBe(g1.id);
    expect(step.invalidated.map((l: ChainLane<string>) => l.items)).toEqual([["c"], ["d"]]);
    expect(step.children.map((l) => l.items)).toEqual([["a"], ["bad"]]);
    expect(step.children[0].parent).toBe(-1); // rebuilt on main
    // the requeued work is rebuilt speculatively on the bisect children
    const [g4] = c.addGroup([["c", "d"]]);
    expect(g4.parent).toBe(step.children[1].id);
  });

  it("dropping an emptied lane re-points the lanes stacked on it", () => {
    const c = new SpeculativeChain<string>(policy({ maxParallel: 3, speculationDepth: 1 }));
    const [a, b, d] = c.addGroup([["a"], ["b"], ["d"]]);
    c.dropItems(b.id, () => true);
    expect(c.lanes.map((l) => l.id)).toEqual([a.id, d.id]);
    expect(d.parent).toBe(a.id);
  });

  it("property: invariants over random pipelines (depth 1-4, random CI order)", () => {
    let speculative = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 7919);
      const p = policy({ maxParallel: 1 + Math.floor(r() * 4), maxPerTrain: 2 + Math.floor(r() * 12), speculationDepth: 1 + Math.floor(r() * 4) });
      const out = runPipeline(seed, p, 10 + Math.floor(r() * 70), r() * 0.2);
      if (effectiveSpeculationDepth(p) === 1) expect(out.maxGroups).toBeLessThanOrEqual(1);
      speculative += out.speculativeLands;
    }
    // speculation actually happened: lanes of a descendant group landed
    // in the same step as their ancestors
    expect(speculative).toBeGreaterThan(0);
  });

  it("property: a single culprit is isolated within ceil(log2 n) bisect rounds under speculation", () => {
    for (let n = 2; n <= 33; n++) {
      for (let k = 0; k < n; k += 3) {
        const chain = new SpeculativeChain<string>(policy({ maxParallel: 1, speculationDepth: 3 }));
        const ids = Array.from({ length: n }, (_, i) => `x${i}`);
        chain.addGroup([ids]);
        chain.addGroup([["after"]]);
        let rounds = 0;
        let culprit: string | null = null;
        for (let guard = 0; guard < 100 && chain.lanes.length && culprit === null; guard++) {
          for (const l of chain.lanes) if (l.outcome === "pending") chain.setOutcome(l.id, chain.prefixItems(l.id).includes(ids[k]) ? "red" : "green");
          const step = chain.decide();
          if (step.red) rounds++;
          culprit = step.culprit;
        }
        expect(culprit).toBe(ids[k]);
        // round 1 is the original lane; the rest are bisect rounds
        expect(rounds - 1).toBeLessThanOrEqual(maxBisectRounds(n));
      }
    }
  });
});
