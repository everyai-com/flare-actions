import { describe, expect, it } from "vitest";
import type { Db, JobRow, StaleJobRow } from "./db";
import { jobConditionSatisfied, maybeRetryJob, promoteBlockedJobs, requeueStaleJobs, triageAndStore } from "./finish";

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "running",
    log: "",
    name: "verify",
    definition: "",
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: "2026-10-02T10:00:00.000Z",
    finished_at: null,
    retained_until: null,
    prior_ms: 0,
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

class MemDb implements Db {
  stale: StaleJobRow[] = [];
  blocked: unknown[] = [];
  jobs = new Map<string, JobRow>();
  runStatus = new Map<string, string>();
  releaseChanges = 1;
  settings = new Map<string, string>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT j.id, j.run_id, j.name, r.repo, r.sha FROM jobs")) {
            return { results: this.stale as T[] };
          }
          if (norm.includes("status = 'blocked'")) {
            return { results: this.blocked as T[] };
          }
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: [...this.jobs.values()].filter((j) => j.run_id === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          if (norm.startsWith("SELECT * FROM jobs WHERE id")) {
            return (this.jobs.get(values[0] as string) ?? null) as unknown as T | null;
          }
          if (norm.startsWith("SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r")) {
            const job = this.jobs.get(values[0] as string);
            if (!job) return null;
            return { ...job, repo: "o/r", sha: "abc123" } as unknown as T;
          }
          if (norm.startsWith("SELECT value FROM app_settings WHERE key")) {
            const value = this.settings.get(values[0] as string);
            return (value !== undefined ? { value } : null) as unknown as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("UPDATE jobs SET log = COALESCE")) {
            const job = this.jobs.get(values[2] as string);
            if (job) job.log += values[0] as string;
            return {};
          }
          if (norm.startsWith("UPDATE jobs SET attempts")) {
            const job = this.jobs.get(values[1] as string);
            if (job) job.attempts = ((job.attempts as number) ?? 0) + 1;
            return {};
          }
          if (norm.startsWith("UPDATE jobs SET status = 'queued'")) {
            // The job id binds last; the billing variant binds the end time first.
            const job = this.jobs.get(values[values.length - 1] as string);
            if (job && job.status === "running" && this.releaseChanges > 0) {
              if (norm.includes("billed_ms = billed_ms +") && typeof job.started_at === "string") {
                job.billed_ms = ((job.billed_ms as number) ?? 0) + Math.max(0, Date.parse(values[0] as string) - Date.parse(job.started_at));
              }
              job.status = "queued";
              job.started_at = null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (norm.startsWith("UPDATE jobs SET status = ?, finished_at")) {
            const job = this.jobs.get(values[3] as string);
            if (job) job.status = values[0] as string;
            return {};
          }
          if (norm.startsWith("UPDATE runs SET status")) {
            this.runStatus.set(values[2] as string, values[0] as string);
            return {};
          }
          if (norm.startsWith("UPDATE jobs SET triage")) {
            const job = this.jobs.get(values[2] as string);
            if (job) job.triage = values[0] as string;
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("requeueStaleJobs", () => {
  const staleRow: StaleJobRow = {
    id: "job-1",
    run_id: "run-1",
    name: "verify",
    repo: "o/r",
    sha: "abc123",
  };

  it("releases, rolls up, and re-queues stale jobs", async () => {
    const db = new MemDb();
    db.stale = [staleRow];
    db.jobs.set("job-1", jobRow());
    const sent: unknown[] = [];
    const woken: unknown[] = [];
    const out = await requeueStaleJobs(
      db,
      { send: async (m) => void sent.push(m) },
      20,
      (j) => void woken.push(j),
    );
    expect(out).toEqual(["job-1"]);
    expect(db.jobs.get("job-1")?.status).toBe("queued");
    expect(db.jobs.get("job-1")?.log).toContain("no executor heartbeat");
    expect(db.runStatus.get("run-1")).toBe("queued");
    expect(sent).toEqual([{ runId: "run-1", jobId: "job-1", repo: "o/r", sha: "abc123" }]);
    expect(woken).toEqual([{ runId: "run-1", jobId: "job-1" }]);
  });

  it("does nothing when nothing is stale", async () => {
    const db = new MemDb();
    const sent: unknown[] = [];
    expect(await requeueStaleJobs(db, { send: async (m) => void sent.push(m) })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("skips the queue send when the release loses its race", async () => {
    const db = new MemDb();
    db.stale = [staleRow];
    db.jobs.set("job-1", jobRow({ status: "success" }));
    db.releaseChanges = 0;
    const sent: unknown[] = [];
    expect(await requeueStaleJobs(db, { send: async (m) => void sent.push(m) })).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("jobConditionSatisfied", () => {
  it("maps the bounded subset onto needs outcomes", () => {
    expect(jobConditionSatisfied(undefined, false)).toBe(true);
    expect(jobConditionSatisfied(undefined, true)).toBe(false);
    expect(jobConditionSatisfied("success()", true)).toBe(false);
    expect(jobConditionSatisfied("failure()", true)).toBe(true);
    expect(jobConditionSatisfied("failure()", false)).toBe(false);
    expect(jobConditionSatisfied("always()", true)).toBe(true);
    expect(jobConditionSatisfied("cancelled()", true)).toBe(false);
    expect(jobConditionSatisfied("!failure()", false)).toBe(true);
    expect(jobConditionSatisfied("!cancelled()", true)).toBe(true);
    expect(jobConditionSatisfied("github.x == 'y'", false)).toBe(false);
  });

  it("evaluates needs refs against the settled context", () => {
    const needs = { build: { result: "success", outputs: { tag: "v1" } } };
    expect(jobConditionSatisfied("needs.build.outputs.tag == 'v1'", false, needs)).toBe(true);
    expect(jobConditionSatisfied("needs.build.outputs.tag == 'zzz'", false, needs)).toBe(false);
    expect(jobConditionSatisfied("needs.build.result == 'success'", false, needs)).toBe(true);
    expect(jobConditionSatisfied("needs.missing.result == ''", false, needs)).toBe(true);
    expect(jobConditionSatisfied("needs.build.outputs.tag == 'v1'", false)).toBe(false);
  });
});

describe("promoteBlockedJobs", () => {
  function def(over: Record<string, unknown> = {}) {
    return JSON.stringify({ steps: [{ run: "x" }], base: "notify", needs: ["test"], ...over });
  }
  function blocked(definition: string, id = "job-2"): JobRow & { repo: string; sha: string } {
    return { ...jobRow({ id, name: "notify", status: "blocked", definition }), repo: "o/r", sha: "abc123" };
  }

  it("promotes needs-satisfied jobs", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow({ id: "job-1", name: "test", status: "success" }));
    const job = blocked(def(), "job-2");
    db.jobs.set("job-2", job);
    db.blocked = [job];
    const sent: unknown[] = [];
    const promoted = await promoteBlockedJobs(db, { send: async (m) => void sent.push(m) }, "o/r");
    expect(promoted).toEqual(["job-2"]);
    expect(db.jobs.get("job-2")?.status).toBe("queued");
    expect(sent).toEqual([{ runId: "run-1", jobId: "job-2", repo: "o/r", sha: "abc123" }]);
  });

  it("gates jobs on needs results and outputs", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow({ id: "job-1", name: "test", status: "success", result: JSON.stringify({ outputs: { tag: "v1" } }) }));
    const match = blocked(def({ if: "needs.test.outputs.tag == 'v1' && success()" }), "job-2");
    const mismatch = blocked(def({ if: "needs.test.outputs.tag == 'zzz'" }), "job-3");
    const noRef = blocked(def({ if: "needs.test.result == 'success'" }), "job-4");
    db.jobs.set("job-2", match);
    db.jobs.set("job-3", mismatch);
    db.jobs.set("job-4", noRef);
    db.blocked = [match, mismatch, noRef];
    const promoted = await promoteBlockedJobs(db, { send: async () => undefined }, "o/r");
    expect(promoted).toEqual(["job-2", "job-4"]);
    expect(db.jobs.get("job-2")?.status).toBe("queued");
    expect(db.jobs.get("job-3")?.status).toBe("skipped");
    expect(db.jobs.get("job-4")?.status).toBe("queued");
  });

  it("skips defaults after a failed need but runs failure()/always() jobs", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow({ id: "job-1", name: "test", status: "failure" }));
    const plain = blocked(def(), "job-2");
    const always = blocked(def({ if: "always()" }), "job-3");
    const onFail = blocked(def({ if: "failure()" }), "job-4");
    db.jobs.set("job-2", plain);
    db.jobs.set("job-3", always);
    db.jobs.set("job-4", onFail);
    db.blocked = [plain, always, onFail];
    const sent: unknown[] = [];
    const promoted = await promoteBlockedJobs(db, { send: async (m) => void sent.push(m) }, "o/r");
    expect(promoted).toEqual(["job-3", "job-4"]);
    expect(db.jobs.get("job-2")?.status).toBe("skipped");
    expect(db.jobs.get("job-3")?.status).toBe("queued");
    expect(db.jobs.get("job-4")?.status).toBe("queued");
    expect(sent).toHaveLength(2);
  });

  it("cascade-skips dependents of skipped needs without tripping failure()", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow({ id: "job-1", name: "test", status: "skipped" }));
    const plain = blocked(def(), "job-2");
    const onFail = blocked(def({ if: "failure()" }), "job-3");
    const always = blocked(def({ if: "always()" }), "job-4");
    db.jobs.set("job-2", plain);
    db.jobs.set("job-3", onFail);
    db.jobs.set("job-4", always);
    db.blocked = [plain, onFail, always];
    const promoted = await promoteBlockedJobs(db, { send: async () => undefined }, "o/r");
    expect(promoted).toEqual(["job-4"]);
    expect(db.jobs.get("job-2")?.status).toBe("skipped");
    expect(db.jobs.get("job-3")?.status).toBe("skipped");
    expect(db.jobs.get("job-4")?.status).toBe("queued");
  });

  it("routes cancelled needs to cancelled(), not failure()", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow({ id: "job-1", name: "test", status: "cancelled" }));
    const onFail = blocked(def({ if: "failure()" }), "job-2");
    const onCancel = blocked(def({ if: "cancelled()" }), "job-3");
    db.jobs.set("job-2", onFail);
    db.jobs.set("job-3", onCancel);
    db.blocked = [onFail, onCancel];
    const promoted = await promoteBlockedJobs(db, { send: async () => undefined }, "o/r");
    expect(promoted).toEqual(["job-3"]);
    expect(db.jobs.get("job-2")?.status).toBe("skipped");
    expect(db.jobs.get("job-3")?.status).toBe("queued");
  });

  it("skips failure() jobs after success and waits for pending needs", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow({ id: "job-1", name: "test", status: "success" }));
    const onFail = blocked(def({ if: "failure()" }), "job-2");
    const pending = blocked(JSON.stringify({ steps: [{ run: "x" }], base: "notify2", needs: ["other"] }), "job-3");
    db.jobs.set("job-2", onFail);
    db.jobs.set("job-3", pending);
    db.jobs.set("job-4", jobRow({ id: "job-4", name: "other", status: "running", definition: JSON.stringify({ base: "other" }) }));
    db.blocked = [onFail, pending];
    const promoted = await promoteBlockedJobs(db, { send: async () => undefined }, "o/r");
    expect(promoted).toEqual([]);
    expect(db.jobs.get("job-2")?.status).toBe("skipped");
    expect(db.jobs.get("job-3")?.status).toBe("blocked");
  });
});

