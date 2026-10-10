/// <reference types="node" />
// Coordinator index micro-benchmark: N synthetic intents go through the
// declare path (indexUpsert + recomputeEdges) into node:sqlite behind
// the DO `sql` shape, then overlap queries are timed. Runs a 5k smoke in
// `npm test`; the recorded 100k numbers (docs/FORGE.md) come from:
//   FORGE_BENCH=1 npx vitest run apps/worker/src/coordinator-core.bench.test.ts
// Workload: 20 packages x 50 modules x 100 files = 100k files; each
// intent declares 1-3 entries (90% files, 5% module dirs, 5% `*.ts`
// globs). Queries are fresh 1-3 entry footprints of the same mix.
import { describe, expect, it } from "vitest";
import type { Intent } from "./intents-core";
import { ensureIndexSchema, indexUpsert, queryOverlaps, recomputeEdges, type SqlStore, type SqlValue } from "./coordinator-core";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const FULL = process.env.FORGE_BENCH === "1";
const N = FULL ? 100_000 : 5_000;
const QUERIES = FULL ? 2_000 : 300;

function store(): SqlStore {
  const raw = new DatabaseSync(":memory:");
  const cache = new Map<string, ReturnType<typeof raw.prepare>>();
  const sql: SqlStore = {
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
      let stmt = cache.get(query);
      if (!stmt) {
        stmt = raw.prepare(query);
        cache.set(query, stmt);
      }
      const rows = stmt.all(...bindings) as T[];
      return { toArray: () => rows };
    },
  };
  ensureIndexSchema(sql);
  return sql;
}

// mulberry32: deterministic, and unlike a power-of-two LCG its low bits
// are not correlated (which would cluster `% n` picks).
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

function footprint(r: (n: number) => number): string[] {
  const k = 1 + r(3);
  const out = new Set<string>();
  for (let i = 0; i < k; i++) {
    const pkg = `pkg${r(20)}`;
    const mod = `mod${r(50)}`;
    const roll = r(100);
    if (roll < 90) out.add(`${pkg}/${mod}/file${r(100)}.ts`);
    else if (roll < 95) out.add(`${pkg}/${mod}`);
    else out.add(`${pkg}/${mod}/*.ts`);
  }
  return [...out].sort();
}

function intent(id: string, paths: string[]): Intent {
  return {
    id,
    goalId: null,
    repo: "bench",
    agent: `agent-${id.slice(-3)}`,
    title: `intent ${id}`,
    reasoning: "",
    accept: "",
    footprint: { paths },
    actualFootprint: null,
    forkRepo: null,
    state: "working",
    risk: 0,
    riskTerms: [],
    baseSha: "",
    headSha: "",
    trainId: null,
    landedSha: null,
    planApprovedBy: null,
    leaseExpiresAt: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

describe(`coordinator index benchmark (${N} intents)`, () => {
  it("declares N intents and measures overlap query latency", () => {
    const sql = store();
    const r = rng(42);
    const declareMs: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const id = `i${String(i).padStart(7, "0")}`;
      const s = performance.now();
      indexUpsert(sql, intent(id, footprint(r)), 0, i);
      recomputeEdges(sql, id, i);
      declareMs.push(performance.now() - s);
    }
    const buildMs = performance.now() - t0;
    const edges = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_edges").toArray()[0].n;
    const pathRows = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_paths").toArray()[0].n;

    const q = rng(7);
    const queryMs: number[] = [];
    let hits = 0;
    let candidates = 0;
    for (let i = 0; i < QUERIES; i++) {
      const fp = footprint(q);
      const s = performance.now();
      const res = queryOverlaps(sql, fp);
      queryMs.push(performance.now() - s);
      hits += res.hits.size;
      candidates += res.candidates;
    }
    declareMs.sort((a, b) => a - b);
    queryMs.sort((a, b) => a - b);
    const lastK = declareMs.slice(-Math.min(1000, declareMs.length));
    const result = {
      intents: N,
      pathRows,
      edges,
      buildSeconds: round(buildMs / 1000),
      declaresPerSecond: Math.round(N / (buildMs / 1000)),
      declareP50Ms: round(pct(declareMs, 50)),
      declareP99Ms: round(pct(declareMs, 99)),
      declareMaxMs: round(lastK[lastK.length - 1]),
      queries: QUERIES,
      queryP50Ms: round(pct(queryMs, 50)),
      queryP99Ms: round(pct(queryMs, 99)),
      avgHitsPerQuery: round(hits / QUERIES),
      avgCandidatesPerQuery: round(candidates / QUERIES),
      node: process.version,
    };
    console.log(JSON.stringify({ bench: "coordinator-index", ...result }));
    expect(pathRows).toBeGreaterThanOrEqual(N);
    // Generous smoke bounds: catches an accidental O(n) scan per query.
    expect(result.queryP50Ms).toBeLessThan(FULL ? 50 : 20);
  }, 600_000);
});
