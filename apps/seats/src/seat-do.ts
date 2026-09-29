import { DurableObject } from "cloudflare:workers";
import { runSeatJob, type ContainerCtl, type ContainerStartOptions } from "./seat";
import { resolveAppCreds } from "../../worker/src/connect";

export interface SeatsEnv {
  DB: D1Database;
  CACHE: R2Bucket;
  RUN_QUEUE: Queue;
  SEAT_QUEUE: Queue;
  AI: Ai;
  SEATS: DurableObjectNamespace;
  ENVIRONMENT: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  SEATS_TOKEN?: string;
}

type BoundContainer = NonNullable<DurableObjectState["container"]>;

function streamOf(data: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
}

function adapt(container: BoundContainer): ContainerCtl {
  return {
    get running() {
      return container.running;
    },
    start: (opts?: ContainerStartOptions) => {
      // enableInternet is required whenever options are passed.
      if (opts) container.start({ enableInternet: opts.enableInternet ?? false });
      else container.start();
    },
    destroy: () => container.destroy(),
    exec: async (cmd, opts) => {
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
    },
  };
}

// One seat (one container) per job, addressed by job id. /run
// executes inline and answers with the outcome: the open request
// keeps the seat alive across long steps and idle container waits,
// where a detached waitUntil could hibernate mid-job and strand the
// claim. Queue wakes therefore ack after completion (natural retry),
// and concurrent wakes for one job are settled by the atomic claim.
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
      // Same D1 the main worker stores Connect-flow credentials in, so
      // connecting once on the dashboard lights up private checkouts
      // on seats with no extra secrets.
      const creds = await resolveAppCreds(env.DB, { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY });
      const outcome = await runSeatJob(
        {
          db: env.DB,
          cache: env.CACHE,
          queue: env.RUN_QUEUE,
          seatQueue: env.SEAT_QUEUE,
          ai: env.AI,
          appId: creds?.appId,
          appKey: creds?.privateKey,
          container: adapt(container),
          spawn: async (id: string) => {
            const stub = env.SEATS.get(env.SEATS.idFromName(`job-${id}`));
            await stub.fetch(
              new Request("https://seat/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jobId: id }),
              }),
            );
          },
        },
        jobId,
      );
      return Response.json({ ok: true, ...outcome });
    } catch (err) {
      console.log(JSON.stringify({ msg: "seat crashed", jobId, error: String(err) }));
      return Response.json({ ok: false, jobId, error: String(err).slice(0, 300) }, { status: 500 });
    }
  }
}
