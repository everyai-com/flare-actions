import {
  audit,
  cancelGroupJobs,
  createJob,
  createRun,
  createToken,
  FAILED_STATUSES,
  findLiveToken,
  flakyStats,
  getJob,
  getJobsForRun,
  getRun,
  getSetting,
  hasActiveGroupJob,
  isTerminal,
  latestRunStatus,
  listAudit,
  listBlockedJobsInRepo,
  listRuns,
  listTokens,
  nextQueuedJob,
  rerunJob,
  revokeToken,
  rollupRunStatus,
  setJobStatus,
  setJobTriage,
  setSetting,
  updateJob,
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
import {
  defaultPipeline,
  fetchPipeline,
  parsePipeline,
  readJobSpec as readPipelineJobSpec,
  serializeDefinition,
  type PipelineJob,
} from "./pipeline";
import { runTriage, type TriageStep } from "./triage";
import { hashToken, newTokenValue, normalizeScopes, parseScopes, scopesAllow } from "./tokens";
import { badgeSvg } from "./badge";
import { jobDurationMs, summarizeRunCost } from "./cost";
import { runGenerate } from "./generate";
import { handleCacheGet, handleCachePut } from "./cache";
import { handleArtifactGet, handleArtifactPut, listRunArtifacts } from "./artifacts";
import { handleMcpMessage, mcpDiscovery } from "./mcp";

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

// Admin password plus the legacy env runner token plus D1-issued
// dashboard tokens. Admin does everything; runner runs + reads;
// readonly only reads runs.
async function authIdentity(request: Request, env: WorkerEnv): Promise<{ scope: AuthScope; actor: string } | null> {
  const bearer = getBearer(request);
  if (!bearer) return null;
  if (env.ADMIN_TOKEN && (await timingSafeEqualStr(bearer, env.ADMIN_TOKEN))) {
    return { scope: "admin", actor: "admin" };
  }
  const hash = await getSetting(env.DB, SETTING_KEYS.adminPasswordHash);
  if (hash && timingSafeEqualHex(await hashToken(bearer), hash)) {
    return { scope: "admin", actor: "admin" };
  }
  if (env.RUNNER_TOKEN && (await timingSafeEqualStr(bearer, env.RUNNER_TOKEN))) {
    return { scope: "runner", actor: "env:runner" };
  }
  const row = await findLiveToken(env.DB, await hashToken(bearer));
  if (!row) return null;
  const scopes = parseScopes(row.scopes);
  if (scopesAllow(scopes, "run")) return { scope: "runner", actor: `token:${row.id}` };
  if (scopesAllow(scopes, "read")) return { scope: "readonly", actor: `token:${row.id}` };
  return null;
}

async function authScope(request: Request, env: WorkerEnv): Promise<AuthScope | null> {
  return (await authIdentity(request, env))?.scope ?? null;
}

async function isAdminRequest(request: Request, env: WorkerEnv): Promise<boolean> {
  return (await authScope(request, env)) === "admin";
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
): Promise<{ runId: string; jobIds: string[]; blocked: number }> {
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
      await env.RUN_QUEUE.send({ runId, jobId, repo: input.repo, sha: input.sha } satisfies QueueJobMessage);
    }
  }
  await rollupRunStatus(env.DB, runId);
  return { runId, jobIds, blocked };
}

// After any terminal transition: unblock needs-satisfied jobs (oldest
// first so concurrency groups serialize), skip jobs whose needs failed.
async function promoteBlockedJobs(env: WorkerEnv, repo: string): Promise<string[]> {
  const blocked = await listBlockedJobsInRepo(env.DB, repo);
  const promoted: string[] = [];
  const runJobsCache = new Map<string, { base: string; status: string }[]>();
  for (const job of blocked) {
    const spec = readPipelineJobSpec(job.definition, job.name);
    if (spec.needs.length > 0) {
      let siblings = runJobsCache.get(job.run_id);
      if (!siblings) {
        const rows = await getJobsForRun(env.DB, job.run_id);
        siblings = rows.map((r) => ({ base: readPipelineJobSpec(r.definition, r.name).base, status: r.status }));
        runJobsCache.set(job.run_id, siblings);
      }
      const byBase = new Map<string, string[]>();
      for (const s of siblings) byBase.set(s.base, [...(byBase.get(s.base) ?? []), s.status]);
      if (spec.needs.some((n) => (byBase.get(n) ?? []).some((st) => FAILED_STATUSES.includes(st)))) {
        await setJobStatus(env.DB, job.id, "skipped");
        await rollupRunStatus(env.DB, job.run_id);
        runJobsCache.delete(job.run_id);
        continue;
      }
      const satisfied = spec.needs.every((n) => {
        const statuses = byBase.get(n) ?? [];
        return statuses.length > 0 && statuses.every((st) => st === "success");
      });
      if (!satisfied) continue;
    }
    if (spec.group && (await hasActiveGroupJob(env.DB, repo, spec.group))) continue;
    await setJobStatus(env.DB, job.id, "queued");
    await rollupRunStatus(env.DB, job.run_id);
    await env.RUN_QUEUE.send({ runId: job.run_id, jobId: job.id, repo: job.repo, sha: job.sha } satisfies QueueJobMessage);
    promoted.push(job.id);
  }
  return promoted;
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
    const { runId, jobIds, blocked } = await createRunAndFanOut(env, { repo, sha, branch, event, installationId, jobs });

    log("info", "run queued", { runId, jobCount: jobIds.length, blocked, repo, sha, event });
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
      const promoted = await promoteBlockedJobs(env, run.repo);
      if (promoted.length > 0) log("info", "blocked jobs promoted", { runId, promoted });
    }
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
): Promise<{ runId: string; jobIds: string[] }> {
  let jobs: PipelineJob[] | null = null;
  if (input.pipeline) {
    jobs = parsePipeline(input.pipeline);
    if (!jobs) throw new Error("pipeline parse failed");
  } else {
    jobs = await loadPipelineJobs(env, input.repo, input.sha, null);
  }
  const branch = branchFromRef(input.ref) || input.ref;
  const { runId, jobIds } = await createRunAndFanOut(env, {
    repo: input.repo,
    sha: input.sha,
    branch,
    event: "dispatch",
    installationId: null,
    jobs,
  });
  log("info", "run dispatched", { runId, repo: input.repo, sha: input.sha });
  return { runId, jobIds };
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
    if (!scopes) return json({ error: "scopes must be a non-empty array of runner|readonly" }, 400);
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
    await audit(env.DB, "setup", "admin.setup", "");
    log("info", "admin password set via first-run setup");
    return json({ ok: true });
  } catch (e) {
    log("error", "setup failed", { error: String(e) });
    return json({ error: "setup failed" }, 500);
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
            return out;
          },
          rerunJob: async (runId, jobId) => {
            const out = await rerunJobAndQueue(env, runId, jobId);
            if (out.ok) await audit(env.DB, ident.actor, "job.rerun", jobId);
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
          return json(out, 202);
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
        const job = await nextQueuedJob(env.DB, labels);
        if (!job) return json({ job: null }, 200);
        await updateJob(env.DB, job.id, { status: "running" });
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
          cache: env.CACHE ? "r2" : "none",
        });
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
