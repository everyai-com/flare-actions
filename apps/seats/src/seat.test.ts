import { describe, expect, it } from "vitest";
import {
  egressHostForKey,
  mirrorNamespaceFor,
  mirrorRepoFor,
  parseNetDev,
  renderArtifactsRemote,
  renderMirrorRemote,
  runSeatJob,
  type SeatArtifactsNamespace,
  seatTokenAuthorized,
  type BrowserDriver,
  type ContainerCtl,
  type ContainerSnapshot,
  type ContainerStartOptions,
  type ExecHandle,
  type ExecOptions,
  type SeatDeps,
} from "./seat";
import type { Db } from "../../worker/src/db";
import { EGRESS_LOG_PATH, EGRESS_SHIM_PATH } from "./egress";

// In-memory Db routing the exact queries runSeatJob issues. Anything
// unrouted throws loudly so SQL drift fails tests, not prod.

interface Row {
  [k: string]: unknown;
}

class MemDb implements Db {
  jobs = new Map<string, Row>();
  runs = new Map<string, Row>();
  failClaims = false;
  monitors: Row[] = [];
  testReports = new Map<string, Row>();
  testCases: Row[] = [];
  snapshots = new Map<string, Row>();
  egress: Row[] = [];
  settings = new Map<string, { value: string }>();

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
    if (norm.startsWith("SELECT * FROM seat_snapshots WHERE image")) {
      return this.snapshots.get(`${values[0] as string}|${values[1] as string}`) ?? null;
    }
    if (norm.startsWith("SELECT value FROM app_settings WHERE key")) {
      return (this.settings.get(values[0] as string) as Row | undefined) ?? null;
    }
    throw new Error(`unrouted first: ${norm}`);
  }

  private routeAll(norm: string, values: unknown[]): Row[] {
    if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
      return [...this.jobs.values()].filter((j) => j.run_id === values[0]);
    }
    if (norm.startsWith("SELECT * FROM monitors ORDER BY")) return this.monitors;
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
    if (norm.startsWith("UPDATE jobs SET retained_until")) {
      const job = this.jobs.get(values[2] as string);
      if (job) job.retained_until = values[0];
      return {};
    }
    if (norm.startsWith("INSERT INTO seat_snapshots")) {
      this.snapshots.set(`${values[0] as string}|${values[1] as string}`, {
        image: values[0], repo: values[1], snapshot_id: values[2], job_id: values[3], created_at: values[4], last_used_at: values[5],
      });
      return {};
    }
    if (norm.startsWith("UPDATE seat_snapshots SET last_used_at")) {
      const row = this.snapshots.get(`${values[1] as string}|${values[2] as string}`);
      if (row) row.last_used_at = values[0];
      return {};
    }
    if (norm.startsWith("DELETE FROM seat_snapshots WHERE image")) {
      this.snapshots.delete(`${values[0] as string}|${values[1] as string}`);
      return {};
    }
    if (norm.startsWith("DELETE FROM job_egress WHERE job_id")) {
      this.egress = this.egress.filter((e) => e.job_id !== values[0]);
      return {};
    }
    if (norm.startsWith("INSERT INTO job_egress")) {
      for (let i = 0; i + 4 < values.length; i += 5) {
        this.egress.push({ job_id: values[i], run_id: values[i + 1], host: values[i + 2], req_bytes: values[i + 3], resp_bytes: values[i + 4] });
      }
      return {};
    }
    if (norm.startsWith("UPDATE runs SET status")) {
      const run = this.runs.get(values[2] as string);
      if (run) run.status = values[0];
      return {};
    }
    if (norm.startsWith("DELETE FROM test_results WHERE job_id")) {
      this.testCases = this.testCases.filter((c) => c.job_id !== values[0]);
      return {};
    }
    if (norm.startsWith("INSERT INTO test_reports")) {
      this.testReports.set(values[0] as string, {
        job_id: values[0], run_id: values[1], passed: values[2], failed: values[3], errors: values[4],
        skipped: values[5], total: values[6],
      });
      return {};
    }
    if (norm.startsWith("INSERT INTO test_results")) {
      for (let i = 0; i + 7 < values.length; i += 8) {
        this.testCases.push({ job_id: values[i], run_id: values[i + 1], suite: values[i + 2], name: values[i + 3] });
      }
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
  // Mirror-checkout answer (stdin containing the artifacts host) and
  // the stderr served for checkout scripts (token-scrub tests).
  mirrorExit = 0;
  coStderr = "";
  // Test-report scan listing (one absolute path per line) and the bytes
  // served for cat calls that hit those paths.
  testScan = "";
  testXml = new Map<string, string>();
  netDevSamples: string[] = [];
  tailBytes = "step-output";
  // Egress-shim probe answer: false keeps every existing test on the
  // no-shim path (steps run, no domain rows).
  shimPresent = false;
  // Enforcement-marker probe answer for the allowlist capability check.
  shimEnforcing = true;

  snapshots: (string | undefined)[] = [];

  async start(opts?: ContainerStartOptions): Promise<void> {
    this.starts += 1;
    this.startOpts.push(opts);
  }

  async snapshot(name?: string): Promise<ContainerSnapshot> {
    this.snapshots.push(name);
    return { id: `snap-${this.snapshots.length}`, size: 1 };
  }

  destroy(): void {
    this.destroys += 1;
  }

  // Resolves when stopNow() is called (or immediately when stopOnBoot);
  // never resolves by default so jobs run normally.
  stopOnBoot = false;
  private stopWaiters: (() => void)[] = [];
  // Deferred monitor promise shared across calls, like the real API's
  // single stop signal per instance.
  private stopPromise: Promise<void> | null = null;

  stopNow(): void {
    for (const w of this.stopWaiters.splice(0)) w();
  }

  async monitor(): Promise<void> {
    if (this.stopOnBoot) return;
    if (!this.stopPromise) this.stopPromise = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    return this.stopPromise;
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
    if (cmd[0] === "sh" && cmd[1] === "-s") {
      const stdin = opts?.stdin;
      const text = typeof stdin === "string" ? stdin : stdin ? new TextDecoder().decode(stdin) : "";
      const mirror = text.includes("artifacts.cloudflare.net");
      return { exitCode: mirror ? this.mirrorExit : this.checkoutExit, stderr: bytes(this.coStderr) };
    }
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("sh -s >")) {
      const code = this.stepExits.length > 0 ? (this.stepExits.shift() as number) : 0;
      return { exitCode: 0, stdout: bytes(`EXIT:${code}`) };
    }
    if (cmd[0] === "tail") return { exitCode: 0, stdout: bytes(this.tailBytes) };
    if (cmd[0] === "tar") return { exitCode: 0 };
    if (cmd[0] === "stat") return { exitCode: 0, stdout: bytes("12") };
    if (cmd[0] === "cat" && cmd[1] === "/proc/net/dev") {
      const sample = this.netDevSamples.length > 0 ? (this.netDevSamples.shift() as string) : "";
      return { exitCode: 0, stdout: bytes(sample) };
    }
    if (cmd[0] === "cat") {
      const hit = this.testXml.get(cmd[1] ?? "");
      return { exitCode: 0, stdout: bytes(hit ?? "blob-bytes-12") };
    }
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("for p in ")) {
      return { exitCode: 0, stdout: bytes(this.testScan) };
    }
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("rm -rf")) return { exitCode: 0 };
    if (cmd[0] === "rm") return { exitCode: 0 };
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("test -f")) return { exitCode: 0 };
    if (cmd[0] === "test" && cmd[1] === "-x") return { exitCode: this.shimPresent ? 0 : 1 };
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("grep -qa FLARE_EGRESS_ALLOW")) {
      return { exitCode: this.shimEnforcing ? 0 : 1 };
    }
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("cat /sys/fs/cgroup")) {
      return { exitCode: 0, stdout: bytes("123456") };
    }
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

