import {
  audit,
  cancelGroupJobs,
  claimAdminMarker,
  claimNextJob,
  claimWebhookDelivery,
  createJob,
  createRun,
  createSchedule,
  createToken,
  createUser,
  deleteRepoSecret,
  deleteSchedule,
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
  isAdminMarkerClaimed,
  isTerminal,
  latestInstallationId,
  latestRunStatus,
  listAudit,
  listRepoSecretNames,
  listRuns,
  listSchedules,
  listTokens,
  listUsers,
  pruneOldRuns,
  pruneWebhookDeliveries,
  releaseAdminMarker,
  rerunJob,
  revokeToken,
  rollupRunStatus,
  setRepoSecret,
  setRunPrComment,
  setScheduleEnabled,
  setSetting,
  touchJob,
  touchScheduleRun,
  updateRunningJob,
} from "./db";
import {
  bytesEqual,
  getInstallationToken,
  mintAppJwt,
  resolveRefToSha,
  verifyGitHubSignature,
} from "./github";
import { DASHBOARD_HTML } from "./dashboard";
import { ensureSchema } from "./schema";
import {
  decryptSettingValue,
  encryptSecretValue,
  encryptSettingValue,
  getDecryptedRepoSecrets,
  resolveSecretsKey,
  validateSecretName,
  validateSecretValue,
} from "./secrets";
import { SETTING_KEYS, isBadgeHiddenRepo, parseBadgeHiddenRepos, validateNotifyFromEmail, validateNotifyMode, validateNotifyWebhookUrl, validateWebhookSecret } from "./settings";
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
  readRetryPolicy,
  seatEligible,
  serializeDefinition,
  type PipelineJob,
} from "./pipeline";
import { promoteBlockedJobs, maybeRetryJob, reportGitHubStatus, requeueStaleJobs, triageAndStore } from "./finish";
import { notifyRunCompleted } from "./notify";
import { authThrottleBlocked, authThrottleKeys, clearAuthFailures, recordAuthFailure } from "./ratelimit";
import { hashToken, newTokenValue, normalizeScopes, parseScopes, scopesAllow } from "./tokens";
import { badgeSvg } from "./badge";
import { jobDurationMs, summarizeRunCost } from "./cost";
import { runGenerate } from "./generate";
import { handleCacheGet, handleCachePut } from "./cache";
import { deleteJobArtifacts, handleArtifactGet, handleArtifactPut, listRunArtifacts, pruneOldCache } from "./artifacts";
import { cronMatches, validateCron } from "./cron";
import { reportJobCheck } from "./checks";
import { upsertPrComment } from "./prcomment";
import { deleteSource, handleSourceGet, handleSourcePut, pruneOldSources, SOURCE_ID_RE } from "./sources";
import { buildRunDigest } from "./digest";
import { waitForRunTerminal } from "./wait";
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
  // Optional sender override for run emails; D1 notify_from_email fills
  // the gap (env wins, like every other credential).
  NOTIFY_FROM_EMAIL?: string;
  // Base64 32-byte data key for repo secrets; when absent a D1-held
  // key is auto-generated (works out of the box, weaker at-rest story).
  SECRETS_KEY?: string;
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
// Statuses an executor may report: "running" is the executor's liveness
// signal, the rest are terminal.
const REPORTED_STATUSES = ["running", "success", "failure", "error", "cancelled", "skipped"];

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
// with no credentials. The claim marker covers a half-finished claim
// (marker won, account write failed) so nobody else can slip in.
async function isClaimed(env: WorkerEnv): Promise<boolean> {
  const [github, email, marker] = await Promise.all([
    getSetting(env.DB, SETTING_KEYS.adminGithubUser),
    getSetting(env.DB, SETTING_KEYS.adminEmail),
    isAdminMarkerClaimed(env.DB),
  ]);
  return github !== null || email !== null || marker;
}

async function getOAuthCreds(env: WorkerEnv): Promise<{ clientId: string; clientSecret: string } | null> {
  const [clientId, clientSecret] = await Promise.all([
    getSetting(env.DB, SETTING_KEYS.githubClientId),
    getSetting(env.DB, SETTING_KEYS.githubClientSecret),
  ]);
  if (!clientId || !clientSecret) return null;
  try {
    const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
    return { clientId, clientSecret: await decryptSettingValue(key, clientSecret) };
  } catch (err) {
    log("error", "oauth client secret undecryptable", { error: String(err) });
    return null;
  }
}