describe("maybeRetryJob", () => {
  const retryDef = JSON.stringify({ steps: [{ run: "x" }], base: "t", retry: 1 });

  it("requeues a failed job while the retry budget remains", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow({ status: "running", definition: retryDef, attempts: 0 }));
    const sent: unknown[] = [];
    const woken: unknown[] = [];
    const retried = await maybeRetryJob(db, { send: async (m) => void sent.push(m) }, "job-1", (j) => void woken.push(j));
    expect(retried).toBe(true);
    const job = db.jobs.get("job-1") as JobRow;
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.log).toContain("retrying after failure (attempt 2/2)");
    expect(db.runStatus.get("run-1")).toBe("queued");
    expect(sent).toEqual([{ runId: "run-1", jobId: "job-1", repo: "o/r", sha: "abc123" }]);
    expect(woken).toEqual([{ runId: "run-1", jobId: "job-1" }]);
  });

  it("stops when the budget is spent or no policy exists", async () => {
    const spent = new MemDb();
    spent.jobs.set("job-1", jobRow({ status: "running", definition: retryDef, attempts: 1 }));
    const sent: unknown[] = [];
    expect(await maybeRetryJob(spent, { send: async (m) => void sent.push(m) }, "job-1")).toBe(false);
    expect(sent).toEqual([]);
    expect(spent.jobs.get("job-1")?.status).toBe("running");

    const none = new MemDb();
    none.jobs.set("job-1", jobRow({ status: "running", definition: JSON.stringify({ steps: [{ run: "x" }] }) }));
    expect(await maybeRetryJob(none, { send: async () => undefined }, "job-1")).toBe(false);
  });

  it("does nothing for an unknown job or a lost release race", async () => {
    const db = new MemDb();
    expect(await maybeRetryJob(db, { send: async () => undefined }, "missing")).toBe(false);
    db.jobs.set("job-1", jobRow({ status: "running", definition: retryDef }));
    db.releaseChanges = 0;
    expect(await maybeRetryJob(db, { send: async () => undefined }, "job-1")).toBe(false);
    expect(db.jobs.get("job-1")?.attempts).toBe(0);
  });
});

