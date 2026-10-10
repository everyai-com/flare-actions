/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { SCHEMA_STATEMENTS } from "./schema";
import { DEFAULT_POLICY } from "./intents-core";
import type { TournamentArtifacts, TournamentRepoHandle } from "./tournaments";
import {
  approvePlan,
  appendForgeLedger,
  claimConflict,
  claimIntent,
  createGoal,
  createTrain,
  declareIntent,
  drainInbox,
  expireLeases,
  getConflict,
  getIntent,
  getIntentByFork,
  getTrain,
  getTrainByRun,
  heartbeatIntent,
  isForgeError,
  listConflicts,
  listForgeLedger,
  listGoals,
  listIntents,
  listTrains,
  markReady,
  openConflict,
  recordPush,
  resolveConflict,
  sendMessage,
  setGoalState,
  transitionConflict,
  transitionIntent,
  transitionTrain,
  FORK_TOKEN_TTL_SECONDS,
} from "./intents";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const FORGE_TABLES = ["goals", "intents", "conflicts", "trains", "intent_messages", "forge_ledger"];

// The real schema.ts DDL for the forge tables (CHECK constraints
// included), so the tests exercise exactly what ships.
function sqliteDb(): { db: Db; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const sql of SCHEMA_STATEMENTS) {
    const m = /(?:TABLE IF NOT EXISTS|ON) (\w+)/.exec(sql);
    if (m && FORGE_TABLES.includes(m[1])) raw.exec(sql);
  }
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          if (values.length > 100) throw new Error("D1: too many SQL variables");
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
            run: async () => {
              const info = raw.prepare(query).run(...params) as { changes?: unknown };
              return { meta: { changes: typeof info.changes === "number" ? info.changes : Number(info.changes ?? 0) } };
            },
          };
        },
      };
    },
  } as unknown as Db;
  return { db, raw };
}

interface FakeOpts {
  forkThrows?: boolean;
  tokenThrows?: boolean;
}

function fakeArtifacts(opts: FakeOpts = {}): {
  artifacts: TournamentArtifacts;
  forks: string[];
  tokens: Array<{ repo: string; scope: string; ttl: number }>;
} {
  const forks: string[] = [];
  const tokens: Array<{ repo: string; scope: string; ttl: number }> = [];
  const handle = (name: string): TournamentRepoHandle => ({
    readFile: async () => null,
    fork: async (forkName: string) => {
      if (opts.forkThrows) throw new Error("fork exploded");
      if (forks.includes(forkName)) {
        const err = new Error("exists") as Error & { code: string };
        err.code = "ALREADY_EXISTS";
        throw err;
      }
      forks.push(forkName);
      return { name: forkName, remote: `https://acct.git/${forkName}.git`, defaultBranch: "main" };
    },
    log: async () => [],
    readTree: async () => null,
    readCommit: async () => null,
    createToken: async (scope, ttl) => {
      if (opts.tokenThrows) throw new Error("token exploded");
      tokens.push({ repo: name, scope, ttl });
      return { plaintext: `tok-${name}` };
    },
    [Symbol.dispose]: () => undefined,
  });
  return { artifacts: { get: async (name: string) => handle(name) }, forks, tokens };
}

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

async function declared(db: Db, paths: string[] = ["src/api/x.ts"], policy = DEFAULT_POLICY) {
  const r = await declareIntent(db, { repo: "demo", title: "Add x", reasoning: "because", accept: "npm test", footprint: { paths }, policy });
  if (isForgeError(r)) throw new Error(r.message);
  return r;
}

describe("goals", () => {
  it("creates, lists and closes", async () => {
    const { db } = sqliteDb();
    const g = await createGoal(db, { repo: "demo", text: "Harden login", createdBy: "pat" });
    if (isForgeError(g)) throw new Error(g.message);
    expect(g.state).toBe("open");
    expect((await listGoals(db, "demo")).map((x) => x.id)).toEqual([g.id]);
    expect(await setGoalState(db, g.id, "open", "done")).toBe(true);
    expect(await setGoalState(db, g.id, "open", "done")).toBe(false);
    expect(await listGoals(db, "demo", { state: "open" })).toEqual([]);
    expect(isForgeError(await createGoal(db, { repo: "demo", text: "  " }))).toBe(true);
    expect(isForgeError(await createGoal(db, { repo: "../x", text: "t" }))).toBe(true);
  });
  it("rejects intents on closed or foreign goals", async () => {
    const { db } = sqliteDb();
    const g = await createGoal(db, { repo: "demo", text: "G" });
    if (isForgeError(g)) throw new Error(g.message);
    const other = await declareIntent(db, { repo: "other", goalId: g.id, title: "abc", footprint: ["a"] });
    expect(isForgeError(other) && other.error).toBe("goal-not-found");
    await setGoalState(db, g.id, "open", "done");
    const closed = await declareIntent(db, { repo: "demo", goalId: g.id, title: "abc", footprint: ["a"] });
    expect(isForgeError(closed) && closed.error).toBe("goal-closed");
  });
});

