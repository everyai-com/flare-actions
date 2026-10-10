/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  appendLedger,
  claimAttempt,
  createTournament,
  forkHead,
  forkNameFor,
  getAttemptRace,
  getTournamentBoard,
  pollTournamentAttempts,
  validateTournamentClaim,
  validateTournamentCreate,
  type TournamentArtifacts,
  type TournamentRepoHandle,
} from "./tournaments";
import type { ArtifactsDispatchInput } from "./artifacts-push";

// node:sqlite via getBuiltinModule: vite-node's import analysis predates
// the specifier, but the runtime resolves it fine.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const SCHEMA = `
CREATE TABLE tournaments (id TEXT PRIMARY KEY, intent TEXT NOT NULL, source_repo TEXT NOT NULL,
  base_ref TEXT NOT NULL DEFAULT 'main', base_sha TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
  winner_run_id TEXT, resolved_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE attempts (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL, agent TEXT NOT NULL,
  fork_repo TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'claimed', last_seen_sha TEXT NOT NULL DEFAULT '',
  run_id TEXT, verdict_rank INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (tournament_id, agent));
CREATE TABLE verdicts (tournament_id TEXT PRIMARY KEY, ranking TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE ledger (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued');
CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);`;

function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          // Mirror D1's bound-parameter cap so oversized IN lists fail here too.
          if (values.length > 100) throw new Error("D1: too many SQL variables");
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

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const YAML = "jobs:\n  t:\n    steps:\n      - run: echo hi\n";

interface FakeRepo {
  head: string | null;
  files: Map<string, string>;
  forks: string[];
}

// In-memory Artifacts binding: repos with heads + ref-pinned files.
function fakeArtifacts(repos: Record<string, Partial<FakeRepo>> = {}, opts: { forkThrows?: boolean } = {}): {
  artifacts: TournamentArtifacts;
  store: Map<string, FakeRepo>;
  reads: { ref: string; path: string }[];
} {
  const store = new Map<string, FakeRepo>();
  for (const [name, over] of Object.entries(repos)) {
    store.set(name, { head: over.head ?? null, files: over.files ?? new Map(), forks: [] });
  }
  const reads: { ref: string; path: string }[] = [];
  const handle = (name: string): TournamentRepoHandle => ({
    readFile: async ({ ref, path }) => {
      reads.push({ ref, path });
      const content = store.get(name)?.files.get(`${ref}:${path}`) ?? null;
      return content === null ? null : { size: content.length, text: async () => content };
    },
    fork: async (forkName: string) => {
      if (opts.forkThrows) throw new Error("fork exploded");
      if (store.has(forkName)) {
        const err = new Error("exists") as Error & { code: string };
        err.code = "ALREADY_EXISTS";
        throw err;
      }
      const src = store.get(name);
      store.set(forkName, { head: src?.head ?? null, files: new Map(src?.files ?? []), forks: [] });
      src?.forks.push(forkName);
      return { name: forkName, remote: `https://acct.git/${forkName}.git`, defaultBranch: "main" };
    },
    log: async () => {
      const head = store.get(name)?.head ?? null;
      return head ? [{ hash: head }] : [];
    },
    readTree: async () => null,
    readCommit: async () => null,
    createToken: async () => ({ plaintext: "tok" }),
    [Symbol.dispose]: () => undefined,
  });
  return { artifacts: { get: async (name: string) => handle(name) }, store, reads };
}

async function seedTournament(db: Db, source = "base"): Promise<string> {
  const { id } = await createTournament(db, { intent: "fix it", sourceRepo: source });
  return id;
}

describe("forkNameFor", () => {
  it("builds deterministic, safe fork names", () => {
    expect(forkNameFor("12345678-90ab", "agent-1")).toBe("t-12345678-agent-1");
    expect(forkNameFor("12345678-90ab", "Agent_1.X")).toBe("t-12345678-agent-1-x");
    expect(forkNameFor("12345678-90ab", "agent-1")).toHaveLength(18);
  });
});

describe("createTournament", () => {
  it("stores intent + source and opens the ledger", async () => {
    const db = sqliteDb();
    const { id } = await createTournament(db, { intent: "ship it", sourceRepo: "base", baseRef: "dev" });
    const row = await db.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(row?.["state"]).toBe("open");
    expect(row?.["base_ref"]).toBe("dev");
    const ledger = await db.prepare("SELECT kind FROM ledger WHERE tournament_id = ?").bind(id).all<{ kind: string }>();
    expect(ledger.results.map((r) => r.kind)).toEqual(["opened"]);
  });
});

