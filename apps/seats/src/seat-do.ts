import { DurableObject } from "cloudflare:workers";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { DirectoryBackup, Files, S3Mount } from "@cloudflare/sandbox";
import type { DirectoryBackupGatewayBinding, S3GatewayBinding } from "@cloudflare/sandbox";
import { runSeatJob, type ContainerCtl, type ContainerStartOptions, type SeatDeps } from "./seat";
import {
  BoxError,
  createBox,
  destroyBox,
  execBox,
  fetchBox,
  restoreBox,
  snapshotBox,
  syncBox,
  type BoxDeps,
} from "./box";
import { runBrowserCheck } from "./browsercheck";
import { resolveAppCreds } from "../../worker/src/connect";
import { markJobRetained } from "../../worker/src/db";
import { basinSink } from "../../worker/src/basin";
import {
  adaptDirBackup,
  adaptFiles,
  adaptMount,
  type S3MountStaticConfig,
} from "./sandbox-fs";

export interface SeatsEnv {
  DB: D1Database;
  CACHE: R2Bucket;
  RUN_QUEUE: Queue;
  SEAT_QUEUE: Queue;
  AI: Ai;
  ANALYTICS?: AnalyticsEngineDataset;
  BROWSER?: BrowserWorker;
  EMAIL?: SendEmail;
  SEATS: DurableObjectNamespace;
  SEATS_V2: DurableObjectNamespace;
  BOXES: DurableObjectNamespace;
  ENVIRONMENT: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  SEATS_TOKEN?: string;
  NOTIFY_FROM_EMAIL?: string;
  SECRETS_KEY?: string;
  AI_GATEWAY_ID?: string;
  TRIAGE_WEB_SEARCH?: string;
  TRIAGE_MODEL?: string;
  ARTIFACTS_MIRROR_REMOTE?: string;
  ARTIFACTS_MIRROR_TOKEN?: string;
  ARTIFACTS_NAMESPACE?: string;
  ARTIFACTS?: Artifacts;
  // R2 S3-API surface for Sandbox SDK cache-bucket mounts (S3Mount
  // signs through the Worker; the sandbox never sees the secret).
  // Unset = no mount dep; seat flows never mount by themselves.
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  // "1" marks the hosted Flare Cloud control plane (env-only, like the
  // main worker — self-hosted seats never meter). See cloud.ts.
  FLARE_CLOUD?: string;
}

type BoundContainer = NonNullable<DurableObjectState["container"]>;

function streamOf(data: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
}

function baseExec(container: BoundContainer): ContainerCtl["exec"] {
  return async (cmd, opts) => {
    const proc = await container.exec(cmd, {
      ...(opts?.stdin !== undefined ? { stdin: streamOf(opts.stdin) } : {}),
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    return {
      pid: proc.pid,
      output: async () => {
        const o = await proc.output();
        return { exitCode: o.exitCode, stdout: new Uint8Array(o.stdout), stderr: new Uint8Array(o.stderr) };
      },
      kill: (signal?: number) => proc.kill(signal),
    };
  };
}

// V1 adapter (default scheduling policy): image comes from wrangler
// config, so only enableInternet is forwarded.
function adaptV1(container: BoundContainer): ContainerCtl {
  return {
    get running() {
      return container.running;
    },
    start: async (opts?: ContainerStartOptions) => {
      // enableInternet is required whenever options are passed.
      if (opts) container.start({ enableInternet: opts.enableInternet ?? false });
      else container.start();
    },
    destroy: () => {
      container.destroy().catch(() => undefined);
    },
    exec: baseExec(container),
    snapshot: async () => {
      throw new Error("snapshots need the durable_object scheduling policy (V2 seats)");
    },
    monitor: () => container.monitor(),
  };
}

// Inactivity window per execution: the longest job timeout (180m) plus
// checkout/cache/artifacts margin, under the 6h platform cap. The
// minute alarm below re-arms it, and runSeatJob destroys the instance
// at the end, so nothing lingers warm.
const SEAT_INACTIVITY_MS = 4 * 60 * 60 * 1000;
const SEAT_ALARM_MS = 60 * 1000;

// V2 adapter (durable_object policy): full start config plus
// snapshots. Sets the inactivity timeout on every start — timeouts do
// not survive DO restarts, so the constructor re-arms them too.
function adaptV2(container: BoundContainer): ContainerCtl {
  return {
    get running() {
      return container.running;
    },
    start: async (opts?: ContainerStartOptions) => {
      if (opts?.snapshotId) {
        container.start({
          enableInternet: opts.enableInternet ?? false,
          containerSnapshot: { id: opts.snapshotId },
          ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}),
          ...(opts.env ? { env: opts.env } : {}),
        });
      } else if (opts?.image) {
        container.start({
          enableInternet: opts.enableInternet ?? false,
          image: opts.image,
          ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}),
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.instance ? { instance: opts.instance } : {}),
        });
      } else if (opts) {
        container.start({ enableInternet: opts.enableInternet ?? false });
      } else {
        container.start();
      }
      await container.setInactivityTimeout(SEAT_INACTIVITY_MS);
    },
    destroy: () => {
      container.destroy().catch(() => undefined);
    },
    exec: baseExec(container),
    snapshot: async (name?: string) => {
      const snap = await container.snapshotContainer(name ? { name } : undefined);
      return { id: snap.id, size: snap.size, name: snap.name };
    },
    monitor: () => container.monitor(),
  };
}