// Env secrets take precedence; dashboard-managed values fill the gaps
// so one-click deploys work with zero wrangler secret commands.
async function getWebhookSecret(env: WorkerEnv): Promise<string | null> {
  if (env.GITHUB_WEBHOOK_SECRET) return env.GITHUB_WEBHOOK_SECRET;
  const stored = await getSetting(env.DB, SETTING_KEYS.webhookSecret);
  if (!stored) return null;
  try {
    const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
    return await decryptSettingValue(key, stored);
  } catch (err) {
    log("error", "webhook secret undecryptable", { error: String(err) });
    return null;
  }
}

async function getAppCreds(env: WorkerEnv): Promise<{ appId: string; privateKey: string } | null> {
  return resolveAppCreds(env.DB, { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY }, env.SECRETS_KEY);
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

export interface GitHubWebhookPayload {
  ref?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  after?: string;
  installation?: { id?: number };
  pull_request?: { head?: { sha?: string; ref?: string }; number?: number };
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

// Events that create runs. Everything else (ping, installation, star, …)
// is acknowledged without a run — GitHub treats non-2xx as failed delivery.
const RUN_EVENTS = ["push", "pull_request"];

// Pure gate for webhook fan-out: returns a skip reason, or null to proceed.
// Branch/tag deletions carry deleted:true with a zero SHA; fanning those
// out would create runs that can never check out (and mail failure noise).
export function webhookSkipReason(event: string, payload: GitHubWebhookPayload): string | null {
  if (!RUN_EVENTS.includes(event)) return `unsupported event: ${event}`;
  if (event === "push" && payload.deleted === true) return "ref deleted";
  const sha = payload.after ?? payload.pull_request?.head?.sha;
  if (typeof sha === "string" && sha === ZERO_SHA) return "zero sha (deleted ref)";
  return null;
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
    priority?: number;
    source?: string | null;
    prNumber?: number | null;
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
    source: input.source ?? null,
    prNumber: input.prNumber ?? null,
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
      priority: input.priority ?? 0,
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

    // Idempotency: GitHub retries (and manual redeliveries) reuse the
    // delivery UUID. First claim wins; a duplicate is acknowledged.
    const delivery = request.headers.get("x-github-delivery");
    if (delivery) {
      if (!/^[A-Za-z0-9-]{8,64}$/.test(delivery)) return json({ error: "invalid delivery id" }, 400);
      if (!(await claimWebhookDelivery(env.DB, delivery))) {
        log("info", "webhook duplicate ignored", { delivery });
        return json({ skipped: "duplicate delivery" }, 200);
      }
    }

    const event = request.headers.get("x-github-event") ?? "unknown";
    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as GitHubWebhookPayload;
    } catch {
      return json({ error: "invalid JSON payload" }, 400);
    }
    const skip = webhookSkipReason(event, payload);
    if (skip) {
      log("info", "webhook skipped", { event, reason: skip });
      return json({ skipped: skip }, 200);
    }
    const repo = payload.repository?.full_name;
    const sha = payload.after ?? payload.pull_request?.head?.sha;
    if (!repo || !sha) return json({ error: "missing repo or sha" }, 400);
    const branch = branchFromRef(payload.ref) || payload.pull_request?.head?.ref || "";

    const installationId = payload.installation?.id ?? null;
    const prNumber = event === "pull_request" ? (payload.pull_request?.number ?? null) : null;
    const jobs = await loadPipelineJobs(env, repo, sha, installationId);
    const { runId, jobIds, queuedIds, blocked } = await createRunAndFanOut(env, {
      repo,
      sha,
      branch,
      event,
      installationId,
      jobs,
      prNumber,
    });

    // Post-response maintenance never blocks the webhook: bounded
    // retention prune plus the stuck-claim sweep (dead executors get
    // their jobs requeued for a live taker).
    ctx.waitUntil(
      (async () => {
        try {
          const pruned = await pruneOldRuns(env.DB);
          if (pruned.runs > 0) {
            let artifacts = 0;
            for (const jobId of pruned.jobIds) artifacts += await deleteJobArtifacts(env.CACHE, jobId);
            for (const source of pruned.sources) await deleteSource(env.CACHE, source);
            log("info", "pruned old runs", { pruned: pruned.runs, artifacts, sources: pruned.sources.length });
          }
          const staleCache = await pruneOldCache(env.CACHE);
          if (staleCache > 0) log("info", "pruned stale cache entries", { pruned: staleCache });
          const staleSources = await pruneOldSources(env.CACHE);
          if (staleSources > 0) log("info", "pruned stale sources", { pruned: staleSources });
          await pruneWebhookDeliveries(env.DB);
        } catch (err: unknown) {
          log("warn", "run prune failed", { error: String(err) });
        }
        try {
          const requeued = await requeueStaleJobs(env.DB, env.RUN_QUEUE, 20, (job) =>
            wakeSeat(env, job.jobId),
          );
          if (requeued.length > 0) log("info", "requeued stale jobs", { requeued });
        } catch (err: unknown) {
          log("warn", "stale sweep failed", { error: String(err) });
        }
      })(),
    );
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
    let body: { status?: string; jobId?: string; log?: string; result?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!body.status || !body.jobId) return json({ error: "missing status or jobId" }, 400);
    const jobId = body.jobId;
    if (!REPORTED_STATUSES.includes(body.status)) {
      return json({ error: "invalid status" }, 400);
    }
    const run = await getRun(env.DB, runId);
    if (!run) return json({ error: "run not found" }, 404);
    const job = await getJob(env.DB, jobId);
    if (!job || job.run_id !== runId) return json({ error: "job not found" }, 404);
    // Retry policy: a failing attempt requeues while the budget remains
    // instead of going terminal (and triaging/notifying on every flake).
    if ((body.status === "failure" || body.status === "error") && readRetryPolicy(job.definition) > 0) {
      const retried = await maybeRetryJob(env.DB, env.RUN_QUEUE, jobId, (j) => wakeSeat(env, j.jobId));
      if (retried) {
        log("info", "job retrying", { runId, jobId, attempt: job.attempts + 2 });
        return json({ ok: true, retrying: true });
      }
    }
    const result = typeof body.result === "string" ? body.result.slice(0, 65536) : undefined;
    const cappedLog = typeof body.log === "string" ? body.log.slice(0, 262144) : undefined;
    const recorded = await updateRunningJob(env.DB, jobId, { status: body.status, log: cappedLog, result });
    if (!recorded) {
      // The row moved on (re-run or stale requeue): this report belongs
      // to a superseded execution, so drop it instead of clobbering.
      log("warn", "status report dropped: job not running", { runId, jobId, status: body.status });
      return json({ ok: true, dropped: true });
    }
    await rollupRunStatus(env.DB, runId);
    // Same post-response maintenance as webhooks: dispatch-driven
    // instances with no push traffic still sweep stuck claims.
    ctx.waitUntil(
      (async () => {
        try {
          const requeued = await requeueStaleJobs(env.DB, env.RUN_QUEUE, 20, (job) =>
            wakeSeat(env, job.jobId),
          );
          if (requeued.length > 0) log("info", "requeued stale jobs", { requeued });
        } catch (err: unknown) {
          log("warn", "stale sweep failed", { error: String(err) });
        }
      })(),
    );
    log("info", "status updated", { runId, jobId, status: body.status });
    if (isTerminal(body.status)) {
      const promoted = await promoteBlockedJobs(env.DB, env.RUN_QUEUE, run.repo, (job) => wakeSeat(env, job.jobId));
      if (promoted.length > 0) log("info", "blocked jobs promoted", { runId, promoted });
    }
    // Notify on the transition into terminal (re-checked after promote, so
    // skip-terminalized runs mail too). A callback on an already-terminal
    // run is a duplicate delivery, not a new completion.
    if (!isTerminal(run.status)) {
      const finalRun = await getRun(env.DB, runId);
      if (finalRun && isTerminal(finalRun.status)) {
        const origin = new URL(request.url).origin;
        ctx.waitUntil(notifyRunCompleted(env.DB, env, { run: finalRun, origin }));
        // One PR comment per run, edited in place on later completions.
        if (run.event !== "source" && finalRun.pr_number && run.installation_id) {
          const creds = await getAppCreds(env);
          ctx.waitUntil(
            (async () => {
              const jobs = await getJobsForRun(env.DB, runId);
              const id = await upsertPrComment(
                {
                  appId: creds?.appId,
                  privateKey: creds?.privateKey,
                  installationId: run.installation_id,
                  repo: run.repo,
                  prNumber: finalRun.pr_number as number,
                  existingCommentId: run.pr_comment_id,
                  origin,
                },
                finalRun,
                jobs,
              );
              if (id && !run.pr_comment_id) await setRunPrComment(env.DB, runId, id).catch(() => undefined);
            })(),
          );
        }
      }
    }
    // Source runs have no commit to annotate: skip commit statuses and
    // Check Runs for them (triage/notify/digest still apply).
    const isSourceRun = run.event === "source";
    if (!isSourceRun && (body.status === "success" || body.status === "failure" || body.status === "error")) {
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
    // Per-job Check Run: the rich PR-page surface (failing command +
    // output tail). Best-effort, independent of commit statuses.
    if (!isSourceRun && isTerminal(body.status)) {
      const creds = await getAppCreds(env);
      const origin = new URL(request.url).origin;
      ctx.waitUntil(
        (async () => {
          const fresh = await getJob(env.DB, jobId);
          if (fresh) {
            await reportJobCheck(
              {
                appId: creds?.appId,
                privateKey: creds?.privateKey,
                installationId: run.installation_id,
                repo: run.repo,
                sha: run.sha,
                origin,
              },
              fresh,
            );
          }
        })(),
      );
    }
    if (body.status === "failure" || body.status === "error") {
      const jobs = await getJobsForRun(env.DB, runId);
      const jobName = jobs.find((j) => j.id === jobId)?.name ?? "";
      ctx.waitUntil(triageAndStore(env.DB, env.AI, run, jobId, jobName, cappedLog, result));
    }
    return json({ ok: true });
  } catch (err) {
    log("error", "status callback failed", { error: String(err) });
    return json({ error: "status update failed" }, 500);
  }
}

export function isHexSha(s: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(s);
}

export function validateDispatch(
  body: Record<string, unknown>,
): { repo: string; sha: string; ref: string; pipeline?: string; priority: number; source?: string } | { error: string } {
  const { repo, sha, ref, pipeline, priority, source } = body;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "repo must be owner/name" };
  if (ref !== undefined && (typeof ref !== "string" || ref.length > 128)) return { error: "invalid ref" };
  if (pipeline !== undefined && (typeof pipeline !== "string" || !pipeline.trim() || pipeline.length > 65536)) {
    return { error: "invalid pipeline" };
  }
  // Agent priority lane: 0 default, 10 urgent (jumps queued batch work).
  if (priority !== undefined && (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 10)) {
    return { error: "priority must be an integer 0-10" };
  }
  const parsedPriority = typeof priority === "number" ? priority : 0;
  const parsedRef = typeof ref === "string" ? ref : "";
  // Source runs execute an uploaded working tree: no commit, no ref —
  // the inline pipeline is the contract (empty pipeline would silently
  // echo, so require it explicitly).
  if (source !== undefined) {
    if (typeof source !== "string" || !SOURCE_ID_RE.test(source)) return { error: "invalid source id" };
    if (typeof pipeline !== "string") return { error: "source runs need an inline pipeline" };
    return { repo, sha: "", ref: parsedRef, pipeline, priority: parsedPriority, source };
  }
  if (typeof sha !== "string" || !/^[\w./-]+$/.test(sha) || sha.length > 128 || sha.includes("..")) {
    return { error: "sha must be a commit SHA, branch, or tag" };
  }
  return {
    repo,
    sha,
    ref: parsedRef,
    pipeline: typeof pipeline === "string" ? pipeline : undefined,
    priority: parsedPriority,
  };
}

