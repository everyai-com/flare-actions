import { describe, expect, it } from "vitest";
import {
  runSeatJob,
  seatTokenAuthorized,
  type ContainerCtl,
  type ContainerStartOptions,
  type ExecHandle,
  type ExecOptions,
  type SeatDeps,
} from "./seat";
import type { Db } from "../../worker/src/db";

// In-memory Db routing the exact queries runSeatJob issues. Anything
// unrouted throws loudly so SQL drift fails tests, not prod.

interface Row {
  [k: string]: unknown;
}

class MemDb implements Db {
  jobs = new Map<string, Row>();
  runs = new Map<string, Row>();
  failClaims = false;

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: this.routeAll(norm, values) as T[] }),
        first: async <T,>() => (this.routeFirst(norm, values) as T | null) ?? null,
        run: async () => this.routeRun(norm, values),
      }),
    };
  }

  private routeFirst(norm: string, values: unknown[]): Row | null {
    if (norm.startsWith("SELECT * FROM jobs WHERE id")) return this.jobs.get(values[0] as string) ?? null;
    if (norm.startsWith("SELECT * FROM runs WHERE id")) return this.runs.get(values[0] as string) ?? null;
    if (norm.startsWith("SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r")) {
      const job = this.jobs.get(values[0] as string);
      if (!job) return null;
      const run = this.runs.get(job.run_id as string);
      return { ...job, repo: run?.repo, sha: run?.sha } as Row;
    }
    throw new Error(`unrouted first: ${norm}`);
  }

  private routeAll(norm: string, values: unknown[]): Row[] {
    if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
      return [...this.jobs.values()].filter((j) => j.run_id === values[0]);
    }
    if (norm.includes("status = 'blocked'")) return [];
    if (norm.startsWith("SELECT j.definition, j.name")) return [];
    if (norm.includes("status IN ('queued', 'running', 'blocked')")) return [];
    throw new Error(`unrouted all: ${norm}`);
  }

  private routeRun(norm: string, values: unknown[]): unknown {
    if (norm.startsWith("UPDATE jobs SET log = COALESCE")) {
      const job = this.jobs.get(values[2] as string);
      if (job) job.log = `${(job.log as string) ?? ""}${values[0] as string}`;
      return {};
    }
    if (norm.includes("COALESCE(started_at")) {
      const job = this.jobs.get(values[2] as string);
      if (!job || job.status !== "queued" || this.failClaims) return { meta: { changes: 0 } };
      job.status = "running";
      job.started_at = job.started_at ?? values[0];
      job.updated_at = values[1];
      return { meta: { changes: 1 } };
    }
    if (norm.startsWith("UPDATE jobs SET status = ?, log = COALESCE")) {
      const job = this.jobs.get(values[5] as string);
      if (!job || job.status !== "running") return { meta: { changes: 0 } };
      job.status = values[0];
      if (values[1] !== null) job.log = values[1];
      if (values[2] !== null) job.result = values[2];
      if (job.finished_at == null && values[3] !== null) job.finished_at = values[3];
      job.updated_at = values[4];
      return { meta: { changes: 1 } };
    }
    if (norm.startsWith("UPDATE jobs SET status = ?, finished_at")) {
      const job = this.jobs.get(values[2] as string);
      if (job) {
        job.status = values[0];
        job.finished_at = values[1];
      }
      return {};
    }
    if (norm.startsWith("UPDATE jobs SET attempts")) {
      const job = this.jobs.get(values[1] as string);
      if (job) job.attempts = ((job.attempts as number) ?? 0) + 1;
      return {};
    }
    if (norm.startsWith("UPDATE jobs SET status = 'queued'")) {
      const job = this.jobs.get(values[1] as string);
      if (job && job.status === "running") {
        job.status = "queued";
        job.started_at = null;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (norm.startsWith("UPDATE jobs SET triage")) {
      const job = this.jobs.get(values[2] as string);
      if (job) job.triage = values[0];
      return {};
    }
    if (norm.startsWith("UPDATE runs SET status")) {
      const run = this.runs.get(values[2] as string);
      if (run) run.status = values[0];
      return {};
    }
    throw new Error(`unrouted run: ${norm}`);
  }
}

function seed(db: MemDb, definition: string, status = "queued") {
  db.runs.set("r1", { id: "r1", repo: "o/r", sha: "abc123", event: "push", installation_id: null, branch: "main", status: "queued", created_at: new Date().toISOString() });
  db.jobs.set("j1", {
    id: "j1",
    run_id: "r1",
    status,
    log: "",
    name: "test",
    definition,
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: null,
    finished_at: null,
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);

interface Scripted {
  exitCode: number;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
  hang?: boolean;
}

class FakeContainer implements ContainerCtl {
  running = true;
  starts = 0;
  startOpts: (ContainerStartOptions | undefined)[] = [];
  destroys = 0;
  kills = 0;
  calls: { cmd: string[]; opts?: ExecOptions }[] = [];
  // Popped per step-run exec (["sh","-c","sh -s > ..."]); default EXIT:0.
  stepExits: number[] = [];
  checkoutExit = 0;

  start(opts?: ContainerStartOptions): void {
    this.starts += 1;
    this.startOpts.push(opts);
  }

  destroy(): void {
    this.destroys += 1;
  }

  exec(cmd: string[], opts?: ExecOptions): Promise<ExecHandle> {
    this.calls.push({ cmd, opts });
    const script = this.route(cmd, opts);
    let killed = false;
    return Promise.resolve({
      pid: 100 + this.calls.length,
      output: async () => {
        if (script.hang && !killed) await new Promise(() => undefined);
        return { exitCode: script.exitCode, stdout: script.stdout ?? new Uint8Array(), stderr: script.stderr ?? new Uint8Array() };
      },
      kill: () => {
        killed = true;
        this.kills += 1;
      },
    });
  }

  private route(cmd: string[], opts?: ExecOptions): Scripted {
    if (cmd[0] === "sh" && cmd[1] === "-s") return { exitCode: this.checkoutExit };
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("sh -s >")) {
      const code = this.stepExits.length > 0 ? (this.stepExits.shift() as number) : 0;
      return { exitCode: 0, stdout: bytes(`EXIT:${code}`) };
    }
    if (cmd[0] === "tail") return { exitCode: 0, stdout: bytes("step-output") };
    if (cmd[0] === "tar") return { exitCode: 0 };
    if (cmd[0] === "stat") return { exitCode: 0, stdout: bytes("12") };
    if (cmd[0] === "cat") return { exitCode: 0, stdout: bytes("blob-bytes-12") };
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("rm -rf")) return { exitCode: 0 };
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("test -f")) return { exitCode: 0 };
    if (cmd[0] === "sleep-forever") return { exitCode: 0, hang: true };
    throw new Error(`unrouted exec: ${JSON.stringify(cmd)} stdin=${String(opts?.stdin).slice(0, 60)}`);
  }
}

