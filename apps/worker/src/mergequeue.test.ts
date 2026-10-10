/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  cancelMergeEntry,
  detectMergeCollisions,
  enqueueMergeEntry,
  getMergeEntry,
  listMergeQueue,
  processMergeQueue,
  toMergeEntry,
  validateMergeEnqueue,
  type MergeQueueGithub,
} from "./mergequeue";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const SCHEMA = `
CREATE TABLE merge_queue (id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main', head_sha TEXT NOT NULL DEFAULT '', base_sha TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', run_id TEXT,
  changed_files TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued');`;

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

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "c".repeat(40);

function fakeGithub(over: Partial<MergeQueueGithub> = {}): MergeQueueGithub & { merged: { repo: string; pr: number; headSha: string }[] } {
  const merged: { repo: string; pr: number; headSha: string }[] = [];
  return {
    merged,
    baseHead: async () => BASE,
    updateBranch: async () => "current",
    prHead: async () => HEAD_A,
    prFiles: async () => ["src/a.ts"],
    mergePr: async (repo, pr, headSha) => {
      merged.push({ repo, pr, headSha });
      return { merged: true, detail: `PR #${pr} merged` };
    },
    ...over,
  };
}

async function seedRun(db: Db, id: string, status: string): Promise<void> {
  await db.prepare("INSERT INTO runs (id, status) VALUES (?, ?)").bind(id, status).run();
}

describe("validateMergeEnqueue", () => {
  it("accepts a full payload", () => {
    const out = validateMergeEnqueue({ repo: "o/r", pr: 12, headSha: HEAD_A, baseBranch: "main", agent: "atlas" });
    expect(out).toEqual({ repo: "o/r", pr: 12, headSha: HEAD_A, baseBranch: "main", agent: "atlas" });
  });

  it("defaults base and agent", () => {
    const out = validateMergeEnqueue({ repo: "o/r", pr: 1, headSha: HEAD_A });
    expect(out).toEqual({ repo: "o/r", pr: 1, headSha: HEAD_A, baseBranch: "main", agent: "" });
  });

  it("rejects bad fields", () => {
    expect(validateMergeEnqueue({ repo: "nope", pr: 1, headSha: HEAD_A })).toHaveProperty("error");
    expect(validateMergeEnqueue({ repo: "o/r", pr: 0, headSha: HEAD_A })).toHaveProperty("error");
    expect(validateMergeEnqueue({ repo: "o/r", pr: 1.5, headSha: HEAD_A })).toHaveProperty("error");
    expect(validateMergeEnqueue({ repo: "o/r", pr: 1, headSha: "zzz" })).toHaveProperty("error");
    expect(validateMergeEnqueue({ repo: "o/r", pr: 1, headSha: HEAD_A, agent: "has space" })).toHaveProperty("error");
  });
});

describe("enqueue / cancel / list", () => {
  it("enqueues then rejects a duplicate active PR", async () => {
    const db = sqliteDb();
    const first = await enqueueMergeEntry(db, { repo: "o/r", pr: 7, headSha: HEAD_A, baseBranch: "main", agent: "a1" });
    expect("id" in first).toBe(true);
    const dup = await enqueueMergeEntry(db, { repo: "o/r", pr: 7, headSha: HEAD_B, baseBranch: "main", agent: "a2" });
    expect(dup).toEqual({ error: "duplicate" });
  });

  it("allows re-enqueue after cancel", async () => {
    const db = sqliteDb();
    const first = await enqueueMergeEntry(db, { repo: "o/r", pr: 7, headSha: HEAD_A, baseBranch: "main", agent: "" });
    const id = (first as { id: string }).id;
    expect(await cancelMergeEntry(db, id)).toBe(true);
    expect(await cancelMergeEntry(db, id)).toBe(false);
    const again = await enqueueMergeEntry(db, { repo: "o/r", pr: 7, headSha: HEAD_B, baseBranch: "main", agent: "" });
    expect("id" in again).toBe(true);
  });

  it("caps active entries per repo", async () => {
    const db = sqliteDb();
    for (let pr = 1; pr <= 20; pr++) {
      const out = await enqueueMergeEntry(db, { repo: "o/r", pr, headSha: HEAD_A, baseBranch: "main", agent: "" });
      expect("id" in out).toBe(true);
    }
    expect(await enqueueMergeEntry(db, { repo: "o/r", pr: 21, headSha: HEAD_A, baseBranch: "main", agent: "" })).toEqual({
      error: "queue-full",
    });
    // Other repos are unaffected.
    const other = await enqueueMergeEntry(db, { repo: "o/other", pr: 1, headSha: HEAD_A, baseBranch: "main", agent: "" });
    expect("id" in other).toBe(true);
  });

  it("cancel misses on unknown ids", async () => {
    expect(await cancelMergeEntry(sqliteDb(), "missing")).toBe(false);
  });

  it("lists newest first with parsed files", async () => {
    const db = sqliteDb();
    await enqueueMergeEntry(db, { repo: "o/r", pr: 1, headSha: HEAD_A, baseBranch: "main", agent: "a" });
    await enqueueMergeEntry(db, { repo: "o/r", pr: 2, headSha: HEAD_B, baseBranch: "main", agent: "b" });
    const rows = await listMergeQueue(db, "o/r");
    expect(rows.map((r) => r.pr_number)).toEqual([2, 1]);
    const entry = toMergeEntry(rows[0]);
    expect(entry.pr).toBe(2);
    expect(entry.agent).toBe("b");
    expect(entry.files).toEqual([]);
    expect(await getMergeEntry(db, rows[0].id)).not.toBeNull();
  });
});