// Sandbox SDK gateway loopback (ctx.exports.S3Gateway /
// .DirectoryBackupGateway, exported from index.ts). Shape-agnostic:
// the generated MainModule type covers the main worker, not seats,
// so read structurally and fail closed when the export is missing.
function gatewayBinding<T>(doCtx: DurableObjectState, key: string, name: string): T {
  const rec: unknown = doCtx.exports;
  const value = typeof rec === "object" && rec !== null ? (rec as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "function") throw new Error(`${name} gateway is not exported from the seats worker`);
  return value as T;
}

async function seatDeps(
  env: SeatsEnv,
  container: BoundContainer,
  v2: boolean,
  doCtx: DurableObjectState,
): Promise<SeatDeps> {
  // Same D1 the main worker stores Connect-flow credentials in, so
  // connecting once on the dashboard lights up private checkouts
  // on seats with no extra secrets.
  const creds = await resolveAppCreds(
    env.DB,
    { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY },
    env.SECRETS_KEY,
  );
  const browserBinding = env.BROWSER;
  const s3cfg: S3MountStaticConfig | null =
    env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          endpoint: env.S3_ENDPOINT,
          region: "auto",
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        }
      : null;
  return {
    db: env.DB,
    cache: env.CACHE,
    // Sandbox SDK 1.0 file utilities. Files rides exec + the in-image
    // shim (pre-shim images fail with PROTOCOL and seat flows fall
    // back to exec); backups need the V2 intercept path; mounts need
    // R2 S3 credentials and stay latent until a flow mounts.
    fs: adaptFiles(new Files(container)),
    ...(v2
      ? {
          dirBackup: adaptDirBackup(
            new DirectoryBackup(
              container,
              gatewayBinding<DirectoryBackupGatewayBinding>(doCtx, "DirectoryBackupGateway", "DirectoryBackup"),
              { binding: "CACHE", prefix: "seat-workspaces/" },
            ),
          ),
        }
      : {}),
    ...(s3cfg
      ? { mount: adaptMount(new S3Mount(container, gatewayBinding<S3GatewayBinding>(doCtx, "S3Gateway", "S3")), s3cfg) }
      : {}),
    queue: env.RUN_QUEUE,
    seatQueue: env.SEAT_QUEUE,
    ai: env.AI,
    analytics: env.ANALYTICS,
    basin: basinSink(env, doCtx),
    browser: browserBinding
      ? { check: (url, opts) => runBrowserCheck(browserBinding, url, opts) }
      : undefined,
    appId: creds?.appId,
    appKey: creds?.privateKey,
    mirrorRemote: env.ARTIFACTS_MIRROR_REMOTE,
    mirrorToken: env.ARTIFACTS_MIRROR_TOKEN,
    artifacts: env.ARTIFACTS ?? null,
    artifactsNamespace: env.ARTIFACTS_NAMESPACE,
    mail: { EMAIL: env.EMAIL, NOTIFY_FROM_EMAIL: env.NOTIFY_FROM_EMAIL, SECRETS_KEY: env.SECRETS_KEY },
    hosted: env.FLARE_CLOUD === "1" ? true : undefined,
    secretsKey: env.SECRETS_KEY,
    gatewayId: env.AI_GATEWAY_ID,
    webSearch: env.TRIAGE_WEB_SEARCH === "1" ? true : undefined,
    triageModel: env.TRIAGE_MODEL,
    container: v2 ? adaptV2(container) : adaptV1(container),
    ...(v2
      ? {
          containerStart: {
            image: container.images["seat"],
            entrypoint: ["sleep", "infinity"],
          } satisfies ContainerStartOptions,
        }
      : {}),
    spawn: async (id: string) => {
      const ns = v2 ? env.SEATS_V2 : env.SEATS;
      const stub = ns.get(ns.idFromName(`job-${id}`));
      await stub.fetch(
        new Request("https://seat/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: id }),
        }),
      );
    },
  };
}

