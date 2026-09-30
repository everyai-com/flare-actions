import {
  audit,
  cancelGroupJobs,
  claimNextJob,
  createJob,
  createRun,
  createToken,
  createUser,
  deleteSession,
  deleteUser,
  deleteUserSessions,
  findLiveToken,
  flakyStats,
  getJob,
  getJobsForRun,
  getRun,
  getSession,
  getSetting,
  getUser,
  hasActiveGroupJob,
  isTerminal,
  latestRunStatus,
  listAudit,
  listRuns,
  listTokens,
  listUsers,
  rerunJob,
  revokeToken,
  rollupRunStatus,
  setSetting,
  updateJob,
} from "./db";
import { bytesEqual, getInstallationToken, mintAppJwt, verifyGitHubSignature } from "./github";
import { DASHBOARD_HTML } from "./dashboard";
import { ensureSchema } from "./schema";
import { SETTING_KEYS, validateWebhookSecret } from "./settings";
import {
  addAllowedUser,
  beginOAuth,
  buildAuthorizeUrl,
  claimAdmin,
  consumeOAuthState,
  createLoginSession,
  decideLogin,
  exchangeOAuthCode,
  fetchGithubLogin,
  listAllowedUsers,
  parseSessionCookie,
  removeAllowedUser,
  sessionClearCookie,
  sessionSetCookie,
  validateGithubLogin,
} from "./oauth";
import {
  consumeInvite,
  createInvite,
  dummyPasswordHash,
  hashPassword,
  listInvites,
  normalizeEmail,
  peekInvite,
  validateEmail,
  validatePassword,
  verifyPassword,
} from "./email";
import {
  defaultPipeline,
  fetchPipeline,
  parsePipeline,
  seatEligible,
  serializeDefinition,
  type PipelineJob,
} from "./pipeline";
import { promoteBlockedJobs, reportGitHubStatus, triageAndStore } from "./finish";
import { hashToken, newTokenValue, normalizeScopes, parseScopes, scopesAllow } from "./tokens";
import { badgeSvg } from "./badge";
import { jobDurationMs, summarizeRunCost } from "./cost";
import { runGenerate } from "./generate";
import { handleCacheGet, handleCachePut } from "./cache";
import { handleArtifactGet, handleArtifactPut, listRunArtifacts } from "./artifacts";
import { handleMcpMessage, mcpDiscovery } from "./mcp";
import {
  beginConnect,
  buildManifest,
  consumeConnectState,
  exchangeManifestCode,
  GITHUB_MANIFEST_URL,
  installUrl,
  resolveAppCreds,
  storeAppCredentials,
  suggestAppName,
  validateAppName,
} from "./connect";

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
  // R2 bucket for cache + artifacts; absent on forks that skipped it.
  CACHE?: R2Bucket;
  // No seats binding here by design: wakes travel over the SEAT_QUEUE
  // producer (a plain queue binding like RUN_QUEUE), so the main worker
  // never couples — at deploy or runtime — to the seats worker.
}

type WorkerEnv = Env & WorkerSecrets;

interface QueueJobMessage {
  runId: string;
  jobId: string;
  repo: string;
  sha: string;
}

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const TERMINAL_REPORT_STATUSES = ["running", "success", "failure", "error", "cancelled", "skipped"];

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

// Tokens plus GitHub sessions. Bearer: break-glass env admin, env
// runner, D1-issued tokens (admin/runner/readonly). Cookie: GitHub
// login sessions (admin, everyone else reads). Admin does everything;
// runner runs + reads; readonly only reads runs.
async function authIdentity(request: Request, env: WorkerEnv): Promise<{ scope: AuthScope; actor: string } | null> {
  const bearer = getBearer(request);
  if (bearer) {
    if (env.ADMIN_TOKEN && (await timingSafeEqualStr(bearer, env.ADMIN_TOKEN))) {
      return { scope: "admin", actor: "break-glass" };
    }
    if (env.RUNNER_TOKEN && (await timingSafeEqualStr(bearer, env.RUNNER_TOKEN))) {
      return { scope: "runner", actor: "env:runner" };
    }
    const row = await findLiveToken(env.DB, await hashToken(bearer));
    if (!row) return null;
    const scopes = parseScopes(row.scopes);
    if (scopesAllow(scopes, "admin")) return { scope: "admin", actor: `token:${row.id}` };
    if (scopesAllow(scopes, "run")) return { scope: "runner", actor: `token:${row.id}` };
    if (scopesAllow(scopes, "read")) return { scope: "readonly", actor: `token:${row.id}` };
    return null;
  }
  const sessionId = parseSessionCookie(request);
  if (!sessionId) return null;
  const session = await getSession(env.DB, sessionId);
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  const kind = session.kind === "email" ? "email" : "github";
  const actor = `${kind}:${session.github_user}`;
  return session.is_admin ? { scope: "admin", actor } : { scope: "readonly", actor };
}

