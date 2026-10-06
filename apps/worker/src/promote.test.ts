/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { FsClient } from "isomorphic-git";
import type { Db } from "./db";
import {
  artifactsRemoteFor,
  fastForwardPass,
  fastForwardWinner,
  resolvePass,
  resolveTournament,
  type FastForwardDeps,
  type PromoteGit,
} from "./promote";

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
  body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);`;

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

const SHA = "c".repeat(40);

async function seedDecided(db: Db, tid: string): Promise<void> {
  const now = "2026-10-06T11:00:00.000Z";
  await db
    .prepare("INSERT INTO tournaments (id, intent, source_repo, state, winner_run_id, resolved_sha, created_at, updated_at) VALUES (?, 'fix', 'base', 'decided', 'run-1', ?, ?, ?)")
    .bind(tid, SHA, now, now)
    .run();
  await db
    .prepare("INSERT INTO attempts (id, tournament_id, agent, fork_repo, state, last_seen_sha, run_id, verdict_rank, created_at, updated_at) VALUES (?, ?, 'a1', 'fork-1', 'terminal', ?, 'run-1', 1, ?, ?)")
    .bind(`a-${tid}`, tid, SHA, now, now)
    .run();
}

async function seedVerifying(db: Db, tid: string, withVerdict: boolean): Promise<void> {
  const now = "2026-10-06T11:00:00.000Z";
  await db
    .prepare("INSERT INTO tournaments (id, intent, source_repo, state, created_at, updated_at) VALUES (?, 'fix', 'base', 'verifying', ?, ?)")
    .bind(tid, now, now)
    .run();
  await db
    .prepare("INSERT INTO attempts (id, tournament_id, agent, fork_repo, state, last_seen_sha, run_id, verdict_rank, created_at, updated_at) VALUES (?, ?, 'a1', 'fork-1', 'terminal', ?, 'run-1', 1, ?, ?)")
    .bind(`a-${tid}`, tid, SHA, now, now)
    .run();
  if (withVerdict) {
    await db
      .prepare("INSERT INTO verdicts (tournament_id, ranking, rationale, model, created_at) VALUES (?, '[\"a1\"]', 'why', 'm', ?)")
      .bind(tid, now)
      .run();
  }
}

describe("artifactsRemoteFor", () => {
  it("builds strict remotes and rejects malformed parts", () => {
    const acct = "a".repeat(32);
    expect(artifactsRemoteFor(acct, "ns", "repo")).toBe(`https://${acct}.artifacts.cloudflare.net/git/ns/repo.git`);
    expect(artifactsRemoteFor("short", "ns", "repo")).toBeNull();
    expect(artifactsRemoteFor(acct, "n/s", "repo")).toBeNull();
    expect(artifactsRemoteFor(acct, "ns", "")).toBeNull();
  });
});

describe("resolveTournament + resolvePass", () => {
  it("resolves verifying tournaments with verdicts to the pointer", async () => {
    const db = sqliteDb();
    await seedVerifying(db, "t1", true);
    const out = await resolveTournament(db, "t1");
    expect(out).toEqual({ status: "resolved", winnerRunId: "run-1", resolvedSha: SHA });
    const row = await db.prepare("SELECT state, winner_run_id, resolved_sha FROM tournaments WHERE id = 't1'").bind().first<Record<string, unknown>>();
    expect(row).toMatchObject({ state: "decided", winner_run_id: "run-1", resolved_sha: SHA });
    const kinds = await db.prepare("SELECT kind FROM ledger WHERE tournament_id = 't1'").bind().all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toEqual(["resolved"]);
  });
  it("skips not-ready and decided tournaments", async () => {
    const db = sqliteDb();
    await seedVerifying(db, "t1", false);
    expect(await resolveTournament(db, "t1")).toEqual({ status: "skipped", reason: "not-ready" });
    expect(await resolveTournament(db, "missing")).toEqual({ status: "skipped", reason: "already" });
    await seedDecided(db, "t2");
    expect(await resolveTournament(db, "t2")).toEqual({ status: "skipped", reason: "already" });
  });
  it("resolvePass resolves each ready tournament once", async () => {
    const db = sqliteDb();
    await seedVerifying(db, "t1", true);
    await seedVerifying(db, "t2", false);
    expect(await resolvePass(db)).toEqual({ resolved: 1 });
    expect(await resolvePass(db)).toEqual({ resolved: 0 });
  });
});

