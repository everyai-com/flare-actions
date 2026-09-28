import {
  createJob,
  createRun,
  getJobsForRun,
  getRun,
  listRuns,
  nextQueuedJob,
  updateJob,
  updateRunStatus,
} from "./db";
import {
  bytesEqual,
  getInstallationToken,
  mintAppJwt,
  postCommitStatus,
  verifyGitHubSignature,
} from "./github";

// Secrets are set via `wrangler secret put` / `.dev.vars`, never in
// wrangler.jsonc. `wrangler types` may or may not include them in the
// generated Env depending on whether `.dev.vars` exists, so intersect
// as optional: this compiles in both cases. Run `npm run types` to
// regenerate bindings after config changes.
interface WorkerSecrets {
  GITHUB_WEBHOOK_SECRET?: string;
  RUNNER_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
}

type WorkerEnv = Env & WorkerSecrets;

interface QueueJobMessage {
  runId: string;
  jobId: string;
  repo: string;
  sha: string;
}

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return bytesEqual(new Uint8Array(da), new Uint8Array(db));
}

async function requireRunnerToken(request: Request, env: WorkerEnv): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ") || !env.RUNNER_TOKEN) return false;
  return timingSafeEqualStr(header.slice("Bearer ".length), env.RUNNER_TOKEN);
}

async function reportGitHubStatus(
  env: WorkerEnv,
  opts: { installationId: number | null; repo: string; sha: string; state: "pending" | "success" | "failure" | "error" },
): Promise<void> {
  try {
    if (!opts.installationId || !env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
      log("info", "github status skipped: app credentials not configured");
      return;
    }
    const jwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
    const token = await getInstallationToken(jwt, opts.installationId);
    if (!token) {
      log("warn", "github installation token mint failed");
      return;
    }
    const ok = await postCommitStatus(token, opts.repo, opts.sha, opts.state);
    log("info", "github status posted", { ok, repo: opts.repo, sha: opts.sha, state: opts.state });
  } catch (err) {
    log("error", "github status failed", { error: String(err) });
  }
}

interface GitHubWebhookPayload {
  repository?: { full_name?: string };
  after?: string;
  installation?: { id?: number };
  pull_request?: { head?: { sha?: string } };
}

async function handleWebhook(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  try {
    if (!env.GITHUB_WEBHOOK_SECRET) {
      log("error", "GITHUB_WEBHOOK_SECRET not configured");
      return json({ error: "server misconfigured" }, 500);
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_WEBHOOK_BYTES) {
      return json({ error: "payload too large" }, 413);
    }
    const valid = await verifyGitHubSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      env.GITHUB_WEBHOOK_SECRET,
    );
    if (!valid) return json({ error: "invalid signature" }, 401);

    const event = request.headers.get("x-github-event") ?? "unknown";
    const payload = JSON.parse(new TextDecoder().decode(raw)) as GitHubWebhookPayload;
    const repo = payload.repository?.full_name;
    const sha = payload.after ?? payload.pull_request?.head?.sha;
    if (!repo || !sha) return json({ error: "missing repo or sha" }, 400);

    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const installationId = payload.installation?.id ?? null;
    await createRun(env.DB, { id: runId, repo, sha, event, installationId });
    await createJob(env.DB, jobId, runId);
    await env.RUN_QUEUE.send({ runId, jobId, repo, sha } satisfies QueueJobMessage);

    log("info", "run queued", { runId, jobId, repo, sha, event });
    ctx.waitUntil(reportGitHubStatus(env, { installationId, repo, sha, state: "pending" }));
    return json({ runId, jobId }, 202);
  } catch (err) {
    log("error", "webhook failed", { error: String(err) });
    return json({ error: "webhook failed" }, 500);
  }
}

async function handleStatusCallback(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  runId: string,
): Promise<Response> {
  try {
    if (!(await requireRunnerToken(request, env))) return json({ error: "unauthorized" }, 401);
    const body = (await request.json()) as { status?: string; jobId?: string; log?: string };
    if (!body.status || !body.jobId) return json({ error: "missing status or jobId" }, 400);
    if (!["running", "success", "failure", "error"].includes(body.status)) {
      return json({ error: "invalid status" }, 400);
    }
    const run = await getRun(env.DB, runId);
    if (!run) return json({ error: "run not found" }, 404);
    await updateJob(env.DB, body.jobId, { status: body.status, log: body.log });
    await updateRunStatus(env.DB, runId, body.status);
    log("info", "status updated", { runId, jobId: body.jobId, status: body.status });
    if (body.status === "success" || body.status === "failure" || body.status === "error") {
      const ghState = body.status === "success" ? "success" : "failure";
      ctx.waitUntil(
        reportGitHubStatus(env, { installationId: run.installation_id, repo: run.repo, sha: run.sha, state: ghState }),
      );
    }
    return json({ ok: true });
  } catch (err) {
    log("error", "status callback failed", { error: String(err) });
    return json({ error: "status update failed" }, 500);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        return await handleWebhook(request, env, ctx);
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        if (!(await requireRunnerToken(request, env))) return json({ error: "unauthorized" }, 401);
        return json({ runs: await listRuns(env.DB) });
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        if (!(await requireRunnerToken(request, env))) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runMatch[1]);
        if (!run) return json({ error: "run not found" }, 404);
        return json({ run, jobs: await getJobsForRun(env.DB, run.id) });
      }
      if (request.method === "GET" && url.pathname === "/v1/jobs/next") {
        if (!(await requireRunnerToken(request, env))) return json({ error: "unauthorized" }, 401);
        const job = await nextQueuedJob(env.DB);
        if (!job) return json({ job: null }, 200);
        await updateJob(env.DB, job.id, { status: "running" });
        return json({ job });
      }
      const statusMatch = /^\/v1\/runs\/([^/]+)\/status$/.exec(url.pathname);
      if (request.method === "POST" && statusMatch) {
        return await handleStatusCallback(request, env, ctx, statusMatch[1]);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      log("error", "request failed", { path: url.pathname, error: String(err) });
      return json({ error: "internal error" }, 500);
    }
  },

  async queue(batch: MessageBatch<QueueJobMessage>, env: WorkerEnv): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const run = await getRun(env.DB, msg.body.runId);
        if (!run) {
          log("warn", "queue message for unknown run, acking", { runId: msg.body.runId });
          msg.ack();
          continue;
        }
        log("info", "dispatch confirmed", { runId: msg.body.runId, jobId: msg.body.jobId });
        msg.ack();
      } catch (err) {
        log("error", "queue message failed, retrying", { error: String(err) });
        msg.retry();
      }
    }
  },
};
