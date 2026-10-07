import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateDurationMonitors,
  evaluateResultMonitors,
  jobNameMatches,
  monitorMuted,
  monitorScopeMatches,
  muteUntilIso,
  validateMonitorInput,
} from "./monitors";
import type { Db, JobRow, MonitorRow, RunRow } from "./db";
import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  listMonitors,
  recordMonitorFire,
  setMonitorEnabled,
  setMonitorMutedUntil,
} from "./db";
import { encryptSettingValue, resolveSecretsKey } from "./secrets";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENV_KEY = Buffer.from("x".repeat(32)).toString("base64");
const mail = { SECRETS_KEY: ENV_KEY };

const run: RunRow = {
  id: "run-1",
  repo: "owner/repo",
  sha: "abcdef1234567890",
  event: "push",
  installation_id: null,
  branch: "main",
  source: null,
  pipeline_source: "",
  changed_files: "",
  pr_number: null,
  pr_comment_id: null,
  heal_branch: null,
  heal_pr_url: null,
  status: "failure",
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-01T09:02:30.000Z",
};

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "failure",
    log: "boom",
    name: "test",
    definition: "",
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: "2026-10-01T09:00:00.000Z",
    finished_at: "2026-10-01T09:02:00.000Z",
    retained_until: null,
    prior_ms: 0,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:02:00.000Z",
    ...over,
  };
}