export function validateScheduleInput(
  body: Record<string, unknown>,
): { repo: string; ref: string; cron: string } | { error: string } {
  const { repo, ref, cron } = body;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "repo must be owner/name" };
  if (typeof ref !== "string" || !/^[\w./-]+$/.test(ref) || ref.length > 128 || ref.includes("..")) {
    return { error: "ref must be a branch or tag (max 128 chars)" };
  }
  const cronErr = validateCron(cron);
  if (cronErr) return { error: cronErr };
  return { repo, ref, cron: (cron as string).trim() };
}

async function dispatchRun(
  env: WorkerEnv,
  input: { repo: string; sha: string; ref: string; pipeline?: string; event?: string; priority?: number; source?: string },
): Promise<{ runId: string; jobIds: string[]; queuedIds: string[] }> {
  // Dispatch accepts a SHA, branch, or tag: non-SHA refs resolve to the
  // head commit (installation token when the repo has App history, else
  // the public API), so the stored run always pins a real commit. The
  // resolved installation rides into the run row so commit statuses and
  // private pipeline fetches work for scheduled runs too. Source runs
  // skip all of that: they execute the uploaded tree against the inline
  // pipeline.
  let sha = input.sha;
  let installationId: number | null = null;
  let jobs: PipelineJob[] | null = null;
  if (input.source) {
    sha = `src-${input.source.slice(0, 8)}`;
    jobs = input.pipeline ? parsePipeline(input.pipeline) : null;
    if (!jobs) throw new Error("pipeline parse failed");
  } else {
    installationId = await latestInstallationId(env.DB, input.repo);
    if (!isHexSha(sha)) {
      let token: string | null = null;
      const creds = await getAppCreds(env);
      if (installationId && creds) {
        try {
          const jwt = await mintAppJwt(creds.appId, creds.privateKey);
          token = await getInstallationToken(jwt, installationId);
        } catch {
          token = null;
        }
      }
      const resolved = await resolveRefToSha(token, input.repo, sha);
      if (!resolved) throw new Error(`could not resolve ref "${sha}" — paste a full commit SHA`);
      sha = resolved;
    }
    if (input.pipeline) {
      jobs = parsePipeline(input.pipeline);
      if (!jobs) throw new Error("pipeline parse failed");
    } else {
      jobs = await loadPipelineJobs(env, input.repo, sha, installationId);
    }
  }
  const branch = input.source
    ? input.ref || "local"
    : branchFromRef(input.ref) || input.ref || (!isHexSha(input.sha) ? input.sha : "");
  const { runId, jobIds, queuedIds } = await createRunAndFanOut(env, {
    repo: input.repo,
    sha,
    branch,
    event: input.event ?? "dispatch",
    installationId,
    jobs,
    priority: input.priority ?? 0,
    source: input.source ?? null,
  });
  log("info", "run dispatched", { runId, repo: input.repo, sha, event: input.event ?? "dispatch", source: input.source ?? null });
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

// Admin-only repo secret management. Values are write-only: GET lists
// names, never values; values decrypt only inside job claims.
async function handleRepoSecrets(request: Request, env: WorkerEnv): Promise<Response> {
  const ident = await authIdentity(request, env);
  if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
    return json({ secrets: await listRepoSecretNames(env.DB, repo) });
  }
  if (request.method === "DELETE") {
    const repo = url.searchParams.get("repo") ?? "";
    const name = url.searchParams.get("name") ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
    const nameErr = validateSecretName(name);
    if (nameErr) return json({ error: nameErr }, 400);
    const deleted = await deleteRepoSecret(env.DB, repo, name);
    if (!deleted) return json({ error: "secret not found" }, 404);
    await audit(env.DB, ident.actor, "secret.delete", `${repo}:${name}`);
    return json({ ok: true });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) {
    return json({ error: "repo must be owner/name" }, 400);
  }
  const nameErr = validateSecretName(body.name);
  if (nameErr) return json({ error: nameErr }, 400);
  const valueErr = validateSecretValue(body.value);
  if (valueErr) return json({ error: valueErr }, 400);
  const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
  const enc = await encryptSecretValue(key, body.value as string);
  await setRepoSecret(env.DB, body.repo, body.name as string, enc.iv, enc.data);
  await audit(env.DB, ident.actor, "secret.set", `${body.repo}:${body.name as string}`);
  return json({ ok: true });
}