describe("triageAndStore", () => {
  const result = JSON.stringify({ steps: [{ command: "npm test", exitCode: 1, durationMs: 5, output: "Error: boom" }] });

  it("triages through the gateway and stores the text", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow());
    db.settings.set("ai_gateway_id", "gw-d1");
    const seen: unknown[] = [];
    const ai = {
      run: async (_m: string, _i: unknown, o?: unknown) => {
        seen.push(o);
        return { response: "Cause: boom." };
      },
    };
    await triageAndStore(db, ai, { id: "run-1", repo: "o/r", sha: "abc" }, "job-1", "test", "log", result, { gatewayId: "gw-env" });
    expect(seen).toEqual([{ gateway: { id: "gw-env" } }]);
    expect(db.jobs.get("job-1")?.triage).toBe("Cause: boom.");
  });

  it("threads the model override (env wins, D1 fills the gap)", async () => {
    const seen: string[] = [];
    const ai = {
      run: async (m: string) => {
        seen.push(m);
        return { response: "Cause: boom." };
      },
    };
    const db = new MemDb();
    db.jobs.set("job-1", jobRow());
    db.settings.set("triage_model", "@cf/qwen/qwen3.8-27b");
    await triageAndStore(db, ai, { id: "run-1", repo: "o/r", sha: "abc" }, "job-1", "test", "log", result, {
      model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    });
    expect(seen).toEqual(["@cf/deepseek-ai/deepseek-v4-flash-0731"]);
    await triageAndStore(db, ai, { id: "run-1", repo: "o/r", sha: "abc" }, "job-1", "test", "log", result);
    expect(seen[1]).toBe("@cf/qwen/qwen3.8-27b");
  });

  it("falls back to the D1 gateway and grounds with web search when on", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow());
    db.settings.set("ai_gateway_id", "gw-d1");
    db.settings.set("triage_web_search", "1");
    const seen: { opts?: unknown; prompt?: string } = {};
    const ai = {
      run: async (_m: string, i: unknown, o?: unknown) => {
        seen.opts = o;
        seen.prompt = JSON.stringify(i);
        return { response: "Cause: boom." };
      },
      websearch: async () => new Response(JSON.stringify({ items: [{ url: "https://x.example", title: "T", description: "D" }] })),
    };
    await triageAndStore(db, ai, { id: "run-1", repo: "o/r", sha: "abc" }, "job-1", "test", "log", result);
    expect(seen.opts).toEqual({ gateway: { id: "gw-d1" } });
    expect(seen.prompt).toContain("Live web context");
    expect(seen.prompt).toContain("https://x.example");
  });

  it("skips search without a gateway and never throws", async () => {
    const db = new MemDb();
    db.jobs.set("job-1", jobRow());
    db.settings.set("triage_web_search", "1");
    let searched = false;
    const ai = {
      run: async () => ({ response: "Cause: boom." }),
      websearch: async () => {
        searched = true;
        return new Response("{}");
      },
    };
    await triageAndStore(db, ai, { id: "run-1", repo: "o/r", sha: "abc" }, "job-1", "test", "log", result);
    expect(searched).toBe(false);
    await triageAndStore(db, undefined, { id: "run-1", repo: "o/r", sha: "abc" }, "job-1", "test", "log", result);
    await triageAndStore(db, { run: async () => { throw new Error("down"); } }, { id: "run-1", repo: "o/r", sha: "abc" }, "job-1", "test", "log", result);
    expect(db.jobs.get("job-1")?.triage).toBe("Cause: boom.");
  });
});
