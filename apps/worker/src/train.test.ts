/// <reference types="node" />
// End-to-end train tests: real bare git repos served over an in-process
// `git http-backend` HTTP fake, isomorphic-git + MemoryFS doing the
// merges and pushes exactly as in the Worker, node:sqlite for D1, and a
// fake CI that judges each dispatched SHA by its tree.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { Db } from "./db";
import { appendForgeLedger, declareIntent, getConflict, getIntent, listConflicts, listForgeLedger } from "./intents";
import { intentForkName, parseTrailers } from "./intents-core";
import { MemoryFS } from "./memory-fs";
import {
  activeTrains,
  advanceRepo,
  approveLanding,
  buildTrains,
  checkTrains,
  claimConflictFor,
  createWhyNotesWriter,
  cutTrain,
  enqueueReady,
  getTrainDetail,
  resolveConflictFor,
  revokeLandedTokens,
  routeLine,
  writeNotes,
  type BuildResult,
  type TrainDeps,
  type TrainDispatchInput,
  type TrainGit,
} from "./train";
import { DEFAULT_POLICY } from "./intents-core";
import { laneRefPool } from "./train-core";
import { gitFixture, sqliteDb, type GitFixture } from "./testing/forge-fixture";

const REPO = "trunk";
const PIPELINE = "jobs:\n  test:\n    steps:\n      - run: npm test\n";

function lines(tag: string, n = 12): string {
  return Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join("\n") + "\n";
}

function withLine(text: string, line: number, value: string): string {
  const parts = text.split("\n");
  parts[line - 1] = value;
  return parts.join("\n");
}

interface Harness {
  fx: GitFixture;
  db: Db;
  deps: TrainDeps;
  dispatched: TrainDispatchInput[];
  mainPushes: string[];
  runs: Map<string, { sha: string; status: string }>;
  completeCi: () => void;
  ready: (input: { title: string; paths: string[]; files: Record<string, string | null>; agent?: string }) => Promise<string>;
  conflictsSeen: string[];
  agentTokens: string[];
  policyText: { value: string | null };
}

let h: Harness;
let tick = 0;

