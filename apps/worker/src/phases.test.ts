/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { bottleneckStats } from "./db";
import { bottleneckHint, classifyStep, parseStepPairs, splitJobPhases, type PhaseSummary, type StepPhase } from "./phases";
import { SCHEMA_STATEMENTS } from "./schema";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

describe("classifyStep", () => {
  it.each([
    "npm ci",
    "npm install --no-audit",
    "pnpm install --frozen-lockfile",
    "yarn",
    "yarn --frozen-lockfile",
    "bun install",
    "python -m pip install -r requirements.txt",
    "uv sync",
    "sudo apt-get update\nsudo apt-get install -y libpq-dev",
    "corepack enable && pnpm install",
    "cd web && npm ci",
    "git submodule update --init",
    "npx playwright install --with-deps",
  ])("setup: %s", (command) => {
    expect(classifyStep(command)).toBe("setup");
  });

  it.each([
    "npm test",
    "npm run lint",
    "npm run build",
    "npx tsc --noEmit",
    "yarn test",
    "npm ci && npm test", // any check wins: never hide the real work
    "set -e\necho starting",
    "",
  ])("run: %s", (command) => {
    expect(classifyStep(command)).toBe("run");
  });
});

describe("parseStepPairs", () => {
  it("reads compact [command, durationMs] pairs", () => {
    expect(parseStepPairs('[["npm ci",12000],["npm test",30000]]')).toEqual([
      { command: "npm ci", durationMs: 12000 },
      { command: "npm test", durationMs: 30000 },
    ]);
  });

  it("treats missing, malformed and empty step data as unknown", () => {
    expect(parseStepPairs(null)).toBeNull();
    expect(parseStepPairs("")).toBeNull();
    expect(parseStepPairs("{not json")).toBeNull();
    expect(parseStepPairs('{"a":1}')).toBeNull();
    // A timed-out job records steps: [] — "all overhead" would be a lie.
    expect(parseStepPairs("[]")).toBeNull();
  });

  it("skips malformed pairs and floors negative durations", () => {
    expect(parseStepPairs('[[null,5],["x","5"],["ok",-3],["y",4]]')).toEqual([
      { command: "ok", durationMs: 0 },
      { command: "y", durationMs: 4 },
    ]);
  });
});

describe("splitJobPhases", () => {
  const classify = (command: string): StepPhase => (command.startsWith("install") ? "setup" : "run");

  it("attributes time outside every step to overhead", () => {
    const steps = [
      { command: "install deps", durationMs: 20_000 },
      { command: "test", durationMs: 30_000 },
    ];
    expect(splitJobPhases(60_000, steps, classify)).toEqual({ overheadMs: 10_000, setupMs: 20_000, runMs: 30_000 });
  });

  it("floors overhead at zero when executor clocks overshoot the wall time", () => {
    expect(splitJobPhases(1_000, [{ command: "test", durationMs: 1_200 }], classify)).toEqual({
      overheadMs: 0,
      setupMs: 0,
      runMs: 1_200,
    });
  });
});

describe("bottleneckHint", () => {
  const quiet: PhaseSummary = {
    queueP50Ms: 1_000,
    overheadP50Ms: 3_000,
    setupP50Ms: 5_000,
    runP50Ms: 40_000,
    cacheHitRate: 1,
    cacheSamples: 20,
  };

  it("stays silent when the checks dominate", () => {
    expect(bottleneckHint(quiet)).toBeNull();
  });

  it("names the machine wait first: it multiplies every other phase", () => {
    const hint = bottleneckHint({ ...quiet, queueP50Ms: 600_000, cacheHitRate: 0.1 });
    expect(hint).toMatch(/^waits 600s for a machine/);
  });

  it("flags a cold cache only with enough samples", () => {
    expect(bottleneckHint({ ...quiet, cacheHitRate: 0.5 })).toMatch(/^cache misses 50% of runs/);
    expect(bottleneckHint({ ...quiet, cacheHitRate: 0, cacheSamples: 2 })).toBeNull();
  });

  it("flags setup, then overhead, once they outweigh the checks", () => {
    expect(bottleneckHint({ ...quiet, setupP50Ms: 60_000 })).toMatch(/^installs take 60s, more than the checks \(40s\)/);
    expect(bottleneckHint({ ...quiet, overheadP50Ms: 50_000 })).toMatch(/^checkout, cache transfer and services take 50s/);
    // Below the floor: a 3s install on a 2s lint is not worth a sentence.
    expect(bottleneckHint({ ...quiet, setupP50Ms: 3_000, runP50Ms: 2_000 })).toBeNull();
  });
});