function fakeGit(calls: string[], opts: { pushThrows?: boolean } = {}): PromoteGit {
  return {
    init: async () => { calls.push("init"); },
    addRemote: async (o) => { calls.push(`remote:${o.remote}`); },
    fetch: async (o) => { calls.push(`fetch:${o.remote}:${o.ref}`); },
    branch: async (o) => { calls.push(`branch:${o.ref}@${o.object}`); },
    push: async () => {
      calls.push("push");
      if (opts.pushThrows) throw new Error("non-fast-forward");
    },
  };
}

function stubFs(): FsClient {
  const fn = async () => undefined;
  return { promises: { readFile: fn, writeFile: fn, unlink: fn, readdir: fn, mkdir: fn, rmdir: fn, stat: fn, lstat: fn } };
}

function ffDeps(db: Db, git: PromoteGit | null, over: Partial<FastForwardDeps> = {}): FastForwardDeps {
  return {
    db,
    artifacts: {
      get: async () => ({
        readFile: async () => null,
        fork: async () => ({ name: "", remote: "", defaultBranch: "main" }),
        log: async () => [],
        readTree: async () => null,
        readCommit: async () => null,
        createToken: async () => ({ plaintext: "writetok?expires=9" }),
        [Symbol.dispose]: () => undefined,
      }),
    },
    remoteFor: (repo: string) => `https://acct.git/ns/${repo}.git`,
    git,
    http: { request: async () => { throw new Error("no network in tests"); } },
    fs: () => stubFs(),
    ...over,
  };
}

describe("fastForwardWinner", () => {

  it("pushes the winner tree through the fetch-branch-push sequence", async () => {
    const db = sqliteDb();
    await seedDecided(db, "t1");
    const calls: string[] = [];
    const out = await fastForwardWinner(ffDeps(db, fakeGit(calls)), "t1");
    expect(out).toEqual({ status: "pushed", sha: SHA });
    expect(calls).toEqual(["init", "remote:winner", "remote:source", `fetch:winner:${SHA}`, `branch:main@${SHA}`, "push"]);
    const kinds = await db.prepare("SELECT kind FROM ledger WHERE tournament_id = 't1'").bind().all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toEqual(["promoted"]);
    expect(await fastForwardWinner(ffDeps(db, fakeGit(calls)), "t1")).toEqual({ status: "skipped", reason: "already" });
  });
  it("fails closed on push rejection and records the fallback", async () => {
    const db = sqliteDb();
    await seedDecided(db, "t1");
    const out = await fastForwardWinner(ffDeps(db, fakeGit([], { pushThrows: true })), "t1");
    expect(out).toEqual({ status: "skipped", reason: "failed" });
    const kinds = await db.prepare("SELECT kind FROM ledger WHERE tournament_id = 't1'").bind().all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toEqual(["promote-failed"]);
  });
  it("skips without git, http, remotes, or readiness", async () => {
    const db = sqliteDb();
    await seedDecided(db, "t1");
    expect(await fastForwardWinner(ffDeps(db, null), "t1")).toEqual({ status: "skipped", reason: "unavailable" });
    expect(await fastForwardWinner(ffDeps(db, fakeGit([]), { remoteFor: () => null }), "t1")).toEqual({ status: "skipped", reason: "unavailable" });
    expect(await fastForwardWinner(ffDeps(db, fakeGit([])), "missing")).toEqual({ status: "skipped", reason: "not-ready" });
  });
});

describe("fastForwardPass", () => {
  it("pushes each unpromoted decided tournament once", async () => {
    const db = sqliteDb();
    await seedDecided(db, "t1");
    const calls: string[] = [];
    const d = ffDeps(db, fakeGit(calls));
    expect(await fastForwardPass(d)).toEqual({ pushed: 1 });
    expect(await fastForwardPass(d)).toEqual({ pushed: 0 });
    expect(calls.filter((c) => c === "push")).toHaveLength(1);
  });
});