async function harness(): Promise<Harness> {
  const fx = gitFixture();
  const db = sqliteDb();
  const seed: Record<string, string> = { "flare.yml": PIPELINE, "docs/readme.md": "readme\n" };
  for (const f of ["a", "b", "c", "d", "e"]) seed[`src/${f}.ts`] = lines(f);
  const main = fx.createRepo(REPO, seed);
  // Lane refs exist up front (spike S5: never create refs from the Worker).
  for (const ref of laneRefPool()) fx.sh(["--git-dir", `${fx.root}/${REPO}.git`, "update-ref", ref, main]);

  const runs = new Map<string, { sha: string; status: string }>();
  const dispatched: TrainDispatchInput[] = [];
  const mainPushes: string[] = [];
  const conflictsSeen: string[] = [];
  const agentTokens: string[] = [];
  const policyText = { value: null as string | null };

  // Wrap push: assert invariant 2 at the moment main moves.
  const wrapped: TrainGit = {
    ...git,
    push: async (args) => {
      if (args.remoteRef === "refs/heads/main" && args.url?.includes(`/${REPO}.git`)) {
        const sha = await git.resolveRef({ fs: args.fs, gitdir: args.gitdir, ref: args.ref ?? "HEAD" });
        const green = [...runs.values()].some((r) => r.sha === sha && r.status === "success");
        if (!green) throw new Error(`INVARIANT 2 VIOLATED: main push of ${sha} without a green run on that exact sha`);
        expect(args.force ?? false).toBe(false);
        mainPushes.push(sha);
      }
      return git.push(args);
    },
  };

  const deps: TrainDeps = {
    db,
    artifacts: fx.artifacts,
    namespace: "ns",
    remoteFor: fx.remoteFor,
    git: wrapped,
    http: fx.http,
    fs: () => new MemoryFS(),
    dispatch: async (input) => {
      const runId = `run-${runs.size + 1}`;
      runs.set(runId, { sha: input.sha, status: "queued" });
      dispatched.push(input);
      return { runId };
    },
    runStatus: async (id) => runs.get(id) ?? null,
    loadPolicyText: async () => policyText.value,
    onConflict: async (c) => {
      conflictsSeen.push(c.id);
    },
  };

  // CI: red iff any source file at that exact SHA contains "BUG".
  const completeCi = (): void => {
    for (const run of runs.values()) {
      if (run.status !== "queued") continue;
      const bad = ["a", "b", "c", "d", "e"].some((f) => (fx.show(REPO, run.sha, `src/${f}.ts`) ?? "").includes("BUG"));
      run.status = bad ? "failure" : "success";
    }
  };

  const ready: Harness["ready"] = async ({ title, paths, files, agent = "agent-1" }) => {
    const d = await declareIntent(db, { repo: REPO, title: title.length < 3 ? `${title} change` : title, reasoning: `because ${title}`, footprint: paths, agent });
    if ("error" in d) throw new Error(d.message);
    const id = d.intent.id;
    const fork = intentForkName(id);
    fx.fork(REPO, fork);
    const base = fx.head(REPO) ?? "";
    const head = fx.commit(fork, files, `wip: ${title}`);
    // The agent's own fork token (minted at claim in prod).
    const tok = await (await fx.artifacts.get(fork)).createToken("write", 3600);
    agentTokens.push(typeof tok === "string" ? tok : tok.plaintext);
    tick += 1;
    await db
      .prepare(
        "UPDATE intents SET state = 'ready', agent = ?, fork_repo = ?, head_sha = ?, base_sha = ?, actual_footprint_json = ?, updated_at = ? WHERE id = ?",
      )
      .bind(agent, fork, head, base, JSON.stringify({ paths: Object.keys(files).sort() }), `2026-10-10T00:00:${String(tick).padStart(2, "0")}.000Z`, id)
      .run();
    return id;
  };

  return { fx, db, deps, dispatched, mainPushes, runs, completeCi, ready, conflictsSeen, agentTokens, policyText };
}

// Drive the repo until nothing is active and nothing ready moves.
async function settle(maxSteps = 40): Promise<number> {
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    await advanceRepo(h.deps, REPO);
    h.completeCi();
    const active = await activeTrains(h.db, REPO);
    const ready = await h.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE repo = ? AND state = 'ready'").bind(REPO).first<{ n: number }>();
    if (!active.length && !(ready?.n ?? 0)) break;
  }
  return steps;
}

async function allRows(db: Db): Promise<string> {
  const tables = ["intents", "trains", "conflicts", "forge_ledger", "intent_messages", "webhook_deliveries"];
  let dump = "";
  for (const t of tables) {
    const res = await db.prepare(`SELECT * FROM ${t}`).bind().all<Record<string, unknown>>();
    dump += JSON.stringify(res.results);
  }
  return dump;
}

beforeEach(async () => {
  h = await harness();
});

afterEach(() => {
  h.fx.cleanup();
});