describe("declareIntent", () => {
  it("inserts a draft with normalized footprint and declare-time risk", async () => {
    const { db } = sqliteDb();
    const { intent, protectedHits } = await declared(db, ["./src/api/x.ts", "src/api/x.ts", "lib/**"]);
    expect(intent.state).toBe("draft");
    expect(protectedHits).toEqual([]);
    expect(intent.footprint.paths).toEqual(["lib/**", "src/api/x.ts"]);
    expect(intent.riskTerms.map((t) => t.term)).toEqual(["footprint_size"]);
    expect((await getIntent(db, intent.id))?.footprint).toEqual(intent.footprint);
  });
  it("gates protected footprints at awaiting_plan until approved", async () => {
    const { db } = sqliteDb();
    const policy = { ...DEFAULT_POLICY, protected: ["src/auth/**"] };
    const { intent, protectedHits } = await declared(db, ["src/auth/session.ts"], policy);
    expect(intent.state).toBe("awaiting_plan");
    expect(protectedHits).toEqual(["src/auth/**"]);
    expect(intent.risk).toBeGreaterThanOrEqual(40);
    const { artifacts } = fakeArtifacts();
    const blocked = await claimIntent(db, artifacts, { id: intent.id, agent: "a1" });
    expect("error" in blocked && blocked.error).toBe("not-claimable");
    expect(await approvePlan(db, intent.id, "")).toBe(false);
    expect(await approvePlan(db, intent.id, "pat")).toBe(true);
    expect(await approvePlan(db, intent.id, "pat")).toBe(false);
    const after = await getIntent(db, intent.id);
    expect(after?.state).toBe("draft");
    expect(after?.planApprovedBy).toBe("pat");
  });
  it("validates input", async () => {
    const { db } = sqliteDb();
    expect(isForgeError(await declareIntent(db, { repo: "demo", title: "x", footprint: ["a"] }))).toBe(true);
    expect(isForgeError(await declareIntent(db, { repo: "demo", title: "abc", footprint: ["../a"] }))).toBe(true);
    expect(isForgeError(await declareIntent(db, { repo: "demo", title: "abc", footprint: ["a"], agent: "bad agent" }))).toBe(true);
    expect(isForgeError(await declareIntent(db, { repo: "demo", title: "abc", footprint: ["a"], baseSha: "zz" }))).toBe(true);
  });
  it("CHECK constraints reject unknown states", async () => {
    const { db, raw } = sqliteDb();
    const { intent } = await declared(db);
    expect(() => raw.prepare("UPDATE intents SET state = 'merged' WHERE id = ?").run(intent.id)).toThrow(/CHECK/);
    expect(() => raw.prepare("UPDATE intents SET risk = 101 WHERE id = ?").run(intent.id)).toThrow(/CHECK/);
  });
});

describe("claimIntent", () => {
  it("forks trunk to i-<shortid> and mints a 1h fork-scoped write token (never trunk)", async () => {
    const { db } = sqliteDb();
    const { intent } = await declared(db);
    const fake = fakeArtifacts();
    const r = await claimIntent(db, fake.artifacts, { id: intent.id, agent: "a1" });
    if ("error" in r) throw new Error(r.message);
    expect(r.forkRepo).toMatch(/^i-[0-9a-f]{12}$/);
    expect(r.remote).toBe(`https://acct.git/${r.forkRepo}.git`);
    expect(r.token).toBe(`tok-${r.forkRepo}`);
    expect(fake.tokens).toEqual([{ repo: r.forkRepo, scope: "write", ttl: FORK_TOKEN_TTL_SECONDS }]);
    expect(fake.tokens.some((t) => t.repo === "demo")).toBe(false);
    expect(r.intent.state).toBe("claimed");
    expect(r.intent.agent).toBe("a1");
    expect(r.intent.leaseExpiresAt).not.toBeNull();
    expect((await getIntentByFork(db, r.forkRepo))?.id).toBe(intent.id);
  });
  it("loses a second concurrent claim without forking twice", async () => {
    const { db } = sqliteDb();
    const { intent } = await declared(db);
    const fake = fakeArtifacts();
    const [x, y] = await Promise.all([
      claimIntent(db, fake.artifacts, { id: intent.id, agent: "a1" }),
      claimIntent(db, fake.artifacts, { id: intent.id, agent: "a2" }),
    ]);
    const wins = [x, y].filter((r) => !("error" in r));
    expect(wins).toHaveLength(1);
    expect(fake.forks).toHaveLength(1);
  });
  it("releases the claim when fork or token fails", async () => {
    const { db } = sqliteDb();
    const { intent } = await declared(db);
    const r1 = await claimIntent(db, fakeArtifacts({ forkThrows: true }).artifacts, { id: intent.id, agent: "a1" });
    expect("error" in r1 && r1.error).toBe("fork-failed");
    expect((await getIntent(db, intent.id))?.state).toBe("draft");
    const r2 = await claimIntent(db, fakeArtifacts({ tokenThrows: true }).artifacts, { id: intent.id, agent: "a1" });
    expect("error" in r2 && r2.error).toBe("token-failed");
    expect((await getIntent(db, intent.id))?.state).toBe("draft");
  });
  it("re-claims an expired intent reusing its fork", async () => {
    const { db } = sqliteDb();
    const { intent } = await declared(db);
    const fake = fakeArtifacts();
    const first = await claimIntent(db, fake.artifacts, { id: intent.id, agent: "a1", leaseTtlSeconds: 1 });
    if ("error" in first) throw new Error(first.message);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await expireLeases(db, future)).toEqual([intent.id]);
    expect(await heartbeatIntent(db, intent.id, "a1")).toBeNull();
    const second = await claimIntent(db, fake.artifacts, { id: intent.id, agent: "a2" });
    if ("error" in second) throw new Error(second.message);
    expect(second.forkRepo).toBe(first.forkRepo);
    expect(fake.forks).toHaveLength(1);
    expect(second.intent.agent).toBe("a2");
  });
});

