import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { loadSetupFacts, setupSteps, SETUP_WAITING_MS, type SetupFacts } from "./setup";
import { sqliteDb } from "./testing/forge-fixture";

function facts(over: Partial<SetupFacts> = {}): SetupFacts {
  return {
    githubConnected: false,
    repos: null,
    webhookSeen: false,
    runs: 0,
    passed: 0,
    latest: null,
    queuedForMs: null,
    executorSeen: false,
    ...over,
  };
}

describe("setupSteps", () => {
  it("starts with only the account done and points at GitHub", () => {
    const s = setupSteps(facts());
    expect(s.done).toBe(1);
    expect(s.total).toBe(5);
    expect(s.next).toBe("github");
    expect(s.complete).toBe(false);
  });

  it("counts installed repos, then the first run, then the first green", () => {
    expect(setupSteps(facts({ githubConnected: true, repos: [] })).next).toBe("repos");
    const installed = setupSteps(facts({ githubConnected: true, repos: [{ fullName: "o/r", defaultBranch: "main", private: false }] }));
    expect(installed.next).toBe("first_run");
    expect(setupSteps(facts({ githubConnected: true, runs: 2 })).next).toBe("green");
    const green = setupSteps(facts({ githubConnected: true, runs: 2, passed: 1 }));
    expect(green.complete).toBe(true);
    expect(green.next).toBeNull();
  });

  it("treats a later step as proof of the earlier ones (env-managed App, no D1 creds)", () => {
    const s = setupSteps(facts({ githubConnected: false, runs: 3, passed: 3 }));
    expect(s.complete).toBe(true);
    expect(s.steps.every((x) => x.done)).toBe(true);
  });

  it("flags jobs stuck waiting for a machine only past the threshold", () => {
    expect(setupSteps(facts({ queuedForMs: SETUP_WAITING_MS - 1 })).waitingForComputer).toBe(false);
    expect(setupSteps(facts({ queuedForMs: SETUP_WAITING_MS })).waitingForComputer).toBe(true);
    expect(setupSteps(facts()).waitingForComputer).toBe(false);
  });
});

async function seedRun(db: Db, id: string, repo: string, status: string, createdAt: string, job?: { status: string; started?: string }) {
  await db
    .prepare("INSERT INTO runs (id, repo, sha, event, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, repo, "a".repeat(40), "push", "main", status, createdAt, createdAt)
    .run();
  if (job) {
    await db
      .prepare("INSERT INTO jobs (id, run_id, status, name, definition, created_at, updated_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(`${id}-j`, id, job.status, "test", "{}", createdAt, createdAt, job.started ?? null)
      .run();
  }
}

describe("loadSetupFacts", () => {
  const NOW = Date.parse("2026-10-10T12:00:00.000Z");

  it("reads counts, the latest run, queue age and executor presence", async () => {
    const db = sqliteDb();
    await seedRun(db, "r1", "o/a", "success", "2026-10-10T10:00:00.000Z", { status: "success", started: "2026-10-10T10:00:05.000Z" });
    await seedRun(db, "r2", "o/a", "queued", "2026-10-10T11:58:00.000Z", { status: "queued" });
    let asked = 0;
    const f = await loadSetupFacts(db, {
      githubConnected: true,
      allowedRepos: [],
      appRepos: async () => {
        asked += 1;
        return [{ fullName: "o/a", defaultBranch: "main", private: false }];
      },
      now: NOW,
    });
    expect(asked).toBe(1);
    expect(f.runs).toBe(2);
    expect(f.passed).toBe(1);
    expect(f.latest?.id).toBe("r2");
    expect(f.queuedForMs).toBe(120_000);
    expect(f.executorSeen).toBe(true);
    expect(setupSteps(f).waitingForComputer).toBe(true);
  });

  it("scopes runs and repos to a token's allowlist and skips GitHub when not connected", async () => {
    const db = sqliteDb();
    await seedRun(db, "r1", "o/a", "success", "2026-10-10T10:00:00.000Z");
    await seedRun(db, "r2", "x/b", "failure", "2026-10-10T11:00:00.000Z");
    const scoped = await loadSetupFacts(db, {
      githubConnected: true,
      allowedRepos: ["o/a"],
      appRepos: async () => [
        { fullName: "o/a", defaultBranch: "main", private: false },
        { fullName: "x/b", defaultBranch: "dev", private: true },
      ],
      now: NOW,
    });
    expect(scoped.runs).toBe(1);
    expect(scoped.latest?.repo).toBe("o/a");
    expect(scoped.repos?.map((r) => r.fullName)).toEqual(["o/a"]);
    let asked = false;
    const offline = await loadSetupFacts(db, {
      githubConnected: false,
      allowedRepos: [],
      appRepos: async () => {
        asked = true;
        return [];
      },
      now: NOW,
    });
    expect(asked).toBe(false);
    expect(offline.repos).toBeNull();
    expect(offline.queuedForMs).toBeNull();
  });

  it("degrades a failing GitHub lookup to unknown repos", async () => {
    const f = await loadSetupFacts(sqliteDb(), {
      githubConnected: true,
      allowedRepos: [],
      appRepos: async () => {
        throw new Error("github down");
      },
      now: NOW,
    });
    expect(f.repos).toBeNull();
  });
});