describe("claimAttempt", () => {
  it("claims a slot and forks the source", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts, store } = fakeArtifacts({ base: { head: SHA_A } });
    const out = await claimAttempt(db, artifacts, tid, "agent-1");
    expect(out).toMatchObject({ forkRepo: `t-${tid.slice(0, 8)}-agent-1` });
    if ("error" in out) throw new Error("should claim");
    expect(out.remote).toContain(out.forkRepo);
    expect(store.has(out.forkRepo)).toBe(true);
    const kinds = await db.prepare("SELECT kind FROM ledger WHERE tournament_id = ? ORDER BY created_at ASC").bind(tid).all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toEqual(["opened", "claimed"]);
  });
  it("rejects bad agents, closed tournaments, and double claims", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts } = fakeArtifacts({ base: {} });
    expect(await claimAttempt(db, artifacts, tid, "no spaces")).toEqual({ error: "invalid-agent" });
    expect(await claimAttempt(db, artifacts, "missing", "a1")).toEqual({ error: "tournament-not-open" });
    expect(await claimAttempt(db, artifacts, tid, "a1")).not.toHaveProperty("error");
    expect(await claimAttempt(db, artifacts, tid, "a1")).toEqual({ error: "already-claimed" });
    await db.prepare("UPDATE tournaments SET state = 'decided' WHERE id = ?").bind(tid).run();
    expect(await claimAttempt(db, artifacts, tid, "a2")).toEqual({ error: "tournament-not-open" });
  });
  it("deletes its row when the fork fails", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts } = fakeArtifacts({ base: {} }, { forkThrows: true });
    expect(await claimAttempt(db, artifacts, tid, "a1")).toEqual({ error: "fork-failed" });
    const rows = await db.prepare("SELECT id FROM attempts WHERE tournament_id = ?").bind(tid).all();
    expect(rows.results).toHaveLength(0);
  });
});

describe("forkHead", () => {
  it("returns validated heads and nulls everything else", async () => {
    const { artifacts } = fakeArtifacts({ good: { head: SHA_A }, empty: {}, bad: { head: "zzz" } });
    expect(await forkHead(artifacts, "good")).toBe(SHA_A);
    expect(await forkHead(artifacts, "empty")).toBeNull();
    expect(await forkHead(artifacts, "bad")).toBeNull();
    expect(await forkHead(artifacts, "missing")).toBeNull();
  });
});

describe("pollTournamentAttempts", () => {
  it("dispatches new heads with the artifacts event", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts, store } = fakeArtifacts({ base: { head: SHA_A, files: new Map([[`${SHA_A}:flare.yml`, YAML]]) } });
    const claimed = await claimAttempt(db, artifacts, tid, "a1");
    if ("error" in claimed) throw new Error("should claim");
    // Agent pushes: fork head + pipeline move together.
    store.get(claimed.forkRepo)!.head = SHA_B;
    store.get(claimed.forkRepo)!.files.set(`${SHA_B}:flare.yml`, YAML);
    const inputs: ArtifactsDispatchInput[] = [];
    const out = await pollTournamentAttempts({
      db,
      artifacts,
      namespace: "ns",
      dispatch: async (input) => {
        inputs.push(input);
        return { runId: "run-1" };
      },
    });
    expect(out).toEqual({ checked: 1, dispatched: 1, terminal: 0 });
    expect(inputs[0]).toEqual({ repo: `ns/${claimed.forkRepo}`, sha: SHA_B, ref: "refs/heads/main", pipeline: YAML, event: "artifacts" });
    const attempt = await db.prepare("SELECT state, run_id, last_seen_sha FROM attempts WHERE id = ?").bind(claimed.attemptId).first<Record<string, unknown>>();
    expect(attempt).toMatchObject({ state: "verifying", run_id: "run-1", last_seen_sha: SHA_B });
    const tstate = await db.prepare("SELECT state FROM tournaments WHERE id = ?").bind(tid).first<{ state: string }>();
    expect(tstate?.state).toBe("verifying");
  });
  it("stamps head-only sightings and never re-reads them", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts, store, reads } = fakeArtifacts({ base: {} });
    const claimed = await claimAttempt(db, artifacts, tid, "a1");
    if ("error" in claimed) throw new Error("should claim");
    store.get(claimed.forkRepo)!.head = SHA_A; // no flare.yml at this head
    let dispatches = 0;
    const deps = { db, artifacts, namespace: "ns", dispatch: async () => { dispatches++; return { runId: "r" }; } };
    expect(await pollTournamentAttempts(deps)).toEqual({ checked: 1, dispatched: 0, terminal: 0 });
    const attempt = await db.prepare("SELECT state, last_seen_sha FROM attempts WHERE id = ?").bind(claimed.attemptId).first<Record<string, unknown>>();
    expect(attempt).toMatchObject({ state: "pushing", last_seen_sha: SHA_A });
    expect(reads).toHaveLength(1);
    expect(await pollTournamentAttempts(deps)).toEqual({ checked: 1, dispatched: 0, terminal: 0 });
    expect(reads).toHaveLength(1);
    expect(dispatches).toBe(0);
  });
  it("terminalizes finished runs and re-dispatches fresher pushes", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts, store } = fakeArtifacts({ base: { head: SHA_A, files: new Map([[`${SHA_A}:flare.yml`, YAML]]) } });
    const claimed = await claimAttempt(db, artifacts, tid, "a1");
    if ("error" in claimed) throw new Error("should claim");
    store.get(claimed.forkRepo)!.head = SHA_A;
    store.get(claimed.forkRepo)!.files.set(`${SHA_A}:flare.yml`, YAML);
    const runs: string[] = [];
    const deps = {
      db,
      artifacts,
      namespace: "ns",
      dispatch: async () => {
        const id = `run-${runs.length + 1}`;
        runs.push(id);
        await db.prepare("INSERT INTO runs (id, status) VALUES (?, 'queued')").bind(id).run();
        return { runId: id };
      },
    };
    expect(await pollTournamentAttempts(deps)).toEqual({ checked: 1, dispatched: 1, terminal: 0 });
    await db.prepare("UPDATE runs SET status = 'success' WHERE id = 'run-1'").bind().run();
    expect(await pollTournamentAttempts(deps)).toEqual({ checked: 1, dispatched: 0, terminal: 1 });
    // Fresh push after terminal dispatches a new verification.
    store.get(claimed.forkRepo)!.head = SHA_B;
    store.get(claimed.forkRepo)!.files.set(`${SHA_B}:flare.yml`, YAML);
    expect(await pollTournamentAttempts(deps)).toEqual({ checked: 1, dispatched: 1, terminal: 0 });
    expect(runs).toEqual(["run-1", "run-2"]);
  });
  it("no-ops without a binding or namespace", async () => {
    const db = sqliteDb();
    await seedTournament(db);
    const out = await pollTournamentAttempts({ db, artifacts: null, namespace: "ns", dispatch: async () => ({ runId: "r" }) });
    expect(out).toEqual({ checked: 0, dispatched: 0, terminal: 0 });
  });
});