describe("push, ready, lifecycle", () => {
  async function claimed(db: Db, paths?: string[]) {
    const { intent } = await declared(db, paths);
    const r = await claimIntent(db, fakeArtifacts().artifacts, { id: intent.id, agent: "a1" });
    if ("error" in r) throw new Error(r.message);
    return r.intent;
  }
  it("records the actual footprint, drift and risk; mark_ready needs a push", async () => {
    const { db } = sqliteDb();
    const intent = await claimed(db, ["src/api/**"]);
    const early = await markReady(db, intent.id, "a1");
    expect(isForgeError(early) && early.error).toBe("not-ready");
    const pushed = await recordPush(db, { id: intent.id, agent: "a1", headSha: SHA, actualFootprint: ["src/api/x.ts", "src/db.ts"] });
    if (isForgeError(pushed)) throw new Error(pushed.message);
    expect(pushed.drift).toEqual(["src/db.ts"]);
    expect(pushed.riskTerms.map((t) => t.term)).toContain("drift");
    expect(pushed.intent.state).toBe("working");
    expect(pushed.intent.headSha).toBe(SHA);
    const other = await recordPush(db, { id: intent.id, agent: "a2", headSha: SHA2, actualFootprint: [] });
    expect(isForgeError(other) && other.error).toBe("not-owner");
    const ready = await markReady(db, intent.id, "a1");
    expect(!isForgeError(ready) && ready.state).toBe("ready");
    // A push after ready reopens the intent.
    const again = await recordPush(db, { id: intent.id, agent: "a1", headSha: SHA2, actualFootprint: ["src/api/x.ts"] });
    expect(!isForgeError(again) && again.intent.state).toBe("working");
  });
  it("transitions are conditional and lifecycle-checked", async () => {
    const { db } = sqliteDb();
    const intent = await claimed(db);
    expect(await transitionIntent(db, intent.id, "claimed", "landed")).toBe(false);
    expect(await transitionIntent(db, intent.id, "working", "ready")).toBe(false);
    expect(await transitionIntent(db, intent.id, "claimed", "working", { headSha: SHA })).toBe(true);
    expect(await transitionIntent(db, intent.id, "working", "ready")).toBe(true);
    expect(await transitionIntent(db, intent.id, "ready", "in_train", { trainId: "t1" })).toBe(true);
    expect(await transitionIntent(db, intent.id, "in_train", "landed", { landedSha: SHA2 })).toBe(true);
    const landed = await getIntent(db, intent.id);
    expect(landed?.state).toBe("landed");
    expect(landed?.trainId).toBe("t1");
    expect(landed?.landedSha).toBe(SHA2);
    const kinds = (await listForgeLedger(db, "intent", intent.id)).map((l) => l.kind);
    expect(kinds).toEqual(["declared", "claimed", "working", "ready", "in_train", "landed"]);
  });
  it("lists with filters and heartbeats leases", async () => {
    const { db } = sqliteDb();
    const a = await claimed(db);
    await declared(db, ["b.ts"]);
    expect((await listIntents(db, "demo")).length).toBe(2);
    expect((await listIntents(db, "demo", { state: "claimed" })).map((i) => i.id)).toEqual([a.id]);
    expect((await listIntents(db, "demo", { agent: "a1" })).map((i) => i.id)).toEqual([a.id]);
    expect(await listIntents(db, "nope")).toEqual([]);
    const lease = await heartbeatIntent(db, a.id, "a1", 600);
    expect(lease && lease > (a.leaseExpiresAt ?? "")).toBe(true);
    expect(await heartbeatIntent(db, a.id, "a2")).toBeNull();
    expect(await expireLeases(db)).toEqual([]);
  });
});

