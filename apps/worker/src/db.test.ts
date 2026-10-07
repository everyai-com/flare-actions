import { describe, expect, it } from "vitest";
import type { Db, JobRow } from "./db";
import {
  cancelQueuedJobs,
  claimAdminMarker,
  claimNextJob,
  claimWebhookDelivery,
  isAdminMarkerClaimed,
  pruneWebhookDeliveries,
  releaseAdminMarker,
  summarizeBottlenecks,
  updateRunningJob,
  usageStats,
} from "./db";

function jobRow(
  over: Partial<JobRow & { repo: string; sha: string; event: string }> = {},
): JobRow & { repo: string; sha: string; event: string } {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "queued",
    log: "",
    name: "verify",
    definition: "",
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: null,
    finished_at: null,
    retained_until: null,
    prior_ms: 0,
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:00:00.000Z",
    repo: "o/r",
    sha: "abc123",
    event: "push",
    ...over,
  };
}

// Routes only the SQL claimNextJob issues, against an in-memory queue.
class QueueDb implements Db {
  constructor(public jobs: (JobRow & { repo: string; sha: string; event: string })[]) {}

  // Ids whose conditional claim loses (poller race simulation).
  raced = new Set<string>();
  selects = 0;

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          if (norm.startsWith("SELECT j.*, r.repo, r.sha, r.source, r.branch, r.changed_files FROM jobs")) {
            this.selects += 1;
            return { results: this.select(norm, values) as T[] };
          }
          if (norm.startsWith("SELECT r.repo AS repo, COUNT(*)")) {
            const counts = new Map<string, number>();
            for (const j of this.jobs) {
              if (j.status === "running") counts.set(j.repo, (counts.get(j.repo) ?? 0) + 1);
            }
            return { results: [...counts].map(([repo, c]) => ({ repo, c })) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("UPDATE jobs SET status = 'running'")) {
            const id = values[2] as string;
            const job = this.jobs.find((j) => j.id === id);
            if (job && job.status === "queued" && !this.raced.has(id)) {
              job.status = "running";
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (norm.startsWith("UPDATE jobs SET status = 'cancelled'")) {
            let changes = 0;
            for (const j of this.jobs) {
              if (j.run_id === values[2] && (j.status === "queued" || j.status === "blocked")) {
                j.status = "cancelled";
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          if (norm.startsWith("UPDATE jobs SET status = ?, log = COALESCE")) {
            const job = this.jobs.find((j) => j.id === values[5]);
            if (!job || job.status !== "running") return { meta: { changes: 0 } };
            job.status = values[0] as string;
            if (values[1] !== null) job.log = values[1] as string;
            if (values[2] !== null) job.result = values[2] as string;
            if (job.finished_at == null && values[3] !== null) job.finished_at = values[3] as string;
            job.updated_at = values[4] as string;
            return { meta: { changes: 1 } };
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }

  private select(norm: string, values: unknown[]) {
    let rows = this.jobs.filter((j) => j.status === "queued");
    if (norm.includes("r.event !=")) rows = rows.filter((j) => (j.event ?? "push") !== "artifacts");
    const inMatch = /r\.repo IN \(([^)]*)\)/.exec(norm);
    const repoCount = inMatch ? ((inMatch[1].match(/\?/g) ?? []).length) : 0;
    if (repoCount > 0) {
      const repos = values.slice(0, repoCount) as string[];
      rows = rows.filter((j) => repos.includes(j.repo));
    }
    if (norm.includes("j.priority < ?")) {
      const [priority, , priorMs, , created, , id] = values.slice(repoCount) as [
        number, number, number, number, string, string, string,
      ];
      rows = rows.filter(
        (j) =>
          (j.priority ?? 0) < priority ||
          ((j.priority ?? 0) === priority &&
            ((j.prior_ms ?? 0) < priorMs ||
              ((j.prior_ms ?? 0) === priorMs &&
                (j.created_at > created || (j.created_at === created && j.id > id))))),
      );
    }
    rows = rows
      .slice()
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          (b.prior_ms ?? 0) - (a.prior_ms ?? 0) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      );
    const limit = Number(values[values.length - 1]);
    return rows.slice(0, limit).map((r) => ({ ...r }));
  }
}

function queue(count: number, over: (i: number) => Partial<JobRow & { repo: string; sha: string }>) {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(4, "0");
    const minute = String(Math.floor(i / 60)).padStart(2, "0");
    const second = String(i % 60).padStart(2, "0");
    return jobRow({
      id: `job-${n}`,
      labels: "gpu",
      created_at: `2026-10-02T10:${minute}:${second}.000Z`,
      ...over(i),
    });
  });
}

describe("claimNextJob", () => {
  it("claims a matching job queued behind more than one page of mismatched jobs", async () => {
    // 60 gpu-only jobs older than the one linux job: the old LIMIT 10
    // window could never see it and every runner starved.
    const db = new QueueDb([
      ...queue(60, () => ({ labels: "gpu" })),
      jobRow({
        id: "job-linux",
        labels: "linux",
        created_at: "2026-10-02T11:00:00.000Z",
      }),
    ]);
    const claimed = await claimNextJob(db, ["linux", "arm64"]);
    expect(claimed?.id).toBe("job-linux");
    expect(claimed?.status).toBe("running");
    expect(db.jobs.find((j) => j.id === "job-linux")?.status).toBe("running");
    expect(db.jobs.filter((j) => j.labels === "gpu").every((j) => j.status === "queued")).toBe(true);
  });

  it("returns null when no queued job matches, without claiming others", async () => {
    const db = new QueueDb(queue(5, () => ({ labels: "macos" })));
    expect(await claimNextJob(db, ["linux"])).toBeNull();
    expect(db.jobs.every((j) => j.status === "queued")).toBe(true);
  });

  it("treats label-less jobs as matching every runner", async () => {
    const db = new QueueDb([
      ...queue(30, () => ({ labels: "macos" })),
      jobRow({ id: "job-free", labels: "", created_at: "2026-10-02T11:00:00.000Z" }),
    ]);
    const claimed = await claimNextJob(db, ["windows"]);
    expect(claimed?.id).toBe("job-free");
  });

  it("moves past a job another poller wins and claims the next match", async () => {
    const db = new QueueDb([
      jobRow({ id: "job-a", labels: "linux", created_at: "2026-10-02T10:00:00.000Z" }),
      jobRow({ id: "job-b", labels: "linux", created_at: "2026-10-02T10:00:01.000Z" }),
    ]);
    db.raced.add("job-a");
    const claimed = await claimNextJob(db, ["linux"]);
    expect(claimed?.id).toBe("job-b");
  });

  it("scopes claims to the token's repos when set", async () => {
    const db = new QueueDb([
      jobRow({ id: "job-a", repo: "o/a", created_at: "2026-10-02T09:00:00.000Z" }),
      jobRow({ id: "job-b", repo: "o/b", created_at: "2026-10-02T08:00:00.000Z" }),
    ]);
    expect((await claimNextJob(db, [], ["o/a"]))?.id).toBe("job-a");
    expect((await claimNextJob(db, []))?.id).toBe("job-b");
  });

  it("never claims artifacts-event jobs (seats-only)", async () => {
    const db = new QueueDb([
      jobRow({ id: "job-art", event: "artifacts", created_at: "2026-10-02T08:00:00.000Z" }),
      jobRow({ id: "job-gh", event: "push", created_at: "2026-10-02T09:00:00.000Z" }),
    ]);
    expect((await claimNextJob(db, []))?.id).toBe("job-gh");
    expect(await claimNextJob(db, [])).toBeNull();
  });

  it("claims higher-priority jobs before older batch work", async () => {
    const db = new QueueDb([
      jobRow({ id: "job-old", created_at: "2026-10-02T09:00:00.000Z", priority: 0 }),
      jobRow({ id: "job-urgent", created_at: "2026-10-02T11:00:00.000Z", priority: 9 }),
    ]);
    expect((await claimNextJob(db, []))?.id).toBe("job-urgent");
  });

  it("stays oldest-first within the same priority", async () => {
    const db = new QueueDb([
      jobRow({ id: "job-new", created_at: "2026-10-02T11:00:00.000Z", priority: 0 }),
      jobRow({ id: "job-old", created_at: "2026-10-02T09:00:00.000Z", priority: 0 }),
    ]);
    expect((await claimNextJob(db, []))?.id).toBe("job-old");
  });

  it("claims longest-predicted-first within a priority (LPT drain order)", async () => {
    const db = new QueueDb([
      jobRow({ id: "job-old-short", created_at: "2026-10-02T09:00:00.000Z", priority: 0, prior_ms: 1000 }),
      jobRow({ id: "job-new-long", created_at: "2026-10-02T11:00:00.000Z", priority: 0, prior_ms: 60000 }),
      jobRow({ id: "job-unknown", created_at: "2026-10-02T08:00:00.000Z", priority: 0, prior_ms: 0 }),
    ]);
    expect((await claimNextJob(db, []))?.id).toBe("job-new-long");
    expect((await claimNextJob(db, []))?.id).toBe("job-old-short");
    expect((await claimNextJob(db, []))?.id).toBe("job-unknown");
  });

  it("keeps repo scoping aligned past the first keyset page", async () => {
    const db = new QueueDb([
      ...queue(30, (i) => ({ labels: "macos", repo: i % 2 === 0 ? "o/a" : "o/b" })),
      jobRow({ id: "job-free", labels: "", repo: "o/a", created_at: "2026-10-02T11:00:00.000Z" }),
    ]);
    // Page 2+ binds repos before the keyset; a misalignment would
    // compare repo against dates and return nothing.
    expect((await claimNextJob(db, ["windows"], ["o/a"]))?.id).toBe("job-free");
  });

  it("stays bounded on a large backlog of mismatched jobs", async () => {
    const db = new QueueDb(queue(400, () => ({ labels: "gpu" })));
    expect(await claimNextJob(db, ["linux"])).toBeNull();
    // 200-scan budget at 25 per page: 8 selects, not the whole backlog.
    expect(db.selects).toBeLessThanOrEqual(8);
  });

  it("skips repos at their fair-share running cap", async () => {
    const jobs = () => [
      jobRow({ id: "job-busy", repo: "o/a", status: "running", created_at: "2026-10-02T09:00:00.000Z" }),
      jobRow({ id: "job-a", repo: "o/a", created_at: "2026-10-02T09:30:00.000Z" }),
      jobRow({ id: "job-b", repo: "o/b", created_at: "2026-10-02T10:00:00.000Z" }),
    ];
    // Cap 1 with o/a already running: the older o/a job waits, o/b flows.
    expect((await claimNextJob(new QueueDb(jobs()), [], [], { fairSharePerRepo: 1 }))?.id).toBe("job-b");
    // Cap 0 (default) keeps strict oldest-first across repos.
    expect((await claimNextJob(new QueueDb(jobs()), [], []))?.id).toBe("job-a");
  });
});

describe("updateRunningJob", () => {
  it("reports the result of a running job and stamps finished_at", async () => {
    const db = new QueueDb([jobRow({ id: "job-1", status: "running" })]);
    expect(await updateRunningJob(db, "job-1", { status: "success", log: "done", result: "{}" })).toBe(true);
    const job = db.jobs[0];
    expect(job.status).toBe("success");
    expect(job.log).toBe("done");
    expect(job.result).toBe("{}");
    expect(job.finished_at).not.toBeNull();
  });

  it("drops a late report once the row moved on (rerun/stale requeue)", async () => {
    const db = new QueueDb([jobRow({ id: "job-1", status: "queued" })]);
    expect(await updateRunningJob(db, "job-1", { status: "failure", log: "stale" })).toBe(false);
    expect(db.jobs[0].status).toBe("queued");
    expect(db.jobs[0].log).toBe("");
  });

  it("keeps a non-terminal report from marking finished_at", async () => {
    const db = new QueueDb([jobRow({ id: "job-1", status: "running" })]);
    expect(await updateRunningJob(db, "job-1", { status: "running" })).toBe(true);
    expect(db.jobs[0].finished_at).toBeNull();
  });
});

// Routes the marker SQL against an in-memory settings map.
class SettingsDb implements Db {
  store = new Map<string, string>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: [] as T[] }),
        first: async <T,>(): Promise<T | null> => {
          if (norm.startsWith("SELECT key FROM app_settings")) {
            return (this.store.has(values[0] as string) ? { key: values[0] } : null) as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO app_settings") && norm.includes("DO NOTHING")) {
            const key = values[0] as string;
            if (this.store.has(key)) return { meta: { changes: 0 } };
            this.store.set(key, values[1] as string);
            return { meta: { changes: 1 } };
          }
          if (norm.startsWith("DELETE FROM app_settings WHERE key")) {
            this.store.delete(values[0] as string);
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("cancelQueuedJobs", () => {
  it("cancels queued/blocked jobs of one run, leaving running and other runs", async () => {
    const db = new QueueDb([
      jobRow({ id: "q", status: "queued" }),
      jobRow({ id: "b", status: "blocked" }),
      jobRow({ id: "r", status: "running" }),
      jobRow({ id: "other", run_id: "run-2", status: "queued" }),
    ]);
    expect(await cancelQueuedJobs(db, "run-1")).toBe(2);
    expect(db.jobs.find((j) => j.id === "q")?.status).toBe("cancelled");
    expect(db.jobs.find((j) => j.id === "b")?.status).toBe("cancelled");
    expect(db.jobs.find((j) => j.id === "r")?.status).toBe("running");
    expect(db.jobs.find((j) => j.id === "other")?.status).toBe("queued");
    expect(await cancelQueuedJobs(db, "run-1")).toBe(0);
  });
});

describe("claimAdminMarker", () => {
  it("lets exactly one claimer win", async () => {
    const db = new SettingsDb();
    expect(await claimAdminMarker(db)).toBe(true);
    expect(await claimAdminMarker(db)).toBe(false);
    expect(await isAdminMarkerClaimed(db)).toBe(true);
  });

  it("releases a failed claim so a fresh deploy stays claimable", async () => {
    const db = new SettingsDb();
    expect(await claimAdminMarker(db)).toBe(true);
    await releaseAdminMarker(db);
    expect(await isAdminMarkerClaimed(db)).toBe(false);
    expect(await claimAdminMarker(db)).toBe(true);
  });
});

// Routes the webhook-delivery SQL against an in-memory map (id ->
// created_at).
class DeliveriesDb implements Db {
  store = new Map<string, string>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: [] as T[] }),
        first: async <T,>(): Promise<T | null> => {
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO webhook_deliveries") && norm.includes("DO NOTHING")) {
            const id = values[0] as string;
            if (this.store.has(id)) return { meta: { changes: 0 } };
            this.store.set(id, values[1] as string);
            return { meta: { changes: 1 } };
          }
          if (norm.startsWith("DELETE FROM webhook_deliveries")) {
            const cutoff = values[0] as string;
            let changes = 0;
            for (const [id, created] of this.store) {
              if (created < cutoff) {
                this.store.delete(id);
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("claimWebhookDelivery", () => {
  it("acks the first delivery and ignores redeliveries", async () => {
    const db = new DeliveriesDb();
    expect(await claimWebhookDelivery(db, "delivery-1")).toBe(true);
    expect(await claimWebhookDelivery(db, "delivery-1")).toBe(false);
    expect(await claimWebhookDelivery(db, "delivery-2")).toBe(true);
  });

  it("prunes deliveries older than the window", async () => {
    const db = new DeliveriesDb();
    db.store.set("old", "2000-01-01T00:00:00.000Z");
    db.store.set("new", new Date().toISOString());
    expect(await pruneWebhookDeliveries(db, 24)).toBe(1);
    expect(db.store.has("old")).toBe(false);
    expect(db.store.has("new")).toBe(true);
  });
});

class UsageDb implements Db {
  constructor(
    public statuses: { status: string; n: number }[],
    public jobAgg: { n: number; secs: number },
    public top: { repo: string; n: number; secs: number }[],
  ) {}

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (..._values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT status, COUNT(*)")) return { results: this.statuses as T[] };
          if (norm.startsWith("SELECT r.repo AS repo")) return { results: this.top as T[] };
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (norm.startsWith("SELECT COUNT(*) AS n")) return this.jobAgg as T;
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("usageStats", () => {
  it("aggregates runs, jobs, minutes, and top repos", async () => {
    const db = new UsageDb(
      [
        { status: "success", n: 8 },
        { status: "failure", n: 2 },
      ],
      { n: 20, secs: 3600 },
      [
        { repo: "o/big", n: 15, secs: 3000 },
        { repo: "o/small", n: 5, secs: 600 },
      ],
    );
    const out = await usageStats(db, 30);
    expect(out).toEqual({
      days: 30,
      runs: 10,
      runsByStatus: { success: 8, failure: 2 },
      jobs: 20,
      computeMinutes: 60,
      actionsListUsd: 0.48,
      topRepos: [
        { repo: "o/big", jobs: 15, computeMinutes: 50 },
        { repo: "o/small", jobs: 5, computeMinutes: 10 },
      ],
    });
  });

  it("handles empty windows", async () => {
    const out = await usageStats(new UsageDb([], { n: 0, secs: 0 }, []), 7);
    expect(out.runs).toBe(0);
    expect(out.computeMinutes).toBe(0);
    expect(out.topRepos).toEqual([]);
  });
});

describe("summarizeBottlenecks", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const row = (
    name: string,
    status: string,
    created: number,
    started: number,
    finished: number,
  ): { name: string; status: string; created_at: string; started_at: string | null; finished_at: string | null } => ({
    name,
    status,
    created_at: at(created),
    started_at: at(started),
    finished_at: at(finished),
  });

  it("groups matrix/shard cells by base check and percentiles timings", () => {
    const rows = [
      row("test (node=18)", "success", 0, 10_000, 110_000), // 100s run, 10s queue
      row("test (node=20)", "success", 0, 20_000, 320_000), // 300s run, 20s queue
      row("test (shard=1/2)", "failure", 0, 30_000, 130_000), // 100s run, 30s queue
      row("test (shard=2/2)", "success", 0, 40_000, 240_000), // 200s run, 40s queue
      row("lint", "success", 0, 5_000, 15_000), // 10s run
      row("queued-only", "queued", 0, 0, 0), // no timings → ignored
    ];
    // Strip the pseudo-timestamps for the unstarted row.
    rows[5] = { name: "queued-only", status: "queued", created_at: at(0), started_at: null, finished_at: null };
    const out = summarizeBottlenecks(rows);
    expect(out.map((r) => r.check)).toEqual(["test", "lint"]);
    const test = out[0];
    expect(test.jobs).toBe(4);
    // Sorted durations [100k, 100k, 200k, 300k] → idx floor(0.5*3)=1, floor(0.95*3)=2.
    expect(test.p50Ms).toBe(100_000);
    expect(test.p95Ms).toBe(200_000);
    // Sorted queues [10k, 20k, 30k, 40k] → idx 1.
    expect(test.queueP50Ms).toBe(20_000);
    expect(test.failures).toBe(1);
    expect(out[1]).toMatchObject({ check: "lint", jobs: 1, p50Ms: 10_000, failures: 0 });
  });

  it("sorts by p95 and honors the limit", () => {
    const rows = [
      row("a", "success", 0, 0, 10_000),
      row("b", "success", 0, 0, 30_000),
      row("c", "success", 0, 0, 20_000),
    ];
    const out = summarizeBottlenecks(rows, 2);
    expect(out.map((r) => r.check)).toEqual(["b", "c"]);
  });
});
