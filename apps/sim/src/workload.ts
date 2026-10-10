// Workload generator: N agents, one intent each, with footprints drawn
// Zipf over a synthetic repo. Generated once per (seed, N) and shared
// by all three modes, so every mode sees the identical workload.

import type { Footprint } from "../../worker/src/intents-core.ts";
import { protectedMatches } from "../../worker/src/intents-core.ts";
import type { SimConstants } from "./constants.ts";
import { bernoulli, lognormal, permutation, rngFor, zipf } from "./prng.ts";

export interface SimIntent {
  idx: number;
  id: string;
  agent: string;
  declareAt: number; // minutes
  workMin: number;
  files: Int32Array; // declared footprint (file indexes, distinct)
  driftFiles: Int32Array; // undeclared files actually touched
  footprint: Footprint; // declared, as strings (for intents-core)
  actualFootprint: Footprint; // declared + drift (concrete files)
  protectedHit: boolean;
  // caught = the intent's own CI (on its branch/fork) catches it before
  // ready; escaped = no CI catches it, so it breaks trunk after landing.
  defect: "none" | "caught" | "escaped";
  // Breaks only in combination with trunk (semantic conflict): passes its
  // own CI, caught by the queue/train CI on the combined SHA.
  interaction: boolean;
  weakEvidence: boolean;
  reviewerDisagrees: boolean;
  // Per-intent stable draws reused by modes (so a mode's own RNG stream
  // never changes the workload).
  reviewLatency: number;
  planLatency: number;
}

export interface Workload {
  agents: number;
  seed: number;
  fileCount: number;
  filePaths: string[];
  intents: SimIntent[];
  // Fraction of intents whose declared footprint overlaps an intent that
  // is live (declared, not yet expected to land) at its declare time,
  // approximated with a work-length window. A workload statistic only.
  overlapAtDeclare: number;
}

export function fileCountFor(c: SimConstants): number {
  return Math.max(1, Math.round(c.repoFiles));
}

export function filePathFor(fileIdx: number, c: SimConstants): string {
  const dir = Math.floor(fileIdx / c.filesPerDir);
  const f = fileIdx % c.filesPerDir;
  // Protected directories are spread evenly: one auth dir and one
  // migrations dir per 1/protectedDirFraction dirs.
  const period = Math.max(2, Math.round(2 / Math.max(1e-9, c.protectedDirFraction)));
  const slot = dir % period;
  if (c.protectedDirFraction > 0 && slot === 0) return `src/auth/d${dir}/f${f}.ts`;
  if (c.protectedDirFraction > 0 && slot === Math.floor(period / 2)) return `migrations/d${dir}/m${f}.sql`;
  return `src/d${dir}/f${f}.ts`;
}

function drawFiles(count: number, sample: () => number): Int32Array {
  const seen = new Set<number>();
  let guard = 0;
  while (seen.size < count && guard++ < count * 50) seen.add(sample());
  return Int32Array.from([...seen].sort((a, b) => a - b));
}

export function generateWorkload(agents: number, seed: number, c: SimConstants): Workload {
  const fileCount = fileCountFor(c);
  const filePaths: string[] = Array.from({ length: fileCount }, () => "");
  for (let i = 0; i < fileCount; i++) filePaths[i] = filePathFor(i, c);
  // Zipf rank -> file index through a permutation, so hot files land in
  // arbitrary directories (some hot files are protected, most are not).
  const rankToFile = permutation(rngFor(seed, "files"), fileCount);
  const z = zipf(fileCount, c.zipfS);
  const rng = rngFor(seed, "workload");
  const sampleFile = (): number => rankToFile[z.sample(rng)];
  const intents: SimIntent[] = [];
  const geomP = 1 / (1 + c.footprintExtraMean);
  for (let i = 0; i < agents; i++) {
    let size = 1;
    while (size < c.footprintMax && !bernoulli(rng, geomP)) size++;
    const files = drawFiles(size, sampleFile);
    let driftFiles = new Int32Array(0);
    if (bernoulli(rng, c.pDrift)) {
      const declared = new Set(files);
      let d = sampleFile();
      let guard = 0;
      while (declared.has(d) && guard++ < 50) d = sampleFile();
      if (!declared.has(d)) driftFiles = Int32Array.from([d]);
    }
    const footprint: Footprint = { paths: [...files].map((f) => filePaths[f]).sort() };
    const actualFootprint: Footprint = {
      paths: [...files, ...driftFiles].map((f) => filePaths[f]).sort(),
    };
    const defectRoll = rng.next();
    const defect: SimIntent["defect"] =
      defectRoll < c.pDefect * c.pDefectCaught ? "caught" : defectRoll < c.pDefect ? "escaped" : "none";
    intents.push({
      idx: i,
      id: `sim-${seed}-${i}`,
      agent: `a-${i}`,
      declareAt: rng.next() * c.arrivalWindowMin,
      workMin: lognormal(rng, c.work.median, c.work.sigma),
      files,
      driftFiles,
      footprint,
      actualFootprint,
      protectedHit: protectedMatches(actualFootprint, c.policy).length > 0,
      defect,
      interaction: bernoulli(rng, c.pInteraction),
      weakEvidence: bernoulli(rng, c.pWeakEvidence),
      reviewerDisagrees: bernoulli(rng, c.pReviewerDisagrees),
      reviewLatency: lognormal(rng, c.reviewLatency.median, c.reviewLatency.sigma),
      planLatency: lognormal(rng, c.planApprovalLatency.median, c.planApprovalLatency.sigma),
    });
  }
  intents.sort((a, b) => a.declareAt - b.declareAt || a.idx - b.idx);
  return { agents, seed, fileCount, filePaths, intents, overlapAtDeclare: overlapRate(intents, fileCount) };
}

// Share of intents whose declared files intersect an earlier intent that
// declared within its own work window (i.e. was still being worked on).
function overlapRate(sorted: SimIntent[], fileCount: number): number {
  if (sorted.length === 0) return 0;
  const lastBusyUntil = new Float64Array(fileCount).fill(-Infinity);
  let hits = 0;
  for (const it of sorted) {
    let hit = false;
    for (const f of it.files) if (lastBusyUntil[f] > it.declareAt) hit = true;
    if (hit) hits++;
    const until = it.declareAt + it.workMin;
    for (const f of it.files) if (lastBusyUntil[f] < until) lastBusyUntil[f] = until;
  }
  return hits / sorted.length;
}