describe("mailbox", () => {
  it("delivers each message exactly once, oldest first", async () => {
    const { db } = sqliteDb();
    const { intent } = await declared(db);
    expect(isForgeError(await sendMessage(db, { toIntent: "missing", fromAgent: "a2", body: "hi" }))).toBe(true);
    expect(isForgeError(await sendMessage(db, { toIntent: intent.id, fromAgent: "a2", body: "" }))).toBe(true);
    await sendMessage(db, { toIntent: intent.id, fromAgent: "a2", body: "one" });
    await sendMessage(db, { toIntent: intent.id, fromAgent: "a3", body: "two" });
    const [x, y] = await Promise.all([drainInbox(db, intent.id), drainInbox(db, intent.id)]);
    const all = [...x, ...y].map((m) => m.body).sort();
    expect(all).toEqual(["one", "two"]);
    expect(await drainInbox(db, intent.id)).toEqual([]);
  });
});

describe("conflicts", () => {
  it("claim, resolve and attempt caps", async () => {
    const { db } = sqliteDb();
    const c = await openConflict(db, { repo: "demo", intentA: "i1", intentB: "i2", files: ["src/a.ts"] });
    expect(c.files).toEqual(["src/a.ts"]);
    expect(await claimConflict(db, c.id, "r1", 1)).toBe(true);
    expect(await claimConflict(db, c.id, "r2", 1)).toBe(false);
    expect(await resolveConflict(db, c.id, "r2", SHA)).toBe(false);
    expect(await transitionConflict(db, c.id, "claimed", "open")).toBe(true);
    // Attempts exhausted (max 1): cannot be claimed again.
    expect(await claimConflict(db, c.id, "r2", 1)).toBe(false);
    expect(await claimConflict(db, c.id, "r2", 2)).toBe(true);
    expect(await resolveConflict(db, c.id, "r2", "nope")).toBe(false);
    expect(await resolveConflict(db, c.id, "r2", SHA)).toBe(true);
    const done = await getConflict(db, c.id);
    expect(done?.state).toBe("resolved");
    expect(done?.resolutionSha).toBe(SHA);
    expect(done?.attempts).toBe(2);
    expect((await listConflicts(db, "demo", { state: "resolved" })).length).toBe(1);
    expect(await transitionConflict(db, c.id, "resolved", "open")).toBe(false);
  });
});

describe("trains + ledger", () => {
  it("creates and moves trains conditionally", async () => {
    const { db } = sqliteDb();
    const t = await createTrain(db, { repo: "demo", lane: 1, baseSha: SHA, intentIds: ["i1", "i2"] });
    expect(t.intentIds).toEqual(["i1", "i2"]);
    expect(await transitionTrain(db, t.id, "forming", "landed")).toBe(false);
    expect(await transitionTrain(db, t.id, "forming", "merging")).toBe(true);
    expect(await transitionTrain(db, t.id, "merging", "verifying", { headSha: SHA2, runId: "run-1" })).toBe(true);
    expect((await getTrainByRun(db, "run-1"))?.id).toBe(t.id);
    expect(await transitionTrain(db, t.id, "verifying", "landed")).toBe(true);
    const done = await getTrain(db, t.id);
    expect(done?.state).toBe("landed");
    expect(done?.headSha).toBe(SHA2);
    const child = await createTrain(db, { repo: "demo", lane: 0, baseSha: SHA, intentIds: ["i1"], parentTrainId: t.id });
    expect(child.parentTrainId).toBe(t.id);
    expect((await listTrains(db, "demo", { state: "forming" })).map((x) => x.id)).toEqual([child.id]);
  });
  it("appends generic ledger rows", async () => {
    const { db, raw } = sqliteDb();
    await appendForgeLedger(db, { repo: "demo", subjectKind: "goal", subjectId: "g1", kind: "note", body: "b", actor: "pat" });
    expect((await listForgeLedger(db, "goal", "g1")).map((r) => [r.kind, r.actor])).toEqual([["note", "pat"]]);
    expect(() =>
      raw
        .prepare("INSERT INTO forge_ledger (id, repo, subject_kind, subject_id, kind, created_at) VALUES ('x','r','pr','s','k','t')")
        .run(),
    ).toThrow(/CHECK/);
  });
});
