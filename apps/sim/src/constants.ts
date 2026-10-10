// Simulator constants. Every number here is an INPUT to the simulator,
// not a measurement. Each carries its source, or says plainly that it is
// an assumption. docs/FORGE-BENCH.md renders this table; keep them in
// sync. All durations are minutes of simulated time.

import { DEFAULT_POLICY, type ForgePolicy } from "../../worker/src/intents-core.ts";

export interface DurationDist {
  median: number;
  sigma: number; // lognormal shape
}

export interface SimConstants {
  // --- workload ---
  // All agents declare within this window (COMPETITION-PLAN §4 scale
  // math: "10k agents in 10 min"). The window stays fixed as N grows,
  // so larger N means a denser burst on the same repo.
  arrivalWindowMin: number;
  // Repo size in files. Fixed across N: the same monorepo gets busier
  // as the swarm grows (that contention is what the bench measures).
  repoFiles: number;
  // Files per directory (directories carry protected-path policy).
  filesPerDir: number;
  // Zipf exponent of file popularity (hot files: routes, configs).
  zipfS: number;
  // Declared footprint size: 1 + geometric extra files with this mean.
  footprintExtraMean: number;
  footprintMax: number;
  // Fraction of directories under protected policy paths.
  protectedDirFraction: number;
  // Agent edits an undeclared file (drift) with this probability.
  pDrift: number;

  // --- durations ---
  work: DurationDist; // agent implements the change
  ci: DurationDist; // one CI run (any batch size; trains run one suite)
  reviewLatency: DurationDist; // wall time until a human reviews
  rereviewLatency: DurationDist; // re-approval after a rebase
  planApprovalLatency: DurationDist; // protected-path plan approval
  replay: DurationDist; // one LLM replay attempt
  mergeMin: number; // serial queue: merge + push one PR
  trainMergeBaseMin: number; // train: merge step per lane
  trainMergePerItemMin: number; // train: per intent merged in a lane
  reworkFactor: number; // author rebase/fix redoes this fraction of work

  // --- probabilities ---
  // Textual conflict probability per shared file changed on trunk since
  // the intent's base (or merged earlier in the same lane).
  pConflictPerSharedFile: number;
  pDefect: number; // change carries a real bug
  pDefectCaught: number; // CI catches it (else it escapes to trunk)
  pInteraction: number; // passes own CI, fails combined with trunk
  pFlake: number; // a CI run goes red with no real defect
  pWeakEvidence: number; // risk term: CI evidence weak
  pReviewerDisagrees: number; // risk term: clean-context reviewer disagrees
  replaySuccess: number; // LLM conflict replay success rate
  mttrMin: number; // escaped defect: red main until revert

  // --- Forge planner ---
  // A declared intent with live overlaps gets after: edges to them and
  // waits at most this long for each predecessor to push a CI-green
  // head, then stacks on it (forks from it). Predecessors not ready by
  // then are dropped and the intent works in parallel.
  afterWaitMaxMin: number;
  // Ready-queue scan bound per train cut (keeps cuts O(1) at 100k).
  cutScanLimit: number;

  // --- serial baseline ---
  maxRebases: number; // author gives up after this many conflict bounces
  maxFixes: number; // ... or this many CI-failure fixes
  maxConflicts: number; // lifetime conflicts before an intent is abandoned

  // --- human cost per item (minutes of human attention) ---
  reviewMin: number;
  rereviewMin: number;
  planApprovalMin: number;
  auditMin: number;
  escalationMin: number;

  // --- Artifacts op model (estimate; Forge + trains-only) ---
  opsPerIntent: number; // fork + token + clone (2) + push (2) + revoke
  opsPerExtraPush: number; // a rework or replay pushes again
  opsPerLaneItem: number; // train fetches each item from its fork
  opsPerLaneLand: number; // push train ref + CAS main + notes
  dollarsPer1kOps: number;

  policy: ForgePolicy;
}

export const PROTECTED_GLOBS = ["src/auth/**", "migrations/**"];

export const DEFAULT_CONSTANTS: SimConstants = {
  arrivalWindowMin: 10,
  repoFiles: 100_000,
  filesPerDir: 20,
  zipfS: 0.7,
  footprintExtraMean: 1.5,
  footprintMax: 12,
  protectedDirFraction: 0.02,
  pDrift: 0.1,

  work: { median: 8, sigma: 0.6 },
  ci: { median: 10, sigma: 0.3 },
  reviewLatency: { median: 30, sigma: 0.8 },
  rereviewLatency: { median: 15, sigma: 0.8 },
  planApprovalLatency: { median: 30, sigma: 0.8 },
  replay: { median: 3, sigma: 0.5 },
  mergeMin: 0.5,
  trainMergeBaseMin: 0.5,
  trainMergePerItemMin: 0.02,
  reworkFactor: 0.5,

  pConflictPerSharedFile: 0.35,
  pDefect: 0.05,
  pDefectCaught: 0.9,
  pInteraction: 0.02,
  pFlake: 0.05,
  pWeakEvidence: 0.15,
  pReviewerDisagrees: 0.06,
  replaySuccess: 0.6,
  mttrMin: 30,

  afterWaitMaxMin: 15,
  cutScanLimit: 2_000,

  maxRebases: 3,
  maxFixes: 3,
  maxConflicts: 8,

  reviewMin: 10,
  rereviewMin: 3,
  planApprovalMin: 5,
  auditMin: 5,
  escalationMin: 10,

  opsPerIntent: 7,
  opsPerExtraPush: 2,
  opsPerLaneItem: 2,
  opsPerLaneLand: 6,
  dollarsPer1kOps: 0.15,

  policy: { ...DEFAULT_POLICY, protected: PROTECTED_GLOBS },
};

// Source notes rendered into docs/FORGE-BENCH.md. "assumption" means no
// external measurement backs the number; it is a tunable input.
export const CONSTANT_SOURCES: Record<string, string> = {
  arrivalWindowMin: "COMPETITION-PLAN.md §4 scale math (10k agents in 10 min)",
  repoFiles: "assumption (a large monorepo)",
  zipfS: "assumption; calibrated so ~22% of intents overlap a live intent at 1k agents (51% at 10k, 75% at 100k)",
  pDrift: "assumption",
  work: "assumption (agent session, median 8 min)",
  ci: "assumption (median 10 min suite)",
  reviewLatency: "assumption; reviewers modeled as unlimited (favors the baselines)",
  pConflictPerSharedFile: "assumption; overlap is necessary, not sufficient, for a textual conflict",
  pFlake: "assumption (per CI run); Google reports ~1.5% of test runs flaky (2016 testing blog)",
  pDefect: "assumption (reaches CI with a real bug; 90% caught by the intent's own CI)",
  pInteraction: "assumption (semantic conflict caught only on the combined SHA)",
  replaySuccess: "Merge-Bench (COMPETITION-PLAN.md §13), default 0.6",
  mttrMin: "assumption (detect + revert)",
  afterWaitMaxMin: "assumption (planner wait budget)",
  reviewMin: "assumption (human minutes per small agent PR)",
  policy: "DEFAULT_POLICY from intents-core.ts + protected src/auth/**, migrations/**",
  dollarsPer1kOps: "COMPETITION-PLAN.md §4 ($0.15 / 1k Artifacts ops); verify against current pricing",
  opsPerIntent: "assumption: fork 1 + token 1 + clone 2 + push 2 + revoke 1",
};