describe("validators", () => {
  it("accepts valid creates and claims", () => {
    expect(validateTournamentCreate({ intent: "fix it", sourceRepo: "base" })).toEqual({
      intent: "fix it",
      sourceRepo: "base",
      baseRef: "main",
      baseSha: "",
    });
    expect(validateTournamentClaim({ agent: "agent-1" })).toEqual({ agent: "agent-1" });
  });
  it("rejects malformed input", () => {
    expect(validateTournamentCreate({ intent: "", sourceRepo: "base" })).toHaveProperty("error");
    expect(validateTournamentCreate({ intent: "x", sourceRepo: "a/b" })).toHaveProperty("error");
    expect(validateTournamentCreate({ intent: "x", sourceRepo: "b", baseRef: "" })).toHaveProperty("error");
    expect(validateTournamentClaim({ agent: "no spaces" })).toHaveProperty("error");
    expect(validateTournamentClaim({})).toHaveProperty("error");
  });
});

describe("appendLedger + getTournamentBoard", () => {
  it("returns the tournament with attempts, verdict, and ledger", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts } = fakeArtifacts({ base: {} });
    await claimAttempt(db, artifacts, tid, "a1");
    await appendLedger(db, tid, "custom", "note");
    const board = await getTournamentBoard(db, tid);
    expect(board?.attempts).toHaveLength(1);
    expect(board?.verdict).toBeNull();
    expect(board?.ledger.map((r) => r.kind)).toEqual(["opened", "claimed", "custom"]);
    expect(await getTournamentBoard(db, "missing")).toBeNull();
  });

  it("attaches verification run status to board attempts", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts } = fakeArtifacts({ base: {} });
    await claimAttempt(db, artifacts, tid, "a1");
    await claimAttempt(db, artifacts, tid, "a2");
    await db.prepare("INSERT INTO runs (id, status) VALUES (?, ?)").bind("run-1", "success").run();
    await db.prepare("UPDATE attempts SET run_id = ? WHERE tournament_id = ? AND agent = ?").bind("run-1", tid, "a1").run();
    const board = await getTournamentBoard(db, tid);
    const byAgent = new Map((board?.attempts ?? []).map((a) => [a.agent, a.run_status]));
    expect(byAgent.get("a1")).toBe("success");
    expect(byAgent.get("a2")).toBeNull();
  });

  it("renders boards past D1's 100-parameter cap", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const now = new Date().toISOString();
    for (let i = 0; i < 150; i++) {
      await db
        .prepare("INSERT INTO attempts (id, tournament_id, agent, fork_repo, run_id, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?)")
        .bind(`at-${i}`, tid, `agent-${i}`, `run-${i}`, now, now)
        .run();
      await db.prepare("INSERT INTO runs (id, status) VALUES (?, 'success')").bind(`run-${i}`).run();
    }
    const board = await getTournamentBoard(db, tid);
    expect(board?.attempts).toHaveLength(150);
    expect(board?.attempts.every((a) => a.run_status === "success")).toBe(true);
  });

  it("resolves the race behind a verification run", async () => {
    const db = sqliteDb();
    const tid = await seedTournament(db);
    const { artifacts } = fakeArtifacts({ base: {} });
    await claimAttempt(db, artifacts, tid, "a1");
    await db.prepare("UPDATE attempts SET run_id = ? WHERE tournament_id = ?").bind("run-9", tid).run();
    expect(await getAttemptRace(db, "run-9")).toEqual({ tournament_id: tid, agent: "a1", verdict_rank: null });
    expect(await getAttemptRace(db, "other")).toBeNull();
  });
});