function deps(db: MemDb, container: FakeContainer, over: Partial<SeatDeps> = {}): SeatDeps {
  const store = new Map<string, Uint8Array>();
  return {
    db,
    cache: {
      get: async (k: string) => {
        const v = store.get(k);
        if (!v) return null;
        return { size: v.byteLength, arrayBuffer: async () => v.buffer as ArrayBuffer };
      },
      put: async (k: string, v: Uint8Array) => {
        store.set(k, v);
      },
    },
    queue: { send: async () => undefined },
    ai: { run: async () => ({ response: "Cause: x. Culprit: y. Fix: z." }) },
    container,
    sleep: async () => undefined,
    ...over,
  };
}

const DEF = (extra = {}) =>
  JSON.stringify({ steps: [{ run: "echo one" }, { run: "echo two" }], base: "test", ...extra });

describe("seatTokenAuthorized", () => {
  it("accepts only the exact bearer token", async () => {
    const req = new Request("https://seat/run", { headers: { Authorization: "Bearer sekrit" } });
    expect(await seatTokenAuthorized(req, "sekrit")).toBe(true);
    expect(await seatTokenAuthorized(req, "sekrit-longer")).toBe(false);
    expect(await seatTokenAuthorized(req, "other")).toBe(false);
  });

  it("rejects missing, malformed, and unconfigured tokens", async () => {
    expect(await seatTokenAuthorized(new Request("https://seat/run"), "sekrit")).toBe(false);
    expect(
      await seatTokenAuthorized(new Request("https://seat/run", { headers: { Authorization: "sekrit" } }), "sekrit"),
    ).toBe(false);
    expect(
      await seatTokenAuthorized(new Request("https://seat/run", { headers: { Authorization: "Bearer sekrit" } }), undefined),
    ).toBe(false);
    expect(await seatTokenAuthorized(new Request("https://seat/run", { headers: { Authorization: "Bearer " } }), "")).toBe(false);
  });
});