// One seat (one container) per job, addressed by job id. /run
// executes inline and answers with the outcome. Pending I/O
// (container.monitor(), exec output, timers) keeps the DO alive
// without a connected client on compat 2026-10-01+, so the old "open
// request keeps the seat alive" constraint is retired — but /run still
// answers inline deliberately: queue wakes ack after completion
// (natural retry), and concurrent wakes for one job are settled by
// the atomic claim.
export class ContainerSeat extends DurableObject<SeatsEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/run") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
    if (typeof body.jobId !== "string" || !body.jobId) {
      return Response.json({ error: "jobId required" }, { status: 400 });
    }
    const container = this.ctx.container;
    if (!container) return Response.json({ error: "no container bound" }, { status: 500 });
    const jobId = body.jobId;
    const env = this.env;
    try {
      const outcome = await runSeatJob(await seatDeps(env, container, false, this.ctx), jobId);
      return Response.json({ ok: true, ...outcome });
    } catch (err) {
      console.log(JSON.stringify({ msg: "seat crashed", jobId, error: String(err) }));
      return Response.json({ ok: false, jobId, error: String(err).slice(0, 300) }, { status: 500 });
    }
  }
}

// V2: durable_object scheduling policy (per-start image/snapshot/
// instance) plus alarm keep-alive. Same /run contract as V1; the
// seats index routes new jobs here, and in-flight V1 jobs finish on
// V1, so cutover and rollback are both one-line binding swaps.
export class ContainerSeatV2 extends DurableObject<SeatsEnv> {
  constructor(ctx: DurableObjectState, env: SeatsEnv) {
    super(ctx, env);
    // Timeouts do not survive restarts: if an instance outlived one,
    // hold it again before the first request lands.
    if (ctx.container?.running) {
      ctx.blockConcurrencyWhile(async () => {
        await ctx.container?.setInactivityTimeout(SEAT_INACTIVITY_MS).catch(() => undefined);
      });
    }
  }