async function authScope(request: Request, env: WorkerEnv): Promise<AuthScope | null> {
  return (await authIdentity(request, env))?.scope ?? null;
}

async function isAdminRequest(request: Request, env: WorkerEnv): Promise<boolean> {
  return (await authScope(request, env)) === "admin";
}

// Claimed once the first admin of either kind exists; before that,
// Connect and email bootstrap stay open so a fresh deploy can start
// with no credentials.
async function isClaimed(env: WorkerEnv): Promise<boolean> {
  const [github, email] = await Promise.all([
    getSetting(env.DB, SETTING_KEYS.adminGithubUser),
    getSetting(env.DB, SETTING_KEYS.adminEmail),
  ]);
  return github !== null || email !== null;
}

async function getOAuthCreds(env: WorkerEnv): Promise<{ clientId: string; clientSecret: string } | null> {
  const [clientId, clientSecret] = await Promise.all([
    getSetting(env.DB, SETTING_KEYS.githubClientId),
    getSetting(env.DB, SETTING_KEYS.githubClientSecret),
  ]);
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

// Env secrets take precedence; dashboard-managed values fill the gaps
// so one-click deploys work with zero wrangler secret commands.
async function getWebhookSecret(env: WorkerEnv): Promise<string | null> {
  if (env.GITHUB_WEBHOOK_SECRET) return env.GITHUB_WEBHOOK_SECRET;
  return getSetting(env.DB, SETTING_KEYS.webhookSecret);
}

async function getAppCreds(env: WorkerEnv): Promise<{ appId: string; privateKey: string } | null> {
  return resolveAppCreds(env.DB, { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY });
}

async function requireScope(
  request: Request,
  env: WorkerEnv,
  need: "run" | "read",
): Promise<{ scope: AuthScope; actor: string } | null> {
  const ident = await authIdentity(request, env);
  if (!ident) return null;
  if (ident.scope === "admin" || ident.scope === "runner") return ident;
  return need === "read" ? ident : null;
}

interface GitHubWebhookPayload {
  ref?: string;
  repository?: { full_name?: string };
  after?: string;
  installation?: { id?: number };
  pull_request?: { head?: { sha?: string; ref?: string } };
}

function branchFromRef(ref: string | undefined): string {
  if (!ref) return "";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
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
    const creds = await getAppCreds(env);
    if (installationId && creds) {
      try {
        const jwt = await mintAppJwt(creds.appId, creds.privateKey);
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

// Shared fan-out for webhooks, API dispatch, and MCP: create the run,
// cancel superseded groups, park needs/group-blocked jobs, queue the rest.
async function createRunAndFanOut(
  env: WorkerEnv,
  input: {
    repo: string;
    sha: string;
    branch: string;
    event: string;
    installationId: number | null;
    jobs: PipelineJob[];
  },
): Promise<{ runId: string; jobIds: string[]; queuedIds: string[]; blocked: number }> {
  const runId = crypto.randomUUID();
  await createRun(env.DB, {
    id: runId,
    repo: input.repo,
    sha: input.sha,
    event: input.event,
    installationId: input.installationId,
    branch: input.branch,
  });
  const jobIds: string[] = [];
  const queuedIds: string[] = [];
  let blocked = 0;
  for (const job of input.jobs) {
    const jobId = crypto.randomUUID();
    const base = job.base ?? job.name;
    if (job.group && job.cancelInProgress) {
      const cancelled = await cancelGroupJobs(env.DB, input.repo, job.group, runId);
      if (cancelled.length > 0) log("info", "concurrency cancelled superseded jobs", { group: job.group, cancelled });
    }
    const needsBlocked = (job.needs?.length ?? 0) > 0;
    const groupBlocked =
      !!job.group && !job.cancelInProgress && (await hasActiveGroupJob(env.DB, input.repo, job.group));
    const status = needsBlocked || groupBlocked ? "blocked" : "queued";
    if (status === "blocked") blocked += 1;
    await createJob(env.DB, jobId, runId, {
      name: job.name,
      definition: serializeDefinition(job, base),
      labels: (job.labels ?? []).join(","),
      status,
    });
    jobIds.push(jobId);
    if (status === "queued") {
      queuedIds.push(jobId);
      await env.RUN_QUEUE.send({ runId, jobId, repo: input.repo, sha: input.sha } satisfies QueueJobMessage);
    }
  }
  await rollupRunStatus(env.DB, runId);
  return { runId, jobIds, queuedIds, blocked };
}

// Best-effort wake of a managed seat for a queued job: drop a message on
// the seats queue and let the seats worker claim it. Seats are an
// enhancement, never a dependency: missing queue, undeployed seats,
// ineligible jobs, and previews all degrade to "BYO runners take it".
// A queue — not HTTPS (worker-to-workers.dev subrequests are edge
// rejected, error 1042) and not a service binding (deploy-time target
// validation would couple one-click deploys to the seats worker).
async function wakeSeat(env: WorkerEnv, jobId: string): Promise<void> {
  try {
    if (env.ENVIRONMENT !== "production") return;
    const job = await getJob(env.DB, jobId);
    if (!job || job.status !== "queued" || !seatEligible(job.definition)) return;
    await env.SEAT_QUEUE.send({ jobId });
    log("info", "seat wake enqueued", { jobId });
    await audit(env.DB, "seat-wake", "wake.enqueued", jobId);
  } catch (err) {
    log("info", "seat wake skipped", { jobId, error: String(err) });
    await audit(env.DB, "seat-wake", "wake.failed", `${jobId}:threw`).catch(() => undefined);
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
    const branch = branchFromRef(payload.ref) || payload.pull_request?.head?.ref || "";

    const installationId = payload.installation?.id ?? null;
    const jobs = await loadPipelineJobs(env, repo, sha, installationId);
    const { runId, jobIds, queuedIds, blocked } = await createRunAndFanOut(env, { repo, sha, branch, event, installationId, jobs });

    log("info", "run queued", { runId, jobCount: jobIds.length, blocked, repo, sha, event });
    for (const jobId of queuedIds) await wakeSeat(env, jobId);
    const creds = await getAppCreds(env);
    ctx.waitUntil(
      reportGitHubStatus({ appId: creds?.appId, privateKey: creds?.privateKey, installationId, repo, sha, state: "pending" }),
    );
    return json({ runId, jobId: jobIds[0], jobIds }, 202);
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
    if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
    const body = (await request.json()) as { status?: string; jobId?: string; log?: string; result?: unknown };
    if (!body.status || !body.jobId) return json({ error: "missing status or jobId" }, 400);
    if (!TERMINAL_REPORT_STATUSES.includes(body.status)) {
      return json({ error: "invalid status" }, 400);
    }
    const run = await getRun(env.DB, runId);
    if (!run) return json({ error: "run not found" }, 404);
    const result = typeof body.result === "string" ? body.result.slice(0, 65536) : undefined;
    const cappedLog = typeof body.log === "string" ? body.log.slice(0, 262144) : undefined;
    await updateJob(env.DB, body.jobId, { status: body.status, log: cappedLog, result });
    await rollupRunStatus(env.DB, runId);
    log("info", "status updated", { runId, jobId: body.jobId, status: body.status });
    if (isTerminal(body.status)) {
      const promoted = await promoteBlockedJobs(env.DB, env.RUN_QUEUE, run.repo, (job) => wakeSeat(env, job.jobId));
      if (promoted.length > 0) log("info", "blocked jobs promoted", { runId, promoted });
    }
    if (body.status === "success" || body.status === "failure" || body.status === "error") {
      const ghState = body.status === "success" ? "success" : "failure";
      const creds = await getAppCreds(env);
      ctx.waitUntil(
        reportGitHubStatus({
          appId: creds?.appId,
          privateKey: creds?.privateKey,
          installationId: run.installation_id,
          repo: run.repo,
          sha: run.sha,
          state: ghState,
        }),
      );
    }
    if (body.status === "failure" || body.status === "error") {
      const jobs = await getJobsForRun(env.DB, runId);
      const jobName = jobs.find((j) => j.id === body.jobId)?.name ?? "";
      ctx.waitUntil(triageAndStore(env.DB, env.AI, run, body.jobId, jobName, cappedLog, result));
    }
    return json({ ok: true });
  } catch (err) {
    log("error", "status callback failed", { error: String(err) });
    return json({ error: "status update failed" }, 500);
  }
}

function validateDispatch(body: Record<string, unknown>): { repo: string; sha: string; ref: string; pipeline?: string } | { error: string } {
  const { repo, sha, ref, pipeline } = body;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "repo must be owner/name" };
  if (typeof sha !== "string" || !/^[\w.-]+$/.test(sha) || sha.length > 128) return { error: "invalid sha" };
  if (ref !== undefined && (typeof ref !== "string" || ref.length > 128)) return { error: "invalid ref" };
  if (pipeline !== undefined && (typeof pipeline !== "string" || !pipeline.trim() || pipeline.length > 65536)) {
    return { error: "invalid pipeline" };
  }
  return { repo, sha, ref: typeof ref === "string" ? ref : "", pipeline: typeof pipeline === "string" ? pipeline : undefined };
}

async function dispatchRun(
  env: WorkerEnv,
  input: { repo: string; sha: string; ref: string; pipeline?: string },
): Promise<{ runId: string; jobIds: string[]; queuedIds: string[] }> {
  let jobs: PipelineJob[] | null = null;
  if (input.pipeline) {
    jobs = parsePipeline(input.pipeline);
    if (!jobs) throw new Error("pipeline parse failed");
  } else {
    jobs = await loadPipelineJobs(env, input.repo, input.sha, null);
  }
  const branch = branchFromRef(input.ref) || input.ref;
  const { runId, jobIds, queuedIds } = await createRunAndFanOut(env, {
    repo: input.repo,
    sha: input.sha,
    branch,
    event: "dispatch",
    installationId: null,
    jobs,
  });
  log("info", "run dispatched", { runId, repo: input.repo, sha: input.sha });
  return { runId, jobIds, queuedIds };
}

async function rerunJobAndQueue(
  env: WorkerEnv,
  runId: string,
  jobId: string,
): Promise<{ ok: boolean; error?: string }> {
  const job = await getJob(env.DB, jobId);
  if (!job || job.run_id !== runId) return { ok: false, error: "job not found" };
  const reset = await rerunJob(env.DB, jobId);
  if (!reset) return { ok: false, error: "job not found" };
  await rollupRunStatus(env.DB, runId);
  await env.RUN_QUEUE.send({ runId, jobId, repo: reset.repo, sha: reset.sha } satisfies QueueJobMessage);
  return { ok: true };
}

async function handleCreateToken(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const ident = await authIdentity(request, env);
    if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
    const body = (await request.json()) as { name?: unknown; scopes?: unknown };
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 64) {
      return json({ error: "name is required (1-64 chars)" }, 400);
    }
    const scopes = body.scopes === undefined ? ["runner"] : normalizeScopes(body.scopes);
    if (!scopes) return json({ error: "scopes must be a non-empty array of runner|readonly|admin" }, 400);
    const id = crypto.randomUUID();
    const value = newTokenValue();
    await createToken(env.DB, { id, name: body.name.trim(), tokenHash: await hashToken(value), scopes: scopes.join(",") });
    await audit(env.DB, ident.actor, "token.create", id);
    log("info", "token issued", { id });
    return json({ id, name: body.name.trim(), scopes, token: value }, 201);
  } catch (err) {
    log("error", "create token failed", { error: String(err) });
    return json({ error: "create token failed" }, 500);
  }
}

async function handleSettingsUpdate(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const ident = await authIdentity(request, env);
    if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
    if (env.GITHUB_WEBHOOK_SECRET) {
      return json({ error: "webhook secret managed via environment" }, 409);
    }
    const body = (await request.json()) as { webhookSecret?: unknown };
    const err = validateWebhookSecret(body.webhookSecret);
    if (err) return json({ error: err }, 400);
    await setSetting(env.DB, SETTING_KEYS.webhookSecret, body.webhookSecret as string);
    await audit(env.DB, ident.actor, "settings.webhook", "");
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
      if (request.method === "GET" && url.pathname === "/mcp") {
        return json(mcpDiscovery());
      }
      if (request.method === "POST" && url.pathname === "/mcp") {
        const ident = await authIdentity(request, env);
        if (!ident) return json({ error: "unauthorized" }, 401);
        let msg: unknown;
        try {
          msg = await request.json();
        } catch {
          return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        }
        const res = await handleMcpMessage(msg, {
          db: env.DB,
          ai: env.AI,
          canWrite: ident.scope === "admin" || ident.scope === "runner",
          dispatchRun: async (input) => {
            const out = await dispatchRun(env, { repo: input.repo, sha: input.sha, ref: input.ref ?? "", pipeline: input.pipeline });
            await audit(env.DB, ident.actor, "run.dispatch", out.runId);
            for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
            return { runId: out.runId, jobIds: out.jobIds };
          },
          rerunJob: async (runId, jobId) => {
            const out = await rerunJobAndQueue(env, runId, jobId);
            if (out.ok) {
              await audit(env.DB, ident.actor, "job.rerun", jobId);
              await wakeSeat(env, jobId);
            }
            return out;
          },
        });
        if (res.status === 202) return new Response(null, { status: 202 });
        return json(res.body);
      }
      if (request.method === "POST" && url.pathname === "/v1/runs/dispatch") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateDispatch(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        try {
          const out = await dispatchRun(env, valid);
          await audit(env.DB, ident.actor, "run.dispatch", out.runId);
          for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
          return json({ runId: out.runId, jobIds: out.jobIds }, 202);
        } catch (err) {
          return json({ error: String(err instanceof Error ? err.message : err) }, 400);
        }
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
        const jobs = await getJobsForRun(env.DB, run.id);
        return json({
          run,
          jobs: jobs.map((j) => ({ ...j, durationMs: jobDurationMs(j) })),
          summary: summarizeRunCost(jobs),
        });
      }
      const runArtifactsMatch = /^\/v1\/runs\/([^/]+)\/artifacts$/.exec(url.pathname);
      if (request.method === "GET" && runArtifactsMatch) {
        if (!(await requireScope(request, env, "read"))) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runArtifactsMatch[1]);
        if (!run) return json({ error: "run not found" }, 404);
        const artifacts = await listRunArtifacts(env.CACHE, env.DB, run.id);
        if (!artifacts) return json({ error: "artifact storage not configured" }, 501);
        return json({ artifacts });
      }
      if (request.method === "GET" && url.pathname === "/v1/jobs/next") {
        if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
        const labels = (url.searchParams.get("labels") ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
        const job = await claimNextJob(env.DB, labels);
        if (!job) return json({ job: null }, 200);
        await rollupRunStatus(env.DB, job.run_id);
        return json({ job });
      }
      const statusMatch = /^\/v1\/runs\/([^/]+)\/status$/.exec(url.pathname);
      if (request.method === "POST" && statusMatch) {
        return await handleStatusCallback(request, env, ctx, statusMatch[1]);
      }
      const rerunMatch = /^\/v1\/runs\/([^/]+)\/jobs\/([^/]+)\/rerun$/.exec(url.pathname);
      if (request.method === "POST" && rerunMatch) {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const out = await rerunJobAndQueue(env, rerunMatch[1], rerunMatch[2]);
        if (!out.ok) return json({ error: out.error ?? "rerun failed" }, 404);
        await audit(env.DB, ident.actor, "job.rerun", rerunMatch[2]);
        await wakeSeat(env, rerunMatch[2]);
        return json({ ok: true });
      }
      const cacheMatch = /^\/v1\/cache\/(.+)$/.exec(url.pathname);
      if (cacheMatch && (request.method === "PUT" || request.method === "GET")) {
        if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
        const key = decodeURIComponent(cacheMatch[1]);
        if (request.method === "PUT") return await handleCachePut(env.CACHE, key, request);
        return await handleCacheGet(env.CACHE, key);
      }
      const artifactMatch = /^\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (artifactMatch && (request.method === "PUT" || request.method === "GET")) {
        const need = request.method === "PUT" ? "run" : "read";
        if (!(await requireScope(request, env, need))) return json({ error: "unauthorized" }, 401);
        const name = decodeURIComponent(artifactMatch[2]);
        if (request.method === "PUT") return await handleArtifactPut(env.CACHE, env.DB, artifactMatch[1], name, request);
        return await handleArtifactGet(env.CACHE, artifactMatch[1], name);
      }
      if (request.method === "GET" && url.pathname === "/v1/badge.svg") {
        const repo = url.searchParams.get("repo") ?? "";
        const branch = url.searchParams.get("branch") ?? undefined;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
        const status = await latestRunStatus(env.DB, repo, branch);
        return new Response(badgeSvg(status), {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=60" },
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/flaky") {
        if (!(await requireScope(request, env, "read"))) return json({ error: "unauthorized" }, 401);
        const repo = url.searchParams.get("repo") ?? "";
        if (!repo) return json({ error: "repo is required" }, 400);
        const days = Number(url.searchParams.get("days") ?? "30");
        if (!Number.isFinite(days) || days < 1 || days > 365) return json({ error: "days must be 1-365" }, 400);
        return json({ stats: await flakyStats(env.DB, repo, Math.floor(days)) });
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
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const ok = await revokeToken(env.DB, revokeMatch[1]);
        if (!ok) return json({ error: "token not found" }, 404);
        await audit(env.DB, ident.actor, "token.revoke", revokeMatch[1]);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/status") {
        const ident = await authIdentity(request, env);
        const connected = (await getOAuthCreds(env)) !== null;
        const slug = connected ? await getSetting(env.DB, SETTING_KEYS.githubAppSlug) : null;
        return json({
          claimed: await isClaimed(env),
          breakGlass: !!env.ADMIN_TOKEN,
          githubConnected: connected,
          installUrl: slug ? installUrl(slug) : null,
          user: ident ? { actor: ident.actor, admin: ident.scope === "admin" } : null,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/logout") {
        const sessionId = parseSessionCookie(request);
        if (sessionId) await deleteSession(env.DB, sessionId).catch(() => undefined);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionClearCookie(url.protocol === "https:"),
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/github/login") {
        const creds = await getOAuthCreds(env);
        if (!creds) {
          return Response.redirect(new URL("/dashboard?github=error&reason=noapp", url).toString(), 302);
        }
        const state = await beginOAuth(env.DB);
        const redirectUri = new URL("/v1/admin/github/oauth/callback", url).toString();
        return Response.redirect(buildAuthorizeUrl(creds.clientId, redirectUri, state), 302);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/github/oauth/callback") {
        const fail = (reason: string): Response =>
          Response.redirect(new URL(`/dashboard?github=error&reason=${reason}`, url).toString(), 302);
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (!state || !code) return fail("missing");
        if (!(await consumeOAuthState(env.DB, state))) return fail("expired");
        const creds = await getOAuthCreds(env);
        if (!creds) return fail("noapp");
        const redirectUri = new URL("/v1/admin/github/oauth/callback", url).toString();
        const accessToken = await exchangeOAuthCode({ ...creds, code, redirectUri });
        if (!accessToken) return fail("exchange");
        const login = await fetchGithubLogin(accessToken);
        if (!login) return fail("exchange");
        const decision = await decideLogin(env.DB, login);
        if (!decision.allowed) {
          log("info", "github login denied", { login });
          return Response.redirect(new URL("/dashboard?github=forbidden", url).toString(), 302);
        }
        if (!decision.claimed) {
          await claimAdmin(env.DB, login);
          await audit(env.DB, `github:${login}`, "admin.claim", "");
          log("info", "admin claimed", { login });
        }
        const sessionId = await createLoginSession(env.DB, { kind: "github", login, isAdmin: decision.isAdmin });
        await audit(env.DB, `github:${login}`, "session.login", "");
        return new Response(null, {
          status: 302,
          headers: {
            Location: new URL("/dashboard", url).toString(),
            "Set-Cookie": sessionSetCookie(sessionId, url.protocol === "https:"),
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/users") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const emailUsers = await listUsers(env.DB);
        return json({
          admin: await getSetting(env.DB, SETTING_KEYS.adminGithubUser),
          adminEmail: await getSetting(env.DB, SETTING_KEYS.adminEmail),
          users: await listAllowedUsers(env.DB),
          emailUsers: emailUsers.map((u) => ({ email: u.email, isAdmin: u.is_admin === 1, createdAt: u.created_at })),
          invites: await listInvites(env.DB),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/users") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { login?: unknown; action?: unknown };
        const err = validateGithubLogin(body.login);
        if (err) return json({ error: err }, 400);
        if (body.action !== "add" && body.action !== "remove") return json({ error: "action must be add|remove" }, 400);
        const login = body.login as string;
        const users = body.action === "add" ? await addAllowedUser(env.DB, login) : await removeAllowedUser(env.DB, login);
        if (body.action === "remove") await deleteUserSessions(env.DB, "github", login);
        await audit(env.DB, ident.actor, `users.${body.action as string}`, login);
        return json({ users });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/users/email") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; action?: unknown };
        const err = validateEmail(body.email);
        if (err) return json({ error: err }, 400);
        if (body.action !== "remove") return json({ error: "action must be remove" }, 400);
        const email = normalizeEmail(body.email as string);
        const adminEmail = await getSetting(env.DB, SETTING_KEYS.adminEmail);
        if (adminEmail && email === adminEmail) return json({ error: "cannot remove the admin account" }, 403);
        if (ident.actor === `email:${email}`) return json({ error: "cannot remove yourself" }, 403);
        await deleteUser(env.DB, email);
        await deleteUserSessions(env.DB, "email", email);
        await audit(env.DB, ident.actor, "users.email.remove", email);
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/users/invite") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { email?: unknown };
        const err = validateEmail(body.email);
        if (err) return json({ error: err }, 400);
        const email = normalizeEmail(body.email as string);
        if (await getUser(env.DB, email)) return json({ error: "that email already has an account" }, 409);
        const { token, invite } = await createInvite(env.DB, email);
        await audit(env.DB, ident.actor, "users.invite", email);
        const inviteUrl = new URL(`/dashboard?invite=${encodeURIComponent(token)}`, url).toString();
        return json({ inviteUrl, email: invite.email, expiresAt: invite.expiresAt });
      }
      const inviteMatch = /^\/v1\/admin\/invite\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && inviteMatch) {
        const invite = await peekInvite(env.DB, decodeURIComponent(inviteMatch[1]));
        if (!invite) return json({ error: "invite invalid or expired" }, 404);
        return json({ email: invite.email });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/register") {
        const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
        if (typeof body.token !== "string" || !body.token) return json({ error: "invite required" }, 400);
        const pwErr = validatePassword(body.password);
        if (pwErr) return json({ error: pwErr }, 400);
        const invite = await consumeInvite(env.DB, body.token);
        if (!invite) return json({ error: "invite invalid or expired" }, 404);
        if (await getUser(env.DB, invite.email)) return json({ error: "that email already has an account" }, 409);
        await createUser(env.DB, { email: invite.email, passwordHash: await hashPassword(body.password as string), isAdmin: false });
        const sessionId = await createLoginSession(env.DB, { kind: "email", login: invite.email, isAdmin: false });
        await audit(env.DB, `email:${invite.email}`, "session.register", "");
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionSetCookie(sessionId, url.protocol === "https:"),
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap") {
        if (await isClaimed(env)) return json({ error: "already claimed" }, 403);
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
        const emailErr = validateEmail(body.email);
        if (emailErr) return json({ error: emailErr }, 400);
        const pwErr = validatePassword(body.password);
        if (pwErr) return json({ error: pwErr }, 400);
        const email = normalizeEmail(body.email as string);
        await createUser(env.DB, { email, passwordHash: await hashPassword(body.password as string), isAdmin: true });
        await setSetting(env.DB, SETTING_KEYS.adminEmail, email);
        const sessionId = await createLoginSession(env.DB, { kind: "email", login: email, isAdmin: true });
        await audit(env.DB, `email:${email}`, "admin.claim", "");
        log("info", "admin claimed", { email });
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionSetCookie(sessionId, url.protocol === "https:"),
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/login") {
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
        if (validateEmail(body.email) || typeof body.password !== "string") {
          return json({ error: "invalid email or password" }, 401);
        }
        const email = normalizeEmail(body.email as string);
        const user = await getUser(env.DB, email);
        const ok = await verifyPassword(body.password, user?.password_hash ?? dummyPasswordHash());
        if (!user || !ok) return json({ error: "invalid email or password" }, 401);
        const sessionId = await createLoginSession(env.DB, { kind: "email", login: email, isAdmin: user.is_admin === 1 });
        await audit(env.DB, `email:${email}`, "session.login", "");
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionSetCookie(sessionId, url.protocol === "https:"),
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/settings") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const webhookSecretSource = env.GITHUB_WEBHOOK_SECRET
          ? "env"
          : (await getSetting(env.DB, SETTING_KEYS.webhookSecret)) !== null
            ? "d1"
            : "none";
        const githubSource = env.GITHUB_APP_ID ? "env" : ((await getSetting(env.DB, SETTING_KEYS.githubAppId)) !== null ? "d1" : "none");
        const githubSlug = githubSource === "d1" ? await getSetting(env.DB, SETTING_KEYS.githubAppSlug) : null;
        return json({
          adminGithubUser: await getSetting(env.DB, SETTING_KEYS.adminGithubUser),
          adminEmail: await getSetting(env.DB, SETTING_KEYS.adminEmail),
          webhookSecretSource,
          cache: env.CACHE ? "r2" : "none",
          githubApp: { source: githubSource, installUrl: githubSlug ? installUrl(githubSlug) : null },
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/github/connect") {
        // Open before claim (fresh-deploy bootstrap), admin-only after.
        const claimed = await isClaimed(env);
        const ident = await authIdentity(request, env);
        if (claimed && (!ident || ident.scope !== "admin")) return json({ error: "unauthorized" }, 401);
        if (env.GITHUB_WEBHOOK_SECRET || env.GITHUB_APP_ID || env.GITHUB_PRIVATE_KEY) {
          return json({ error: "github already managed via environment" }, 409);
        }
        const body = (await request.json().catch(() => ({}))) as { name?: unknown };
        const name =
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : suggestAppName(crypto.randomUUID().replace(/-/g, ""));
        const err = validateAppName(name);
        if (err) return json({ error: err }, 400);
        const state = await beginConnect(env.DB);
        await audit(env.DB, ident?.actor ?? "setup", "github.connect.begin", name);
        log("info", "github connect started", { name });
        return json({ postUrl: `${GITHUB_MANIFEST_URL}?state=${encodeURIComponent(state)}`, manifest: buildManifest(name, url.origin) });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/github/callback") {
        // Unauthenticated by design (GitHub redirects the browser here);
        // the single-use state is the capability.
        const fail = (reason: string): Response =>
          Response.redirect(new URL(`/dashboard?github=error&reason=${reason}`, url).toString(), 302);
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (!state || !code) return fail("missing");
        if (!(await consumeConnectState(env.DB, state))) return fail("expired");
        const app = await exchangeManifestCode(code);
        if (!app) {
          log("warn", "github connect exchange failed");
          return fail("exchange");
        }
        await storeAppCredentials(env.DB, app);
        await audit(env.DB, "github-connect", "github.connect.done", app.slug);
        log("info", "github app connected", { slug: app.slug, appId: app.appId });
        return Response.redirect(new URL("/dashboard?github=connected", url).toString(), 302);
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/settings") {
        return await handleSettingsUpdate(request, env);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/audit") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        return json({ entries: await listAudit(env.DB) });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/generate") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        if (!env.AI) return json({ error: "AI not configured" }, 501);
        const body = (await request.json().catch(() => ({}))) as { prompt?: unknown };
        if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 2000) {
          return json({ error: "prompt is required (max 2000 chars)" }, 400);
        }
        const yaml = await runGenerate(env.AI, body.prompt);
        if (!yaml) return json({ error: "generation failed" }, 502);
        await audit(env.DB, ident.actor, "pipeline.generate", body.prompt.slice(0, 80));
        return json({ yaml });
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
