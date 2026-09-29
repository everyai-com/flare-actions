import {
  createJob,
  createRun,
  createToken,
  findLiveToken,
  getJobsForRun,
  getRun,
  getSetting,
  listRuns,
  listTokens,
  nextQueuedJob,
  revokeToken,
  setJobTriage,
  setSetting,
  updateJob,
  updateRunStatus,
} from "./db";
import {
  bytesEqual,
  getInstallationToken,
  mintAppJwt,
  postCommitStatus,
  timingSafeEqualHex,
  verifyGitHubSignature,
} from "./github";
import { DASHBOARD_HTML } from "./dashboard";
import { ensureSchema } from "./schema";
import { SETTING_KEYS, validateNewPassword, validateWebhookSecret } from "./settings";
import { defaultPipeline, fetchPipeline, parsePipeline, type PipelineJob } from "./pipeline";
import { runTriage, type TriageStep } from "./triage";
import { hashToken, newTokenValue, normalizeScopes, parseScopes, scopesAllow } from "./tokens";

// Secrets are set via `wrangler secret put` / `.dev.vars`, never in
// wrangler.jsonc. `wrangler types` may or may not include them in the
// generated Env depending on whether `.dev.vars` exists, so intersect
// as optional: this compiles in both cases. Run `npm run types` to
// regenerate bindings after config changes.
interface WorkerSecrets {
  GITHUB_WEBHOOK_SECRET?: string;
  RUNNER_TOKEN?: string;
  ADMIN_TOKEN?: string;
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
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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

type AuthScope = "admin" | "runner" | "readonly";

function getBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

async function isAdminRequest(request: Request, env: WorkerEnv): Promise<boolean> {
  const bearer = getBearer(request);
  if (!bearer) return false;
  if (env.ADMIN_TOKEN && (await timingSafeEqualStr(bearer, env.ADMIN_TOKEN))) return true;
  // Dashboard-managed password (first-run setup), stored as a hash.
  const hash = await getSetting(env.DB, SETTING_KEYS.adminPasswordHash);
  if (!hash) return false;
  return timingSafeEqualHex(await hashToken(bearer), hash);
}

async function isAdminConfigured(env: WorkerEnv): Promise<boolean> {
  if (env.ADMIN_TOKEN) return true;
  return (await getSetting(env.DB, SETTING_KEYS.adminPasswordHash)) !== null;
}

// Env secrets take precedence; dashboard-managed values fill the gaps
// so one-click deploys work with zero wrangler secret commands.
async function getWebhookSecret(env: WorkerEnv): Promise<string | null> {
  if (env.GITHUB_WEBHOOK_SECRET) return env.GITHUB_WEBHOOK_SECRET;
  return getSetting(env.DB, SETTING_KEYS.webhookSecret);
}

// Admin password plus the legacy env runner token plus D1-issued
// dashboard tokens. Admin does everything; runner runs + reads;
// readonly only reads runs.
async function authScope(request: Request, env: WorkerEnv): Promise<AuthScope | null> {
  if (await isAdminRequest(request, env)) return "admin";
  const bearer = getBearer(request);
  if (!bearer) return null;
  if (env.RUNNER_TOKEN && (await timingSafeEqualStr(bearer, env.RUNNER_TOKEN))) return "runner";
  const row = await findLiveToken(env.DB, await hashToken(bearer));
  if (!row) return null;
  const scopes = parseScopes(row.scopes);
  if (scopesAllow(scopes, "run")) return "runner";
  if (scopesAllow(scopes, "read")) return "readonly";
  return null;
}

async function requireScope(
  request: Request,
  env: WorkerEnv,
  need: "run" | "read",
): Promise<AuthScope | null> {
  const scope = await authScope(request, env);
  if (!scope) return null;
  if (scope === "admin" || scope === "runner") return scope;
  return need === "read" ? scope : null;
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

async function loadPipelineJobs(
  env: WorkerEnv,
  repo: string,
  sha: string,
  installationId: number | null,
): Promise<PipelineJob[]> {
  try {
    // Public fast path first (no token minted); fall back to the
    // authenticated API for private repos when App creds exist.
    const direct = await fetchPipeline(repo, sha, null);
    if (direct) return parsePipeline(direct) ?? defaultPipeline();
    if (installationId && env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY) {
      try {
        const jwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
        const token = await getInstallationToken(jwt, installationId);
        if (token) {
          const text = await fetchPipeline(repo, sha, token);
          if (text) return parsePipeline(text) ?? defaultPipeline();
        }
      } catch (err) {
        log("warn", "private pipeline fetch failed, using default", { error: String(err) });
      }
    }
    return defaultPipeline();
  } catch (err) {
    log("warn", "pipeline load failed, using default", { error: String(err) });
    return defaultPipeline();
  }
}

async function handleWebhook(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  try {
    const secret = await getWebhookSecret(env);
    if (!secret) {
      log("error", "webhook secret not configured");
      return json({ error: "webhook secret not configured — set it in the dashboard" }, 500);
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_WEBHOOK_BYTES) {
      return json({ error: "payload too large" }, 413);
    }
    const valid = await verifyGitHubSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      secret,
    );
    if (!valid) return json({ error: "invalid signature" }, 401);

    const event = request.headers.get("x-github-event") ?? "unknown";
    const payload = JSON.parse(new TextDecoder().decode(raw)) as GitHubWebhookPayload;
    const repo = payload.repository?.full_name;
    const sha = payload.after ?? payload.pull_request?.head?.sha;
    if (!repo || !sha) return json({ error: "missing repo or sha" }, 400);

    const runId = crypto.randomUUID();
    const installationId = payload.installation?.id ?? null;
    await createRun(env.DB, { id: runId, repo, sha, event, installationId });
    const jobs = await loadPipelineJobs(env, repo, sha, installationId);
    const jobIds: string[] = [];
    for (const job of jobs) {
      const jobId = crypto.randomUUID();
      jobIds.push(jobId);
      await createJob(env.DB, jobId, runId, {
        name: job.name,
        definition: JSON.stringify({ steps: job.steps }),
      });
      await env.RUN_QUEUE.send({ runId, jobId, repo, sha } satisfies QueueJobMessage);
    }

    log("info", "run queued", { runId, jobCount: jobIds.length, repo, sha, event });
    ctx.waitUntil(reportGitHubStatus(env, { installationId, repo, sha, state: "pending" }));
    return json({ runId, jobId: jobIds[0], jobIds }, 202);
  } catch (err) {
    log("error", "webhook failed", { error: String(err) });
    return json({ error: "webhook failed" }, 500);
  }
}

function parseReportedSteps(result: unknown): TriageStep[] {
  if (typeof result !== "string" || !result) return [];
  try {
    const parsed = JSON.parse(result) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps)) return [];
    const out: TriageStep[] = [];
    for (const s of parsed.steps) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      if (typeof rec.command !== "string" || typeof rec.exitCode !== "number") continue;
      out.push({
        command: rec.command.slice(0, 500),
        exitCode: rec.exitCode,
        output: typeof rec.output === "string" ? rec.output : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function triageAndStore(
  env: WorkerEnv,
  run: { repo: string; sha: string },
  jobId: string,
  jobName: string,
  log: string | undefined,
  result: string | undefined,
): Promise<void> {
  try {
    // Forks without the AI binding simply skip triage.
    if (!env.AI) return;
    const text = await runTriage(env.AI, {
      repo: run.repo,
      sha: run.sha,
      jobName,
      steps: parseReportedSteps(result),
      logTail: (log ?? "").slice(-4000),
    });
    if (!text) return;
    await setJobTriage(env.DB, jobId, text);
  } catch (err) {
    // Triage must never fail a status update; it runs in waitUntil.
    console.log(JSON.stringify({ level: "warn", msg: "triage failed", error: String(err) }));
  }
}

async function handleStatusCallback(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  runId: string,
): Promise<Response> {
  try {
    if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
    const body = (await request.json()) as { status?: string; jobId?: string; log?: string; result?: unknown };
    if (!body.status || !body.jobId) return json({ error: "missing status or jobId" }, 400);
    if (!["running", "success", "failure", "error"].includes(body.status)) {
      return json({ error: "invalid status" }, 400);
    }
    const run = await getRun(env.DB, runId);
    if (!run) return json({ error: "run not found" }, 404);
    const result = typeof body.result === "string" ? body.result.slice(0, 65536) : undefined;
    const cappedLog = typeof body.log === "string" ? body.log.slice(0, 262144) : undefined;
    await updateJob(env.DB, body.jobId, { status: body.status, log: cappedLog, result });
    await updateRunStatus(env.DB, runId, body.status);
    log("info", "status updated", { runId, jobId: body.jobId, status: body.status });
    if (body.status === "success" || body.status === "failure" || body.status === "error") {
      const ghState = body.status === "success" ? "success" : "failure";
      ctx.waitUntil(
        reportGitHubStatus(env, { installationId: run.installation_id, repo: run.repo, sha: run.sha, state: ghState }),
      );
    }
    if (body.status === "failure" || body.status === "error") {
      const jobs = await getJobsForRun(env.DB, runId);
      const jobName = jobs.find((j) => j.id === body.jobId)?.name ?? "";
      ctx.waitUntil(triageAndStore(env, run, body.jobId, jobName, cappedLog, result));
    }
    return json({ ok: true });
  } catch (err) {
    log("error", "status callback failed", { error: String(err) });
    return json({ error: "status update failed" }, 500);
  }
}

async function handleCreateToken(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
    const body = (await request.json()) as { name?: unknown; scopes?: unknown };
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 64) {
      return json({ error: "name is required (1-64 chars)" }, 400);
    }
    const scopes = body.scopes === undefined ? ["runner"] : normalizeScopes(body.scopes);
    if (!scopes) return json({ error: "scopes must be a non-empty array of runner|readonly" }, 400);
    const id = crypto.randomUUID();
    const value = newTokenValue();
    await createToken(env.DB, { id, name: body.name.trim(), tokenHash: await hashToken(value), scopes: scopes.join(",") });
    log("info", "token issued", { id });
    return json({ id, name: body.name.trim(), scopes, token: value }, 201);
  } catch (err) {
    log("error", "create token failed", { error: String(err) });
    return json({ error: "create token failed" }, 500);
  }
}

async function handleSetup(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    // First-run only: refused the moment any admin credential exists.
    if (env.ADMIN_TOKEN) return json({ error: "admin managed via environment" }, 403);
    if (await getSetting(env.DB, SETTING_KEYS.adminPasswordHash)) {
      return json({ error: "already configured" }, 403);
    }
    const body = (await request.json()) as { password?: unknown };
    const err = validateNewPassword(body.password);
    if (err) return json({ error: err }, 400);
    await setSetting(env.DB, SETTING_KEYS.adminPasswordHash, await hashToken(body.password as string));
    log("info", "admin password set via first-run setup");
    return json({ ok: true });
  } catch (e) {
    log("error", "setup failed", { error: String(e) });
    return json({ error: "setup failed" }, 500);
  }
}

