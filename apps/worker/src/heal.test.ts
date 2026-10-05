/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { SETTING_KEYS } from "./settings";
import {
  buildHealMessages,
  healBranchForRun,
  parseHealFiles,
  processHealClaims,
  requestHeal,
  type HealDeps,
  type HealGitHub,
} from "./heal";

// node:sqlite via getBuiltinModule: vite-node's import analysis predates
// the specifier, but the runtime resolves it fine.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    `CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, sha TEXT NOT NULL, event TEXT NOT NULL,
      installation_id INTEGER, branch TEXT NOT NULL DEFAULT '', source TEXT, pr_number INTEGER,
      pr_comment_id INTEGER, heal_branch TEXT, heal_pr_url TEXT, status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      log TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '', triage TEXT NOT NULL DEFAULT '', labels TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE heal_claims (run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT, pr_url TEXT, created_at TEXT NOT NULL);
     CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);`,
  );
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
  };
}

async function seedRun(
  db: Db,
  opts: {
    runId?: string;
    jobId?: string;
    status?: string;
    installationId?: number | null;
    branch?: string;
    source?: string | null;
    healOn?: boolean;
    triage?: string;
  } = {},
): Promise<{ runId: string; jobId: string }> {
  const runId = opts.runId ?? "run-heal-1";
  const jobId = opts.jobId ?? "job-heal-1";
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO runs (id, repo, sha, event, installation_id, branch, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(runId, "o/r", "abc123", "push", opts.installationId === null ? null : (opts.installationId ?? 42), opts.branch ?? "main", opts.source ?? null, opts.status ?? "failure", now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs (id, run_id, status, log, name, definition, result, triage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      jobId,
      runId,
      "failure",
      "traceback...\nAssertionError: expected 2 got 3",
      "test",
      "",
      JSON.stringify({ steps: [{ command: "npm test", exitCode: 1, output: "AssertionError: expected 2 got 3" }] }),
      opts.triage ?? "off-by-one in sum()",
      now,
      now,
    )
    .run();
  if (opts.healOn) {
    await db
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(SETTING_KEYS.healOnFailure, "1", now)
      .run();
  }
  return { runId, jobId };
}

function fakeGh(): HealGitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    treePaths: async () => {
      calls.push("tree");
      return ["src/sum.ts", "src/main.ts", "README.md"];
    },
    commitFiles: async () => {
      calls.push("commit");
      return true;
    },
    openDraftPr: async () => {
      calls.push("pr");
      return "https://github.com/o/r/pull/7";
    },
    defaultBranch: async () => "main",
  };
}

function fakeAi(response: string | null): { run: (...args: unknown[]) => Promise<{ response?: unknown }> } {
  return { run: async () => (response === null ? {} : { response }) };
}

const PROPOSAL = JSON.stringify({
  files: [{ path: "src/sum.ts", content: "export function sum(a: number, b: number): number {\n  return a + b;\n}\n" }],
  summary: "Fix off-by-one in sum().",
});

describe("parseHealFiles", () => {
  it("parses raw and fenced JSON proposals", () => {
    expect(parseHealFiles(PROPOSAL)?.files).toHaveLength(1);
    expect(parseHealFiles("```json\n" + PROPOSAL + "\n```")?.summary).toBe("Fix off-by-one in sum().");
  });

  it("rejects traversal, absolute paths, dupes, and oversize files", () => {
    const evil = (path: string): string => JSON.stringify({ files: [{ path, content: "x" }], summary: "" });
    expect(parseHealFiles(evil("../escape.ts"))).toBeNull();
    expect(parseHealFiles(evil("/abs.ts"))).toBeNull();
    expect(parseHealFiles(evil("a/../../b.ts"))).toBeNull();
    expect(parseHealFiles(JSON.stringify({ files: [{ path: "a.ts", content: "x" }, { path: "a.ts", content: "y" }] }))).toBeNull();
    expect(parseHealFiles(JSON.stringify({ files: [{ path: "a.ts", content: "x".repeat(9000) }] }))).toBeNull();
    expect(parseHealFiles(JSON.stringify({ files: [] }))).toBeNull();
    expect(parseHealFiles("not json")).toBeNull();
  });

  it("rejects more than three files", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ path, content: "x" }));
    expect(parseHealFiles(JSON.stringify({ files }))).toBeNull();
  });
});

describe("buildHealMessages", () => {
  it("leads with failing steps and bounds the tree", () => {
    const messages = buildHealMessages({
      repo: "o/r",
      sha: "abc",
      branch: "main",
      jobName: "test",
      steps: [{ command: "npm test", exitCode: 1, output: "boom" }],
      logTail: "tail",
      triage: "t",
      treePaths: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("COMPLETE file contents");
    expect(messages[1].content).toContain("npm test");
    expect(messages[1].content).toContain("f299.ts");
    expect(messages[1].content).not.toContain("f300.ts");
  });
});

describe("healBranchForRun", () => {
  it("derives a safe branch name", () => {
    expect(healBranchForRun("run-heal-1")).toBe("flare-heal/runheal1");
  });
});

describe("requestHeal", () => {
  it("claims once: the second trigger for a run loses", async () => {
    const db = sqliteDb();
    const { runId, jobId } = await seedRun(db, { healOn: true });
    expect(await requestHeal(db, runId, jobId)).toBe(true);
    expect(await requestHeal(db, runId, jobId)).toBe(false);
  });

  it("refuses when the toggle is off, uninstalled, or a heal loop", async () => {
    const off = sqliteDb();
    const seeded = await seedRun(off, {});
    expect(await requestHeal(off, seeded.runId, seeded.jobId)).toBe(false);

    const noInstall = sqliteDb();
    const ni = await seedRun(noInstall, { healOn: true, installationId: null });
    expect(await requestHeal(noInstall, ni.runId, ni.jobId)).toBe(false);

    const loop = sqliteDb();
    const hb = await seedRun(loop, { healOn: true, branch: "flare-heal/abc" });
    expect(await requestHeal(loop, hb.runId, hb.jobId)).toBe(false);

    const verify = sqliteDb();
    const v = await seedRun(verify, { healOn: true, source: "heal:run-1" });
    expect(await requestHeal(verify, v.runId, v.jobId)).toBe(false);
  });
});

describe("processHealClaims", () => {
  function deps(db: Db, gh: HealGitHub, response: string | null, verifyRunId: string | null = "run-verify-1"): HealDeps {
    return {
      db,
      ai: fakeAi(response) as HealDeps["ai"],
      installationToken: async () => "tok",
      gh,
      verify: async () => verifyRunId,
    };
  }

  it("heals end to end: branch, draft PR, run row, verify dispatch", async () => {
    const db = sqliteDb();
    const gh = fakeGh();
    const { runId, jobId } = await seedRun(db, { healOn: true });
    expect(await requestHeal(db, runId, jobId)).toBe(true);
    let verified: { repo: string; branch: string; source: string } | null = null;
    const out = await processHealClaims({
      ...deps(db, gh, PROPOSAL),
      verify: async (repo, branch, source) => {
        verified = { repo, branch, source };
        return "run-verify-1";
      },
    });
    expect(out).toEqual({ processed: 1, healed: 1 });
    expect(gh.calls).toEqual(["tree", "commit", "pr"]);
    expect(verified).toEqual({ repo: "o/r", branch: "flare-heal/runheal1", source: `heal:${runId}` });
    const run = await db.prepare("SELECT heal_branch AS b, heal_pr_url AS u FROM runs WHERE id = ?").bind(runId).first<{ b: string; u: string }>();
    expect(run?.b).toBe("flare-heal/runheal1");
    expect(run?.u).toBe("https://github.com/o/r/pull/7");
    const claim = await db.prepare("SELECT status FROM heal_claims WHERE run_id = ?").bind(runId).first<{ status: string }>();
    expect(claim?.status).toBe("done");
  });

  it("skips runs that recovered since the claim", async () => {
    const db = sqliteDb();
    const gh = fakeGh();
    const { runId, jobId } = await seedRun(db, { healOn: true });
    expect(await requestHeal(db, runId, jobId)).toBe(true);
    await db.prepare("UPDATE runs SET status = 'success' WHERE id = ?").bind(runId).run();
    const out = await processHealClaims(deps(db, gh, PROPOSAL));
    expect(out).toEqual({ processed: 1, healed: 0 });
    expect(gh.calls).toEqual([]);
  });

  it("fails closed on unparseable model output", async () => {
    const db = sqliteDb();
    const gh = fakeGh();
    const { runId, jobId } = await seedRun(db, { healOn: true });
    expect(await requestHeal(db, runId, jobId)).toBe(true);
    const out = await processHealClaims(deps(db, gh, "sorry, cannot fix (not json)"));
    expect(out).toEqual({ processed: 1, healed: 0 });
    expect(gh.calls).toEqual(["tree"]);
  });

  it("still lands the PR when verification dispatch fails", async () => {
    const db = sqliteDb();
    const gh = fakeGh();
    const { runId, jobId } = await seedRun(db, { healOn: true });
    expect(await requestHeal(db, runId, jobId)).toBe(true);
    const out = await processHealClaims(deps(db, gh, PROPOSAL, null));
    expect(out).toEqual({ processed: 1, healed: 1 });
    const audit = await db
      .prepare("SELECT target FROM audit_log WHERE action = 'run.healed'")
      .bind()
      .first<{ target: string }>();
    expect(audit?.target).toContain("verify:failed");
  });
});
