import { describe, expect, it } from "vitest";
import type { Db, JobRow } from "./db";
import {
  claimAdminMarker,
  claimNextJob,
  claimWebhookDelivery,
  isAdminMarkerClaimed,
  pruneWebhookDeliveries,
  releaseAdminMarker,
  updateRunningJob,
} from "./db";

function jobRow(over: Partial<JobRow> = {}): JobRow & { repo: string; sha: string } {
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
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:00:00.000Z",
    repo: "o/r",
    sha: "abc123",
    ...over,
  };
}

// Routes only the SQL claimNextJob issues, against an in-memory queue.
class QueueDb implements Db {
  constructor(public jobs: (JobRow & { repo: string; sha: string })[]) {}

  // Ids whose conditional claim loses (poller race simulation).
  raced = new Set<string>();
  selects = 0;

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          if (norm.startsWith("SELECT j.*, r.repo, r.sha, r.source FROM jobs")) {
            this.selects += 1;
            return { results: this.select(norm, values) as T[] };
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
    if (norm.includes("j.priority < ?")) {
      const [priority, , created, , id] = values as [number, number, string, string, string];
      rows = rows.filter(
        (j) =>
          (j.priority ?? 0) < priority ||
          ((j.priority ?? 0) === priority && (j.created_at > created || (j.created_at === created && j.id > id))),
      );
    }
    rows = rows
      .slice()
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
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

  it("stays bounded on a large backlog of mismatched jobs", async () => {
    const db = new QueueDb(queue(400, () => ({ labels: "gpu" })));
    expect(await claimNextJob(db, ["linux"])).toBeNull();
    // 200-scan budget at 25 per page: 8 selects, not the whole backlog.
    expect(db.selects).toBeLessThanOrEqual(8);
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