const MIRROR_TEMPLATE = "https://a54b12fe3ef06df16ff0041d79c18fc0.artifacts.cloudflare.net/git/mirrors/{repo}.git";

function stdinText(call: { opts?: ExecOptions }): string {
  const s = call.opts?.stdin;
  return typeof s === "string" ? s : s ? new TextDecoder().decode(s) : "";
}

function fakeBrowser(
  pages: Record<string, { title: string; text?: string; shot?: boolean; throws?: string }>,
): BrowserDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check: async (url, opts) => {
      calls.push(url);
      const p = pages[url];
      if (!p) throw new Error(`unexpected url ${url}`);
      if (p.throws) throw new Error(p.throws);
      return {
        title: p.title,
        text: p.text ?? "",
        screenshot: opts.screenshot && p.shot === true ? new TextEncoder().encode("png-bytes") : null,
      };
    },
  };
}

function spyCache(): { puts: Map<string, Uint8Array>; cache: SeatDeps["cache"] } {
  const puts = new Map<string, Uint8Array>();
  return {
    puts,
    cache: {
      get: async (_k: string) => null,
      put: async (k: string, v: Uint8Array) => {
        puts.set(k, v);
      },
    },
  };
}

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

describe("renderMirrorRemote", () => {
  it("renders per-repo remotes and fails closed", () => {
    expect(renderMirrorRemote(MIRROR_TEMPLATE, "o/r")).toBe(
      "https://a54b12fe3ef06df16ff0041d79c18fc0.artifacts.cloudflare.net/git/mirrors/o-r.git",
    );
    // No placeholder, wrong host, non-hex account, unsafe name.
    expect(renderMirrorRemote("https://example.com/x.git", "o/r")).toBeNull();
    expect(renderMirrorRemote("https://evil.example/{repo}.git", "o/r")).toBeNull();
    expect(renderMirrorRemote("https://short.artifacts.cloudflare.net/git/m/{repo}.git", "o/r")).toBeNull();
    expect(renderMirrorRemote(MIRROR_TEMPLATE, "o /r")).toBeNull();
  });
  it("renders namespace/name verbatim for artifacts runs", () => {
    const template = "https://a54b12fe3ef06df16ff0041d79c18fc0.artifacts.cloudflare.net/git/{repo}.git";
    expect(renderMirrorRemote(template, "default/race-1", true)).toBe(
      "https://a54b12fe3ef06df16ff0041d79c18fc0.artifacts.cloudflare.net/git/default/race-1.git",
    );
    // Verbatim requires exactly two safe segments.
    expect(renderMirrorRemote(template, "noslash", true)).toBeNull();
    expect(renderMirrorRemote(template, "a/b/c", true)).toBeNull();
    expect(renderMirrorRemote(template, "a/b c", true)).toBeNull();
    expect(renderMirrorRemote(template, "../x", true)).toBeNull();
  });
});

