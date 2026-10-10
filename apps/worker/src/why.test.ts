/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { appendTrailers, serializeWhyNote, type WhyNote } from "./intents-core";
import { appendForgeLedger, createGoal, createTrain, declareIntent, isForgeError, openConflict } from "./intents";
import { WHY_BRANCH, whyBranchPath, WHY_NOTES_REF } from "./provenance";
import { blameLine, diffLineMap, isBlameError, narrateWhy, splitLines, why, type WhyArtifacts } from "./why";
import { type ForkSessionArtifacts, type SessionArtifacts } from "./session";
import { fakeRepo, sha, sqliteDb, type FakeCommitSpec } from "./why-fakes.test-util";

// Compile-time: the real binding satisfies every injected surface.
export function bindingFits(a: Artifacts): [WhyArtifacts, SessionArtifacts, ForkSessionArtifacts] {
  return [a, a, a];
}

function lcsLength(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("diffLineMap", () => {
  it("maps unchanged, inserted and deleted lines", () => {
    const map = diffLineMap(["a", "b", "c", "d"], ["x", "a", "c", "d", "y"]);
    expect(Array.from(map ?? [])).toEqual([-1, 0, 2, 3, -1]);
  });

  it("is an optimal, monotonic alignment (random vs DP LCS)", () => {
    const r = rng(7);
    for (let t = 0; t < 200; t++) {
      const alpha = ["a", "b", "c", "d"];
      const a = Array.from({ length: Math.floor(r() * 14) }, () => alpha[Math.floor(r() * alpha.length)]);
      const b = Array.from({ length: Math.floor(r() * 14) }, () => alpha[Math.floor(r() * alpha.length)]);
      const map = diffLineMap(a, b);
      expect(map).not.toBeNull();
      let last = -1;
      let matches = 0;
      for (let j = 0; j < b.length; j++) {
        const i = map![j];
        if (i < 0) continue;
        expect(a[i]).toBe(b[j]);
        expect(i).toBeGreaterThan(last);
        last = i;
        matches++;
      }
      expect(matches).toBe(lcsLength(a, b));
    }
  });

  it("returns null past the edit budget", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffLineMap(a, b, 10)).toBeNull();
    expect(diffLineMap(a, b, 200)).not.toBeNull();
  });

  it("splitLines drops only the final newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});

function linear(files: Array<Record<string, string>>, messages: string[] = []): FakeCommitSpec[] {
  return files.map((f, i) => ({
    hash: sha(`c${i}`),
    parents: i === 0 ? [] : [sha(`c${i - 1}`)],
    files: f,
    message: messages[i] ?? `c${i}`,
    author: `author${i}`,
  }));
}

describe("blameLine", () => {
  const history = linear([
    { "f.ts": "a\nb\nc\n" },
    { "f.ts": "x\na\nb\nc\n" }, // c1 inserts x at the top
    { "f.ts": "x\nb\nc\n" }, // c2 deletes a
    { "f.ts": "x\nb\nC\n", "other.ts": "1\n" }, // c3 modifies c -> C
    { "f.ts": "x\nb\nC\n", "other.ts": "2\n" }, // c4 leaves f.ts alone
    { "f.ts": "y\nx\nb\nC\nz\n" }, // c5 adds y on top, z at bottom
  ]);
  const repo = fakeRepo(history, { main: sha("c5") });

  it("finds the commit that introduced a line N commits ago, through insertions and deletions", async () => {
    const b = await blameLine(repo, { ref: "main", path: "f.ts", line: 3 });
    expect(isBlameError(b)).toBe(false);
    if (isBlameError(b)) return;
    expect(b.sha).toBe(sha("c0"));
    expect(b.text).toBe("b");
    expect(b.line).toBe(2);
    expect(b.depth).toBe(6);
    expect(b.truncated).toBe(false);
    expect(b.landedVia).toBeNull();
  });

  it("attributes modified, inserted and appended lines to their commit", async () => {
    const at = async (line: number) => {
      const r = await blameLine(repo, { ref: "main", path: "f.ts", line });
      return isBlameError(r) ? r.error : r.sha;
    };
    expect(await at(1)).toBe(sha("c5"));
    expect(await at(2)).toBe(sha("c1"));
    expect(await at(4)).toBe(sha("c3"));
    expect(await at(5)).toBe(sha("c5"));
  });

  it("tracks duplicated lines by position", async () => {
    const h = linear([{ "d.txt": "}\n}\n" }, { "d.txt": "{\n}\n}\n" }, { "d.txt": "{\n}\nnew\n}\n" }]);
    const r = fakeRepo(h, { main: sha("c2") });
    const last = await blameLine(r, { ref: "main", path: "d.txt", line: 4 });
    expect(!isBlameError(last) && last.sha).toBe(sha("c0"));
    const added = await blameLine(r, { ref: "main", path: "d.txt", line: 3 });
    expect(!isBlameError(added) && added.sha).toBe(sha("c2"));
  });

  it("is bounded: stops after maxCommits and flags truncation", async () => {
    const files: Array<Record<string, string>> = [];
    let text = "root\n";
    for (let i = 0; i < 60; i++) {
      files.push({ "f.txt": text });
      text = `l${i}\n${text}`;
    }
    const r = fakeRepo(linear(files), { main: sha("c59") });
    const out = await blameLine(r, { ref: "main", path: "f.txt", line: 59 });
    expect(isBlameError(out)).toBe(false);
    if (isBlameError(out)) return;
    expect(out.truncated).toBe(true);
    expect(out.depth).toBe(50);
    expect(out.sha).toBe(sha("c10"));
    expect(r.calls.readFile).toBeLessThanOrEqual(51);
  });

  it("dives into a merged side branch and reports the trunk merge", async () => {
    const msg = appendTrailers("feat: limiter", { intent: "int-1", agent: "claude-2" });
    const specs: FakeCommitSpec[] = [
      { hash: sha("m0"), parents: [], files: { "a.ts": "one\ntwo\n" } },
      { hash: sha("s1"), parents: [sha("m0")], files: { "a.ts": "one\nlimit()\ntwo\n" }, message: msg, author: "claude-2" },
      { hash: sha("m1"), parents: [sha("m0")], files: { "a.ts": "one\ntwo\n", "b.ts": "b\n" } },
      { hash: sha("M"), parents: [sha("m1"), sha("s1")], files: { "a.ts": "one\nlimit()\ntwo\n", "b.ts": "b\n" }, message: "train t1" },
    ];
    const r = fakeRepo(specs, { main: sha("M") });
    const out = await blameLine(r, { ref: "main", path: "a.ts", line: 2 });
    expect(isBlameError(out)).toBe(false);
    if (isBlameError(out)) return;
    expect(out.sha).toBe(sha("s1"));
    expect(out.landedVia).toBe(sha("M"));
    expect(out.author.name).toBe("claude-2");
  });

  it("reports structured errors", async () => {
    const big = "x".repeat(300 * 1024);
    const r = fakeRepo(linear([{ "f.txt": "a\n", "bin": "a\0b", "big.txt": big }]), { main: sha("c0") });
    const err = async (input: { ref?: string; path: string; line: number }) => {
      const out = await blameLine(r, { ref: input.ref ?? "main", path: input.path, line: input.line });
      return isBlameError(out) ? out.error : "ok";
    };
    expect(await err({ path: "f.txt", line: 1 })).toBe("ok");
    expect(await err({ path: "f.txt", line: 2 })).toBe("line-out-of-range");
    expect(await err({ path: "f.txt", line: 0 })).toBe("invalid-input");
    expect(await err({ path: "nope", line: 1 })).toBe("path-not-found");
    expect(await err({ path: "bin", line: 1 })).toBe("binary");
    expect(await err({ path: "big.txt", line: 1 })).toBe("too-large");
    expect(await err({ ref: "gone", path: "f.txt", line: 1 })).toBe("ref-not-found");
  });
});

// ---------------------------------------------------------------------------
// Chain assembly
// ---------------------------------------------------------------------------

function note(over: Partial<WhyNote>): WhyNote {
  return {
    v: 1,
    goal: null,
    intent: { id: "x", title: "t", reasoning: "r", accept: "a" },
    agent: "claude-1",
    session_repo: "",
    alternatives_rejected: [],
    evidence: { run_id: "", sha: "", status: "" },
    conflict_decisions: [],
    review: { decision: "auto", by: "policy", policy: "risk 12 <= 30" },
    train_id: "",
    ...over,
  };
}

function artifactsOf(repo: ReturnType<typeof fakeRepo>): WhyArtifacts {
  return { get: async () => repo };
}

async function seedForge() {
  const { db, raw } = sqliteDb();
  const goal = await createGoal(db, { repo: "demo", text: "Stop credential stuffing on /login", createdBy: "pat" });
  if (isForgeError(goal)) throw new Error(goal.message);
  const declared = await declareIntent(db, {
    repo: "demo",
    goalId: goal.id,
    agent: "claude-2",
    title: "Rate-limit login",
    reasoning: "token bucket per IP keeps p99 flat",
    accept: "npm test",
    footprint: ["src/login.ts"],
  });
  if (isForgeError(declared)) throw new Error(declared.message);
  const intent = declared.intent;
  const other = await declareIntent(db, { repo: "demo", title: "Session TTL", footprint: ["src/login.ts"] });
  if (isForgeError(other)) throw new Error(other.message);
  const train = await createTrain(db, { repo: "demo", lane: 0, baseSha: sha("m0"), intentIds: [intent.id] });
  const runId = "run-0001-aaaa";
  raw.prepare(
    "INSERT INTO runs (id, repo, sha, event, branch, status, created_at, updated_at) VALUES (?, 'demo', ?, 'forge', 'train/1', 'success', 'now', 'now')",
  ).run(runId, sha("M"));
  raw.prepare("UPDATE trains SET run_id = ?, state = 'landed' WHERE id = ?").run(runId, train.id);
  raw.prepare("UPDATE intents SET state = 'landed', train_id = ?, fork_repo = ?, risk = 12 WHERE id = ?").run(
    train.id,
    "i-forkrepo",
    intent.id,
  );
  await appendForgeLedger(db, { repo: "demo", subjectKind: "intent", subjectId: intent.id, kind: "decision", body: "token bucket over sliding window", actor: "claude-2" });
  await appendForgeLedger(db, { repo: "demo", subjectKind: "intent", subjectId: intent.id, kind: "alternative.rejected", body: "nginx limit_req (not in repo)", actor: "claude-2" });
  const conflict = await openConflict(db, { repo: "demo", intentA: intent.id, intentB: other.intent.id, files: ["src/login.ts"] });
  const tid = "11111111-2222-3333-4444-555555555555";
  raw.prepare("INSERT INTO tournaments (id, intent, source_repo, state, created_at, updated_at) VALUES (?, 'resolve', 'demo', 'decided', 'now', 'now')").run(tid);
  raw.prepare("INSERT INTO attempts (id, tournament_id, agent, fork_repo, state, run_id, verdict_rank, created_at, updated_at) VALUES ('a1', ?, 'claude-2', 'f1', 'terminal', 'r1', 1, 'now', 'now')").run(tid);
  raw.prepare("INSERT INTO attempts (id, tournament_id, agent, fork_repo, state, run_id, verdict_rank, created_at, updated_at) VALUES ('a2', ?, 'gpt-x', 'f2', 'terminal', 'r2', 2, 'now', 'now')").run(tid);
  raw.prepare("INSERT INTO verdicts (tournament_id, ranking, rationale, model, created_at) VALUES (?, '[]', 'kept both TTL and limiter', 'm', 'now')").run(tid);
  await appendForgeLedger(db, { repo: "demo", subjectKind: "conflict", subjectId: conflict.id, kind: "tournament", body: `race ${tid}` });
  return { db, raw, goal, intent, other, train, runId, conflict };
}

describe("why chain", () => {
  it("assembles the full chain (trailers + note on the branch fallback)", async () => {
    const s = await seedForge();
    const msg = appendTrailers("feat: limit login", { goal: s.goal.id, intent: s.intent.id, agent: "claude-2", session: "i-forkrepo" });
    const repo = fakeRepo(
      [
        { hash: sha("m0"), parents: [], files: { "src/login.ts": "export function login() {}\n" } },
        { hash: sha("s1"), parents: [sha("m0")], files: { "src/login.ts": "limit();\nexport function login() {}\n" }, message: msg, author: "claude-2" },
      ],
      { main: sha("s1") },
    );
    repo.extraFiles.set(
      WHY_BRANCH,
      new Map([
        [
          whyBranchPath(sha("s1")),
          serializeWhyNote(
            note({
              intent: { id: s.intent.id, title: s.intent.title, reasoning: s.intent.reasoning, accept: "npm test" },
              agent: "claude-2",
              session_repo: "i-forkrepo",
              alternatives_rejected: ["global middleware (too broad)"],
              evidence: { run_id: s.runId, sha: sha("M"), status: "success" },
              conflict_decisions: [{ conflict_id: s.conflict.id, with_intent: s.other.intent.id, decision: "kept both: TTL wraps the limiter" }],
              train_id: s.train.id,
            }),
          ),
        ],
      ]),
    );
    const chain = await why({ db: s.db, artifacts: artifactsOf(repo) }, { repo: "demo", path: "src/login.ts", line: 1 });
    expect(chain.error).toBeNull();
    expect(chain.origin).toBe("forge");
    expect(chain.commit?.sha).toBe(sha("s1"));
    expect(chain.noteSource).toBe("branch");
    expect(chain.goal?.text).toContain("credential stuffing");
    expect(chain.intent).toMatchObject({ id: s.intent.id, state: "landed", risk: 12, forkRepo: "i-forkrepo" });
    expect(chain.decisions.map((d) => d.body)).toContain("token bucket over sliding window");
    expect(chain.alternatives.map((a) => a.source).sort()).toEqual(["ledger", "note", "tournament"]);
    expect(chain.alternatives.find((a) => a.source === "tournament")).toMatchObject({ agent: "gpt-x", runId: "r2" });
    expect(chain.conflicts).toHaveLength(1);
    expect(chain.conflicts[0]).toMatchObject({ withIntent: s.other.intent.id, decision: "kept both: TTL wraps the limiter" });
    expect(chain.evidence).toEqual({ runId: s.runId, sha: sha("M"), status: "success", source: "note" });
    expect(chain.train).toMatchObject({ id: s.train.id, state: "landed", runId: s.runId });
    expect(chain.review).toMatchObject({ decision: "auto", source: "note" });
    expect(chain.session).toEqual({ repo: "i-forkrepo", branch: "flare/session" });
    expect(chain.narrative).toContain('This line exists because of the goal "Stop credential stuffing on /login"');
    expect(chain.narrative).toContain("claude-2 took intent");
    expect(chain.narrative).toContain("Rejected:");
    expect(chain.narrative).toContain("Resolved a conflict");
    expect(chain.narrative).toContain("Verified by run run-0001 (success)");
    expect(chain.narrative).toMatch(/Landed by train \S+ under policy auto/);
    expect(chain.warnings).toEqual([]);
  });

  it("reads the note from refs/notes/why on the trunk merge when the side commit has none", async () => {
    const s = await seedForge();
    const msg = appendTrailers("feat", { intent: s.intent.id });
    const repo = fakeRepo(
      [
        { hash: sha("m0"), parents: [], files: { "a.ts": "a\n" } },
        { hash: sha("s1"), parents: [sha("m0")], files: { "a.ts": "a\nb\n" }, message: msg },
        { hash: sha("m1"), parents: [sha("m0")], files: { "a.ts": "a\n", "z": "z\n" } },
        { hash: sha("M"), parents: [sha("m1"), sha("s1")], files: { "a.ts": "a\nb\n", "z": "z\n" } },
      ],
      { main: sha("M"), [WHY_NOTES_REF]: sha("M") },
    );
    // Notes commit "nt" with the note under the merge sha (flat path).
    repo.refs.set(WHY_NOTES_REF, "nt");
    repo.extraFiles.set("nt", new Map([[sha("M"), serializeWhyNote(note({ intent: { id: s.intent.id, title: "t", reasoning: "r", accept: "a" }, train_id: s.train.id }))]]));
    const origLog = repo.log.bind(repo);
    repo.log = async (opts = {}) => (opts.ref === WHY_NOTES_REF ? [{ ...(await origLog({ ref: "main", limit: 1 }))[0], hash: "nt" }] : origLog(opts));
    const chain = await why({ db: s.db, artifacts: artifactsOf(repo) }, { repo: "demo", path: "a.ts", line: 2 });
    expect(chain.commit?.sha).toBe(sha("s1"));
    expect(chain.commit?.landedVia).toBe(sha("M"));
    expect(chain.noteSha).toBe(sha("M"));
    expect(chain.noteSource).toBe("notes");
    expect(chain.review?.decision).toBe("auto");
  });

  it("degrades: no trailers and no note = human or pre-forge", async () => {
    const { db } = sqliteDb();
    const repo = fakeRepo(linear([{ "r.md": "hello\n" }], ["docs: readme"]), { main: sha("c0") });
    const chain = await why({ db, artifacts: artifactsOf(repo) }, { repo: "demo", path: "r.md", line: 1 });
    expect(chain.origin).toBe("human");
    expect(chain.intent).toBeNull();
    expect(chain.narrative).toContain("human or pre-forge commit");
    expect(chain.narrative).toContain("author0");
  });

  it("degrades: trailers but intent unknown and no note -> warning, still forge", async () => {
    const { db } = sqliteDb();
    const repo = fakeRepo(linear([{ "r.md": "hello\n" }], [appendTrailers("x", { intent: "ghost", agent: "bot" })]), { main: sha("c0") });
    const chain = await why({ db, artifacts: artifactsOf(repo) }, { repo: "demo", path: "r.md", line: 1 });
    expect(chain.origin).toBe("forge");
    expect(chain.intent).toBeNull();
    expect(chain.warnings.join(" ")).toContain("ghost");
    expect(chain.narrative).toContain("bot took intent");
  });

  it("degrades: note-only chain when D1 rows are gone (or D1 throws)", async () => {
    const throwingDb = {
      prepare() {
        throw new Error("D1 down");
      },
    } as unknown as Parameters<typeof why>[0]["db"];
    const repo = fakeRepo(linear([{ "r.md": "hello\n" }]), { main: sha("c0") });
    repo.extraFiles.set(
      WHY_BRANCH,
      new Map([[whyBranchPath(sha("c0")), serializeWhyNote(note({ goal: { id: "g", text: "ship it" }, intent: { id: "i9", title: "Ship", reasoning: "because", accept: "" }, evidence: { run_id: "r9", sha: sha("c0"), status: "success" }, train_id: "t9" }))]]),
    );
    const chain = await why({ db: throwingDb, artifacts: artifactsOf(repo) }, { repo: "demo", path: "r.md", line: 1 });
    expect(chain.error).toBeNull();
    expect(chain.intent?.id).toBe("i9");
    expect(chain.goal?.text).toBe("ship it");
    expect(chain.evidence).toMatchObject({ runId: "r9", status: "success", source: "note" });
    expect(chain.warnings.length).toBeGreaterThan(0);
    expect(chain.narrative).toContain('goal "ship it"');
  });

  it("returns a structured error for bad input, missing files and a broken binding", async () => {
    const { db } = sqliteDb();
    const repo = fakeRepo(linear([{ "r.md": "hello\n" }]), { main: sha("c0") });
    const bad = await why({ db, artifacts: artifactsOf(repo) }, { repo: "demo", path: "../x", line: 1 });
    expect(bad.error?.code).toBe("invalid-input");
    const missing = await why({ db, artifacts: artifactsOf(repo) }, { repo: "demo", path: "nope.md", line: 1 });
    expect(missing.error?.code).toBe("path-not-found");
    expect(missing.narrative).toContain("Could not trace");
    const broken = await why({ db, artifacts: { get: async () => { throw new Error("NOT_FOUND"); } } }, { repo: "x", path: "a", line: 1 });
    expect(broken.error?.code).toBe("artifacts-unavailable");
    expect(narrateWhy(broken)).toContain("Could not trace");
  });
});
