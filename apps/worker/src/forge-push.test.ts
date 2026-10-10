/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { SCHEMA_STATEMENTS } from "./schema";
import { declareIntent, isForgeError } from "./intents";
import { changedFiles, compactPaths, handleForgePush, isCodeRef, parseForgePush, type ForgePushDeps, type TreeEntryLike, type TreeReader } from "./forge-push";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

function d1(): { db: Db; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of SCHEMA_STATEMENTS) {
    const m = /(?:TABLE IF NOT EXISTS|ON) (\w+)/.exec(stmt);
    if (m && ["intents", "goals", "forge_ledger"].includes(m[1])) raw.exec(stmt);
  }
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
            run: async () => ({ meta: { changes: Number((raw.prepare(query).run(...params) as { changes?: unknown }).changes ?? 0) } }),
          };
        },
      };
    },
  } as unknown as Db;
  return { db, raw };
}

// A tiny content-addressed fake: commits map to nested {name: hash|tree}.
type Tree = { [name: string]: string | Tree };

function fakeRepo(commits: Record<string, Tree>): TreeReader & { reads: number } {
  const trees = new Map<string, TreeEntryLike[]>();
  const hashTree = (t: Tree): string => {
    const entries: TreeEntryLike[] = Object.keys(t)
      .sort()
      .map((name) => {
        const v = t[name];
        return typeof v === "string" ? { name, mode: "100644", hash: v, type: "blob" } : { name, mode: "40000", hash: hashTree(v), type: "tree" };
      });
    const h = `t:${JSON.stringify(entries)}`;
    trees.set(h, entries);
    return h;
  };
  const roots = new Map(Object.entries(commits).map(([sha, t]) => [sha, hashTree(t)]));
  const repo = {
    reads: 0,
    readCommit: async (sha: string) => (roots.has(sha) ? { treeHash: roots.get(sha) ?? "" } : null),
    readTree: async (hash: string) => {
      repo.reads++;
      return trees.get(hash) ?? null;
    },
  };
  return repo;
}

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

describe("parseForgePush / isCodeRef", () => {
  const envelope = {
    type: "cf.artifacts.repo.pushed",
    source: { type: "artifacts.repo", namespace: "ns", repoName: "i-abc" },
    payload: { ref: "refs/heads/main", before: BASE, after: HEAD.toUpperCase(), commits: [] },
  };
  it("accepts the envelope and the flattened shape", () => {
    expect(parseForgePush(envelope)).toEqual({ namespace: "ns", repo: "i-abc", ref: "refs/heads/main", before: BASE, after: HEAD });
    expect(parseForgePush({ source: envelope.source, ...envelope.payload })?.repo).toBe("i-abc");
  });
  it("rejects malformed, deletions and other event types", () => {
    expect(parseForgePush(null)).toBeNull();
    expect(parseForgePush({ ...envelope, type: "cf.artifacts.repo.cloned" })).toBeNull();
    expect(parseForgePush({ ...envelope, payload: { ...envelope.payload, after: "0".repeat(40) } })).toBeNull();
    expect(parseForgePush({ ...envelope, source: { namespace: "ns", repoName: "../x" } })).toBeNull();
  });
  it("only branch pushes outside flare/ and forge/ are code", () => {
    expect(isCodeRef("refs/heads/main")).toBe(true);
    expect(isCodeRef("refs/notes/why")).toBe(false);
    expect(isCodeRef("refs/tags/v1")).toBe(false);
    expect(isCodeRef("refs/heads/flare/session")).toBe(false);
    expect(isCodeRef("refs/heads/forge/lane-0")).toBe(false);
  });
});

describe("changedFiles", () => {
  it("diffs by hash, skipping unchanged subtrees, walking added/removed dirs", async () => {
    const repo = fakeRepo({
      [BASE]: { src: { a: "h1", keep: { k: "hk" }, old: { o: "ho" } }, "README.md": "r1" },
      [HEAD]: { src: { a: "h2", keep: { k: "hk" }, fresh: { n: { deep: "hd" } } }, "README.md": "r1", f: "x" },
    });
    const out = await changedFiles(repo, BASE, HEAD);
    expect(out).toEqual({ files: ["f", "src/a", "src/fresh/n/deep", "src/old/o"], truncated: false });
    expect(await changedFiles(repo, BASE, "9".repeat(40))).toBeNull();
  });
  it("records directories past the read budget and caps files", async () => {
    const big: Tree = {};
    for (let i = 0; i < 10; i++) big[`d${i}`] = { x: `h${i}` };
    const repo = fakeRepo({ [BASE]: {}, [HEAD]: big });
    const budget = await changedFiles(repo, BASE, HEAD, { treeReads: 4, files: 100 });
    expect(budget?.truncated).toBe(true);
    expect(budget?.files).toContain("d0/x");
    expect(budget?.files).toContain("d9");
    const capped = await changedFiles(repo, BASE, HEAD, { treeReads: 100, files: 3 });
    expect(capped?.files).toHaveLength(3);
    expect(capped?.truncated).toBe(true);
  });
});

