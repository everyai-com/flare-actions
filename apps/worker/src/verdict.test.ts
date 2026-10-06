/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  changedFiles,
  collectTreePaths,
  composeVerdict,
  detectCollisions,
  rankEvidence,
  verdictPass,
  type VerdictEvidence,
} from "./verdict";
import type { TournamentArtifacts, TournamentRepoHandle } from "./tournaments";

// node:sqlite via getBuiltinModule: vite-node's import analysis predates
// the specifier, but the runtime resolves it fine.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const SCHEMA = `
CREATE TABLE tournaments (id TEXT PRIMARY KEY, intent TEXT NOT NULL, source_repo TEXT NOT NULL,
  base_ref TEXT NOT NULL DEFAULT 'main', base_sha TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
  winner_run_id TEXT, resolved_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE attempts (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL, agent TEXT NOT NULL,
  fork_repo TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'claimed', last_seen_sha TEXT NOT NULL DEFAULT '',
  run_id TEXT, verdict_rank INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE verdicts (tournament_id TEXT PRIMARY KEY, ranking TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE ledger (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued');
CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', result TEXT NOT NULL DEFAULT '', triage TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '', log TEXT NOT NULL DEFAULT '');
CREATE TABLE test_results (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, job_id TEXT NOT NULL,
  suite TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', classname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '');`;

function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
            run: async () => {
              const info = raw.prepare(query).run(...params) as { changes?: unknown };
              return { meta: { changes: typeof info.changes === "number" ? info.changes : 0 } };
            },
          };
        },
      };
    },
  } as unknown as Db;
}

// Tree/commit store keyed by repo: commits point at trees, trees list entries.
interface FakeStore {
  commits: Map<string, string>;
  trees: Map<string, { name: string; mode: string; hash: string }[]>;
}

function fakeArtifacts(repos: Record<string, FakeStore> = {}): TournamentArtifacts {
  const store = new Map(Object.entries(repos));
  const handle = (): TournamentRepoHandle => ({
    readFile: async () => null,
    fork: async () => ({ name: "", remote: "", defaultBranch: "main" }),
    log: async () => [],
    readTree: async (hash: string) => {
      for (const repo of store.values()) {
        const entries = repo.trees.get(hash);
        if (entries) return entries;
      }
      return null;
    },
    readCommit: async (hash: string) => {
      for (const repo of store.values()) {
        const tree = repo.commits.get(hash);
        if (tree) return { treeHash: tree };
      }
      return null;
    },
    createToken: async () => ({ plaintext: "tok" }),
    [Symbol.dispose]: () => undefined,
  });
  return { get: async () => handle() };
}

