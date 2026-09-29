import { ContainerSeat, type SeatsEnv } from "./seat-do";
import { bytesEqual } from "../../worker/src/github";

export { ContainerSeat };

async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ") || !token) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  return bytesEqual(new Uint8Array(a), new Uint8Array(b));
}

export default {
  async fetch(request: Request, env: SeatsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "flare-actions-seats" });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      if (!env.SEATS_TOKEN) {
        console.log(JSON.stringify({ level: "warn", msg: "seat run rejected: token not configured" }));
        return Response.json({ error: "seats token not configured" }, { status: 500 });
      }
      if (!(await authorized(request, env.SEATS_TOKEN))) {
        console.log(JSON.stringify({ level: "warn", msg: "seat run rejected: unauthorized" }));
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
      if (typeof body.jobId !== "string" || !body.jobId) {
        return Response.json({ error: "jobId required" }, { status: 400 });
      }
      console.log(JSON.stringify({ level: "info", msg: "seat run accepted", jobId: body.jobId }));
      const stub = env.SEATS.get(env.SEATS.idFromName(`job-${body.jobId}`));
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
          const stub = env.SEATS.get(env.SEATS.idFromName(`job-${jobId}`));
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