async function handleCreateToken(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const ident = await authIdentity(request, env);
    if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
    let body: { name?: unknown; scopes?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
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
    let body: {
      webhookSecret?: unknown;
      notifyFromEmail?: unknown;
      notifyMode?: unknown;
      notifyWebhookUrl?: unknown;
      badgeHiddenRepos?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const hasWebhook = body.webhookSecret !== undefined;
    const hasNotifyFrom = body.notifyFromEmail !== undefined;
    const hasNotifyMode = body.notifyMode !== undefined;
    const hasNotifyWebhook = body.notifyWebhookUrl !== undefined;
    const hasBadgeHidden = body.badgeHiddenRepos !== undefined;
    if (!hasWebhook && !hasNotifyFrom && !hasNotifyMode && !hasNotifyWebhook && !hasBadgeHidden) {
      return json({ error: "no settings provided" }, 400);
    }
    if (hasWebhook) {
      if (env.GITHUB_WEBHOOK_SECRET) {
        return json({ error: "webhook secret managed via environment" }, 409);
      }
      const err = validateWebhookSecret(body.webhookSecret);
      if (err) return json({ error: err }, 400);
      await setSetting(env.DB, SETTING_KEYS.webhookSecret, body.webhookSecret as string);
      await audit(env.DB, ident.actor, "settings.webhook", "");
      log("info", "webhook secret set via dashboard");
    }
    if (hasNotifyFrom) {
      if (env.NOTIFY_FROM_EMAIL) {
        return json({ error: "notify sender managed via environment" }, 409);
      }
      const err = validateNotifyFromEmail(body.notifyFromEmail);
      if (err) return json({ error: err }, 400);
      await setSetting(env.DB, SETTING_KEYS.notifyFromEmail, (body.notifyFromEmail as string).trim());
      await audit(env.DB, ident.actor, "settings.notify_from", "");
      log("info", "notify sender set via dashboard");
    }
    if (hasNotifyMode) {
      const err = validateNotifyMode(body.notifyMode);
      if (err) return json({ error: err }, 400);
      await setSetting(env.DB, SETTING_KEYS.notifyMode, body.notifyMode as string);
      await audit(env.DB, ident.actor, "settings.notify_mode", body.notifyMode as string);
    }
    if (hasNotifyWebhook) {
      // Write-only credential: a URL is either set (encrypted) or
      // cleared with an empty string/null. Never read back over the API.
      const value = body.notifyWebhookUrl;
      const clearing = value === null || value === "" || value === undefined;
      if (clearing) {
        await setSetting(env.DB, SETTING_KEYS.notifyWebhookUrl, "");
        await audit(env.DB, ident.actor, "settings.notify_webhook", "cleared");
      } else {
        const err = validateNotifyWebhookUrl(value);
        if (err) return json({ error: err }, 400);
        const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
        await setSetting(env.DB, SETTING_KEYS.notifyWebhookUrl, await encryptSettingValue(key, value as string));
        await audit(env.DB, ident.actor, "settings.notify_webhook", "set");
      }
    }
    if (hasBadgeHidden) {
      const parsed = parseBadgeHiddenRepos(body.badgeHiddenRepos);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.badgeHiddenRepos, parsed.repos.join(","));
      await audit(env.DB, ident.actor, "settings.badge_hidden", String(parsed.repos.length));
    }
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
      // CSRF defense-in-depth for cookie-authenticated mutations:
      // browsers send Origin on cross-site and same-origin fetch/form
      // POSTs, so a mismatch is rejected. Bearer flows (API, MCP) and
      // GitHub's webhook carry no session cookie and stay exempt.
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        if (getBearer(request) === null && parseSessionCookie(request) !== null) {
          const origin = request.headers.get("Origin");
          if (origin && origin !== url.origin) {
            log("warn", "cross-origin mutation rejected", { path: url.pathname, origin });
            return json({ error: "cross-origin request rejected" }, 403);
          }
        }
      }
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
          waitForRun: async (runId, timeoutMs) => {
            const out = await waitForRunTerminal(env.DB, runId, { timeoutMs });
            return { timedOut: out ? out.timedOut : true };
          },
          digestRun: async (runId) => buildRunDigest(env.DB, runId),
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
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          return json({ error: "limit must be an integer 1-200" }, 400);
        }
        if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
          return json({ error: "offset must be an integer 0-100000" }, 400);
        }
        return json({ runs: await listRuns(env.DB, limit, offset) });
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
      // Blocking wait: hold the request until the run is terminal (or the
      // budget runs out) so agents verify in one call instead of polling.
      const runWaitMatch = /^\/v1\/runs\/([^/]+)\/wait$/.exec(url.pathname);
      if (request.method === "GET" && runWaitMatch) {
        if (!(await requireScope(request, env, "read"))) return json({ error: "unauthorized" }, 401);
        const timeout = Number(url.searchParams.get("timeout") ?? "30");
        if (!Number.isFinite(timeout) || timeout < 1 || timeout > 90) {
          return json({ error: "timeout must be 1-90 seconds" }, 400);
        }
        const out = await waitForRunTerminal(env.DB, runWaitMatch[1], { timeoutMs: timeout * 1000 });
        if (!out) return json({ error: "run not found" }, 404);
        return json({
          run: out.run,
          jobs: out.jobs.map((j) => ({ ...j, durationMs: jobDurationMs(j) })),
          summary: summarizeRunCost(out.jobs),
          timedOut: out.timedOut,
          waitedMs: out.waitedMs,
        });
      }
      // Token-efficient digest for agents: failures, bounded tails, no logs.
      const runDigestMatch = /^\/v1\/runs\/([^/]+)\/digest$/.exec(url.pathname);
      if (request.method === "GET" && runDigestMatch) {
        if (!(await requireScope(request, env, "read"))) return json({ error: "unauthorized" }, 401);
        const digest = await buildRunDigest(env.DB, runDigestMatch[1]);
        if (!digest) return json({ error: "run not found" }, 404);
        return json(digest);
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
        // Secrets ride the authenticated claim only — never any read API.
        // Undecryptable rows fail open to empty (flagged) rather than
        // stranding the job in a claim loop.
        let secrets: Record<string, string> = {};
        let secretsError = false;
        try {
          secrets = await getDecryptedRepoSecrets(env.DB, env.SECRETS_KEY, job.repo);
        } catch (err) {
          secretsError = true;
          log("warn", "repo secrets undecryptable", { repo: job.repo, error: String(err) });
          await audit(env.DB, "system", "secrets.decrypt_failed", job.repo).catch(() => undefined);
        }
        return json({ job, secrets, secretsError });
      }
      const statusMatch = /^\/v1\/runs\/([^/]+)\/status$/.exec(url.pathname);
      if (request.method === "POST" && statusMatch) {
        return await handleStatusCallback(request, env, ctx, statusMatch[1]);
      }
      const heartbeatMatch = /^\/v1\/runs\/([^/]+)\/jobs\/([^/]+)\/heartbeat$/.exec(url.pathname);
      if (request.method === "POST" && heartbeatMatch) {
        if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
        const job = await getJob(env.DB, heartbeatMatch[2]);
        if (!job || job.run_id !== heartbeatMatch[1]) return json({ error: "job not found" }, 404);
        await touchJob(env.DB, job.id);
        return json({ ok: true });
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
      // Source dispatch: upload a working-tree tarball, then dispatch
      // with `source: <id>` and an inline pipeline (run scope only).
      if (request.method === "POST" && url.pathname === "/v1/source") {
        if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
        return await handleSourcePut(env.CACHE, request);
      }
      const sourceMatch = /^\/v1\/source\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && sourceMatch) {
        if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
        return await handleSourceGet(env.CACHE, sourceMatch[1]);
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
        // Repos opted out (private ones) never leak pass/fail: the
        // public endpoint serves "unknown" instead.
        const hidden = isBadgeHiddenRepo(await getSetting(env.DB, SETTING_KEYS.badgeHiddenRepos), repo);
        const status = hidden ? null : await latestRunStatus(env.DB, repo, branch);
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
          githubConnected: connected,
          installUrl: slug ? installUrl(slug) : null,
          user: ident ? { actor: ident.actor, admin: ident.scope === "admin" } : null,
          // Deployment hardening detail: admins only, not the pre-login page.
          ...(ident?.scope === "admin" ? { breakGlass: !!env.ADMIN_TOKEN } : {}),
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
        let decision = await decideLogin(env.DB, login);
        if (!decision.allowed) {
          log("info", "github login denied", { login });
          return Response.redirect(new URL("/dashboard?github=forbidden", url).toString(), 302);
        }
        if (!decision.claimed) {
          // Atomic gate for the first login: a concurrent first login
          // that loses the race re-decides against the winner's state
          // instead of both claiming admin.
          if (await claimAdminMarker(env.DB)) {
            await claimAdmin(env.DB, login);
            await audit(env.DB, `github:${login}`, "admin.claim", "");
            log("info", "admin claimed", { login });
          } else {
            decision = await decideLogin(env.DB, login);
            if (!decision.allowed) {
              log("info", "github login denied", { login });
              return Response.redirect(new URL("/dashboard?github=forbidden", url).toString(), 302);
            }
          }
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
        const keys = await authThrottleKeys(request);
        if (await authThrottleBlocked(env.DB, keys)) {
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        if (typeof body.token !== "string" || !body.token) return await fail(json({ error: "invite required" }, 400));
        const pwErr = validatePassword(body.password);
        if (pwErr) return await fail(json({ error: pwErr }, 400));
        const invite = await consumeInvite(env.DB, body.token);
        if (!invite) return await fail(json({ error: "invite invalid or expired" }, 404));
        if (await getUser(env.DB, invite.email)) {
          return await fail(json({ error: "that email already has an account" }, 409));
        }
        await createUser(env.DB, { email: invite.email, passwordHash: await hashPassword(body.password as string), isAdmin: false });
        await clearAuthFailures(env.DB, keys);
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
        const keys = await authThrottleKeys(request, typeof body.email === "string" ? normalizeEmail(body.email) : undefined);
        if (await authThrottleBlocked(env.DB, keys)) {
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        const emailErr = validateEmail(body.email);
        if (emailErr) return await fail(json({ error: emailErr }, 400));
        const pwErr = validatePassword(body.password);
        if (pwErr) return await fail(json({ error: pwErr }, 400));
        const email = normalizeEmail(body.email as string);
        // Atomic gate: concurrent first requests can otherwise both pass
        // the isClaimed() read above and both create an admin.
        if (!(await claimAdminMarker(env.DB))) return json({ error: "already claimed" }, 403);
        try {
          await createUser(env.DB, { email, passwordHash: await hashPassword(body.password as string), isAdmin: true });
          await setSetting(env.DB, SETTING_KEYS.adminEmail, email);
        } catch (err) {
          await releaseAdminMarker(env.DB);
          throw err;
        }
        await clearAuthFailures(env.DB, keys);
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
        const keys = await authThrottleKeys(request, email);
        if (await authThrottleBlocked(env.DB, keys)) {
          log("warn", "login throttled", { email });
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const user = await getUser(env.DB, email);
        const ok = await verifyPassword(body.password, user?.password_hash ?? dummyPasswordHash());
        if (!user || !ok) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json({ error: "invalid email or password" }, 401);
        }
        await clearAuthFailures(env.DB, keys);
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
        const notifyFromSource = env.NOTIFY_FROM_EMAIL
          ? "env"
          : (await getSetting(env.DB, SETTING_KEYS.notifyFromEmail)) !== null
            ? "d1"
            : "none";
        return json({
          adminGithubUser: await getSetting(env.DB, SETTING_KEYS.adminGithubUser),
          adminEmail: await getSetting(env.DB, SETTING_KEYS.adminEmail),
          webhookSecretSource,
          cache: env.CACHE ? "r2" : "none",
          githubApp: { source: githubSource, installUrl: githubSlug ? installUrl(githubSlug) : null },
          notifyFrom: env.NOTIFY_FROM_EMAIL ?? (await getSetting(env.DB, SETTING_KEYS.notifyFromEmail)),
          notifyFromSource,
          notifyMode: (await getSetting(env.DB, SETTING_KEYS.notifyMode)) ?? "all",
          notifyWebhookSet: !!(await getSetting(env.DB, SETTING_KEYS.notifyWebhookUrl)),
          badgeHiddenRepos: (await getSetting(env.DB, SETTING_KEYS.badgeHiddenRepos)) ?? "",
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
        await storeAppCredentials(env.DB, app, await resolveSecretsKey(env.DB, env.SECRETS_KEY));
        await audit(env.DB, "github-connect", "github.connect.done", app.slug);
        log("info", "github app connected", { slug: app.slug, appId: app.appId });
        return Response.redirect(new URL("/dashboard?github=connected", url).toString(), 302);
      }
      if (
        (request.method === "GET" || request.method === "POST" || request.method === "DELETE") &&
        url.pathname === "/v1/admin/secrets"
      ) {
        return await handleRepoSecrets(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/settings") {
        return await handleSettingsUpdate(request, env);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/audit") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        return json({ entries: await listAudit(env.DB) });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/schedules") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const schedules = await listSchedules(env.DB);
        return json({
          schedules: schedules.map((s) => ({
            id: s.id,
            repo: s.repo,
            ref: s.ref,
            cron: s.cron,
            enabled: s.enabled === 1,
            lastRunAt: s.last_run_at,
            createdAt: s.created_at,
          })),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/schedules") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateScheduleInput(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        if ((await listSchedules(env.DB)).length >= 50) {
          return json({ error: "schedule limit reached (50)" }, 400);
        }
        const id = crypto.randomUUID();
        await createSchedule(env.DB, { id, repo: valid.repo, ref: valid.ref, cron: valid.cron });
        await audit(env.DB, ident.actor, "schedule.create", `${id} ${valid.repo}@${valid.ref} ${valid.cron}`);
        log("info", "schedule created", { id, repo: valid.repo, ref: valid.ref, cron: valid.cron });
        return json({ id }, 201);
      }
      const scheduleMatch = /^\/v1\/admin\/schedules\/([^/]+)$/.exec(url.pathname);
      if (scheduleMatch && request.method === "POST") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
        if (typeof body.enabled !== "boolean") return json({ error: "enabled must be a boolean" }, 400);
        const ok = await setScheduleEnabled(env.DB, scheduleMatch[1], body.enabled);
        if (!ok) return json({ error: "schedule not found" }, 404);
        await audit(env.DB, ident.actor, "schedule.toggle", `${scheduleMatch[1]} ${String(body.enabled)}`);
        return json({ ok: true });
      }
      if (scheduleMatch && request.method === "DELETE") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const ok = await deleteSchedule(env.DB, scheduleMatch[1]);
        if (!ok) return json({ error: "schedule not found" }, 404);
        await audit(env.DB, ident.actor, "schedule.delete", scheduleMatch[1]);
        return json({ ok: true });
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

  // Cron trigger (every minute): fire due schedules. last_run_at guards
  // against trigger redelivery and broken schedules hot-looping.
  async scheduled(controller: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    try {
      await ensureSchema(env.DB);
      // Previews share the staging database; only production dispatches.
      if (env.ENVIRONMENT !== "production") return;
      const now = new Date(controller.scheduledTime);
      const schedules = await listSchedules(env.DB);
      for (const s of schedules) {
        if (s.enabled !== 1 || !cronMatches(s.cron, now)) continue;
        if (s.last_run_at && Date.now() - Date.parse(s.last_run_at) < 60000) continue;
        try {
          const out = await dispatchRun(env, { repo: s.repo, sha: s.ref, ref: s.ref, event: "schedule" });
          await touchScheduleRun(env.DB, s.id);
          await audit(env.DB, "schedule", "run.dispatch", `${s.id} ${out.runId}`);
          for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
          log("info", "scheduled run dispatched", { scheduleId: s.id, runId: out.runId, repo: s.repo, ref: s.ref });
        } catch (err) {
          // Stamp the attempt anyway: a schedule that cannot dispatch
          // must not retry every minute forever.
          await touchScheduleRun(env.DB, s.id).catch(() => undefined);
          log("warn", "scheduled dispatch failed", { scheduleId: s.id, error: String(err) });
        }
      }
    } catch (err) {
      log("error", "scheduled handler failed", { error: String(err) });
    }
  },
};