async function handleSettingsUpdate(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
    if (env.GITHUB_WEBHOOK_SECRET) {
      return json({ error: "webhook secret managed via environment" }, 409);
    }
    const body = (await request.json()) as { webhookSecret?: unknown };
    const err = validateWebhookSecret(body.webhookSecret);
    if (err) return json({ error: err }, 400);
    await setSetting(env.DB, SETTING_KEYS.webhookSecret, body.webhookSecret as string);
    log("info", "webhook secret set via dashboard");
    return json({ ok: true });
  } catch (e) {
    log("error", "settings update failed", { error: String(e) });
    return json({ error: "settings update failed" }, 500);
  }
}

function dashboardResponse(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      await ensureSchema(env.DB);
      if (request.method === "GET" && url.pathname === "/") {
        return Response.redirect(new URL("/dashboard", url).toString(), 302);
      }
      if (request.method === "GET" && url.pathname === "/dashboard") {
        return dashboardResponse();
      }
      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        return await handleWebhook(request, env, ctx);
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        if (!(await requireScope(request, env, "read"))) return json({ error: "unauthorized" }, 401);
        return json({ runs: await listRuns(env.DB) });
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        if (!(await requireScope(request, env, "read"))) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runMatch[1]);
        if (!run) return json({ error: "run not found" }, 404);
        return json({ run, jobs: await getJobsForRun(env.DB, run.id) });
      }
      if (request.method === "GET" && url.pathname === "/v1/jobs/next") {
        if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
        const job = await nextQueuedJob(env.DB);
        if (!job) return json({ job: null }, 200);
        await updateJob(env.DB, job.id, { status: "running" });
        return json({ job });
      }
      const statusMatch = /^\/v1\/runs\/([^/]+)\/status$/.exec(url.pathname);
      if (request.method === "POST" && statusMatch) {
        return await handleStatusCallback(request, env, ctx, statusMatch[1]);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/tokens") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        return json({ tokens: await listTokens(env.DB) });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/tokens") {
        return await handleCreateToken(request, env);
      }
      const revokeMatch = /^\/v1\/admin\/tokens\/([^/]+)\/revoke$/.exec(url.pathname);
      if (request.method === "POST" && revokeMatch) {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const ok = await revokeToken(env.DB, revokeMatch[1]);
        if (!ok) return json({ error: "token not found" }, 404);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/status") {
        return json({ configured: await isAdminConfigured(env) });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/setup") {
        return await handleSetup(request, env);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/settings") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const webhookSecretSource = env.GITHUB_WEBHOOK_SECRET
          ? "env"
          : (await getSetting(env.DB, SETTING_KEYS.webhookSecret)) !== null
            ? "d1"
            : "none";
        return json({
          adminSource: env.ADMIN_TOKEN ? "env" : "d1",
          webhookSecretSource,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/settings") {
        return await handleSettingsUpdate(request, env);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      log("error", "request failed", { path: url.pathname, error: String(err) });
      return json({ error: "internal error" }, 500);
    }
  },

  async queue(batch: MessageBatch<QueueJobMessage>, env: WorkerEnv): Promise<void> {
    await ensureSchema(env.DB);
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