describe("renderArtifactsRemote", () => {
  it("derives the account host and renders namespace/name verbatim", () => {
    expect(renderArtifactsRemote(MIRROR_TEMPLATE, "flare-tournaments", "tournament-canary")).toBe(
      "https://a54b12fe3ef06df16ff0041d79c18fc0.artifacts.cloudflare.net/git/flare-tournaments/tournament-canary.git",
    );
    expect(renderArtifactsRemote("https://evil.example/git/m/{repo}.git", "ns", "r")).toBeNull();
    expect(renderArtifactsRemote(MIRROR_TEMPLATE, "ns", "../x")).toBeNull();
    expect(renderArtifactsRemote(MIRROR_TEMPLATE, "n/s", "r")).toBeNull();
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
    expect(stepCall?.opts?.env).toMatchObject({ TAG: "v1", FLARE_MATRIX_NODE: "20", FLARE_REPO: "o/r", FLARE_REF: "main", FLARE_CHANGED_FILES: "", CI: "true" });
    expect(stepCall?.opts?.stdin).toBe("echo one");
    expect(stepCall?.opts?.cwd).toBe("/work");
    // FETCH_HEAD (not the raw ref) so branch names and HEAD resolve.
    const checkoutCall = container.calls.find((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(checkoutCall?.opts?.stdin as string).toContain("git checkout -q FETCH_HEAD");
  });

  it("collects and stores JUnit reports from the container", async () => {
    const db = new MemDb();
    seed(db, DEF({ testReports: { paths: ["custom"] } }));
    const container = new FakeContainer();
    container.testScan = "/work/custom/out.xml\n/etc/passwd\n";
    container.testXml.set(
      "/work/custom/out.xml",
      `<testsuite name="s"><testcase name="t1" time="0.1"/><testcase name="t2"><failure message="bad"/></testcase></testsuite>`,
    );
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    expect(db.testReports.get("j1")).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(db.testCases.map((c) => c.name)).toEqual(["t1", "t2"]);
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] tests: 2 tests, 1 failed");
    const scan = container.calls.find((c) => c.cmd[2]?.startsWith("for p in "));
    expect(scan?.cmd[2]).toContain("/work/custom");
    expect(scan?.cmd[2]).toContain("/work/junit.xml");
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
    container.start = async (opts?: ContainerStartOptions) => {
      await origStart(opts);
      container.running = true;
    };
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    expect(container.startOpts).toEqual([{ enableInternet: true }]);
  });

  it("merges V2 containerStart (image/instance/snapshot) into the boot call", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.running = false;
    const origStart = container.start.bind(container);
    container.start = async (opts?: ContainerStartOptions) => {
      await origStart(opts);
      container.running = true;
    };
    const out = await runSeatJob(
      deps(db, container, {
        containerStart: { image: "registry.example/seat@sha256:abc", entrypoint: ["sleep", "infinity"], instance: "standard-1" },
      }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(container.startOpts).toEqual([
      { enableInternet: true, image: "registry.example/seat@sha256:abc", entrypoint: ["sleep", "infinity"], instance: "standard-1" },
    ]);

    // Snapshot restore replaces the image on the start call.
    const db2 = new MemDb();
    seed(db2, DEF());
    const snap = new FakeContainer();
    snap.running = false;
    const origSnapStart = snap.start.bind(snap);
    snap.start = async (opts?: ContainerStartOptions) => {
      await origSnapStart(opts);
      snap.running = true;
    };
    const out2 = await runSeatJob(deps(db2, snap, { containerStart: { snapshotId: "snap-9" } }), "j1");
    expect(out2.status).toBe("completed");
    expect(snap.startOpts).toEqual([{ enableInternet: true, snapshotId: "snap-9" }]);
  });

  it("restores a fresh snapshot on V2 boot and touches it", async () => {
    const db = new MemDb();
    seed(db, DEF());
    db.snapshots.set("img1|o/r", {
      image: "img1", repo: "o/r", snapshot_id: "snap-aaa", job_id: "j0",
      created_at: new Date().toISOString(), last_used_at: new Date().toISOString(),
    });
    const container = new FakeContainer();
    container.running = false;
    const origStart = container.start.bind(container);
    container.start = async (opts?: ContainerStartOptions) => {
      await origStart(opts);
      container.running = true;
    };
    const out = await runSeatJob(
      deps(db, container, {
        containerStart: { image: "img1" },
        timing: { startWaitMs: 5, startAttempts: 1, startPollMs: 1, stepMs: 100, blobMs: 100 },
      }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(container.startOpts[0]).toEqual({ enableInternet: true, snapshotId: "snap-aaa" });
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] snapshot restored (snap-aaa…)");
    // A successful job replaces the restored snapshot with a fresh one.
    expect(container.snapshots).toHaveLength(1);
    expect(db.snapshots.get("img1|o/r")?.snapshot_id).toBe("snap-1");
  });

  it("deletes a degraded snapshot and falls through to a fresh boot", async () => {
    const db = new MemDb();
    seed(db, DEF());
    db.snapshots.set("img1|o/r", {
      image: "img1", repo: "o/r", snapshot_id: "snap-bad", job_id: "j0",
      created_at: new Date().toISOString(), last_used_at: new Date().toISOString(),
    });
    const container = new FakeContainer();
    container.running = false;
    // Restore starts never come up; fresh starts do.
    container.start = async (opts?: ContainerStartOptions) => {
      container.starts += 1;
      container.startOpts.push(opts);
      if (!opts?.snapshotId) container.running = true;
    };
    const out = await runSeatJob(
      deps(db, container, {
        containerStart: { image: "img1" },
        timing: { startWaitMs: 5, startAttempts: 2, startPollMs: 1, stepMs: 100, blobMs: 100 },
      }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(container.startOpts[0]).toEqual({ enableInternet: true, snapshotId: "snap-bad" });
    expect(container.startOpts[1]).toEqual({ enableInternet: true, image: "img1" });
    expect(db.snapshots.has("img1|o/r")).toBe(true); // deleted, then re-saved on success
    expect(db.snapshots.get("img1|o/r")?.snapshot_id).toBe("snap-1");
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] snapshot degraded, deleted; fresh boot");
  });

  it("ignores stale snapshots and never snapshots on V1 or failure", async () => {
    const db = new MemDb();
    seed(db, DEF());
    db.snapshots.set("img1|o/r", {
      image: "img1", repo: "o/r", snapshot_id: "snap-old", job_id: "j0",
      created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
      last_used_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    });
    const container = new FakeContainer();
    container.running = false;
    const origStart = container.start.bind(container);
    container.start = async (opts?: ContainerStartOptions) => {
      await origStart(opts);
      container.running = true;
    };
    const out = await runSeatJob(
      deps(db, container, {
        containerStart: { image: "img1" },
        timing: { startWaitMs: 5, startAttempts: 1, startPollMs: 1, stepMs: 100, blobMs: 100 },
      }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(container.startOpts).toEqual([{ enableInternet: true, image: "img1" }]);

    // V1 (no containerStart): no snapshot traffic at all.
    const db2 = new MemDb();
    seed(db2, DEF());
    const v1 = new FakeContainer();
    await runSeatJob(deps(db2, v1), "j1");
    expect(v1.snapshots).toHaveLength(0);
    expect(db2.snapshots.size).toBe(0);

    // Failures never save: a failed build's state must not be inherited.
    const db3 = new MemDb();
    seed(db3, JSON.stringify({ steps: [{ run: "boom" }], base: "t" }));
    const fail = new FakeContainer();
    fail.stepExits = [1];
    const out3 = await runSeatJob(deps(db3, fail, { containerStart: { image: "img1" } }), "j1");
    expect(out3.status).toBe("completed");
    expect(fail.snapshots).toHaveLength(0);
    expect(db3.snapshots.size).toBe(0);
  });

  it("retains failed V2 containers when retain-on-failure is set", async () => {
    const db = new MemDb();
    seed(db, JSON.stringify({ steps: [{ run: "boom" }], base: "t", retainOnFailure: true }));
    const container = new FakeContainer();
    container.stepExits = [1];
    const out = await runSeatJob(deps(db, container, { containerStart: { image: "img1" } }), "j1");
    expect(out.status).toBe("retained");
    expect((out as { retainedUntil: string }).retainedUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(container.destroys).toBe(0);
    expect(db.jobs.get("j1")?.status).toBe("failure");
    expect(db.jobs.get("j1")?.retained_until as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] retained for debugging until");

    // V1 ignores retain-on-failure (no alarm to enforce the deadline).
    const db2 = new MemDb();
    seed(db2, JSON.stringify({ steps: [{ run: "boom" }], base: "t", retainOnFailure: true }));
    const v1 = new FakeContainer();
    v1.stepExits = [1];
    const out2 = await runSeatJob(deps(db2, v1), "j1");
    expect(out2.status).toBe("completed");
    expect(v1.destroys).toBe(1);
    expect(db2.jobs.get("j1")?.retained_until).toBeUndefined();

    // Successes are never retained.
    const db3 = new MemDb();
    seed(db3, DEF({ retainOnFailure: true }));
    const ok = new FakeContainer();
    const out3 = await runSeatJob(deps(db3, ok, { containerStart: { image: "img1" } }), "j1");
    expect(out3.status).toBe("completed");
    expect(ok.destroys).toBe(1);
  });

  it("caps stored logs and results like the BYO route", async () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({ run: `echo ${i}` }));
    const db = new MemDb();
    seed(db, JSON.stringify({ steps, base: "t" }));
    const container = new FakeContainer();
    container.tailBytes = "x".repeat(32768);
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("completed");
    expect((db.jobs.get("j1")?.log as string).length).toBeLessThanOrEqual(262144);
    expect((db.jobs.get("j1")?.result as string).length).toBeLessThanOrEqual(65536);
  });

  it("records peak RSS in the seat result", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    await runSeatJob(deps(db, container), "j1");
    const result = JSON.parse(db.jobs.get("j1")?.result as string) as { peakRssBytes?: number };
    expect(result.peakRssBytes).toBe(123456);
  });

  it("parses /proc/net/dev across interfaces, skipping loopback and garbage", () => {
    expect(parseNetDev("")).toEqual({ rx: 0, tx: 0 });
    expect(parseNetDev("not counters\neth0: nope")).toEqual({ rx: 0, tx: 0 });
    expect(
      parseNetDev(
        "Inter-|   Receive                                                |  Transmit\n" +
          " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo frame compressed multicast\n" +
          "    lo: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n" +
          "  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n" +
          "  eth1: 500 0 0 0 0 0 0 0 700 0 0 0 0 0 0 0\n",
      ),
    ).toEqual({ rx: 1500, tx: 2700 });
    expect(egressHostForKey("cache/k")).toBe("r2:cache");
    expect(egressHostForKey("artifacts/j1/a")).toBe("r2:artifacts");
    expect(egressHostForKey("sources/u")).toBe("r2:sources");
    expect(egressHostForKey("test-reports/j1.xml")).toBe("r2:test-reports");
    expect(egressHostForKey("mystery/x")).toBe("r2:other");
  });

  it("records measured R2 transfers and the interface delta as job egress", async () => {
    const db = new MemDb();
    seed(db, DEF({ cache: { key: "k", paths: ["node_modules"] } }));
    const container = new FakeContainer();
    container.netDevSamples = [
      "  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n",
      "  eth0: 5000 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0\n",
    ];
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
    expect(db.egress).toContainEqual({ job_id: "j1", run_id: "r1", host: "r2:cache", req_bytes: 13, resp_bytes: 7 });
    expect(db.egress).toContainEqual({ job_id: "j1", run_id: "r1", host: "(interface)", req_bytes: 7000, resp_bytes: 4000 });
  });

  it("injects the egress shim env only when the image carries it", async () => {
    const stepEnvs = (container: FakeContainer): Record<string, string>[] =>
      container.calls
        .filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-c" && c.cmd[2]?.startsWith("sh -s >"))
        .map((c) => c.opts?.env ?? {});
    // Absent shim: steps run with no preload, no domain rows.
    const db = new MemDb();
    seed(db, DEF());
    const plain = new FakeContainer();
    expect((await runSeatJob(deps(db, plain), "j1")).status).toBe("completed");
    expect(plain.calls.some((c) => c.cmd[0] === "test" && c.cmd[1] === "-x")).toBe(true);
    for (const env of stepEnvs(plain)) expect(env["LD_PRELOAD"]).toBeUndefined();
    expect(db.egress.some((e) => e.host === "example.com")).toBe(false);

    // Present shim: preload + log path on every step, chaining a
    // job-supplied LD_PRELOAD instead of clobbering it.
    const db2 = new MemDb();
    seed(db2, DEF({ env: { LD_PRELOAD: "/usr/lib/libtcmalloc.so" } }));
    const shimmed = new FakeContainer();
    shimmed.shimPresent = true;
    shimmed.testXml.set(EGRESS_LOG_PATH, "DNS 93.184.216.34 example.com\nOUT 93.184.216.34 10\nIN 93.184.216.34 20\n");
    expect((await runSeatJob(deps(db2, shimmed), "j1")).status).toBe("completed");
    const envs = stepEnvs(shimmed);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env["LD_PRELOAD"]).toBe(`${EGRESS_SHIM_PATH} /usr/lib/libtcmalloc.so`);
      expect(env["FLARE_EGRESS_LOG"]).toBe(EGRESS_LOG_PATH);
    }
    expect(db2.egress).toContainEqual({ job_id: "j1", run_id: "r1", host: "example.com", req_bytes: 10, resp_bytes: 20 });
    expect(db2.jobs.get("j1")?.log).toContain("[seat] domain egress: 1 domains");
    // The previous job's log is removed before the first step, so a
    // snapshot-restored container never leaks rows across jobs.
    const rmIdx = shimmed.calls.findIndex((c) => c.cmd[0] === "rm" && c.cmd.includes(EGRESS_LOG_PATH));
    const firstStep = shimmed.calls.findIndex((c) => c.cmd[0] === "sh" && c.cmd[1] === "-c" && c.cmd[2]?.startsWith("sh -s >"));
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeLessThan(firstStep);
  });

  it("passes the egress allowlist to steps and reports denials", async () => {
    const db = new MemDb();
    seed(db, DEF({ egress: { allow: ["example.com"] } }));
    const container = new FakeContainer();
    container.shimPresent = true;
    container.testXml.set(EGRESS_LOG_PATH, "BLOCK 1.2.3.4 evil.example.net\nOUT 93.184.216.34 10\n");
    expect((await runSeatJob(deps(db, container), "j1")).status).toBe("completed");
    const stepEnvs = container.calls
      .filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-c" && c.cmd[2]?.startsWith("sh -s >"))
      .map((c) => c.opts?.env ?? {});
    expect(stepEnvs.length).toBeGreaterThan(0);
    for (const env of stepEnvs) expect(env["FLARE_EGRESS_ALLOW"]).toBe("example.com");
    const log = db.jobs.get("j1")?.log as string;
    expect(log).toContain("[seat] egress allowlist: 1 domains");
    expect(log).toContain("[seat] egress blocked 1 connects (evil.example.net)");
  });

  it("releases allowlisted jobs when the image has no shim", async () => {
    const db = new MemDb();
    seed(db, DEF({ egress: { allow: ["example.com"] } }));
    const container = new FakeContainer();
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("released");
    expect((out as { detail: string }).detail).toContain("shim-carrying seat image");
  });

  it("releases allowlisted jobs on observe-only shim images", async () => {
    const db = new MemDb();
    seed(db, DEF({ egress: { allow: ["example.com"] } }));
    const container = new FakeContainer();
    container.shimPresent = true;
    container.shimEnforcing = false;
    const out = await runSeatJob(deps(db, container), "j1");
    expect(out.status).toBe("released");
    expect((out as { detail: string }).detail).toContain("predates it");
  });

  it("treats a malformed shim log as no rows, not a failure", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.shimPresent = true;
    container.testXml.set(EGRESS_LOG_PATH, "garbage\nOUT nope\n");
    expect((await runSeatJob(deps(db, container), "j1")).status).toBe("completed");
    expect(db.egress.some((e) => !String(e.host).startsWith("r2:") && e.host !== "(interface)")).toBe(false);
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
    dead.start = async () => {
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
    dead.start = async () => {
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
    old.start = async () => {
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
    dead.start = async () => {
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
    flaky.start = async () => {
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
    const origHungExec = hung.exec.bind(hung);
    // Only the checkout call wedges; fast metadata reads (NIC sample)
    // still answer, as they would on a real slow-but-alive container.
    hung.exec = (cmd: string[], opts?: ExecOptions) =>
      cmd[0] === "sh" && cmd[1] === "-s" ? new Promise<ExecHandle>(() => undefined) : origHungExec(cmd, opts);
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

  it("checks out from the artifacts mirror when configured", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: MIRROR_TEMPLATE, mirrorToken: "mirror-secret" }),
      "j1",
    );
    expect(out.status).toBe("completed");
    const checkouts = container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(checkouts).toHaveLength(1);
    expect(stdinText(checkouts[0])).toContain("artifacts.cloudflare.net/git/mirrors/o-r.git");
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] checkout ok (mirror)");
  });

  it("falls back to github when the mirror fails", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.mirrorExit = 128;
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: MIRROR_TEMPLATE, mirrorToken: "mirror-secret" }),
      "j1",
    );
    expect(out.status).toBe("completed");
    const checkouts = container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(checkouts).toHaveLength(2);
    expect(stdinText(checkouts[0])).toContain("artifacts.cloudflare.net");
    expect(stdinText(checkouts[1])).toContain("github.com/o/r.git");
    const log = db.jobs.get("j1")?.log as string;
    expect(log).toContain("[seat] mirror unavailable, trying github");
    expect(log).toContain("[seat] checkout ok");
    expect(log).not.toContain("(mirror)");
  });

  it("parses mirror template namespaces and rendered repo names", () => {
    expect(mirrorNamespaceFor(MIRROR_TEMPLATE)).toBe("mirrors");
    expect(mirrorNamespaceFor("https://evil.example/{repo}.git")).toBeNull();
    expect(mirrorRepoFor("https://a54b12fe3ef06df16ff0041d79c18fc0.artifacts.cloudflare.net/git/mirrors/o-r.git")).toBe("o-r");
    expect(mirrorRepoFor("https://github.com/o/r.git")).toBeNull();
  });

  it("mints a per-job mirror token inside the binding namespace", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    const minted: string[] = [];
    const artifacts: SeatArtifactsNamespace = {
      get: async (name: string) => {
        minted.push(name);
        return {
          createToken: async () => ({ plaintext: "job-minted?expires=9999999999" }),
          [Symbol.dispose]: () => undefined,
        };
      },
    };
    const template = MIRROR_TEMPLATE.replace("/git/mirrors/", "/git/flare-tournaments/");
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: template, artifacts, artifactsNamespace: "flare-tournaments" }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(minted).toEqual(["o-r"]);
    const checkouts = container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(checkouts).toHaveLength(1);
    expect(stdinText(checkouts[0])).toContain("x-access-token:job-minted@");
    expect(stdinText(checkouts[0])).toContain("git/flare-tournaments/o-r.git");
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] checkout ok (mirror)");
  });

  it("falls back to the shared token outside the binding namespace", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    let minted = 0;
    const artifacts: SeatArtifactsNamespace = {
      get: async () => {
        minted += 1;
        return {
          createToken: async () => ({ plaintext: "job-minted?expires=9999999999" }),
          [Symbol.dispose]: () => undefined,
        };
      },
    };
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: MIRROR_TEMPLATE, mirrorToken: "shared-secret", artifacts, artifactsNamespace: "flare-tournaments" }),
      "j1",
    );
    expect(out.status).toBe("completed");
    expect(minted).toBe(0);
    const checkouts = container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(stdinText(checkouts[0])).toContain("x-access-token:shared-secret@");
  });

  it("scrubs the minted mirror token when checkout fails", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.mirrorExit = 128;
    container.checkoutExit = 128;
    container.coStderr = "fatal: https://x-access-token:job-minted@host/git/ns/o-r.git: auth failed";
    const artifacts: SeatArtifactsNamespace = {
      get: async () => ({
        createToken: async () => ({ plaintext: "job-minted?expires=9999999999" }),
        [Symbol.dispose]: () => undefined,
      }),
    };
    const template = MIRROR_TEMPLATE.replace("/git/mirrors/", "/git/flare-tournaments/");
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: template, artifacts, artifactsNamespace: "flare-tournaments" }),
      "j1",
    );
    expect(out.status).toBe("released");
    const detail = (out as { detail: string }).detail;
    expect(detail).not.toContain("job-minted");
    expect(detail).toContain("[redacted]");
    expect(db.jobs.get("j1")?.log as string).not.toContain("job-minted");
  });

  it("goes straight to github on an invalid mirror template", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: "https://evil.example/{repo}.git", mirrorToken: "mirror-secret" }),
      "j1",
    );
    expect(out.status).toBe("completed");
    const checkouts = container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(checkouts).toHaveLength(1);
    expect(stdinText(checkouts[0])).not.toContain("artifacts");
  });

  it("checks out artifacts runs from the fork with a minted token", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const run = db.runs.get("r1")!;
    run["event"] = "artifacts";
    run["repo"] = "flare-tournaments/tournament-canary";
    run["sha"] = "e3359ae1ebc1ef774437e4dfeedb6a4d511b7f9e";
    const container = new FakeContainer();
    const artifacts: SeatArtifactsNamespace = {
      get: async () => ({
        createToken: async () => ({ plaintext: "art-v1_mintedsecret?expires=9999999999" }),
        [Symbol.dispose]: () => undefined,
      }),
    };
    const out = await runSeatJob(deps(db, container, { mirrorRemote: MIRROR_TEMPLATE, artifacts }), "j1");
    expect(out.status).toBe("completed");
    const checkouts = container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(checkouts).toHaveLength(1);
    expect(stdinText(checkouts[0])).toContain("git/flare-tournaments/tournament-canary.git");
    expect(stdinText(checkouts[0])).not.toContain("github.com");
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] checkout ok (artifacts)");
  });

  it("releases artifacts runs when the token cannot be minted", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const run = db.runs.get("r1")!;
    run["event"] = "artifacts";
    run["repo"] = "flare-tournaments/tournament-canary";
    const container = new FakeContainer();
    const out = await runSeatJob(deps(db, container, { mirrorRemote: MIRROR_TEMPLATE }), "j1");
    expect(out.status).toBe("released");
    expect((out as { detail: string }).detail).toContain("token mint failed");
    expect(container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s")).toHaveLength(0);
  });

  it("scrubs the minted token when artifacts checkout fails", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const run = db.runs.get("r1")!;
    run["event"] = "artifacts";
    run["repo"] = "flare-tournaments/tournament-canary";
    const container = new FakeContainer();
    container.mirrorExit = 128;
    container.coStderr = "fatal: https://x:art-v1_mintedsecret@host/git/flare-tournaments/tournament-canary.git: auth failed";
    const artifacts: SeatArtifactsNamespace = {
      get: async () => ({
        createToken: async () => ({ plaintext: "art-v1_mintedsecret?expires=9999999999" }),
        [Symbol.dispose]: () => undefined,
      }),
    };
    const out = await runSeatJob(deps(db, container, { mirrorRemote: MIRROR_TEMPLATE, artifacts }), "j1");
    expect(out.status).toBe("released");
    const detail = (out as { detail: string }).detail;
    expect(detail).toContain("checkout failed (artifacts:");
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("art-v1_mintedsecret");
    expect(db.jobs.get("j1")?.log as string).not.toContain("art-v1_mintedsecret");
  });

  it("scrubs both tokens when checkout fails everywhere", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.mirrorExit = 128;
    container.checkoutExit = 128;
    container.coStderr = "fatal: https://x-access-token:mirror-secret@host/git/mirrors/o-r.git: auth failed";
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: MIRROR_TEMPLATE, mirrorToken: "mirror-secret" }),
      "j1",
    );
    expect(out.status).toBe("released");
    const detail = (out as { detail: string }).detail;
    expect(detail).toContain("checkout failed (mirror:");
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("mirror-secret");
    expect(db.jobs.get("j1")?.log as string).not.toContain("mirror-secret");
  });

  it("URL-encodes expiring mirror tokens and scrubs the encoded form", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const container = new FakeContainer();
    container.mirrorExit = 128;
    container.checkoutExit = 128;
    // git echoes the URL as embedded: with the token URL-encoded.
    container.coStderr = "fatal: https://x-access-token:abc%3Fexpires%3D1@host/git/mirrors/o-r.git: auth failed";
    const out = await runSeatJob(
      deps(db, container, { mirrorRemote: MIRROR_TEMPLATE, mirrorToken: "abc?expires=1" }),
      "j1",
    );
    expect(out.status).toBe("released");
    const checkouts = container.calls.filter((c) => c.cmd[0] === "sh" && c.cmd[1] === "-s");
    expect(stdinText(checkouts[0])).toContain("x-access-token:abc%3Fexpires%3D1@");
    const detail = (out as { detail: string }).detail;
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("abc%3Fexpires%3D1");
    expect(detail).not.toContain("abc?expires=1");
  });

  it("runs browser checks after successful steps and stores screenshots", async () => {
    const db = new MemDb();
    seed(db, DEF({ browserChecks: [{ name: "home", url: "https://example.com/", expectTitle: "Example" }] }));
    const container = new FakeContainer();
    const browser = fakeBrowser({ "https://example.com/": { title: "Example Domain", shot: true } });
    const spy = spyCache();
    const d = deps(db, container, { browser });
    d.cache = spy.cache;
    const out = await runSeatJob(d, "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("success");
    expect(browser.calls).toEqual(["https://example.com/"]);
    expect(spy.puts.get("artifacts/j1/browser-home.png")).toEqual(new TextEncoder().encode("png-bytes"));
    expect(db.jobs.get("j1")?.log as string).toContain("--- browser home: https://example.com/ ---");
  });

  it("fails the job when a browser assertion misses", async () => {
    const db = new MemDb();
    seed(
      db,
      DEF({
        browserChecks: [
          { name: "home", url: "https://example.com/", expectTitle: "Nope" },
          { name: "docs", url: "https://example.com/docs", expectText: "missing-bit" },
        ],
      }),
    );
    const container = new FakeContainer();
    const browser = fakeBrowser({
      "https://example.com/": { title: "Example Domain", text: "hello" },
      "https://example.com/docs": { title: "Docs", text: "hello" },
    });
    const out = await runSeatJob(deps(db, container, { browser }), "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("failure");
    const log = db.jobs.get("j1")?.log as string;
    expect(log).toContain("missing");
    // Both checks run (full signal), not just the first failure.
    expect(browser.calls).toEqual(["https://example.com/", "https://example.com/docs"]);
  });

  it("fails closed without the BROWSER binding", async () => {
    const db = new MemDb();
    seed(db, DEF({ browserChecks: [{ name: "home", url: "https://example.com/", expectTitle: "Example" }] }));
    const out = await runSeatJob(deps(db, new FakeContainer()), "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("failure");
    expect(db.jobs.get("j1")?.log as string).toContain("need the BROWSER binding");
  });

  it("skips browser checks when steps fail and honors screenshot:false", async () => {
    const db = new MemDb();
    seed(db, DEF({ browserChecks: [{ name: "home", url: "https://example.com/", expectTitle: "Example" }] }));
    const container = new FakeContainer();
    container.stepExits = [1];
    const browser = fakeBrowser({ "https://example.com/": { title: "Example Domain" } });
    const out = await runSeatJob(deps(db, container, { browser }), "j1");
    expect(db.jobs.get("j1")?.status).toBe("failure");
    expect(db.jobs.get("j1")?.log as string).toContain("browser checks skipped");
    expect(browser.calls).toEqual([]);
    expect(out.status).toBe("completed");

    const db2 = new MemDb();
    seed(db2, DEF({ browserChecks: [{ name: "home", url: "https://example.com/", expectTitle: "Example", screenshot: false }] }));
    const container2 = new FakeContainer();
    const browser2 = fakeBrowser({ "https://example.com/": { title: "Example Domain", shot: true } });
    const spy = spyCache();
    const d2 = deps(db2, container2, { browser: browser2 });
    d2.cache = spy.cache;
    expect((await runSeatJob(d2, "j1")).status).toBe("completed");
    expect(db2.jobs.get("j1")?.status).toBe("success");
    expect([...spy.puts.keys()]).toEqual([]);
  });

  it("treats driver errors as check failures", async () => {
    const db = new MemDb();
    seed(db, DEF({ browserChecks: [{ name: "home", url: "https://example.com/", expectTitle: "Example" }] }));
    const container = new FakeContainer();
    const browser = fakeBrowser({ "https://example.com/": { title: "", throws: "session limit reached" } });
    const out = await runSeatJob(deps(db, container, { browser }), "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("failure");
    expect(db.jobs.get("j1")?.log as string).toContain("browser error: session limit reached");
  });

  it("releases fast when the container stops mid-checkout (monitor race)", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const stopped = new FakeContainer();
    stopped.stopOnBoot = true;
    // A dead container never answers exec: hang the checkout call so
    // only the stop signal can settle the race (checkoutMs is generous
    // to prove the monitor, not the clock, ended it).
    const origExec = stopped.exec.bind(stopped);
    stopped.exec = (cmd: string[], opts?: ExecOptions) =>
      cmd[0] === "sh" && cmd[1] === "-s"
        ? Promise.resolve({ pid: 1, output: () => new Promise<never>(() => undefined), kill: () => undefined })
        : origExec(cmd, opts);
    const out = await runSeatJob(
      deps(db, stopped, {
        timing: { startWaitMs: 5, startAttempts: 1, startPollMs: 1, stepMs: 60000, blobMs: 100, checkoutMs: 60000 },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
      "j1",
    );
    expect(out.status).toBe("released");
    expect((out as { detail: string }).detail).toContain("container stopped unexpectedly");
  });

  it("fails the job when the container stops mid-step", async () => {
    const db = new MemDb();
    seed(db, DEF());
    const dying = new FakeContainer();
    const origExec = dying.exec.bind(dying);
    let steps = 0;
    dying.exec = (cmd: string[], opts?: ExecOptions) => {
      if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2]?.startsWith("sh -s >")) {
        steps += 1;
        if (steps === 2) {
          dying.stopNow();
          return Promise.resolve({ pid: 1, output: () => new Promise<never>(() => undefined), kill: () => undefined });
        }
      }
      return origExec(cmd, opts);
    };
    const out = await runSeatJob(deps(db, dying), "j1");
    expect(out.status).toBe("completed");
    expect(db.jobs.get("j1")?.status).toBe("failure");
    expect(db.jobs.get("j1")?.log as string).toContain("[seat] container stopped unexpectedly");
    expect(db.jobs.get("j1")?.log as string).toContain("(exit 125");
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