  // Minute heartbeat while a job runs: code inside the instance does
  // not count as activity, so without this the timeout would SIGTERM
  // long builds mid-step. Doubles as the retain-on-failure enforcer.
  async alarm(): Promise<void> {
    // Retain-on-failure deadline: hold the kept container until its
    // deadline, then destroy it and clear the job row.
    const retained = await this.ctx.storage.get<{ jobId: string; until: string }>("retainedJob");
    if (retained) {
      if (!Number.isFinite(Date.parse(retained.until)) || Date.now() >= Date.parse(retained.until)) {
        try {
          await this.ctx.container?.destroy();
        } catch {
          // Already gone.
        }
        await this.ctx.storage.delete("retainedJob").catch(() => undefined);
        await this.ctx.storage.delete("activeJob").catch(() => undefined);
        try {
          await markJobRetained(this.env.DB, retained.jobId, null);
        } catch {
          // Discovery only.
        }
        await this.ctx.storage.deleteAlarm().catch(() => undefined);
        return;
      }
      await this.ctx.container?.setInactivityTimeout(SEAT_INACTIVITY_MS).catch(() => undefined);
      await this.ctx.storage.setAlarm(Date.parse(retained.until)).catch(() => undefined);
      return;
    }
    if ((await this.ctx.storage.get("activeJob")) && this.ctx.container) {
      await this.ctx.container.setInactivityTimeout(SEAT_INACTIVITY_MS).catch(() => undefined);
      await this.ctx.storage.setAlarm(Date.now() + SEAT_ALARM_MS).catch(() => undefined);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/run") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
    if (typeof body.jobId !== "string" || !body.jobId) {
      return Response.json({ error: "jobId required" }, { status: 400 });
    }
    const container = this.ctx.container;
    if (!container) return Response.json({ error: "no container bound" }, { status: 500 });
    if (!container.images["seat"]) {
      return Response.json({ error: "seat image not configured (durable_object policy)" }, { status: 500 });
    }
    const jobId = body.jobId;
    const env = this.env;
    try {
      await this.ctx.storage.put("activeJob", jobId);
      await this.ctx.storage.setAlarm(Date.now() + SEAT_ALARM_MS).catch(() => undefined);
      const outcome = await runSeatJob(await seatDeps(env, container, true, this.ctx), jobId);
      if (outcome.status === "retained") {
        await this.ctx.storage.put("retainedJob", { jobId, until: outcome.retainedUntil });
        await this.ctx.storage.setAlarm(Date.parse(outcome.retainedUntil)).catch(() => undefined);
        return Response.json({ ok: true, ...outcome });
      }
      await this.ctx.storage.delete("activeJob").catch(() => undefined);
      await this.ctx.storage.deleteAlarm().catch(() => undefined);
      return Response.json({ ok: true, ...outcome });
    } catch (err) {
      await this.ctx.storage.delete("activeJob").catch(() => undefined);
      await this.ctx.storage.deleteAlarm().catch(() => undefined);
      console.log(JSON.stringify({ msg: "seat crashed", jobId, error: String(err) }));
      return Response.json({ ok: false, jobId, error: String(err).slice(0, 300) }, { status: 500 });
    }
  }
}

const BOX_OPS = ["create", "exec", "sync", "fetch", "snapshot", "restore", "destroy"] as const;
type BoxOp = (typeof BOX_OPS)[number];

function boxStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

// One warm dev box per name, addressed as `box-<name>` by the seats
// index. The container sleeps between ops (inactivity timeout) and
// wakes on demand; box.ts owns the registry + filesystem logic, this
// class owns bindings, body validation, and the keep-alive alarm that
// holds long execs/snapshots past the inactivity timeout.
export class BoxSeat extends DurableObject<SeatsEnv> {
  constructor(ctx: DurableObjectState, env: SeatsEnv) {
    super(ctx, env);
    if (ctx.container?.running) {
      ctx.blockConcurrencyWhile(async () => {
        await ctx.container?.setInactivityTimeout(SEAT_INACTIVITY_MS).catch(() => undefined);
      });
    }
  }

