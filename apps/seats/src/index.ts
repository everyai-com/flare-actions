import { BoxSeat, ContainerSeat, ContainerSeatV2, type SeatsEnv } from "./seat-do";
import { boxDoName, listBoxes } from "./box";
import { seatTokenAuthorized } from "./seat";

export { BoxSeat, ContainerSeat, ContainerSeatV2 };
// Sandbox SDK gateways: the container reaches these through the
// outbound intercept (creds stay Worker-side); the DO passes
// ctx.exports.* into the SDK classes in seat-do.ts.
export { DirectoryBackupGateway, S3Gateway } from "@cloudflare/sandbox";

// Every non-health route needs the operator token: the same gate
// /run has always had, shared now that boxes add routes. Returns the
// rejection response, or null when the request is authorized.
async function seatsGate(request: Request, env: SeatsEnv, what: string): Promise<Response | null> {
  if (!env.SEATS_TOKEN) {
    console.log(JSON.stringify({ level: "warn", msg: `seat ${what} rejected: token not configured` }));
    return Response.json({ error: "seats token not configured" }, { status: 500 });
  }
  if (!(await seatTokenAuthorized(request, env.SEATS_TOKEN))) {
    console.log(JSON.stringify({ level: "warn", msg: `seat ${what} rejected: unauthorized` }));
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

const PUBLIC_BOX_OPS = ["create", "exec", "sync", "fetch", "snapshot", "restore", "destroy"];

export default {
  async fetch(request: Request, env: SeatsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "flare-actions-seats" });
    }
    // Remote dev boxes: list reads the D1 registry directly; every
    // other op forwards to the box's own DO (`box-<name>`).
    if (request.method === "GET" && url.pathname === "/v1/boxes") {
      const gate = await seatsGate(request, env, "boxes");
      if (gate) return gate;
      const boxes = await listBoxes({ db: env.DB });
      return Response.json({ ok: true, boxes });
    }
    if (request.method === "POST" && url.pathname.startsWith("/v1/box/")) {
      const op = url.pathname.slice("/v1/box/".length);
      if (!PUBLIC_BOX_OPS.includes(op)) return Response.json({ error: "not found" }, { status: 404 });
      const gate = await seatsGate(request, env, `box ${op}`);
      if (gate) return gate;
      const body = (await request.json().catch(() => ({}))) as { name?: unknown };
      if (typeof body.name !== "string" || !body.name) {
        return Response.json({ error: "name required" }, { status: 400 });
      }
      const stub = env.BOXES.get(env.BOXES.idFromName(boxDoName(body.name)));
      return stub.fetch(
        new Request(`https://box/box/${op}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/run") {
      const gate = await seatsGate(request, env, "run");
      if (gate) return gate;
      const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
      if (typeof body.jobId !== "string" || !body.jobId) {
        return Response.json({ error: "jobId required" }, { status: 400 });
      }
      console.log(JSON.stringify({ level: "info", msg: "seat run accepted", jobId: body.jobId }));
      // V2 (durable_object policy) serves new jobs; in-flight V1 jobs
      // finish on V1. Rollback: point these two stubs at env.SEATS.
      const stub = env.SEATS_V2.get(env.SEATS_V2.idFromName(`job-${body.jobId}`));
      return stub.fetch(
        new Request("https://seat/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: body.jobId }),
        }),
      );
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  // Queue wakes from the main worker. Seats run inline, so each wake
  // resolves with the outcome and acks after completion (natural
  // retry). Wakes fan out concurrently; the seat claim is idempotent,
  // so redeliveries are safe: only the first wake per job does work.
  async queue(batch: MessageBatch<{ jobId: string }>, env: SeatsEnv): Promise<void> {
    await Promise.all(
      batch.messages.map(async (msg) => {
        try {
          const jobId = msg.body?.jobId;
          if (typeof jobId !== "string" || !jobId) {
            msg.ack();
            return;
          }
          const stub = env.SEATS_V2.get(env.SEATS_V2.idFromName(`job-${jobId}`));
          await stub.fetch(
            new Request("https://seat/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jobId }),
            }),
          );
          msg.ack();
        } catch {
          msg.retry();
        }
      }),
    );
  },
};
