/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { claimJob, releaseJob, rerunJob } from "./db";
import { runComputeMs } from "./cloud";

// Real SQLite (node:sqlite) so the billing and cap SQL — julianday
// math, the claim-time COUNT subquery — runs as written, not via a
// string-matching fake.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const SCHEMA = `
CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, sha TEXT NOT NULL);
CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, log TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '', triage TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, finished_at TEXT, billed_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE log_fts (job_id TEXT, body TEXT);`;

function sqliteDb(): { db: Db; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  const db = {
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
  raw.exec("INSERT INTO runs VALUES ('r1', 'o/r', 'abc')");
  return { db, raw };
}

function addJob(raw: InstanceType<typeof DatabaseSync>, id: string, status: string, started: string | null = null, finished: string | null = null): void {
  raw.prepare("INSERT INTO jobs (id, run_id, status, started_at, finished_at) VALUES (?, 'r1', ?, ?, ?)").run(id, status, started, finished);
}

function job(raw: InstanceType<typeof DatabaseSync>, id: string): { status: string; billed_ms: number; started_at: string | null; finished_at: string | null } {
  return raw.prepare("SELECT status, billed_ms, started_at, finished_at FROM jobs WHERE id = ?").get(id) as never;
}

describe("claim-time plan cap", () => {
  it("refuses a claim once the running count reaches the cap", async () => {
    const { db, raw } = sqliteDb();
    addJob(raw, "a", "running", "2026-10-09T00:00:00.000Z");
    addJob(raw, "b", "queued");
    addJob(raw, "c", "queued");
    expect(await claimJob(db, "b", 2)).toBe(true);
    expect(await claimJob(db, "c", 2)).toBe(false);
    expect(job(raw, "c").status).toBe("queued");
    expect(await claimJob(db, "c")).toBe(true); // uncapped (self-hosted)
  });
});

describe("attempt billing", () => {
  it("bills a retried attempt's elapsed time; plain releases stay free", async () => {
    const { db, raw } = sqliteDb();
    const started = new Date(Date.now() - 90_000).toISOString();
    addJob(raw, "a", "running", started);
    addJob(raw, "b", "running", started);
    expect(await releaseJob(db, "a", { bill: true })).toBe(true);
    expect(await releaseJob(db, "b")).toBe(true);
    const billed = job(raw, "a").billed_ms;
    expect(billed).toBeGreaterThanOrEqual(89_000);
    expect(billed).toBeLessThan(120_000);
    expect(job(raw, "a").started_at).toBeNull();
    expect(job(raw, "b").billed_ms).toBe(0);
  });

  it("carries a finished attempt into billed_ms on rerun", async () => {
    const { db, raw } = sqliteDb();
    addJob(raw, "a", "failure", "2026-10-09T00:00:00.000Z", "2026-10-09T00:02:30.000Z");
    await rerunJob(db, "a");
    const row = job(raw, "a");
    expect(row).toMatchObject({ status: "queued", billed_ms: 150_000, started_at: null, finished_at: null });
    // Second attempt runs a minute; metering sees both.
    expect(runComputeMs([{ started_at: "2026-10-09T01:00:00.000Z", finished_at: "2026-10-09T01:01:00.000Z", billed_ms: row.billed_ms }])).toBe(210_000);
  });
});