  async alarm(): Promise<void> {
    if ((await this.ctx.storage.get("activeBoxOp")) && this.ctx.container) {
      await this.ctx.container.setInactivityTimeout(SEAT_INACTIVITY_MS).catch(() => undefined);
      await this.ctx.storage.setAlarm(Date.now() + SEAT_ALARM_MS).catch(() => undefined);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.startsWith("/box/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const op = url.pathname.slice("/box/".length);
    if (!(BOX_OPS as readonly string[]).includes(op)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return Response.json({ error: "JSON body required" }, { status: 400 });
    }
    const name = body.name;
    if (typeof name !== "string" || !name) {
      return Response.json({ error: "name required" }, { status: 400 });
    }
    const container = this.ctx.container;
    if (!container) return Response.json({ error: "no container bound" }, { status: 500 });
    const seatImage = container.images["seat"];
    if (!seatImage) {
      return Response.json({ error: "seat image not configured (durable_object policy)" }, { status: 500 });
    }
    const deps: BoxDeps = { db: this.env.DB, container: adaptV2(container), fs: adaptFiles(new Files(container)), seatImage };
    // destroy is instant (no container I/O to protect); every other op
    // holds the box awake until it answers.
    const keepalive = op !== "destroy";
    try {
      if (keepalive) {
        await this.ctx.storage.put("activeBoxOp", op);
        await this.ctx.storage.setAlarm(Date.now() + SEAT_ALARM_MS).catch(() => undefined);
      }
      try {
        return await this.dispatch(op as BoxOp, deps, name, body);
      } finally {
        if (keepalive) {
          await this.ctx.storage.delete("activeBoxOp").catch(() => undefined);
          await this.ctx.storage.deleteAlarm().catch(() => undefined);
        }
      }
    } catch (err) {
      if (err instanceof BoxError) {
        return Response.json({ ok: false, error: err.message }, { status: err.status });
      }
      console.log(JSON.stringify({ msg: "box op crashed", op, error: String(err) }));
      return Response.json({ ok: false, error: String(err).slice(0, 300) }, { status: 500 });
    }
  }

  private async dispatch(op: BoxOp, deps: BoxDeps, name: string, body: Record<string, unknown>): Promise<Response> {
    switch (op) {
      case "create": {
        if (body.image !== undefined && typeof body.image !== "string") {
          return Response.json({ error: "image must be a string" }, { status: 400 });
        }
        const box = await createBox(deps, name, body.image as string | undefined);
        return Response.json({ ok: true, box });
      }
      case "exec": {
        if (!Array.isArray(body.command) || !body.command.every((a) => typeof a === "string")) {
          return Response.json({ error: "command must be a string array" }, { status: 400 });
        }
        if (body.cwd !== undefined && typeof body.cwd !== "string") {
          return Response.json({ error: "cwd must be a string" }, { status: 400 });
        }
        let env: Record<string, string> | undefined;
        if (body.env !== undefined) {
          env = boxStringRecord(body.env) ?? undefined;
          if (!env) return Response.json({ error: "env must be a string map" }, { status: 400 });
        }
        const res = await execBox(deps, name, body.command as string[], {
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
          ...(env ? { env } : {}),
        });
        return Response.json({ ok: true, ...res });
      }
      case "sync": {
        if (!Array.isArray(body.files)) {
          return Response.json({ error: "files must be an array" }, { status: 400 });
        }
        for (const f of body.files) {
          const rec = f as Record<string, unknown> | null;
          if (typeof rec !== "object" || rec === null || typeof rec.path !== "string" || typeof rec.content_b64 !== "string") {
            return Response.json({ error: "each file needs {path, content_b64} strings" }, { status: 400 });
          }
        }
        const res = await syncBox(deps, name, body.files as { path: string; content_b64: string }[]);
        return Response.json({ ok: true, ...res });
      }
      case "fetch": {
        if (typeof body.path !== "string") {
          return Response.json({ error: "path required" }, { status: 400 });
        }
        const res = await fetchBox(deps, name, body.path);
        return Response.json({ ok: true, ...res });
      }
      case "snapshot": {
        if (body.tag !== undefined && typeof body.tag !== "string") {
          return Response.json({ error: "tag must be a string" }, { status: 400 });
        }
        const snap = await snapshotBox(deps, name, body.tag as string | undefined);
        return Response.json({ ok: true, snapshot: snap });
      }
      case "restore": {
        if (typeof body.tag !== "string") {
          return Response.json({ error: "tag required" }, { status: 400 });
        }
        const box = await restoreBox(deps, name, body.tag);
        return Response.json({ ok: true, box });
      }
      case "destroy": {
        const res = await destroyBox(deps, name);
        return Response.json({ ok: true, ...res });
      }
    }
  }
}