async function seedTournament(db: Db, over: Record<string, string> = {}): Promise<string> {
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  const now = "2026-10-06T11:00:00.000Z";
  await db
    .prepare("INSERT INTO tournaments (id, intent, source_repo, base_sha, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, over.intent ?? "fix it", over.source ?? "base", over.baseSha ?? "", over.state ?? "verifying", now, now)
    .run();
  return id;
}

async function seedAttempt(db: Db, tid: string, agent: string, over: Record<string, string | null> = {}): Promise<string> {
  const id = `a-${agent}-${Math.random().toString(36).slice(2, 6)}`;
  const now = "2026-10-06T11:00:00.000Z";
  await db
    .prepare("INSERT INTO attempts (id, tournament_id, agent, fork_repo, state, last_seen_sha, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, tid, agent, over.fork ?? `${agent}-fork`, over.state ?? "verifying", over.sha ?? "h".repeat(40), over.run ?? null, now, over.updated ?? now)
    .run();
  return id;
}

async function seedRun(db: Db, id: string, status: string, failingTests = 0): Promise<void> {
  await db.prepare("INSERT INTO runs (id, status) VALUES (?, ?)").bind(id, status).run();
  await db
    .prepare("INSERT INTO jobs (id, run_id, name, status, result) VALUES (?, ?, 'verify', ?, '{\"steps\":[{\"command\":\"t\",\"exitCode\":0,\"output\":\"ok\"}]}')")
    .bind(`j-${id}`, id, status)
    .run();
  for (let i = 0; i < failingTests; i++) {
    await db
      .prepare("INSERT INTO test_results (run_id, job_id, name, status) VALUES (?, ?, ?, 'failed')")
      .bind(id, `j-${id}`, `test-${i}`)
      .run();
  }
}

describe("detectCollisions", () => {
  it("finds pairwise overlaps and skips disjoint sets", () => {
    expect(detectCollisions([])).toEqual([]);
    expect(detectCollisions([{ agent: "a", changed: ["x"] }])).toEqual([]);
    const out = detectCollisions([
      { agent: "a", changed: ["x.ts", "y.ts"] },
      { agent: "b", changed: ["y.ts", "z.ts"] },
      { agent: "c", changed: ["w.ts"] },
    ]);
    expect(out).toEqual([{ agents: ["a", "b"], paths: ["y.ts"] }]);
  });
});

describe("rankEvidence", () => {
  const ev = (agent: string, over: Partial<VerdictEvidence>): VerdictEvidence => ({
    attemptId: agent,
    agent,
    terminal: true,
    status: "success",
    failingTests: 0,
    summary: "",
    ...over,
  });
  it("orders terminal-success, fewer failures, then name", () => {
    const ranked = rankEvidence([
      ev("b", { status: "failure", failingTests: 1 }),
      ev("c", { terminal: false, status: "queued" }),
      ev("a", { failingTests: 2 }),
      ev("d", {}),
    ]);
    expect(ranked.map((r) => r.agent)).toEqual(["d", "a", "b", "c"]);
  });
});

describe("collectTreePaths + changedFiles", () => {
  const store: FakeStore = {
    commits: new Map([["c0", "t0"], ["c1", "t1"]]),
    trees: new Map([
      ["t0", [{ name: "a.ts", mode: "100644", hash: "h1" }, { name: "sub", mode: "40000", hash: "t0s" }]],
      ["t0s", [{ name: "b.ts", mode: "100644", hash: "h2" }]],
      ["t1", [{ name: "a.ts", mode: "100644", hash: "h9" }, { name: "sub", mode: "40000", hash: "t0s" }, { name: "new.ts", mode: "100644", hash: "h3" }]],
    ]),
  };
  it("walks nested trees", async () => {
    const { paths, truncated } = await collectTreePaths(fakeArtifacts({ r: store }), "r", "t0");
    expect(truncated).toBe(false);
    expect([...paths.keys()].sort()).toEqual(["a.ts", "sub/b.ts"]);
  });
  it("diffs by blob hash and presence", async () => {
    const diff = await changedFiles(fakeArtifacts({ r: store }), "r", "c0", "c1");
    expect(diff?.changed.sort()).toEqual(["a.ts", "new.ts"]);
  });
  it("returns null when a side is unreadable", async () => {
    expect(await changedFiles(fakeArtifacts({ r: store }), "r", "c0", "missing")).toBeNull();
    expect(await changedFiles(fakeArtifacts({}), "r", "c0", "c1")).toBeNull();
  });
});

describe("composeVerdict", () => {
  it("skips tournaments that are not ready", async () => {
    const db = sqliteDb();
    const open = await seedTournament(db, { state: "open" });
    expect(await composeVerdict(db, { artifacts: null }, open)).toEqual({ status: "skipped", reason: "not-ready" });
    const empty = await seedTournament(db);
    expect(await composeVerdict(db, { artifacts: null }, empty)).toEqual({ status: "skipped", reason: "no-attempts" });
    const tid = await seedTournament(db);
    await seedAttempt(db, tid, "a1");
    expect(await composeVerdict(db, { artifacts: null }, tid)).toEqual({ status: "skipped", reason: "not-ready" });
  });
  it("decides with AI rationale and records ranks + ledger", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    await seedRun(db, "run-a", "failure", 2);
    await seedRun(db, "run-b", "success", 0);
    const a1 = await seedAttempt(db, tid, "a1", { run: "run-a" });
    const a2 = await seedAttempt(db, tid, "a2", { run: "run-b" });
    const ai = { run: async () => ({ response: "Winner: a2. Why: green while a1 fails two tests." }) };
    const out = await composeVerdict(db, { artifacts: null, ai }, tid);
    expect(out.status).toBe("decided");
    if (out.status !== "decided") throw new Error("should decide");
    expect(out.winnerAttemptId).toBe(a2);
    expect(out.model).toContain("llama");
    const ranks = await db.prepare("SELECT agent, verdict_rank FROM attempts WHERE tournament_id = ?").bind(tid).all<{ agent: string; verdict_rank: number }>();
    expect(new Map(ranks.results.map((r) => [r.agent, r.verdict_rank]))).toEqual(new Map([["a2", 1], ["a1", 2]]));
    expect(a1).not.toBe(a2);
    const kinds = await db.prepare("SELECT kind FROM ledger WHERE tournament_id = ?").bind(tid).all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toContain("verdict");
    expect(await composeVerdict(db, { artifacts: null, ai }, tid)).toEqual({ status: "skipped", reason: "already" });
  });
  it("falls back to deterministic ranking without AI", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    await seedRun(db, "run-a", "success", 0);
    await seedAttempt(db, tid, "a1", { run: "run-a" });
    const out = await composeVerdict(db, { artifacts: null }, tid);
    expect(out).toEqual(expect.objectContaining({ status: "decided", model: "deterministic" }));
  });
  it("decides on timeout with a stuck attempt", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    await seedRun(db, "run-a", "success", 0);
    await seedAttempt(db, tid, "a1", { run: "run-a", updated: "2026-10-06T10:00:00.000Z" });
    await seedAttempt(db, tid, "a2", { updated: "2026-10-06T10:00:00.000Z" });
    const out = await composeVerdict(db, { artifacts: null }, tid, Date.parse("2026-10-06T11:00:00.000Z"));
    expect(out.status).toBe("decided");
    if (out.status !== "decided") throw new Error("should decide");
    expect(out.rationale).toContain("[decided on timeout]");
  });
  it("records radar collisions in the ledger", async () => {
    const db = sqliteDb();
    const base = "b".repeat(40);
    const tid = await seedTournament(db, { baseSha: base });
    await seedRun(db, "run-a", "success", 0);
    await seedRun(db, "run-b", "success", 0);
    const h1 = "1".repeat(40);
    const h2 = "2".repeat(40);
    await seedAttempt(db, tid, "a1", { run: "run-a", fork: "f1", sha: h1 });
    await seedAttempt(db, tid, "a2", { run: "run-b", fork: "f2", sha: h2 });
    const merged: FakeStore = {
      commits: new Map([[base, "tb"], [h1, "t1"], [h2, "t2"]]),
      trees: new Map([
        ["tb", [{ name: "shared.ts", mode: "100644", hash: "o" }]],
        ["t1", [{ name: "shared.ts", mode: "100644", hash: "n1" }]],
        ["t2", [{ name: "shared.ts", mode: "100644", hash: "n2" }]],
      ]),
    };
    const out = await composeVerdict(db, { artifacts: fakeArtifacts({ f1: merged, f2: merged }) }, tid);
    expect(out.status).toBe("decided");
    const kinds = await db.prepare("SELECT kind, body FROM ledger WHERE tournament_id = ? AND kind = 'collision'").bind(tid).all<{ kind: string; body: string }>();
    expect(kinds.results).toHaveLength(1);
    expect(kinds.results[0].body).toContain("shared.ts");
  });
});

describe("verdictPass", () => {
  it("decides eligible tournaments and counts them", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    await seedRun(db, "run-a", "success", 0);
    await seedAttempt(db, tid, "a1", { run: "run-a" });
    expect(await verdictPass(db, { artifacts: null })).toEqual({ decided: 1 });
    expect(await verdictPass(db, { artifacts: null })).toEqual({ decided: 0 });
  });
});