describe("trains: merger end-to-end (isomorphic-git + MemoryFS + git http-backend)", { timeout: 60_000 }, () => {
  it("lands 3 disjoint intents with one push to main, one squashed commit each", async () => {
    const ids = [
      await h.ready({ title: "Tune a", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 2, "a TUNED") } }),
      await h.ready({ title: "Tune b", paths: ["src/b.ts"], files: { "src/b.ts": withLine(lines("b"), 5, "b TUNED") }, agent: "agent-2" }),
      await h.ready({ title: "Add doc", paths: ["docs/**"], files: { "docs/guide.md": "guide\n" }, agent: "agent-3" }),
    ];
    const base = h.fx.head(REPO);
    const cut = await cutTrain(h.deps, REPO);
    expect(cut.status).toBe("cut");
    if (cut.status !== "cut") return;
    expect(cut.lanes).toEqual([[ids[0]], [ids[1]], [ids[2]]]);

    const t0 = Date.now();
    const built = (await buildTrains(h.deps, REPO)) as Extract<BuildResult, { status: "built" }>;
    const buildMs = Date.now() - t0;
    if (built.status !== "built") console.log("BUILD", JSON.stringify(built));
    expect(built.status).toBe("built");
    expect(built.lanes.map((l) => l.merged.length)).toEqual([1, 1, 1]);
    console.log(`[measure] 3-lane build (fetch+3 merges+3 lane pushes): ${buildMs} ms; per-lane merge ms: ${built.lanes.map((l) => l.mergeMs).join(", ")}`);
    // Lanes stack: each lane head is a child of the previous lane head.
    const heads = built.lanes.map((l) => l.head ?? "");
    expect(h.fx.log(REPO, heads[2]).slice(0, 4)).toEqual([heads[2], heads[1], heads[0], base]);
    for (let i = 0; i < 3; i++) expect(h.fx.head(REPO, `forge/lane-${i}`)).toBe(heads[i]);
    // CI dispatched on each exact lane SHA, Artifacts event, train agent.
    expect(h.dispatched.map((d) => d.sha)).toEqual(heads);
    expect(h.dispatched.every((d) => d.event === "artifacts" && d.agent === "forge-train" && d.repo === `ns/${REPO}`)).toBe(true);
    expect(h.fx.head(REPO)).toBe(base); // main untouched while verifying

    expect((await checkTrains(h.deps, REPO)).status).toBe("waiting");
    h.completeCi();
    const decided = await checkTrains(h.deps, REPO);
    expect(decided).toMatchObject({ status: "decided", landed: ids, failed: [], requeued: [] });
    expect(h.mainPushes).toEqual([heads[2]]);
    expect(h.fx.head(REPO)).toBe(heads[2]);
    expect(h.fx.show(REPO, "main", "src/a.ts")).toContain("a TUNED");
    expect(h.fx.show(REPO, "main", "src/b.ts")).toContain("b TUNED");
    expect(h.fx.show(REPO, "main", "docs/guide.md")).toBe("guide\n");

    const msgs = h.fx.messages(REPO).slice(0, 3).reverse();
    for (let i = 0; i < 3; i++) {
      const intent = await getIntent(h.db, ids[i]);
      expect(intent?.state).toBe("landed");
      expect(intent?.landedSha).toBe(heads[i]);
      expect(parseTrailers(msgs[i])).toMatchObject({ intent: ids[i], agent: intent?.agent, session: intent?.forkRepo });
      expect(msgs[i].startsWith(intent?.title ?? "?")).toBe(true);
      const routed = (await listForgeLedger(h.db, "intent", ids[i])).find((r) => r.kind === "routed");
      expect(routed?.body).toMatch(/^risk \d+ <= 30 → (auto|audit) \(run run-\d/);
    }

    // Why notes on every landed commit; the tip is recorded on the train.
    const notes = createWhyNotesWriter({ git, http: h.fx.http, fs: () => new MemoryFS(), remoteFor: h.fx.remoteFor, artifacts: h.fx.artifacts });
    const wrote = await writeNotes({ ...h.deps, notes }, REPO);
    expect(wrote.written).toBe(3);
    for (let i = 0; i < 3; i++) {
      const raw = h.fx.sh(["--git-dir", `${h.fx.root}/${REPO}.git`, "notes", "--ref=why", "show", heads[i]]);
      expect(JSON.parse(raw)).toMatchObject({ v: 1, intent: { id: ids[i] }, evidence: { status: "success" } });
    }
    expect(h.fx.sh(["--git-dir", `${h.fx.root}/${REPO}.git`, "rev-parse", "refs/notes/why"])).toBe(wrote.head);
    const tip = await h.db.prepare("SELECT body FROM forge_ledger WHERE kind = 'notes.tip'").bind().first<{ body: string }>();
    expect(tip?.body).toBe(wrote.head);
    expect((await writeNotes({ ...h.deps, notes }, REPO)).written).toBe(0); // idempotent

    // Invariant 1: fork tokens revoked on land; trunk tokens never persisted.
    const revoked = await revokeLandedTokens(h.deps, REPO);
    expect(revoked.revoked).toBeGreaterThanOrEqual(3);
    for (const tok of h.fx.tokens.filter((t) => t.repo !== REPO)) expect(tok.revoked).toBe(true);
    const dump = await allRows(h.db);
    expect(dump).not.toContain("art_v2_");
    expect(JSON.stringify([cut, built, decided])).not.toContain("art_v2_");
  });

  it("textual conflict: the first intent lands, the second opens a Conflict and leaves the train", async () => {
    const x = await h.ready({ title: "X edits a3", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 3, "a3 by X") } });
    const y = await h.ready({ title: "Y edits a3", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 3, "a3 by Y") }, agent: "agent-y" });
    const cut = await cutTrain(h.deps, REPO);
    expect(cut).toMatchObject({ status: "cut", lanes: [[x, y]] });
    const built = (await buildTrains(h.deps, REPO)) as Extract<BuildResult, { status: "built" }>;
    console.log(`[measure] conflict lane build: merge ms ${built.lanes[0].mergeMs}`);
    expect(built.lanes[0].merged).toEqual([x]);
    expect(built.lanes[0].conflicts.length).toBe(1);
    const conflict = await getConflict(h.db, built.lanes[0].conflicts[0]);
    expect(conflict).toMatchObject({ intentA: y, intentB: x, files: ["src/a.ts"], state: "open" });
    expect(h.conflictsSeen).toEqual([conflict?.id]);
    expect((await getIntent(h.db, y))?.state).toBe("conflicted");
    h.completeCi();
    expect(await checkTrains(h.deps, REPO)).toMatchObject({ status: "decided", landed: [x] });
    expect(h.fx.show(REPO, "main", "src/a.ts")).toContain("a3 by X");

    // Replay by the owner on a fresh fork of the new trunk; it lands only
    // through a train (invariant 4).
    const claimed = await claimConflictFor(h.deps, conflict?.id ?? "", "agent-y");
    expect("error" in claimed).toBe(false);
    expect((await getIntent(h.db, y))?.state).toBe("replaying");
    h.fx.fork(REPO, "y-replay");
    const replay = h.fx.commit("y-replay", { "src/a.ts": withLine(lines("a"), 3, "a3 by X and Y") }, "replay Y");
    const mainBefore = h.fx.head(REPO);
    const resolved = await resolveConflictFor(h.deps, conflict?.id ?? "", "agent-y", replay, { forkRepo: "y-replay" });
    expect("error" in resolved).toBe(false);
    expect(h.fx.head(REPO)).toBe(mainBefore); // resolve never touches main
    const after = await getIntent(h.db, y);
    expect(after).toMatchObject({ forkRepo: "y-replay", headSha: replay, baseSha: mainBefore });
    await settle();
    const landed = await getIntent(h.db, y);
    expect(landed?.state).toBe("landed");
    expect(landed?.trainId).toBeTruthy();
    expect(h.fx.show(REPO, "main", "src/a.ts")).toContain("a3 by X and Y");
    expect((await listForgeLedger(h.db, "intent", y)).some((r) => r.kind === "decision")).toBe(true);
    expect((await getConflict(h.db, conflict?.id ?? ""))?.state).toBe("resolved");
  });

  it("semantic red: bisect isolates the culprit in <= log2(n) rounds; the rest land; main never red", async () => {
    const ids: string[] = [];
    for (const f of ["a", "b", "c", "d"]) {
      const content = f === "c" ? withLine(lines(f), 4, "c BUG") : withLine(lines(f), 4, `${f} ok`);
      ids.push(await h.ready({ title: `Touch ${f}`, paths: ["src/**"], files: { [`src/${f}.ts`]: content } }));
    }
    const cut = await cutTrain(h.deps, REPO);
    expect(cut).toMatchObject({ status: "cut", lanes: [ids] });
    const root = cut.status === "cut" ? cut.trainIds[0] : "";
    await settle();
    expect((await getIntent(h.db, ids[2]))?.state).toBe("failed");
    const culprit = (await listForgeLedger(h.db, "intent", ids[2])).find((r) => r.kind === "culprit");
    expect(culprit?.body).toMatch(/^run run-\d+ red on [0-9a-f]{12}/);
    for (const id of [ids[0], ids[1], ids[3]]) expect((await getIntent(h.db, id))?.state).toBe("landed");
    expect(h.fx.show(REPO, "main", "src/c.ts")).not.toContain("BUG");
    // Every SHA main ever pointed at was CI-green on that exact SHA.
    for (const sha of h.mainPushes) expect([...h.runs.values()].some((r) => r.sha === sha && r.status === "success")).toBe(true);
    // Bisect tree: root -> [left, right]; right -> [c, d]: 2 rounds = log2(4).
    const detail = await getTrainDetail(h.deps, root);
    expect(detail?.train.state).toBe("bisected");
    expect(detail?.children.length).toBe(2);
    const depth = (n: { children: Array<{ children: unknown[] }> }): number => 1 + Math.max(0, ...n.children.map((c) => depth(c as typeof n)));
    expect(depth(detail ?? { children: [] }) - 1).toBeLessThanOrEqual(2);
    expect(detail?.run?.status).toBe("failure");
    expect(detail?.intents.map((i) => i.id)).toEqual(ids);
  });

  it("red lane in a stack: the green prefix lands, the red lane bisects, lanes behind are requeued", async () => {
    const a = await h.ready({ title: "lane a", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 1, "a ok") } });
    const b = await h.ready({ title: "lane b", paths: ["src/b.ts"], files: { "src/b.ts": withLine(lines("b"), 1, "b BUG") } });
    const c = await h.ready({ title: "lane c", paths: ["src/c.ts"], files: { "src/c.ts": withLine(lines("c"), 1, "c ok") } });
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    h.completeCi();
    expect(await checkTrains(h.deps, REPO)).toMatchObject({ status: "decided", landed: [a], failed: [b], requeued: [c] });
    expect((await getIntent(h.db, c))?.state).toBe("ready");
    await settle();
    expect((await getIntent(h.db, c))?.state).toBe("landed");
    expect(h.fx.show(REPO, "main", "src/b.ts")).not.toContain("BUG");
  });

  it("main moved under a green train: no push, rebuild on the new main, then land", async () => {
    const a = await h.ready({ title: "a", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 6, "a6") } });
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    const moved = h.fx.commit(REPO, { "docs/readme.md": "moved by someone else\n" }, "external");
    h.completeCi();
    const res = await checkTrains(h.deps, REPO);
    expect(res).toMatchObject({ status: "rebuild", requeued: [a] });
    expect(h.mainPushes).toEqual([]);
    expect(h.fx.head(REPO)).toBe(moved);
    expect((await getIntent(h.db, a))?.state).toBe("ready");
    await settle();
    expect((await getIntent(h.db, a))?.state).toBe("landed");
    expect(h.fx.log(REPO)).toContain(moved);
    expect(h.fx.show(REPO, "main", "docs/readme.md")).toBe("moved by someone else\n");
    expect(h.fx.show(REPO, "main", "src/a.ts")).toContain("a6");
  });

  it("human-routed intents are held out of trains until a landing approval", async () => {
    h.policyText.value = "auto_land_max_risk: 0\n";
    const a = await h.ready({ title: "risky", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 2, "risky") } });
    const q = await enqueueReady(h.deps, a);
    expect(q).toMatchObject({ route: "human", held: true, cut: null });
    expect(await cutTrain(h.deps, REPO)).toEqual({ status: "idle" });
    expect(await approveLanding(h.deps, a, "alice")).toBe(true);
    const q2 = await enqueueReady(h.deps, a);
    expect(q2).toMatchObject({ route: "human", held: false, cut: { status: "cut" } });
    await settle();
    expect((await getIntent(h.db, a))?.state).toBe("landed");
    const routed = (await listForgeLedger(h.db, "intent", a)).find((r) => r.kind === "routed");
    expect(routed?.body).toMatch(/^risk \d+ > 0 → approved/);
  });

  it("landing gate is enforced before main moves: an intent that became human-routed does not land (review #11)", async () => {
    const a = await h.ready({ title: "a", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 2, "a2") } });
    const b = await h.ready({ title: "b", paths: ["src/b.ts"], files: { "src/b.ts": withLine(lines("b"), 2, "b2") } });
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    h.completeCi();
    // policy tightened while CI ran: every change now needs a human
    h.policyText.value = "auto_land_max_risk: 0\n";
    expect(await checkTrains(h.deps, REPO)).toMatchObject({ status: "decided", landed: [], requeued: [a, b] });
    expect(h.mainPushes).toEqual([]);
    expect((await getIntent(h.db, a))?.state).toBe("ready");
    expect(await cutTrain(h.deps, REPO)).toEqual({ status: "idle" }); // held until approved
    expect(await approveLanding(h.deps, a, "alice")).toBe(true);
    await settle();
    expect((await getIntent(h.db, a))?.state).toBe("landed");
    expect((await getIntent(h.db, b))?.state).toBe("ready");
  });

  it("two executors deciding the same red lane bisect it once (review #13)", async () => {
    const ids: string[] = [];
    for (const f of ["a", "b", "c", "d"]) ids.push(await h.ready({ title: `t${f}`, paths: ["src/**"], files: { [`src/${f}.ts`]: withLine(lines(f), 4, f === "b" ? "b BUG" : `${f} ok`) } }));
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    h.completeCi();
    await Promise.all([checkTrains(h.deps, REPO), checkTrains(h.deps, REPO)]);
    const kids = await h.db.prepare("SELECT COUNT(*) AS n FROM trains WHERE parent_train_id IS NOT NULL").bind().first<{ n: number }>();
    expect(kids?.n).toBe(2);
    await settle();
    expect((await getIntent(h.db, ids[1]))?.state).toBe("failed");
    for (const id of [ids[0], ids[2], ids[3]]) expect((await getIntent(h.db, id))?.state).toBe("landed");
  });

  it("long ledgers: approvals and train commits past the 200 oldest rows still count (review #12)", async () => {
    h.policyText.value = "auto_land_max_risk: 0\n";
    const a = await h.ready({ title: "risky", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 2, "risky") } });
    for (let i = 0; i < 230; i++) await appendForgeLedger(h.db, { repo: REPO, subjectKind: "intent", subjectId: a, kind: "noise", body: `n${i}`, actor: "t" });
    expect(await approveLanding(h.deps, a, "alice")).toBe(true);
    expect(await enqueueReady(h.deps, a, { cut: false })).toMatchObject({ route: "human", held: false });
    const cut = await cutTrain(h.deps, REPO);
    expect(cut.status).toBe("cut");
    await settle();
    const landed = await getIntent(h.db, a);
    expect(landed?.state).toBe("landed");
    const detail = await getTrainDetail(h.deps, landed?.trainId ?? "");
    expect(detail?.intents[0].commit).toBe(landed?.landedSha);
    const routed = await h.db.prepare("SELECT body FROM forge_ledger WHERE subject_id = ? AND kind = 'routed'").bind(a).first<{ body: string }>();
    expect(routed?.body).toMatch(/→ approved/);
  });

  it("refuses to cut without a pipeline (nothing can verify, nothing lands)", async () => {
    await h.ready({ title: "a", paths: ["src/a.ts"], files: { "src/a.ts": "x\n" } });
    expect(await cutTrain({ ...h.deps, loadPipeline: async () => null }, REPO)).toEqual({ status: "no-pipeline" });
  });

  it("speculation_depth 1 serializes groups; a lost build race is busy", async () => {
    h.policyText.value = "lanes: { speculation_depth: 1 }\n";
    await h.ready({ title: "a", paths: ["src/a.ts"], files: { "src/a.ts": "x\n" } });
    await cutTrain(h.deps, REPO);
    await h.ready({ title: "b", paths: ["src/b.ts"], files: { "src/b.ts": "y\n" } });
    expect((await cutTrain(h.deps, REPO)).status).toBe("busy");
    const [one, two] = await Promise.all([buildTrains(h.deps, REPO), buildTrains(h.deps, REPO)]);
    expect([one.status, two.status].sort()).toEqual(["built", "busy"]);
    expect(h.dispatched.length).toBe(1);
  });

  it("speculative: group 2 is built on in-flight group 1's head and lands right after it", async () => {
    const a = await h.ready({ title: "a2", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 2, "a2 by A") } });
    const c1 = await cutTrain(h.deps, REPO);
    expect(c1).toMatchObject({ status: "cut", speculative: false, slots: [0] });
    const g1 = (await buildTrains(h.deps, REPO)) as Extract<BuildResult, { status: "built" }>;
    const h1 = g1.lanes[0].head ?? "";
    // b overlaps a (same file): it stacks on a's in-flight head instead of waiting
    const b = await h.ready({ title: "a9", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 9, "a9 by B") }, agent: "agent-b" });
    const c2 = await cutTrain(h.deps, REPO);
    expect(c2).toMatchObject({ status: "cut", speculative: true, slots: [1], lanes: [[b]] });
    const g2 = (await buildTrains(h.deps, REPO)) as Extract<BuildResult, { status: "built" }>;
    expect(g2.status).toBe("built");
    const h2 = g2.lanes[0].head ?? "";
    expect(h.fx.log(REPO, h2).slice(0, 2)).toEqual([h2, h1]);
    expect(h.fx.head(REPO, "forge/lane-1")).toBe(h2);
    expect(h.dispatched.map((d) => d.sha)).toEqual([h1, h2]);
    expect(h.fx.show(REPO, h2, "src/a.ts")).toContain("a9 by B");
    // group 2 finishes first: nothing lands until group 1 is green
    h.runs.forEach((r) => {
      if (r.sha === h2) r.status = "success";
    });
    expect(await checkTrains(h.deps, REPO)).toEqual({ status: "waiting" });
    h.completeCi();
    expect(await checkTrains(h.deps, REPO)).toMatchObject({ status: "decided", landed: [a, b] });
    // one CAS push covers both groups; main = exactly the verified h2
    expect(h.mainPushes).toEqual([h2]);
    expect(h.fx.head(REPO)).toBe(h2);
    expect((await getIntent(h.db, b))?.landedSha).toBe(h2);
  });

  it("speculative: group 1 lands while group 2 is still verifying, then group 2 lands right after", async () => {
    const a = await h.ready({ title: "a", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 1, "a ok") } });
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    h.completeCi();
    const b = await h.ready({ title: "b", paths: ["src/b.ts"], files: { "src/b.ts": withLine(lines("b"), 1, "b ok") } });
    const cut = await cutTrain(h.deps, REPO);
    expect(cut).toMatchObject({ status: "cut", speculative: true });
    await buildTrains(h.deps, REPO);
    const prog = await checkTrains(h.deps, REPO);
    expect(prog).toMatchObject({ status: "progress", landed: [a] });
    const [h1, h2] = h.dispatched.map((d) => d.sha);
    expect(h.fx.head(REPO)).toBe(h1);
    h.completeCi();
    expect(await checkTrains(h.deps, REPO)).toMatchObject({ status: "decided", landed: [b] });
    expect(h.mainPushes).toEqual([h1, h2]);
  });

  it("speculative: group 1 red invalidates group 2, which is rebuilt on the new main without blame", async () => {
    const a = await h.ready({ title: "bad a", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 1, "a BUG") } });
    await cutTrain(h.deps, REPO);
    const g1 = (await buildTrains(h.deps, REPO)) as Extract<BuildResult, { status: "built" }>;
    const b = await h.ready({ title: "b", paths: ["src/b.ts"], files: { "src/b.ts": withLine(lines("b"), 1, "b ok") } });
    await cutTrain(h.deps, REPO);
    const g2 = (await buildTrains(h.deps, REPO)) as Extract<BuildResult, { status: "built" }>;
    const specHead = g2.lanes[0].head ?? "";
    expect(h.fx.log(REPO, specHead)[1]).toBe(g1.lanes[0].head);
    h.completeCi(); // both red: g2's head contains a's BUG
    expect(await checkTrains(h.deps, REPO)).toMatchObject({ status: "decided", landed: [], failed: [a], requeued: [b] });
    const bi = await getIntent(h.db, b);
    expect(bi?.state).toBe("ready");
    expect((await listForgeLedger(h.db, "intent", b)).some((r) => r.kind === "culprit")).toBe(false);
    await settle();
    const landed = await getIntent(h.db, b);
    expect(landed?.state).toBe("landed");
    expect(landed?.landedSha).not.toBe(specHead);
    expect(h.fx.log(REPO)).not.toContain(g1.lanes[0].head);
    expect(h.fx.show(REPO, "main", "src/a.ts")).not.toContain("BUG");
    expect(h.mainPushes.length).toBe(1);
  });

  it("speculative: a lane that loses the lane it was stacked on is invalidated (chain broken), never landed", async () => {
    await h.ready({ title: "a", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 1, "a ok") } });
    const c1 = await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    const b = await h.ready({ title: "b", paths: ["src/b.ts"], files: { "src/b.ts": withLine(lines("b"), 1, "b ok") } });
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    h.completeCi();
    // group 1 vanishes (e.g. a stale sweep aborted it)
    await h.db.prepare("UPDATE trains SET state = 'aborted' WHERE id = ?").bind(c1.status === "cut" ? c1.trainIds[0] : "").run();
    // b is now the chain's first lane but sits on a's head, not main: the
    // CAS against its base refuses, and it is rebuilt.
    expect(await checkTrains(h.deps, REPO)).toMatchObject({ status: "rebuild", requeued: [b] });
    expect(h.mainPushes).toEqual([]);
    expect((await getIntent(h.db, b))?.state).toBe("ready");
  });

  it("CI runs the TRUNK pipeline, never one an intent rewrote (no `echo ok` self-verification)", async () => {
    const a = await h.ready({
      title: "sneaky",
      paths: ["src/a.ts", "flare.yml"],
      files: { "src/a.ts": withLine(lines("a"), 1, "a BUG"), "flare.yml": "jobs:\n  test:\n    steps:\n      - run: echo ok\n" },
    });
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    expect(h.dispatched.length).toBe(1);
    expect(h.fx.show(REPO, h.dispatched[0].sha, "flare.yml")).toContain("echo ok");
    expect(h.dispatched[0].pipeline).toBe(PIPELINE);
    h.completeCi();
    await checkTrains(h.deps, REPO);
    expect((await getIntent(h.db, a))?.state).toBe("failed");
    expect(h.mainPushes).toEqual([]);
  });

  it("never creates a lane ref: a missing pool ref aborts the lane and requeues it", async () => {
    h.fx.sh(["--git-dir", `${h.fx.root}/${REPO}.git`, "update-ref", "-d", "refs/heads/forge/lane-0"]);
    const a = await h.ready({ title: "a", paths: ["src/a.ts"], files: { "src/a.ts": "x\n" } });
    await cutTrain(h.deps, REPO);
    const built = await buildTrains(h.deps, REPO);
    expect(built.status).toBe("built");
    expect(h.dispatched).toEqual([]);
    expect(h.fx.head(REPO, "forge/lane-0")).toBeNull();
    expect((await getIntent(h.db, a))?.state).toBe("ready");
    const reason = (await h.db.prepare("SELECT body FROM forge_ledger WHERE kind = 'abort_reason'").bind().first<{ body: string }>())?.body;
    expect(reason).toMatch(/lane ref forge\/lane-0 missing/);
  });

  it("routeLine renders the policy decision", () => {
    expect(routeLine(12, DEFAULT_POLICY, "auto", false)).toBe("risk 12 <= 30 → auto");
    expect(routeLine(45, DEFAULT_POLICY, "human", true, "x")).toBe("risk 45 > 30 → approved (x)");
  });

  it("unclaimed conflicts stay listable for the surface", async () => {
    await h.ready({ title: "X", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 3, "X") } });
    await h.ready({ title: "Y", paths: ["src/a.ts"], files: { "src/a.ts": withLine(lines("a"), 3, "Y") } });
    await cutTrain(h.deps, REPO);
    await buildTrains(h.deps, REPO);
    expect((await listConflicts(h.db, REPO, { state: "open" })).length).toBe(1);
  });
});