describe("compactPaths", () => {
  it("collapses the deepest paths into parents until it fits, dropping covered entries", () => {
    expect(compactPaths(["b", "a", "a"], 5)).toEqual(["a", "b"]);
    const files = Array.from({ length: 300 }, (_, i) => `src/m${i % 3}/f${i}.ts`);
    expect(compactPaths(files, 200)).toEqual(["src/m0", "src/m1", "src/m2"]);
    expect(compactPaths(["a/b/c", "a/b", "x"], 2)).toEqual(["a/b", "x"]);
    expect(compactPaths(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});

describe("handleForgePush", () => {
  async function setup(state = "working", baseSha = BASE) {
    const { db, raw } = d1();
    const r = await declareIntent(db, { repo: "trunk", title: "Fix a", footprint: ["src"] });
    if (isForgeError(r)) throw new Error(r.message);
    raw.prepare("UPDATE intents SET fork_repo = 'i-abc', agent = 'bot', state = ?, base_sha = ? WHERE id = ?").run(state, baseSha, r.intent.id);
    const calls: Array<{ repo: string; id: string; paths: string[]; agent: string; sha: string }> = [];
    const repo = fakeRepo({ [BASE]: { src: { a: "1" } }, [HEAD]: { src: { a: "2", b: "3" } } });
    let disposed = 0;
    const deps: ForgePushDeps = {
      db,
      namespace: "ns",
      openRepo: async () => Object.assign(repo, { [Symbol.dispose]: () => void disposed++ }),
      reportPush: async (repoName, id, input) => {
        calls.push({ repo: repoName, id, paths: input.actualFootprint.paths, agent: input.agent, sha: input.headSha });
        return { ok: true, duplicate: false, drift: [] };
      },
    };
    return { deps, calls, id: r.intent.id, disposed: () => disposed };
  }
  const push = (over: Record<string, unknown> = {}) => ({
    type: "cf.artifacts.repo.pushed",
    source: { namespace: "ns", repoName: "i-abc" },
    payload: { ref: "refs/heads/main", before: BASE, after: HEAD, ...over },
  });

  it("maps fork -> intent, diffs vs the intent base, and reports to the trunk coordinator", async () => {
    const s = await setup();
    const out = await handleForgePush(s.deps, push());
    expect(out).toEqual({ status: "reported", intentId: s.id, files: 2, drift: 0, duplicate: false, truncated: false });
    expect(s.calls).toEqual([{ repo: "trunk", id: s.id, paths: ["src/a", "src/b"], agent: "bot", sha: HEAD }]);
    expect(s.disposed()).toBe(1);
  });
  it("skips non-code refs, other namespaces, unknown forks and non-pushable intents", async () => {
    const s = await setup();
    expect(await handleForgePush(s.deps, push({ ref: "refs/notes/why" }))).toEqual({ status: "skipped", reason: "not-code-ref" });
    expect(await handleForgePush({ ...s.deps, namespace: "other" }, push())).toEqual({ status: "skipped", reason: "other-namespace" });
    expect(await handleForgePush(s.deps, { ...push(), source: { namespace: "ns", repoName: "nobody" } })).toEqual({
      status: "skipped",
      reason: "not-a-fork",
    });
    expect(await handleForgePush(s.deps, "junk")).toEqual({ status: "skipped", reason: "invalid" });
    const landed = await setup("landed");
    expect(await handleForgePush(landed.deps, push())).toEqual({ status: "skipped", reason: "not-pushable" });
  });
  it("ignores a trunk-sync push to a mirror's default branch (not an intent fork)", async () => {
    // Seats fast-forward the GitHub mirror's trunk (repo "trunk" here,
    // the repo intents are declared against) on default-branch pushes;
    // the namespace trigger fires for it like any push. It must not
    // touch intents, the coordinator, or the ledger.
    const s = await setup();
    let opened = 0;
    const deps = { ...s.deps, openRepo: async () => { opened++; return Promise.reject(new Error("must not open")); } };
    const before = s.deps.db;
    const ledgerBefore = await before.prepare("SELECT COUNT(*) AS n FROM forge_ledger").bind().first<{ n: number }>();
    const out = await handleForgePush(deps, {
      type: "cf.artifacts.repo.pushed",
      source: { namespace: "ns", repoName: "trunk" },
      payload: { ref: "refs/heads/main", before: BASE, after: HEAD },
    });
    expect(out).toEqual({ status: "skipped", reason: "not-a-fork" });
    expect(s.calls).toEqual([]);
    expect(opened).toBe(0);
    const ledgerAfter = await before.prepare("SELECT COUNT(*) AS n FROM forge_ledger").bind().first<{ n: number }>();
    expect(ledgerAfter?.n).toBe(ledgerBefore?.n);
    const intent = await before.prepare("SELECT state, base_sha FROM intents WHERE id = ?").bind(s.id).first<{ state: string; base_sha: string }>();
    expect(intent).toEqual({ state: "working", base_sha: BASE });
    // The lazy checkout-cache branch on a mirror is equally inert.
    expect(
      await handleForgePush(deps, {
        type: "cf.artifacts.repo.pushed",
        source: { namespace: "ns", repoName: "trunk" },
        payload: { ref: "refs/heads/flare-mirror", before: "", after: HEAD },
      }),
    ).toEqual({ status: "skipped", reason: "not-a-fork" });
  });
  it("falls back to `before` when the intent has no base; zero before = no-base", async () => {
    const s = await setup("working", "");
    expect((await handleForgePush(s.deps, push())).status).toBe("reported");
    expect(await handleForgePush(s.deps, push({ before: "0".repeat(40) }))).toEqual({ status: "skipped", reason: "no-base" });
  });
  it("surfaces coordinator failures and unreadable repos", async () => {
    const s = await setup();
    const failing = { ...s.deps, reportPush: async () => ({ ok: false as const, error: "boom", message: "x" }) };
    expect(await handleForgePush(failing, push())).toEqual({ status: "failed", error: "boom", message: "x" });
    const unreadable = { ...s.deps, openRepo: async () => Promise.reject(new Error("no repo")) };
    expect(await handleForgePush(unreadable, push())).toEqual({ status: "skipped", reason: "unreadable" });
  });
});