describe("detectMergeCollisions", () => {
  it("finds shared paths between queued PRs", () => {
    const out = detectMergeCollisions([
      { id: "e1", pr: 1, files: ["src/a.ts", "src/b.ts"] },
      { id: "e2", pr: 2, files: ["src/b.ts", "src/c.ts"] },
      { id: "e3", pr: 3, files: ["docs/x.md"] },
    ]);
    expect(out).toEqual([{ entries: ["e1", "e2"], prs: [1, 2], paths: ["src/b.ts"] }]);
  });

  it("ignores entries with unknown files and disjoint sets", () => {
    expect(detectMergeCollisions([
      { id: "e1", pr: 1, files: [] },
      { id: "e2", pr: 2, files: ["src/a.ts"] },
    ])).toEqual([]);
    expect(detectMergeCollisions([
      { id: "e1", pr: 1, files: ["a"] },
      { id: "e2", pr: 2, files: ["b"] },
    ])).toEqual([]);
  });

  it("bounds pairs and paths", () => {
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, pr: i + 1, files }));
    const out = detectMergeCollisions(entries);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out[0].paths.length).toBeLessThanOrEqual(10);
  });
});

describe("processMergeQueue", () => {
  async function queued(db: Db, pr: number, agent = ""): Promise<string> {
    const out = await enqueueMergeEntry(db, { repo: "o/r", pr, headSha: HEAD_A, baseBranch: "main", agent });
    return (out as { id: string }).id;
  }

  it("starts the oldest queued entry and stamps base + files", async () => {
    const db = sqliteDb();
    const id = await queued(db, 3);
    const github = fakeGithub({ prFiles: async () => ["src/a.ts", "src/b.ts"] });
    const seen: string[] = [];
    const out = await processMergeQueue({
      db,
      dispatch: async (input) => {
        seen.push(`${input.repo}@${input.sha.slice(0, 4)}`);
        return { runId: "run-1" };
      },
      github,
    });
    expect(out).toEqual({ started: 1, landed: 0, failed: 0, requeued: 0 });
    expect(seen).toEqual(["o/r@aaaa"]);
    const row = (await getMergeEntry(db, id))!;
    expect(row.status).toBe("verifying");
    expect(row.run_id).toBe("run-1");
    expect(row.base_sha).toBe(BASE);
    expect(toMergeEntry(row).files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(row.note).toContain("verifying");
  });

  it("serializes one verification per repo", async () => {
    const db = sqliteDb();
    await queued(db, 1);
    await queued(db, 2);
    await seedRun(db, "run-1", "running");
    await seedRun(db, "run-2", "running");
    let n = 0;
    const deps = { db, dispatch: async () => ({ runId: `run-${++n}` }), github: fakeGithub() };
    expect(await processMergeQueue(deps)).toMatchObject({ started: 1 });
    // Second entry waits while the first verifies.
    expect(await processMergeQueue(deps)).toMatchObject({ started: 0 });
    const rows = await listMergeQueue(db, "o/r");
    expect(rows.filter((r) => r.status === "verifying")).toHaveLength(1);
  });

  it("lands on green when the base is unchanged", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    const github = fakeGithub();
    await seedRun(db, "run-1", "running");
    const deps = { db, dispatch: async () => ({ runId: "run-1" }), github };
    await processMergeQueue(deps);
    await db.prepare("UPDATE runs SET status = 'success' WHERE id = 'run-1'").bind().run();
    const out = await processMergeQueue(deps);
    expect(out).toEqual({ started: 0, landed: 1, failed: 0, requeued: 0 });
    expect(github.merged).toEqual([{ repo: "o/r", pr: 1, headSha: HEAD_A }]);
    expect((await getMergeEntry(db, id))!.status).toBe("landed");
  });

  it("fails terminally on a red verification without merging", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    const github = fakeGithub();
    await seedRun(db, "run-1", "failure");
    const deps = { db, dispatch: async () => ({ runId: "run-1" }), github };
    await processMergeQueue(deps);
    expect(await processMergeQueue(deps)).toMatchObject({ failed: 1, landed: 0 });
    expect(github.merged).toEqual([]);
    const row = (await getMergeEntry(db, id))!;
    expect(row.status).toBe("failed");
    expect(row.note).toContain("failure");
  });

  it("re-queues when the base moves instead of landing stale", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    let head = BASE;
    const github = fakeGithub({ baseHead: async () => head });
    await seedRun(db, "run-1", "success");
    const deps = { db, dispatch: async () => ({ runId: "run-1" }), github };
    await processMergeQueue(deps);
    head = "d".repeat(40);
    // Re-queued, then immediately re-verifying against the new head.
    expect(await processMergeQueue(deps)).toMatchObject({ requeued: 1, landed: 0, started: 1 });
    expect(github.merged).toEqual([]);
    const row = (await getMergeEntry(db, id))!;
    expect(row.status).toBe("verifying");
    expect(row.base_sha).toBe(head);
  });

  it("re-queues mid-verify when the base moves under a live run", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    let head = BASE;
    const github = fakeGithub({ baseHead: async () => head });
    await seedRun(db, "run-1", "running");
    const deps = { db, dispatch: async () => ({ runId: "run-1" }), github };
    await processMergeQueue(deps);
    head = "d".repeat(40);
    expect(await processMergeQueue(deps)).toMatchObject({ requeued: 1, started: 1 });
    const row = (await getMergeEntry(db, id))!;
    expect(row.status).toBe("verifying");
    expect(row.base_sha).toBe(head);
  });

  it("fails visibly when the merge is rejected", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    const github = fakeGithub({ mergePr: async () => ({ merged: false, detail: "needs approval" }) });
    await seedRun(db, "run-1", "success");
    const deps = { db, dispatch: async () => ({ runId: "run-1" }), github };
    await processMergeQueue(deps);
    expect(await processMergeQueue(deps)).toMatchObject({ failed: 1 });
    const row = (await getMergeEntry(db, id))!;
    expect(row.status).toBe("failed");
    expect(row.note).toContain("needs approval");
  });

  it("parks visibly when GitHub or dispatch is unavailable", async () => {
    const db = sqliteDb();
    const blind = await queued(db, 1);
    // Unreadable base: stays queued with a note.
    await processMergeQueue({ db, dispatch: async () => ({ runId: "x" }), github: fakeGithub({ baseHead: async () => null }) });
    expect((await getMergeEntry(db, blind))!.status).toBe("queued");
    expect((await getMergeEntry(db, blind))!.note).toContain("unreadable");
    // Rebase failure and dispatch throw park the same way.
    await processMergeQueue({ db, dispatch: async () => ({ runId: "x" }), github: fakeGithub({ updateBranch: async () => "failed" }) });
    expect((await getMergeEntry(db, blind))!.note).toContain("rebase");
    await processMergeQueue({
      db,
      dispatch: async () => { throw new Error("boom"); },
      github: fakeGithub(),
    });
    expect((await getMergeEntry(db, blind))!.note).toContain("dispatch failed");
  });

  it("fails entries whose run vanished", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    const deps = { db, dispatch: async () => ({ runId: "ghost" }), github: fakeGithub() };
    await processMergeQueue(deps);
    expect(await processMergeQueue(deps)).toMatchObject({ failed: 1 });
    expect((await getMergeEntry(db, id))!.status).toBe("failed");
  });

  it("verifies and merges the post-update PR head, not the enqueued SHA", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    const POST = "e".repeat(40);
    let prHead = HEAD_A;
    const github = fakeGithub({
      prHead: async () => prHead,
      updateBranch: async () => {
        prHead = POST; // update-branch adds a merge commit on the PR
        return "updated";
      },
    });
    const dispatched: string[] = [];
    await seedRun(db, "run-1", "running");
    const deps = {
      db,
      dispatch: async (input: { sha: string }) => {
        dispatched.push(input.sha);
        return { runId: "run-1" };
      },
      github,
    };
    await processMergeQueue(deps);
    expect(dispatched).toEqual([POST]);
    const row = (await getMergeEntry(db, id))!;
    expect(row.head_sha).toBe(POST);
    expect(row.note).toContain(POST.slice(0, 7));
    await db.prepare("UPDATE runs SET status = 'success' WHERE id = 'run-1'").bind().run();
    expect(await processMergeQueue(deps)).toMatchObject({ landed: 1 });
    expect(github.merged).toEqual([{ repo: "o/r", pr: 1, headSha: POST }]);
  });

  it("waits while an accepted branch update has not moved the head yet", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    const dispatched: string[] = [];
    const deps = {
      db,
      dispatch: async (input: { sha: string }) => {
        dispatched.push(input.sha);
        return { runId: "run-1" };
      },
      github: fakeGithub({ updateBranch: async () => "updated" }),
    };
    expect(await processMergeQueue(deps)).toMatchObject({ started: 0 });
    expect(dispatched).toEqual([]);
    const row = (await getMergeEntry(db, id))!;
    expect(row.status).toBe("queued");
    expect(row.note).toContain("pending");
  });

  it("parks when the PR head is unreadable after the update", async () => {
    const db = sqliteDb();
    const id = await queued(db, 1);
    await processMergeQueue({ db, dispatch: async () => ({ runId: "x" }), github: fakeGithub({ prHead: async () => null }) });
    const row = (await getMergeEntry(db, id))!;
    expect(row.status).toBe("queued");
    expect(row.note).toContain("PR head unreadable");
  });
});