describe("runSeatJob", () => {
  it("runs steps to success with env propagation", async () => {
    const db = new MemDb();
    seed(db, DEF({ env: { TAG: "v1" }, matrix: { node: "20" } }));
    const container = new FakeContainer();
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    const job = db.jobs.get("j1") as Row;
    expect(job.status).toBe("success");
    const result = JSON.parse(job.result as string) as { steps: { exitCode: number }[]; executor: string };
    expect(result.steps).toHaveLength(2);
    expect(result.executor).toBe("seat");
    expect(job.log as string).toContain("[seat] claimed");
    expect(job.log as string).toContain("--- step 1: echo one ---");
    expect(db.runs.get("r1")?.status).toBe("success");
    expect(container.destroys).toBe(1);
    const stepCall = container.calls.find((c) => c.cmd[2]?.startsWith("sh -s >"));
    expect(stepCall?.opts?.env).toMatchObject({ TAG: "v1", FLARE_MATRIX_NODE: "20", FLARE_REPO: "o/r", CI: "true" });
    expect(stepCall?.opts?.stdin).toBe("echo one");
    expect(stepCall?.opts?.cwd).toBe("/work");
    // FETCH_HEAD (not the raw ref) so branch names and HEAD resolve.
    const checkoutCall = container.calls.find((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(checkoutCall?.opts?.stdin as string).toContain("git checkout -q FETCH_HEAD");
  });

  it("fails fast and triages", async () => {
    const db = new MemDb();
    seed(db, JSON.stringify({ steps: [{ run: "a" }, { run: "b" }, { run: "c" }], base: "t" }));
    const container = new FakeContainer();
    container.stepExits = [0, 1];
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    const job = db.jobs.get("j1") as Row;
    expect(job.status).toBe("failure");
    expect((JSON.parse(job.result as string) as { steps: unknown[] }).steps).toHaveLength(2);
    expect(job.triage as string).toContain("Cause:");
    const stepRuns = container.calls.filter((c) => c.cmd[2]?.startsWith("sh -s >"));
    expect(stepRuns).toHaveLength(2);
  });

  it("skips non-queued, ineligible, and lost claims without touching the container", async () => {
    const db = new MemDb();
    seed(db, DEF(), "running");
    const c1 = new FakeContainer();
    expect((await runSeatJob(deps(db, c1), "j1")).status).toBe("skipped");
    expect(c1.calls).toHaveLength(0);

    const db2 = new MemDb();
    seed(db2, DEF({ container: "node:20" }));
    const c2 = new FakeContainer();
    const inelig = await runSeatJob(deps(db2, c2), "j1");
    expect(inelig).toEqual({ status: "skipped", jobId: "j1", detail: "ineligible for seats" });
    expect(db2.jobs.get("j1")?.status).toBe("queued");

    const db3 = new MemDb();
    db3.failClaims = true;
    seed(db3, DEF());
    const c3 = new FakeContainer();
    expect(await runSeatJob(deps(db3, c3), "j1")).toEqual({ status: "skipped", jobId: "j1", detail: "claim lost" });
    expect(c3.destroys).toBe(0);
  });

  it("boots containers with internet enabled", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.running = false;
    const origStart = container.start.bind(container);
    container.start = (opts?: ContainerStartOptions) => {
      origStart(opts);
      container.running = true;
    };
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    expect(container.startOpts).toEqual([{ enableInternet: true }]);
  });

  it("releases on checkout failure and on boot failure", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.checkoutExit = 128;
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("released");
    expect(db.jobs.get("j1")?.status).toBe("queued");
    expect(container.destroys).toBe(1);

    const db2 = new MemDb();
    seed(db2, DEF());
    const dead = new FakeContainer();
    dead.running = false;
    dead.start = () => {
      dead.starts += 1;
    };
    const out2 = await runSeatJob(
      deps(db2, dead, { timing: { startWaitMs: 5, startAttempts: 2, startPollMs: 1, stepMs: 100, blobMs: 100 } }),
      "j1",
    );
    expect(out2.status).toBe("released");
    expect(dead.starts).toBe(2);
    expect(db2.jobs.get("j1")?.status).toBe("queued");
  });

  it("re-wakes on boot failure for fresh runs, stays silent for stale ones", async () => {
    const fresh = new MemDb();
    seed(fresh, DEF());
    const dead = new FakeContainer();
    dead.running = false;
    dead.start = () => {
      dead.starts += 1;
    };
    const wakes: { msg: { jobId: string }; opts?: { delaySeconds?: number } }[] = [];
    const out = await runSeatJob(
      deps(fresh, dead, {
        timing: { startWaitMs: 5, startAttempts: 2, startPollMs: 1, stepMs: 100, blobMs: 100 },
        seatQueue: { send: async (msg, opts) => wakes.push({ msg, opts }) },
      }),
      "j1",
    );
    expect(out.status).toBe("released");
    expect(wakes).toEqual([{ msg: { jobId: "j1" }, opts: { delaySeconds: 60 } }]);
    expect((out as { detail: string }).detail).toContain("re-wake");

    // Checkout failures never re-wake: a retry would hit the same wall.
    const co = new MemDb();
    seed(co, DEF());
    const bad = new FakeContainer();
    bad.checkoutExit = 128;
    const coWakes: unknown[] = [];
    await runSeatJob(deps(co, bad, { seatQueue: { send: async (m) => coWakes.push(m) } }), "j1");
    expect(coWakes).toHaveLength(0);

    // Stale runs stop the loop: no BYO runners, no point retrying forever.
    const stale = new MemDb();
    seed(stale, DEF());
    (stale.runs.get("r1") as Row).created_at = new Date(Date.now() - 3600000).toISOString();
    const old = new FakeContainer();
    old.running = false;
    old.start = () => {
      old.starts += 1;
    };
    const staleWakes: unknown[] = [];
    const outStale = await runSeatJob(
      deps(stale, old, {
        timing: { startWaitMs: 5, startAttempts: 2, startPollMs: 1, stepMs: 100, blobMs: 100 },
        seatQueue: { send: async (m) => staleWakes.push(m) },
      }),
      "j1",
    );
    expect(outStale.status).toBe("released");
    expect(staleWakes).toHaveLength(0);
    expect((outStale as { detail: string }).detail).not.toContain("re-wake");
  });

  it("mirrors progress to the job log so releases are self-diagnosing", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const dead = new FakeContainer();
    dead.running = false;
    dead.start = () => {
      dead.starts += 1;
    };
    const out = await runSeatJob(
      deps(db, dead, { timing: { startWaitMs: 5, startAttempts: 1, startPollMs: 1, stepMs: 100, blobMs: 100 } }),
      "j1",
    );
    expect(out.status).toBe("released");
    const log = db.jobs.get("j1")?.log as string;
    expect(log).toContain("[seat] claimed test (o/r@abc123)");
    expect(log).toContain("[seat] start attempt 1 timed out");
    expect(log).toContain("[seat] released: container did not start");
  });

  it("tolerates a throwing start and still boots", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const flaky = new FakeContainer();
    flaky.running = false;
    flaky.start = () => {
      throw new Error("boom");
    };
    const out = await runSeatJob(
      deps(db, flaky, {
        sleep: async () => {
          flaky.running = true;
        },
      }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("success");
    const log = db.jobs.get("j1")?.log as string;
    expect(log).toContain("[seat] start attempt 1 error: Error: boom");
    expect(log).toContain("[seat] container running (attempt 1)");
  });

  it("times out a hanging exec call instead of wedging", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const hung = new FakeContainer();
    hung.exec = () => new Promise<ExecHandle>(() => undefined);
    const out = await runSeatJob(
      deps(db, hung, {
        timing: { startWaitMs: 5, startAttempts: 1, startPollMs: 1, stepMs: 30, blobMs: 100, checkoutMs: 30 },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
      "j1",
    );
    expect(out.status).toBe("released");
    expect((out as { detail: string }).detail).toContain("checkout failed");
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] released: checkout failed");
  });

  it("restores and saves cache through tar", async () => {
    const db = new MemDb();
    seed(db, DEF({ cache: { key: "k", paths: ["node_modules"] } }));
    const container = new FakeContainer();
    const store = new Map<string, Uint8Array>([["cache/k", bytes("old-tar")]]);
    const d = deps(db, container);
    d.cache = {
      get: async (k: string) => {
        const v = store.get(k);
        if (!v) return null;
        return { size: v.byteLength, arrayBuffer: async () => v.buffer as ArrayBuffer };
      },
      put: async (k: string, v: Uint8Array) => {
        store.set(k, v);
      },
    };
    const out = await runSeatJob(d, "j1");
    expect(out.status).toBe("completed");
    expect(JSON.parse((db.jobs.get("j1")?.result ?? "{}") as string).cacheHit).toBe(true);
    const restore = container.calls.find((c) => c.cmd[0] === "tar" && c.cmd.includes("-xzf"));
    expect(new TextDecoder().decode(restore?.opts?.stdin as Uint8Array)).toBe("old-tar");
    expect(store.get("cache/k")).toBeDefined();
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] cache hit: k");
  });

  it("uploads a single-file artifact raw", async () => {
    const db = new MemDb();
    seed(db, DEF({ artifacts: { paths: ["README.md"] } }));
    const container = new FakeContainer();
    const store = new Map<string, Uint8Array>();
    const d = deps(db, container);
    d.cache = {
      get: async () => null,
      put: async (k: string, v: Uint8Array) => {
        store.set(k, v);
      },
    };
    await runSeatJob(d, "j1");
    expect([...store.keys()]).toEqual(["artifacts/j1/README.md"]);
    expect(JSON.parse((db.jobs.get("j1")?.result ?? "{}") as string).artifacts).toEqual(["README.md"]);
  });

  it("continues past continue-on-error steps and still succeeds", async () => {
    const db = new MemDb();
    seed(db, JSON.stringify({ steps: [{ run: "flaky", continueOnError: true }, { run: "echo after" }], base: "t" }));
    const container = new FakeContainer();
    container.stepExits = [1];
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("success");
    const stepRuns = container.calls.filter((c) => c.cmd[2]?.startsWith("sh -s >"));
    expect(stepRuns).toHaveLength(2);
    expect(JSON.parse(db.jobs.get("j1")?.result as string).steps).toHaveLength(2);
    expect(db.jobs.get("j1")?.log as string).toContain("continue-on-error");
  });

  it("runs always() cleanup steps after a failure, skipping defaults", async () => {
    const db = new MemDb();
    seed(
      db,
      JSON.stringify({
        steps: [{ run: "fail" }, { run: "cleanup", if: "always()" }, { run: "skipped-default" }],
        base: "t",
      }),
    );
    const container = new FakeContainer();
    container.stepExits = [1];
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("failure");
    const stepRuns = container.calls.filter((c) => c.cmd[2]?.startsWith("sh -s >"));
    expect(stepRuns).toHaveLength(2); // fail + cleanup; the default step never starts
    const log = db.jobs.get("j1")?.log as string;
    expect(log).toContain("cleanup");
    expect(log).toContain("skipped (");
  });

  it("requeues a failed job while the retry policy allows", async () => {
    const db = new MemDb();
    seed(db, JSON.stringify({ steps: [{ run: "flaky" }], base: "t", retry: 1 }));
    const container = new FakeContainer();
    container.stepExits = [1];
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("retrying");
    expect(db.jobs.get("j1")?.status).toBe("queued");
    expect(db.jobs.get("j1")?.attempts).toBe(1);
    expect(db.jobs.get("j1")?.log as string).toContain("retrying after failure (attempt 2/2)");
    expect(container.destroys).toBe(1);
  });

  it("unpacks source tarballs instead of checking out", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const sourceId = "123e4567-e89b-12d3-a456-426614174000";
    (db.runs.get("r1") as Row).source = sourceId;
    const container = new FakeContainer();
    const d = deps(db, container);
    await d.cache?.put(`sources/${sourceId}`, bytes("fake-tar-bytes"));
    const out = await runSeatJob(d, "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("success");
    const gitCheckout = container.calls.find((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(gitCheckout).toBeUndefined();
    expect(container.calls.find((c) => c.cmd[0] === "tar" && c.cmd[1] === "-tzf")).toBeDefined();
    expect(container.calls.find((c) => c.cmd[0] === "tar" && c.cmd[1] === "-xzf")).toBeDefined();
    expect(db.jobs.get("j1")?.log as string).toContain("source unpacked");
  });

  it("releases when the source tarball is missing", async () => {
    const db = new MemDb();
    seed(db, DEF());
    (db.runs.get("r1") as Row).source = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const container = new FakeContainer();
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("released");
    expect((out as { detail: string }).detail).toContain("source tarball missing");
    expect(db.jobs.get("j1")?.status).toBe("queued");
  });

  it("fails closed on an unparseable definition instead of echo-succeeding", async () => {
    const db = new MemDb();
    seed(db, "{not-json");
    const container = new FakeContainer();
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out).toEqual({ status: "failed", jobId: "j1", detail: "unparseable job definition" });
    expect(db.jobs.get("j1")?.status).toBe("error");
    expect(db.jobs.get("j1")?.log as string).toContain("could not be parsed");
    expect(container.calls).toHaveLength(0);
    expect(db.runs.get("r1")?.status).toBe("failure");
  });

  it("drops the result when the job was requeued before completion", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    // Simulate the stale sweep releasing the job mid-execution: the
    // terminal report must not clobber the fresh queued row.
    const origExec = container.exec.bind(container);
    let flipped = false;
    container.exec = (cmd: string[], opts?: ExecOptions) => {
      if (!flipped) {
        flipped = true;
        (db.jobs.get("j1") as Row).status = "queued";
      }
      return origExec(cmd, opts);
    };
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("released");
    expect((out as { detail: string }).detail).toContain("requeued before completion");
    expect(db.jobs.get("j1")?.status).toBe("queued");
    expect(db.jobs.get("j1")?.result).toBe("");
  });

  it("kills hung steps and fails the job", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    // First step-run exec hangs; kill() releases output().
    let hung = false;
    const origExec = container.exec.bind(container);
    container.exec = async (cmd: string[], opts?: ExecOptions) => {
      if (cmd[2]?.startsWith("sh -s >") && !hung) {
        hung = true;
        let killed = false;
        return {
          pid: 1,
          output: async () => {
            while (!killed) await new Promise((r) => setTimeout(r, 5));
            return { exitCode: 124, stdout: new Uint8Array(), stderr: new Uint8Array() };
          },
          kill: () => {
            killed = true;
            container.kills += 1;
          },
        };
      }
      return origExec(cmd, opts);
    };
    const out = await runSeatJob(
      deps(db, container, { timing: { startWaitMs: 5, startAttempts: 1, startPollMs: 1, stepMs: 30, blobMs: 100 }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("failure");
    expect(container.kills).toBe(1);
    expect((db.jobs.get("j1")?.log as string) ?? "").toContain("timed out");
  });
});