// The phase query leans on SQLite JSON1 (json_valid / json_each /
// json_group_array), which D1 shares; run it for real so a malformed
// legacy row can never fail the whole report.
function jobsDb(): { db: Db; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const sql of SCHEMA_STATEMENTS) {
    if (/TABLE IF NOT EXISTS (runs|jobs) \(/.test(sql)) raw.exec(sql);
  }
  const db: Db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) ?? null) as T | null,
            run: async () => ({ meta: { changes: Number(raw.prepare(query).run(...params).changes ?? 0) } }),
          };
        },
      };
    },
  };
  return { db, raw };
}

describe("bottleneckStats phase query", () => {
  it("splits time and counts cache outcomes from result JSON without shipping step output", async () => {
    const { db, raw } = jobsDb();
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now - 3_600_000 + offsetMs).toISOString();
    raw
      .prepare("INSERT INTO runs (id, repo, sha, event, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("r1", "o/r", "abc", "push", iso(0), iso(0));
    const insertJob = raw.prepare(
      "INSERT INTO jobs (id, run_id, status, name, result, started_at, finished_at, created_at, updated_at) VALUES (?, 'r1', ?, ?, ?, ?, ?, ?, ?)",
    );
    const job = (id: string, name: string, result: string, offsetMs: number) =>
      insertJob.run(id, "success", name, result, iso(offsetMs + 2_000), iso(offsetMs + 62_000), iso(offsetMs), iso(offsetMs));
    const steps = (cache: string | null) =>
      JSON.stringify({
        steps: [
          { command: "npm ci", exitCode: 0, durationMs: 20_000, output: "x".repeat(5000) },
          { command: "npm test", exitCode: 0, durationMs: 30_000, output: "ok" },
          "not-an-object",
        ],
        cacheHit: cache === "hit",
        ...(cache ? { cache } : {}),
      });
    job("j1", "test (shard=1/2)", steps("hit"), 0);
    job("j2", "test (shard=2/2)", steps("miss"), 1_000);
    job("j3", "test (shard=1/2)", "{not json", 2_000); // malformed legacy row
    job("j4", "test (shard=2/2)", "", 3_000); // never reported a result
    job("j5", "lint", steps(null), 4_000); // no cache declared

    const out = await bottleneckStats(db, "o/r");
    const test = out.find((r) => r.check === "test");
    expect(test).toMatchObject({
      jobs: 4,
      queueP50Ms: 2_000,
      // 60s executed − 50s of steps, from the two jobs with step data.
      overheadP50Ms: 10_000,
      setupP50Ms: 20_000,
      runP50Ms: 30_000,
      cacheHitRate: 0.5,
      cacheSamples: 2,
    });
    const lint = out.find((r) => r.check === "lint");
    expect(lint).toMatchObject({ cacheHitRate: null, cacheSamples: 0, overheadP50Ms: 10_000 });
  });

  it("returns timing-only rows when no job recorded steps", async () => {
    const { db, raw } = jobsDb();
    const iso = new Date(Date.now() - 60_000).toISOString();
    raw
      .prepare("INSERT INTO runs (id, repo, sha, event, created_at, updated_at) VALUES ('r1', 'o/r', 'abc', 'push', ?, ?)")
      .run(iso, iso);
    raw
      .prepare(
        "INSERT INTO jobs (id, run_id, status, name, result, started_at, finished_at, created_at, updated_at) VALUES ('j1', 'r1', 'error', 'build', '', ?, ?, ?, ?)",
      )
      .run(iso, iso, iso, iso);
    const [build] = await bottleneckStats(db, "o/r");
    expect(build).toMatchObject({ check: "build", overheadP50Ms: null, setupP50Ms: null, runP50Ms: null, hint: null });
  });
});
