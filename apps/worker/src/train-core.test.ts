import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, footprintsOverlap, parseTrailers, type ForgePolicy } from "./intents-core";
import {
  agentIdentity,
  auditRoll,
  bisectStep,
  decideStack,
  effectiveMaxParallel,
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
    expect(laneRef(99)).toBe(`forge/lane-${MAX_LANE_REFS - 1}`);
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

  it("defers past max_per_train and past max_parallel lanes, never drops", () => {
    const items = Array.from({ length: 10 }, (_, i) => cand(`i${i}`, [`f${i}`], `t${i}`));
    const plan = planTrain(items, policy({ maxPerTrain: 6, maxParallel: 4 }));
    expect(plan.lanes.length).toBe(4);
    expect(plan.lanes.flat().map((c) => c.id)).toEqual(["i0", "i1", "i2", "i3"]);
    expect(plan.deferred.map((c) => c.id)).toEqual(["i4", "i5", "i6", "i7", "i8", "i9"]);
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

  it("round budget covers a full bisect plus rebuilds", () => {
    expect(maxTrainRounds(DEFAULT_POLICY)).toBe(maxBisectRounds(50) + 5);
  });
});