function monitor(over: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: "mon-1",
    name: "",
    repo: "owner/repo",
    branch: "",
    job: "",
    trigger: "result",
    result: "failure",
    consecutive: 1,
    duration_seconds: 0,
    log_pattern: "",
    webhook_url: "",
    enabled: 1,
    muted_until: null,
    streak: 0,
    last_fired_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

class MemDb implements Db {
  settings = new Map<string, string>();
  monitors = new Map<string, MonitorRow>();
  fires = new Set<string>();
  jobs: { id: string; run_id: string; name: string; repo: string; branch: string; status: string; started_at: string | null }[] = [];
  audits: { actor: string; action: string; target: string }[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT * FROM monitors ORDER BY")) {
            return { results: [...this.monitors.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1)) as T[] };
          }
          if (norm.startsWith("SELECT j.id, j.run_id, j.name, r.repo")) {
            const [repo, cutoff, limit] = values as [string, string, number];
            const rows = this.jobs
              .filter((j) => j.repo === repo && j.status === "running" && j.started_at !== null && (j.started_at as string) < cutoff)
              .sort((a, b) => ((a.started_at as string) < (b.started_at as string) ? -1 : 1))
              .slice(0, limit);
            return { results: rows as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (norm.startsWith("SELECT * FROM monitors WHERE id")) {
            return (this.monitors.get(values[0] as string) ?? null) as T | null;
          }
          if (norm.startsWith("SELECT monitor_id FROM monitor_fires")) {
            const hit = this.fires.has(`${values[0]}:${values[1]}`);
            return (hit ? { monitor_id: values[0] } : null) as T | null;
          }
          if (norm.startsWith("SELECT value FROM app_settings")) {
            const v = this.settings.get(values[0] as string);
            return (v === undefined ? null : { value: v }) as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO monitors")) {
            const [id, name, repo, branch, jobPat, trigger, result, consecutive, durationSeconds, logPattern, webhookUrl, , , , , createdAt] =
              values as [string, string, string, string, string, string, string, number, number, string, string, number, null, number, null, string];
            this.monitors.set(id, {
              id, name, repo, branch, job: jobPat, trigger, result, consecutive,
              duration_seconds: durationSeconds, log_pattern: logPattern, webhook_url: webhookUrl,
              enabled: 1, muted_until: null, streak: 0, last_fired_at: null, created_at: createdAt,
            });
            return {};
          }
          if (norm.startsWith("DELETE FROM monitor_fires WHERE monitor_id")) {
            for (const k of [...this.fires]) if (k.startsWith(`${values[0]}:`)) this.fires.delete(k);
            return { meta: { changes: 0 } };
          }
          if (norm.startsWith("DELETE FROM monitor_fires WHERE fired_at")) {
            return { meta: { changes: 0 } };
          }
          if (norm.startsWith("DELETE FROM monitors")) {
            return { meta: { changes: this.monitors.delete(values[0] as string) ? 1 : 0 } };
          }
          if (norm.startsWith("UPDATE monitors SET enabled")) {
            const m = this.monitors.get(values[1] as string);
            if (m) m.enabled = values[0] as number;
            return { meta: { changes: m ? 1 : 0 } };
          }
          if (norm.startsWith("UPDATE monitors SET muted_until")) {
            const m = this.monitors.get(values[1] as string);
            if (m) m.muted_until = values[0] as string | null;
            return { meta: { changes: m ? 1 : 0 } };
          }
          if (norm.startsWith("UPDATE monitors SET streak")) {
            const m = this.monitors.get(values[1] as string);
            if (m) m.streak = values[0] as number;
            return {};
          }
          if (norm.startsWith("UPDATE monitors SET last_fired_at")) {
            const m = this.monitors.get(values[1] as string);
            if (m) {
              m.last_fired_at = values[0] as string;
              m.streak = 0;
            }
            return {};
          }
          if (norm.startsWith("INSERT INTO monitor_fires")) {
            this.fires.add(`${values[0]}:${values[1]}`);
            return {};
          }
          if (norm.startsWith("INSERT INTO audit_log")) {
            this.audits.push({ actor: values[1] as string, action: values[2] as string, target: values[3] as string });
            return {};
          }
          if (norm.startsWith("INSERT INTO app_settings")) {
            this.settings.set(values[0] as string, values[1] as string);
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

async function encryptedWebhook(db: Db, url: string): Promise<string> {
  const key = await resolveSecretsKey(db, ENV_KEY);
  return encryptSettingValue(key, url);
}

function stubWebhookFetch(posts: { url: string; body: string }[], ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      posts.push({ url, body: String(init.body ?? "") });
      return new Response("{}", { status: ok ? 200 : 500 });
    }),
  );
}

describe("validateMonitorInput", () => {
  const base = { repo: "owner/repo", trigger: "result", result: "failure" };

  it("accepts a result monitor with defaults", () => {
    expect(validateMonitorInput({ ...base })).toEqual({
      name: "",
      repo: "owner/repo",
      branch: "",
      job: "",
      trigger: "result",
      result: "failure",
      consecutive: 1,
      durationSeconds: 0,
      logPattern: "",
      webhookUrl: "",
    });
  });

  it("accepts a duration monitor with scope", () => {
    const out = validateMonitorInput({ ...base, trigger: "duration", durationSeconds: 600, branch: "main", job: "test*" });
    expect(out).toMatchObject({ trigger: "duration", result: "", durationSeconds: 600, branch: "main", job: "test*" });
  });

  it("rejects bad repo, trigger, result, and ranges", () => {
    expect(validateMonitorInput({ ...base, repo: "nope" })).toEqual({ error: "repo must be owner/name" });
    expect(validateMonitorInput({ ...base, trigger: "bogus" })).toEqual({ error: "trigger must be result or duration" });
    expect(validateMonitorInput({ ...base, result: "running" })).toEqual({
      error: "result must be one of failure, error, cancelled, skipped, success",
    });
    expect(validateMonitorInput({ ...base, consecutive: 0 })).toEqual({ error: "consecutive must be an integer 1-100" });
    expect(validateMonitorInput({ ...base, consecutive: 101 })).toEqual({ error: "consecutive must be an integer 1-100" });
    expect(validateMonitorInput({ ...base, durationSeconds: 90000 })).toEqual({
      error: "durationSeconds must be an integer 0-86400",
    });
    expect(validateMonitorInput({ ...base, trigger: "duration", durationSeconds: 30 })).toEqual({
      error: "duration monitors need durationSeconds >= 60",
    });
    expect(validateMonitorInput({ ...base, name: "x".repeat(81) })).toEqual({
      error: "name must be a string (max 80 chars)",
    });
    expect(validateMonitorInput({ ...base, logPattern: "x".repeat(201) })).toEqual({
      error: "logPattern must be a string (max 200 chars)",
    });
  });

  it("rejects non-https webhook URLs", () => {
    const out = validateMonitorInput({ ...base, webhookUrl: "http://hooks.example.com/x" });
    expect("error" in (out as object)).toBe(true);
  });
});

describe("jobNameMatches", () => {
  it("matches exact, glob, and empty patterns", () => {
    expect(jobNameMatches("", "anything")).toBe(true);
    expect(jobNameMatches("test", "test")).toBe(true);
    expect(jobNameMatches("test", "test2")).toBe(false);
    expect(jobNameMatches("test*", "test-linux")).toBe(true);
    expect(jobNameMatches("test*", "contest")).toBe(false);
    expect(jobNameMatches("t?st", "test")).toBe(true);
    expect(jobNameMatches("build (x)", "build (x)")).toBe(true);
  });
});

describe("monitorScopeMatches / monitorMuted", () => {
  it("scopes on repo, branch, and job glob", () => {
    const m = monitor({ branch: "main", job: "test*" });
    expect(monitorScopeMatches(m, "owner/repo", "main", "test-linux")).toBe(true);
    expect(monitorScopeMatches(m, "owner/other", "main", "test-linux")).toBe(false);
    expect(monitorScopeMatches(m, "owner/repo", "dev", "test-linux")).toBe(false);
    expect(monitorScopeMatches(m, "owner/repo", "main", "build")).toBe(false);
  });

  it("treats muted_until as a mute window", () => {
    expect(monitorMuted(monitor())).toBe(false);
    expect(monitorMuted(monitor({ muted_until: new Date(Date.now() + 60000).toISOString() }))).toBe(true);
    expect(monitorMuted(monitor({ muted_until: new Date(Date.now() - 60000).toISOString() }))).toBe(false);
  });
});

describe("muteUntilIso", () => {
  it("computes mute windows and clears on zero", () => {
    const iso = muteUntilIso(30);
    expect(iso).toBeTruthy();
    expect(Date.parse(iso as string)).toBeGreaterThan(Date.now());
    expect(muteUntilIso(0)).toBeNull();
    expect(muteUntilIso(null)).toBeNull();
  });
});

describe("monitor db helpers", () => {
  it("creates, lists, gets, disables, mutes, and deletes", async () => {
    const db = new MemDb();
    await createMonitor(db, {
      id: "m1", name: "n", repo: "owner/repo", branch: "", job: "",
      trigger: "result", result: "failure", consecutive: 2, durationSeconds: 0, logPattern: "", webhookUrl: "",
    });
    expect((await listMonitors(db)).map((m) => m.id)).toEqual(["m1"]);
    expect((await getMonitor(db, "m1"))?.consecutive).toBe(2);
    expect(await setMonitorEnabled(db, "m1", false)).toBe(true);
    expect((await getMonitor(db, "m1"))?.enabled).toBe(0);
    expect(await setMonitorMutedUntil(db, "m1", "2030-01-01T00:00:00.000Z")).toBe(true);
    expect((await getMonitor(db, "m1"))?.muted_until).toBe("2030-01-01T00:00:00.000Z");
    expect(await setMonitorEnabled(db, "missing", true)).toBe(false);
    db.fires.add("m1:job-9");
    expect(await deleteMonitor(db, "m1")).toBe(true);
    expect(db.fires.size).toBe(0);
    expect(await deleteMonitor(db, "m1")).toBe(false);
  });

  it("records fires idempotently", async () => {
    const db = new MemDb();
    await recordMonitorFire(db, "m1", "job-1");
    await recordMonitorFire(db, "m1", "job-1");
    expect(db.fires.size).toBe(1);
  });
});

describe("evaluateResultMonitors", () => {
  async function seeded(over: Partial<MonitorRow> = {}) {
    const db = new MemDb();
    const m = monitor(over);
    db.monitors.set(m.id, m);
    return db;
  }

  it("fires on match and posts to the encrypted webhook", async () => {
    const db = await seeded();
    db.monitors.get("mon-1")!.webhook_url = await encryptedWebhook(db, "https://hooks.example.com/slack");
    const posts: { url: string; body: string }[] = [];
    stubWebhookFetch(posts);
    const fired = await evaluateResultMonitors(db, mail, run, job());
    expect(fired).toEqual(["mon-1"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://hooks.example.com/slack");
    expect(posts[0]?.body).toContain("test");
    expect(posts[0]?.body).toContain("failure");
    expect(db.monitors.get("mon-1")?.streak).toBe(0);
    expect(db.monitors.get("mon-1")?.last_fired_at).toBeTruthy();
    expect(db.audits).toEqual([{ actor: "monitor", action: "monitor.fired", target: "mon-1 job-1" }]);
  });

  it("counts streaks and fires once per streak", async () => {
    const db = await seeded({ consecutive: 3 });
    db.monitors.get("mon-1")!.webhook_url = await encryptedWebhook(db, "https://hooks.example.com/slack");
    const posts: { url: string; body: string }[] = [];
    stubWebhookFetch(posts);
    expect(await evaluateResultMonitors(db, mail, run, job())).toEqual([]);
    expect(await evaluateResultMonitors(db, mail, run, job({ id: "job-2" }))).toEqual([]);
    expect(db.monitors.get("mon-1")?.streak).toBe(2);
    expect(await evaluateResultMonitors(db, mail, run, job({ id: "job-3" }))).toEqual(["mon-1"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toContain("streak 3");
  });

  it("resets the streak on non-matching terminal jobs in scope", async () => {
    const db = await seeded({ consecutive: 2 });
    db.monitors.get("mon-1")!.webhook_url = await encryptedWebhook(db, "https://hooks.example.com/slack");
    stubWebhookFetch([]);
    await evaluateResultMonitors(db, mail, run, job());
    expect(db.monitors.get("mon-1")?.streak).toBe(1);
    await evaluateResultMonitors(db, mail, run, job({ id: "job-2", status: "success", log: "ok" }));
    expect(db.monitors.get("mon-1")?.streak).toBe(0);
  });

  it("filters on log pattern, branch, and job glob", async () => {
    const db = await seeded({ log_pattern: "OOM", branch: "main", job: "test*" });
    db.monitors.get("mon-1")!.webhook_url = await encryptedWebhook(db, "https://hooks.example.com/slack");
    const posts: { url: string; body: string }[] = [];
    stubWebhookFetch(posts);
    expect(await evaluateResultMonitors(db, mail, run, job({ log: "plain failure" }))).toEqual([]);
    expect(await evaluateResultMonitors(db, mail, run, job({ log: "killed: oom killer", name: "build" }))).toEqual([]);
    expect(await evaluateResultMonitors(db, mail, { ...run, branch: "dev" }, job({ log: "oom" }))).toEqual([]);
    expect(await evaluateResultMonitors(db, mail, run, job({ log: "exit: OOM" }))).toEqual(["mon-1"]);
    expect(posts).toHaveLength(1);
  });

  it("skips disabled and muted monitors without touching the streak", async () => {
    const db = await seeded({ consecutive: 1 });
    db.monitors.set("mon-2", monitor({ id: "mon-2", enabled: 0, streak: 5 }));
    db.monitors.set("mon-3", monitor({ id: "mon-3", streak: 5, muted_until: new Date(Date.now() + 60000).toISOString() }));
    db.monitors.get("mon-1")!.webhook_url = await encryptedWebhook(db, "https://hooks.example.com/slack");
    stubWebhookFetch([]);
    const fired = await evaluateResultMonitors(db, mail, run, job());
    expect(fired).toEqual(["mon-1"]);
    expect(db.monitors.get("mon-2")?.streak).toBe(5);
    // Muted monitors still reset the streak (the streak fired) but do not post.
    expect(db.monitors.get("mon-3")?.streak).toBe(0);
  });

  it("falls back to the global webhook and degrades without any webhook", async () => {
    const db = await seeded();
    const posts: { url: string; body: string }[] = [];
    stubWebhookFetch(posts);
    expect(await evaluateResultMonitors(db, mail, run, job())).toEqual([]);
    expect(posts).toHaveLength(0);
    expect(db.audits[0]?.action).toBe("monitor.skipped");
    db.settings.set("notify_webhook_url", await encryptedWebhook(db, "https://hooks.example.com/global"));
    expect(await evaluateResultMonitors(db, mail, run, job())).toEqual(["mon-1"]);
    expect(posts[0]?.url).toBe("https://hooks.example.com/global");
  });

  it("ignores duration monitors and out-of-scope repos", async () => {
    const db = await seeded({ trigger: "duration", result: "", duration_seconds: 300 });
    db.monitors.set("mon-2", monitor({ id: "mon-2", repo: "other/repo" }));
    stubWebhookFetch([]);
    expect(await evaluateResultMonitors(db, mail, run, job())).toEqual([]);
    expect(db.monitors.get("mon-1")?.streak).toBe(0);
  });
});

describe("evaluateDurationMonitors", () => {
  async function seeded(over: Partial<MonitorRow> = {}) {
    const db = new MemDb();
    const m = monitor({ trigger: "duration", result: "", duration_seconds: 300, ...over });
    db.monitors.set(m.id, m);
    db.monitors.get(m.id)!.webhook_url = await encryptedWebhook(db, "https://hooks.example.com/slack");
    return db;
  }

  function running(id: string, startedAgoMs: number, over: Partial<MemDb["jobs"][number]> = {}) {
    return {
      id, run_id: "run-1", name: "test", repo: "owner/repo", branch: "main",
      status: "running", started_at: new Date(Date.now() - startedAgoMs).toISOString(), ...over,
    };
  }

  it("fires once per job and lists every over-threshold job", async () => {
    const db = await seeded();
    db.jobs = [running("job-1", 20 * 60000), running("job-2", 10 * 60000), running("job-3", 60000)];
    const posts: { url: string; body: string }[] = [];
    stubWebhookFetch(posts);
    expect(await evaluateDurationMonitors(db, mail)).toEqual(["mon-1"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toContain("2 job(s)");
    expect(posts[0]?.body).toContain("running 20m+");
    // Second pass: already-fired jobs are skipped, nothing new.
    expect(await evaluateDurationMonitors(db, mail)).toEqual([]);
    expect(posts).toHaveLength(1);
  });

  it("respects branch and job scoping", async () => {
    const db = await seeded({ branch: "main", job: "test*" });
    db.jobs = [
      running("job-1", 20 * 60000, { branch: "dev" }),
      running("job-2", 20 * 60000, { name: "build" }),
    ];
    stubWebhookFetch([]);
    expect(await evaluateDurationMonitors(db, mail)).toEqual([]);
    db.jobs.push(running("job-3", 20 * 60000, { name: "test-linux" }));
    const posts: { url: string; body: string }[] = [];
    stubWebhookFetch(posts);
    expect(await evaluateDurationMonitors(db, mail)).toEqual(["mon-1"]);
    expect(posts).toHaveLength(1);
  });

  it("skips muted and disabled monitors", async () => {
    const db = await seeded({ enabled: 0 });
    db.jobs = [running("job-1", 20 * 60000)];
    stubWebhookFetch([]);
    expect(await evaluateDurationMonitors(db, mail)).toEqual([]);
    db.monitors.get("mon-1")!.enabled = 1;
    db.monitors.get("mon-1")!.muted_until = new Date(Date.now() + 60000).toISOString();
    expect(await evaluateDurationMonitors(db, mail)).toEqual([]);
  });
});
