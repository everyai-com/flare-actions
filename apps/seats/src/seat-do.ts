import { DurableObject } from "cloudflare:workers";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { runSeatJob, type ContainerCtl, type ContainerStartOptions, type SeatDeps } from "./seat";
import { runBrowserCheck } from "./browsercheck";
import { resolveAppCreds } from "../../worker/src/connect";
import { markJobRetained } from "../../worker/src/db";
import { basinSink } from "../../worker/src/basin";

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
  return {
    db: env.DB,
    cache: env.CACHE,
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
    mail: { EMAIL: env.EMAIL, NOTIFY_FROM_EMAIL: env.NOTIFY_FROM_EMAIL, SECRETS_KEY: env.SECRETS_KEY },
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
