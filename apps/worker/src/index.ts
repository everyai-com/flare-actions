import {
  audit,
  cancelGroupJobs,
  cancelQueuedJobs,
  claimAdminMarker,
  claimNextJob,
  claimWebhookDelivery,
  createJob,
  createMonitor,
  createRun,
  createSchedule,
  createToken,
  createUser,
  deleteMonitor,
  deleteRepoSecret,
  deleteSchedule,
  deleteSession,
  deleteUser,
  deleteUserSessions,
  flakyStats,
  getJob,
  getJobsForRun,
  getMonitor,
  getRun,
  getRunEgress,
  getRunTestJobs,
  getSession,
  getSetting,
  getUser,
  hasActiveGroupJob,
  isAdminMarkerClaimed,
  isTerminal,
  latestInstallationId,
  latestRunStatus,
  listAudit,
  listFailingTests,
  listMonitors,
  listQueuedJobs,
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
  saveTestReport,
  setMonitorEnabled,
  setMonitorMutedUntil,
  setRepoSecret,
  setRunPrComment,
  setScheduleEnabled,
  setSetting,
  setUserPassword,
  touchJob,
  touchScheduleRun,
  updateRunningJob,
  usageStats,
} from "./db";
import { commitFilesToNewBranch, getDefaultBranch, getInstallationToken, getRepoTreePaths, mintAppJwt, openDraftPullRequest, resolveRefToSha, verifyGitHubSignature } from "./github";
import { processHealClaims, requestHeal } from "./heal";
import { judgeFlaky } from "./judge";
import { DASHBOARD_HTML } from "./dashboard";
import { apiDocsPage } from "./apidocs";
import { OPENAPI_YAML } from "./openapi-spec";
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
import { SETTING_KEYS, isBadgeHiddenRepo, parseAiGatewayId, parseBadgeHiddenRepos, parseFairSharePerRepo, parseHealOnFailure, parseMcpWriteConfirm, parseTriageWebSearch, validateBillingApiToken, validateCloudflareAccountId, validateNotifyFromEmail, validateNotifyMode, validateNotifyWebhookUrl, validateTriageModel, validateTurnstileSecretKey, validateTurnstileSiteKey, validateWebhookSecret } from "./settings";
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
  consumeResetToken,
  createInvite,
  createResetToken,
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
import { buildCompatJobs, fetchWorkflowFiles, type WorkflowEventContext } from "./actionsCompat";
import { promoteBlockedJobs, maybeRetryJob, reportGitHubStatus, requeueStaleJobs, triageAndStore } from "./finish";
import { notifyRunCompleted, resolveNotifySender } from "./notify";
import {
  authThrottleBlocked,
  authThrottleKeys,
  clearAuthFailures,
  ipThrottleKey,
  recordAuthFailure,
} from "./ratelimit";
import {
  authIdentityFromToken,
  hashToken,
  newTokenValue,
  normalizeRepos,
  normalizeScopes,
  type AuthScope,
} from "./tokens";
import { badgeSvg } from "./badge";
import { emitJobTerminal, emitRunDispatched } from "./analytics";
import { basinJobTerminal, basinRunDispatched, basinSink, sendBasin, type BasinSink } from "./basin";
import { jobDurationMs, summarizeRunCost } from "./cost";
import { runGenerateWithStatus } from "./generate";
import { handleCacheGet, handleCachePut, listCacheEntries, purgeCachePrefix } from "./cache";
import { deleteJobArtifacts, handleArtifactGet, handleArtifactPut, listRunArtifacts, pruneOldCache } from "./artifacts";
import { ARTIFACTS_EVENT, handleArtifactsPush } from "./artifacts-push";
import {
  claimAttempt,
  createTournament,
  getTournamentBoard,
  listTournaments,
  pollTournamentAttempts,
  validateTournamentClaim,
  validateTournamentCreate,
} from "./tournaments";
import { verdictPass } from "./verdict";
import { artifactsRemoteFor, fastForwardPass, resolvePass } from "./promote";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { cronMatches, validateCron } from "./cron";
import { reportJobCheck } from "./checks";
import {
  evaluateDurationMonitors,
  evaluateResultMonitors,
  MAX_MONITORS,
  muteUntilIso,
  validateMonitorInput,
} from "./monitors";
import { MAX_JUNIT_BYTES, parseJUnit } from "./junit";
import { compileLogQuery, indexJobLog, searchLogs } from "./search";
import { lookupPriorMs, recordRuntimePrior } from "./priors";
import { billableWindow, fetchBillableUsage, summarizeBillableUsage } from "./billing";
import { TRIAGE_MODEL } from "./triage";
import { upsertPrComment } from "./prcomment";
import { deleteSource, handleSourceGet, handleSourcePut, pruneOldSources, SOURCE_ID_RE } from "./sources";
import { buildRunDigest } from "./digest";
import { annotateSpan, recordSpanException } from "./trace";
import { checkTurnstile, getTurnstileSiteKey } from "./turnstile";
import { waitForRunTerminal } from "./wait";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { buildMcpServer, mcpDiscovery } from "./mcp";
import {
  describeScope,
  handleAuthorizeGet,
  handleAuthorizePost,
  listOAuthGrants,
  listUserOAuthGrants,
  oauthUserId,
  principalFromCtx,
  principalFromSession,
  type AuthorizeContext,
  type McpPrincipalProps,
  type OAuthSession,
} from "./mcp-oauth";
import { D1KV } from "./oauth-kv";
// oauth-server holds the provider runtime (`cloudflare:` modules), so it
// loads lazily inside the OAuth routes — the static graph stays
// runtime-free for vitest (same split as seat.ts/seat-do.ts).
import type { OAuthEnv } from "./oauth-server";
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

import type { WorkerEnv } from "./env";

interface QueueJobMessage {
  runId: string;
  jobId: string;
  repo: string;
  sha: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The runs queue carries dispatch confirmations; the artifacts queue
// carries event envelopes. Shape-narrow before touching either.
function isQueueJobMessage(v: unknown): v is QueueJobMessage {
  return isRecord(v) && typeof v["runId"] === "string" && typeof v["jobId"] === "string";
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

function getBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

// Tokens plus GitHub sessions. Bearer: break-glass env admin, env
// runner, D1-issued tokens (admin/runner/readonly). Cookie: GitHub
// login sessions (admin, everyone else reads). Admin does everything;
// runner runs + reads; readonly only reads runs. `repos` is the token's
// repo allowlist ([] = all repos).
async function authIdentity(request: Request, env: WorkerEnv): Promise<{ scope: AuthScope; actor: string; repos: string[] } | null> {
  const bearer = getBearer(request);
  if (bearer) {
    return authIdentityFromToken(bearer, { db: env.DB, adminToken: env.ADMIN_TOKEN, runnerToken: env.RUNNER_TOKEN });
  }
  const sessionId = parseSessionCookie(request);
  if (!sessionId) return null;
  const session = await getSession(env.DB, sessionId);
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  const kind = session.kind === "email" ? "email" : "github";
  const actor = `${kind}:${session.github_user}`;
  return session.is_admin ? { scope: "admin", actor, repos: [] } : { scope: "readonly", actor, repos: [] };
}

// Repo-scoped tokens: empty allowlist means every repo.
function repoAllowed(ident: { repos: string[] }, repo: string): boolean {
  if (ident.repos.length === 0) return true;
  const needle = repo.toLowerCase();
  return ident.repos.some((r) => r.toLowerCase() === needle);
}

async function authScope(request: Request, env: WorkerEnv): Promise<AuthScope | null> {
  return (await authIdentity(request, env))?.scope ?? null;
}

async function isAdminRequest(request: Request, env: WorkerEnv): Promise<boolean> {
  return (await authScope(request, env)) === "admin";
}

// Dashboard session resolved for the OAuth consent page (logged-out
// users get the login prompt, not an error).
async function oauthSession(request: Request, env: WorkerEnv): Promise<OAuthSession | null> {
  const sessionId = parseSessionCookie(request);
  if (!sessionId) return null;
  const session = await getSession(env.DB, sessionId);
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  const kind = session.kind === "email" ? "email" : "github";
  return {
    userId: oauthUserId(kind, session.github_user),
    login: session.github_user,
    actor: `${kind}:${session.github_user}`,
    isAdmin: session.is_admin === 1,
  };
}

// MCP serving for one validated principal (shared by the resource
// server and the same-origin session-cookie path below).
async function serveMcpRequest(
  request: Request,
  env: WorkerEnv,
  props: McpPrincipalProps,
  canWrite: boolean,
  basin?: BasinSink,
): Promise<Response> {
  const handler = createMcpHandler(() =>
    buildMcpServer({
      db: env.DB,
      ai: env.AI,
      canWrite,
      gatewayId: env.AI_GATEWAY_ID,
      agent: request.headers.get("X-Flare-Agent") ?? request.headers.get("User-Agent") ?? undefined,
      dispatchRun: async (input) => {
        if (!repoAllowed({ repos: props.repos }, input.repo)) throw new Error("token is not scoped to that repo");
        const out = await dispatchRun(env, { repo: input.repo, sha: input.sha, ref: input.ref ?? "", pipeline: input.pipeline }, basin);
        await audit(env.DB, props.actor, "run.dispatch", out.runId);
        for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
        return { runId: out.runId, jobIds: out.jobIds };
      },
      rerunJob: async (runId, jobId) => {
        const out = await rerunJobAndQueue(env, runId, jobId, basin);
        if (out.ok) {
          await audit(env.DB, props.actor, "job.rerun", jobId);
          await wakeSeat(env, jobId);
        }
        return out;
      },
      waitForRun: async (runId, timeoutMs) => {
        const out = await waitForRunTerminal(env.DB, runId, { timeoutMs });
        return { timedOut: out ? out.timedOut : true };
      },
      digestRun: async (runId) => buildRunDigest(env.DB, runId),
    }),
  );
  return handler.fetch(request);
}

// MCP tool handler behind the OAuth resource server: the Bearer token
// (OAuth access token or legacy API token) arrives validated, with the
// principal in ctx.props and its scopes in ctx.auth.
const mcpApiHandler = {
  async fetch(request: Request, env: OAuthEnv, ctx: OAuthResourceContext<McpPrincipalProps>): Promise<Response> {
    const { props, canWrite } = principalFromCtx(ctx);
    return serveMcpRequest(request, env, props, canWrite, basinSink(env, ctx));
  },
};

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
): Promise<{ scope: AuthScope; actor: string; repos: string[] } | null> {
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
  pull_request?: {
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
    number?: number;
  };
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

// Resolve the run's jobs at repo@sha. Precedence: flare.yml (public
// raw, then authenticated) always wins; without one, GitHub Actions
// workflow files matching the run's event are translated and merged
// (actionsCompat.ts). Anything else is the default single job.
async function loadPipelineJobs(
  env: WorkerEnv,
  repo: string,
  sha: string,
  installationId: number | null,
  ctx?: WorkflowEventContext,
): Promise<PipelineJob[]> {
  try {
    // Public fast path first (no token minted); fall back to the
    // authenticated API for private repos when App creds exist.
    const direct = await fetchPipeline(repo, sha, null);
    if (direct) return parsePipeline(direct) ?? defaultPipeline();
    const creds = await getAppCreds(env);
    let token: string | null = null;
    if (installationId && creds) {
      try {
        const jwt = await mintAppJwt(creds.appId, creds.privateKey);
        token = await getInstallationToken(jwt, installationId);
      } catch (err) {
        log("warn", "private pipeline fetch failed, using default", { error: String(err) });
      }
    }
    if (token) {
      const text = await fetchPipeline(repo, sha, token);
      if (text) return parsePipeline(text) ?? defaultPipeline();
    }
    // No flare.yml at this commit: native .github/workflows compatibility.
    if (ctx) {
      let fetched = await fetchWorkflowFiles(repo, sha, null);
      if (!fetched && token) fetched = await fetchWorkflowFiles(repo, sha, token);
      if (fetched) {
        const compat = buildCompatJobs(fetched.files, { ...ctx, repo: ctx.repo ?? repo });
        const warnings = [...fetched.warnings, ...compat.warnings];
        if (compat.jobs) {
          log("info", "actions-compat run", {
            repo,
            sha,
            files: fetched.files.length,
            used: compat.used,
            jobs: compat.jobs.length,
            warnings: warnings.slice(0, 10),
          });
          return compat.jobs;
        }
        log("info", "actions-compat produced no jobs", {
          repo,
          sha,
          event: ctx.event,
          files: fetched.files.length,
          warnings: warnings.slice(0, 10),
        });
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
  basin?: BasinSink,
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
      const cancelled = await cancelGroupJobs(env.DB, input.repo, job.group, runId, env.ANALYTICS, basin);
      if (cancelled.length > 0) log("info", "concurrency cancelled superseded jobs", { group: job.group, cancelled });
    }
    const needsBlocked = (job.needs?.length ?? 0) > 0;
    const groupBlocked =
      !!job.group && !job.cancelInProgress && (await hasActiveGroupJob(env.DB, input.repo, job.group));
    const status = needsBlocked || groupBlocked ? "blocked" : "queued";
    if (status === "blocked") blocked += 1;
    const priorMs = await lookupPriorMs(env.DB, input.repo, job.name).catch(() => 0);
    await createJob(env.DB, jobId, runId, {
      name: job.name,
      definition: serializeDefinition(job, base),
      labels: (job.labels ?? []).join(","),
      status,
      priority: input.priority ?? 0,
      priorMs,
    });
    jobIds.push(jobId);
    if (status === "queued") {
      queuedIds.push(jobId);
      await env.RUN_QUEUE.send({ runId, jobId, repo: input.repo, sha: input.sha } satisfies QueueJobMessage);
    }
  }
  await rollupRunStatus(env.DB, runId, env.ANALYTICS, basin);
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
    // Previews wake the staging seats (their SEAT_QUEUE producer points
    // at the staging queue); production wakes production seats.
    if (env.ENVIRONMENT !== "production" && env.ENVIRONMENT !== "preview") return;
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
    const tag = payload.ref?.startsWith("refs/tags/") ? payload.ref.slice("refs/tags/".length) : "";

    const installationId = payload.installation?.id ?? null;
    const prNumber = event === "pull_request" ? (payload.pull_request?.number ?? null) : null;
    const jobs = await loadPipelineJobs(env, repo, sha, installationId, {
      event,
      branch,
      baseBranch: payload.pull_request?.base?.ref,
      tag,
    });
    const { runId, jobIds, queuedIds, blocked } = await createRunAndFanOut(env, {
      repo,
      sha,
      branch,
      event,
      installationId,
      jobs,
      prNumber,
    }, basinSink(env, ctx));

    // Post-response maintenance never blocks the webhook: bounded
    // retention prune plus the stuck-claim sweep (dead executors get
    // their jobs requeued for a live taker).
    ctx.waitUntil(
      (async () => {
        try {
          const pruned = await pruneOldRuns(env.DB);
          if (pruned.runs > 0) {
            let artifacts = 0;
            for (const jobId of pruned.jobIds) {
              artifacts += await deleteJobArtifacts(env.CACHE, jobId);
              // (D1 test rows go with the run inside pruneOldRuns.)
              if (env.CACHE) await env.CACHE.delete(`test-reports/${jobId}.xml`).catch(() => undefined);
            }
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
    ctx.waitUntil(annotateSpan({ "run.id": runId, repo, "event": event }));
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
    const ident = await requireScope(request, env, "run");
    if (!ident) return json({ error: "unauthorized" }, 401);
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
    if (!repoAllowed(ident, run.repo)) return json({ error: "job not found" }, 404);
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
    await rollupRunStatus(env.DB, runId, env.ANALYTICS, basinSink(env, ctx));
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
    ctx.waitUntil(annotateSpan({ "run.id": runId, "job.id": jobId, status: body.status }));
    if (isTerminal(body.status)) {
      const basin = basinSink(env, ctx);
      const promoted = await promoteBlockedJobs(env.DB, env.RUN_QUEUE, run.repo, (job) => wakeSeat(env, job.jobId), env.ANALYTICS, basin);
      if (promoted.length > 0) log("info", "blocked jobs promoted", { runId, promoted });
      // Result monitors ride the terminal transition (best-effort, never blocking).
      const finishedJob = await getJob(env.DB, jobId);
      if (finishedJob) {
        emitJobTerminal(env.ANALYTICS, {
          repo: run.repo,
          runId,
          jobName: finishedJob.name,
          status: body.status,
          durationMs: jobDurationMs(finishedJob) ?? 0,
          executor: "runner",
          attempts: finishedJob.attempts,
        });
        if (basin) {
          sendBasin(basin, basinJobTerminal({
            repo: run.repo,
            runId,
            jobName: finishedJob.name,
            status: body.status,
            durationMs: jobDurationMs(finishedJob) ?? 0,
            executor: "runner",
            attempts: finishedJob.attempts,
          }));
        }
        ctx.waitUntil(evaluateResultMonitors(env.DB, env, run, finishedJob));
      }
      if (finishedJob?.log) {
        ctx.waitUntil(
          indexJobLog(env.DB, {
            jobId,
            runId,
            repo: run.repo,
            branch: run.branch,
            log: finishedJob.log,
          }).catch((err: unknown) => log("warn", "log index failed", { runId, jobId, error: String(err) })),
        );
      }
      // Runtime prior: fold real durations (success/failure only —
      // cancels and infra errors carry no signal) into the hourly EMA.
      if (finishedJob && (body.status === "success" || body.status === "failure")) {
        const durationMs = jobDurationMs(finishedJob);
        if (durationMs !== null && finishedJob.finished_at) {
          const prior = { repo: run.repo, name: finishedJob.name, finishedAt: finishedJob.finished_at, durationMs };
          ctx.waitUntil(recordRuntimePrior(env.DB, prior).catch(() => undefined));
        }
      }
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
        if (run.event !== "source" && run.event !== ARTIFACTS_EVENT && finalRun.pr_number && run.installation_id) {
          const creds = await getAppCreds(env);
          ctx.waitUntil(
            (async () => {
              const jobs = await getJobsForRun(env.DB, runId);
              const failing = await listFailingTests(env.DB, runId, 15).catch(() => []);
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
                failing.map((f) => ({ jobName: f.job_name, suite: f.suite, name: f.name, message: f.message })),
              );
              if (id && !run.pr_comment_id) await setRunPrComment(env.DB, runId, id).catch(() => undefined);
            })(),
          );
        }
      }
    }
    // Source and Artifacts runs have no GitHub commit to annotate: skip
    // commit statuses and Check Runs for them (triage/notify/digest
    // still apply).
    const skipsGitHub = run.event === "source" || run.event === ARTIFACTS_EVENT;
    if (!skipsGitHub && (body.status === "success" || body.status === "failure" || body.status === "error")) {
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
    if (!skipsGitHub && isTerminal(body.status)) {
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
      ctx.waitUntil(
        triageAndStore(env.DB, env.AI, run, jobId, jobName, cappedLog, result, {
          gatewayId: env.AI_GATEWAY_ID,
          webSearch: env.TRIAGE_WEB_SEARCH === "1" ? true : undefined,
          model: env.TRIAGE_MODEL,
        }),
      );
      // Self-heal request: cheap guards + atomic claim; the scheduled
      // tick drains the queue (inference + GitHub writes never ride
      // the status callback).
      ctx.waitUntil(requestHeal(env.DB, runId, jobId));
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
  input: {
    repo: string;
    sha: string;
    ref: string;
    pipeline?: string;
    event?: string;
    priority?: number;
    source?: string;
    // Firing cron for schedule events; matches `on.schedule` entries in
    // Actions-compatible workflow files.
    cron?: string;
  },
  basin?: BasinSink,
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
  const branch = input.source
    ? input.ref || "local"
    : branchFromRef(input.ref) || input.ref || (!isHexSha(input.sha) ? input.sha : "");
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
      jobs = await loadPipelineJobs(env, input.repo, sha, installationId, {
        event: input.event ?? "dispatch",
        branch,
        cron: input.cron,
      });
    }
  }
  const { runId, jobIds, queuedIds } = await createRunAndFanOut(env, {
    repo: input.repo,
    sha,
    branch,
    event: input.event ?? "dispatch",
    installationId,
    jobs,
    priority: input.priority ?? 0,
    source: input.source ?? null,
  }, basin);
  log("info", "run dispatched", { runId, repo: input.repo, sha, event: input.event ?? "dispatch", source: input.source ?? null });
  emitRunDispatched(env.ANALYTICS, { repo: input.repo, runId, event: input.event ?? "dispatch", jobCount: jobIds.length });
  if (basin) {
    sendBasin(basin, basinRunDispatched({ repo: input.repo, runId, event: input.event ?? "dispatch", jobCount: jobIds.length }));
  }
  return { runId, jobIds, queuedIds };
}

async function rerunJobAndQueue(
  env: WorkerEnv,
  runId: string,
  jobId: string,
  basin?: BasinSink,
): Promise<{ ok: boolean; error?: string }> {
  const job = await getJob(env.DB, jobId);
  if (!job || job.run_id !== runId) return { ok: false, error: "job not found" };
  const reset = await rerunJob(env.DB, jobId);
  if (!reset) return { ok: false, error: "job not found" };
  await rollupRunStatus(env.DB, runId, env.ANALYTICS, basin);
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
    if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
    return json({ secrets: await listRepoSecretNames(env.DB, repo) });
  }
  if (request.method === "DELETE") {
    const repo = url.searchParams.get("repo") ?? "";
    const name = url.searchParams.get("name") ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
    if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
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
  if (!repoAllowed(ident, body.repo)) return json({ error: "token is not scoped to that repo" }, 403);
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
    let body: { name?: unknown; scopes?: unknown; repos?: unknown };
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
    const repos = normalizeRepos(body.repos);
    if (repos === null) return json({ error: "repos must be owner/name entries (max 50)" }, 400);
    const id = crypto.randomUUID();
    const value = newTokenValue();
    await createToken(env.DB, {
      id,
      name: body.name.trim(),
      tokenHash: await hashToken(value),
      scopes: scopes.join(","),
      repos: repos.join(","),
    });
    await audit(env.DB, ident.actor, "token.create", id);
    log("info", "token issued", { id, repos: repos.length });
    return json({ id, name: body.name.trim(), scopes, repos, token: value }, 201);
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
      turnstileSiteKey?: unknown;
      turnstileSecretKey?: unknown;
      fairSharePerRepo?: unknown;
      aiGatewayId?: unknown;
      mcpWriteConfirm?: unknown;
      triageWebSearch?: unknown;
      healOnFailure?: unknown;
      billingApiToken?: unknown;
      cloudflareAccountId?: unknown;
      triageModel?: unknown;
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
    const hasTurnstileSite = body.turnstileSiteKey !== undefined;
    const hasTurnstileSecret = body.turnstileSecretKey !== undefined;
    const hasFairShare = body.fairSharePerRepo !== undefined;
    const hasGateway = body.aiGatewayId !== undefined;
    const hasWriteConfirm = body.mcpWriteConfirm !== undefined;
    const hasWebSearch = body.triageWebSearch !== undefined;
    const hasHeal = body.healOnFailure !== undefined;
    const hasBillingToken = body.billingApiToken !== undefined;
    const hasAccountId = body.cloudflareAccountId !== undefined;
    const hasTriageModel = body.triageModel !== undefined;
    if (
      !hasWebhook && !hasNotifyFrom && !hasNotifyMode && !hasNotifyWebhook && !hasBadgeHidden &&
      !hasTurnstileSite && !hasTurnstileSecret && !hasFairShare && !hasGateway && !hasWriteConfirm && !hasWebSearch &&
      !hasHeal && !hasBillingToken && !hasAccountId && !hasTriageModel
    ) {
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
    if (hasTurnstileSite) {
      if (env.TURNSTILE_SITE_KEY) {
        return json({ error: "turnstile site key managed via environment" }, 409);
      }
      const value = body.turnstileSiteKey;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.turnstileSiteKey, "");
        await audit(env.DB, ident.actor, "settings.turnstile_site", "cleared");
      } else {
        const err = validateTurnstileSiteKey(value);
        if (err) return json({ error: err }, 400);
        await setSetting(env.DB, SETTING_KEYS.turnstileSiteKey, (value as string).trim());
        await audit(env.DB, ident.actor, "settings.turnstile_site", "set");
      }
    }
    if (hasTurnstileSecret) {
      if (env.TURNSTILE_SECRET_KEY) {
        return json({ error: "turnstile secret managed via environment" }, 409);
      }
      const value = body.turnstileSecretKey;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.turnstileSecretKey, "");
        await audit(env.DB, ident.actor, "settings.turnstile_secret", "cleared");
      } else {
        const err = validateTurnstileSecretKey(value);
        if (err) return json({ error: err }, 400);
        const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
        await setSetting(env.DB, SETTING_KEYS.turnstileSecretKey, await encryptSettingValue(key, value as string));
        await audit(env.DB, ident.actor, "settings.turnstile_secret", "set");
      }
    }
    if (hasFairShare) {
      const parsed = parseFairSharePerRepo(body.fairSharePerRepo);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.fairSharePerRepo, String(parsed.cap));
      await audit(env.DB, ident.actor, "settings.fair_share", String(parsed.cap));
    }
    if (hasGateway) {
      // Env-managed gateway wins over D1, like every other credential.
      if (env.AI_GATEWAY_ID) {
        return json({ error: "AI gateway managed via environment" }, 409);
      }
      const value = body.aiGatewayId;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.aiGatewayId, "");
        await audit(env.DB, ident.actor, "settings.ai_gateway", "cleared");
      } else {
        const parsed = parseAiGatewayId(value);
        if ("error" in parsed) return json({ error: parsed.error }, 400);
        await setSetting(env.DB, SETTING_KEYS.aiGatewayId, parsed.id);
        await audit(env.DB, ident.actor, "settings.ai_gateway", parsed.id);
      }
    }
    if (hasWriteConfirm) {
      const parsed = parseMcpWriteConfirm(body.mcpWriteConfirm);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.mcpWriteConfirm, parsed.on ? "1" : "0");
      await audit(env.DB, ident.actor, "settings.mcp_write_confirm", parsed.on ? "on" : "off");
    }
    if (hasWebSearch) {
      if (env.TRIAGE_WEB_SEARCH === "1") {
        return json({ error: "triage web search managed via environment" }, 409);
      }
      const parsed = parseTriageWebSearch(body.triageWebSearch);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.triageWebSearch, parsed.on ? "1" : "0");
      await audit(env.DB, ident.actor, "settings.triage_web_search", parsed.on ? "on" : "off");
    }
    if (hasHeal) {
      const parsed = parseHealOnFailure(body.healOnFailure);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.healOnFailure, parsed.on ? "1" : "0");
      await audit(env.DB, ident.actor, "settings.heal_on_failure", parsed.on ? "on" : "off");
      log("info", "heal on failure toggled", { on: parsed.on });
    }
    if (hasBillingToken) {
      if (env.BILLING_API_TOKEN) {
        return json({ error: "billing token managed via environment" }, 409);
      }
      const value = body.billingApiToken;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.billingApiToken, "");
        await audit(env.DB, ident.actor, "settings.billing_token", "cleared");
      } else {
        const err = validateBillingApiToken(value);
        if (err) return json({ error: err }, 400);
        const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
        await setSetting(env.DB, SETTING_KEYS.billingApiToken, await encryptSettingValue(key, value as string));
        await audit(env.DB, ident.actor, "settings.billing_token", "set");
      }
    }
    if (hasAccountId) {
      if (env.CLOUDFLARE_ACCOUNT_ID) {
        return json({ error: "account id managed via environment" }, 409);
      }
      const value = body.cloudflareAccountId;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.cloudflareAccountId, "");
        await audit(env.DB, ident.actor, "settings.account_id", "cleared");
      } else {
        const err = validateCloudflareAccountId(value);
        if (err) return json({ error: err }, 400);
        await setSetting(env.DB, SETTING_KEYS.cloudflareAccountId, (value as string).trim().toLowerCase());
        await audit(env.DB, ident.actor, "settings.account_id", "set");
      }
    }
    if (hasTriageModel) {
      if (env.TRIAGE_MODEL) {
        return json({ error: "triage model managed via environment" }, 409);
      }
      const value = body.triageModel;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.triageModel, "");
        await audit(env.DB, ident.actor, "settings.triage_model", "cleared");
      } else {
        const err = validateTriageModel(value);
        if (err) return json({ error: err }, 400);
        await setSetting(env.DB, SETTING_KEYS.triageModel, (value as string).trim());
        await audit(env.DB, ident.actor, "settings.triage_model", (value as string).trim());
      }
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

export interface TournamentTickResult {
  polled: { dispatched: number; terminal: number };
  verdicts: { decided: number };
  resolved: { resolved: number };
  pushed: { pushed: number };
}

// One tournament-machine tick: poll forks for pushes, decide ripe
// tournaments, resolve winners, fast-forward the blessed ref. Shared by the
// production cron and the admin tick endpoint (staging has no cron).
// Every pass degrades to zero counts, never throws.
export async function runTournamentTick(env: WorkerEnv): Promise<TournamentTickResult> {
  const out: TournamentTickResult = {
    polled: { dispatched: 0, terminal: 0 },
    verdicts: { decided: 0 },
    resolved: { resolved: 0 },
    pushed: { pushed: 0 },
  };
  try {
    const polled = await pollTournamentAttempts({
      db: env.DB,
      artifacts: env.ARTIFACTS ?? null,
      namespace: env.ARTIFACTS_NAMESPACE ?? "",
      dispatch: async (input) => {
        const result = await dispatchRun(env, input);
        for (const jobId of result.queuedIds) await wakeSeat(env, jobId);
        return { runId: result.runId };
      },
    });
    out.polled = { dispatched: polled.dispatched, terminal: polled.terminal };
  } catch (err) {
    log("warn", "tournament poll failed", { error: String(err) });
  }
  try {
    const verdicts = await verdictPass(env.DB, {
      artifacts: env.ARTIFACTS ?? null,
      ai: env.AI ?? null,
      gatewayId: env.AI_GATEWAY_ID,
      model: env.TRIAGE_MODEL,
    });
    out.verdicts = { decided: verdicts.decided };
  } catch (err) {
    log("warn", "tournament verdicts failed", { error: String(err) });
  }
  try {
    const resolved = await resolvePass(env.DB);
    out.resolved = { resolved: resolved.resolved };
  } catch (err) {
    log("warn", "tournament resolve failed", { error: String(err) });
  }
  try {
    const pushed = await fastForwardPass({
      db: env.DB,
      artifacts: env.ARTIFACTS ?? null,
      remoteFor: (repo) =>
        artifactsRemoteFor(env.ARTIFACTS_ACCOUNT_ID ?? "", env.ARTIFACTS_NAMESPACE ?? "", repo),
      git,
      http,
      fs: () => new MemoryFS(),
    });
    out.pushed = { pushed: pushed.pushed };
  } catch (err) {
    log("warn", "tournament promote failed", { error: String(err) });
  }
  return out;
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
      // The API serves its own contract (generated module, CI-synced)
      // plus an interactive Redoc reference over it.
      if (request.method === "GET" && url.pathname === "/openapi.yaml") {
        return new Response(OPENAPI_YAML, {
          headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      }
      if (request.method === "GET" && url.pathname === "/docs") {
        return new Response(apiDocsPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        return await handleWebhook(request, env, ctx);
      }
      if (request.method === "GET" && url.pathname === "/mcp") {
        return json(mcpDiscovery());
      }
      // MCP OAuth: the app-owned consent page. Per-request server
      // instances keep the issuer correct on every origin.
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/authorize") {
        const session = await oauthSession(request, env);
        const { createAuthServer, oauthEnv } = await import("./oauth-server");
        const api = createAuthServer(url.origin).getOAuthApi(oauthEnv(env));
        const context: AuthorizeContext = {
          api,
          session,
          audit: (action, target) => audit(env.DB, session?.actor ?? "oauth-session:?", action, target),
        };
        return request.method === "GET" ? handleAuthorizeGet(request, context) : handleAuthorizePost(request, context);
      }
      // Authorization-server endpoints: metadata, token (issuance,
      // refresh, revocation), and dynamic client registration.
      if (
        url.pathname === "/oauth/token" ||
        url.pathname === "/oauth/register" ||
        url.pathname === "/.well-known/oauth-authorization-server"
      ) {
        const { createAuthServer, oauthEnv } = await import("./oauth-server");
        return createAuthServer(url.origin).fetch(request, oauthEnv(env), ctx);
      }
      // Protected-resource metadata for MCP client discovery.
      if (
        url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname.startsWith("/.well-known/oauth-protected-resource/")
      ) {
        const { createAuthServer, createResourceServer, oauthEnv } = await import("./oauth-server");
        const authServer = createAuthServer(url.origin);
        return createResourceServer(url.origin, authServer, mcpApiHandler).fetch(request, oauthEnv(env), ctx);
      }
      if (request.method === "POST" && url.pathname === "/mcp") {
        // Same-origin browser callers (the Cloudflare Site MCP Server
        // pack, native page tools) carry the dashboard session cookie
        // instead of a Bearer [REDACTED] the global CSRF check above already
        // rejected cross-origin cookie POSTs, so a valid session here is
        // the visitor acting as themselves.
        if (!getBearer(request)) {
          const session = await oauthSession(request, env);
          if (session) {
            const { props, canWrite } = principalFromSession(session);
            return serveMcpRequest(request, env, props, canWrite, basinSink(env, ctx));
          }
        }
        // OAuth access tokens and legacy API tokens both validate here;
        // missing credentials get the 401 + metadata challenge MCP
        // clients use to discover OAuth.
        const { createAuthServer, createResourceServer, oauthEnv } = await import("./oauth-server");
        const authServer = createAuthServer(url.origin);
        return createResourceServer(url.origin, authServer, mcpApiHandler).fetch(request, oauthEnv(env), ctx);
      }
      if (request.method === "POST" && url.pathname === "/v1/runs/dispatch") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateDispatch(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        if (!repoAllowed(ident, valid.repo)) return json({ error: "token is not scoped to that repo" }, 403);
        try {
          const out = await dispatchRun(env, valid, basinSink(env, ctx));
          await audit(env.DB, ident.actor, "run.dispatch", out.runId);
          for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
          ctx.waitUntil(annotateSpan({ "run.id": out.runId, "repo": valid.repo, "actor": ident.actor }));
          return json({ runId: out.runId, jobIds: out.jobIds }, 202);
        } catch (err) {
          return json({ error: String(err instanceof Error ? err.message : err) }, 400);
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          return json({ error: "limit must be an integer 1-200" }, 400);
        }
        if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
          return json({ error: "offset must be an integer 0-100000" }, 400);
        }
        return json({ runs: await listRuns(env.DB, limit, offset, ident.repos) });
      }
      if (request.method === "POST" && url.pathname === "/v1/tournaments") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateTournamentCreate(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        const namespace = env.ARTIFACTS_NAMESPACE ?? "";
        if (!repoAllowed(ident, `${namespace}/${valid.sourceRepo}`)) {
          return json({ error: "token is not scoped to that repo" }, 403);
        }
        const out = await createTournament(env.DB, valid);
        await audit(env.DB, ident.actor, "tournament.create", out.id);
        return json({ id: out.id }, 201);
      }
      if (request.method === "GET" && url.pathname === "/v1/tournaments") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return json({ error: "limit must be an integer 1-100" }, 400);
        }
        return json({ tournaments: await listTournaments(env.DB, limit) });
      }
      const tournamentMatch = /^\/v1\/tournaments\/([^/]+)$/.exec(url.pathname);
      if (tournamentMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const board = await getTournamentBoard(env.DB, tournamentMatch[1]);
        if (!board) return json({ error: "tournament not found" }, 404);
        return json(board);
      }
      const claimMatch = /^\/v1\/tournaments\/([^/]+)\/claims$/.exec(url.pathname);
      if (claimMatch && request.method === "POST") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        if (!env.ARTIFACTS) return json({ error: "artifacts not configured" }, 503);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateTournamentClaim(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        const out = await claimAttempt(env.DB, env.ARTIFACTS, claimMatch[1], valid.agent);
        if ("error" in out) {
          const status = out.error === "already-claimed" ? 409 : out.error === "fork-failed" ? 502 : 400;
          return json({ error: out.error }, status);
        }
        await audit(env.DB, ident.actor, "tournament.claim", `${claimMatch[1]}:${valid.agent}`);
        return json(out, 201);
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/tournaments/tick") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const tick = await runTournamentTick(env);
        await audit(env.DB, ident.actor, "tournament.tick", JSON.stringify(tick));
        return json(tick);
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runMatch[1]);
        if (!run || !repoAllowed(ident, run.repo)) return json({ error: "run not found" }, 404);
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
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const known = await getRun(env.DB, runWaitMatch[1]);
        if (!known || !repoAllowed(ident, known.repo)) return json({ error: "run not found" }, 404);
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
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const known = await getRun(env.DB, runDigestMatch[1]);
        if (!known || !repoAllowed(ident, known.repo)) return json({ error: "run not found" }, 404);
        const digest = await buildRunDigest(env.DB, runDigestMatch[1]);
        if (!digest) return json({ error: "run not found" }, 404);
        return json(digest);
      }
      const runArtifactsMatch = /^\/v1\/runs\/([^/]+)\/artifacts$/.exec(url.pathname);
      if (request.method === "GET" && runArtifactsMatch) {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runArtifactsMatch[1]);
        if (!run || !repoAllowed(ident, run.repo)) return json({ error: "run not found" }, 404);
        const artifacts = await listRunArtifacts(env.CACHE, env.DB, run.id);
        if (!artifacts) return json({ error: "artifact storage not configured" }, 501);
        return json({ artifacts });
      }
      // Global log search over the FTS5 index. Scoped tokens only see
      // their repos (IN filter); an explicit repo: filter outside the
      // scope is a 403, not an empty result.
      if (request.method === "GET" && url.pathname === "/v1/search/logs") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const q = url.searchParams.get("q") ?? "";
        if (!q.trim() || q.length > 500) return json({ error: "q must be 1-500 characters" }, 400);
        const compiled = compileLogQuery(q);
        if ("error" in compiled) return json({ error: compiled.error }, 400);
        if (compiled.query.repo && !repoAllowed(ident, compiled.query.repo)) {
          return json({ error: "token is not scoped to that repo" }, 403);
        }
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          return json({ error: "limit must be an integer 1-200" }, 400);
        }
        return json({ hits: await searchLogs(env.DB, compiled.query, ident.repos, limit) });
      }
      if (request.method === "GET" && url.pathname === "/v1/jobs/next") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const labels = (url.searchParams.get("labels") ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
        const fairShare = parseFairSharePerRepo(await getSetting(env.DB, SETTING_KEYS.fairSharePerRepo));
        const job = await claimNextJob(env.DB, labels, ident.repos, {
          fairSharePerRepo: "cap" in fairShare ? fairShare.cap : 0,
        });
        if (!job) return json({ job: null }, 200);
        await rollupRunStatus(env.DB, job.run_id, env.ANALYTICS, basinSink(env, ctx));
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
      const runCancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && runCancelMatch) {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runCancelMatch[1]);
        if (!run || !repoAllowed(ident, run.repo)) return json({ error: "run not found" }, 404);
        const cancelled = await cancelQueuedJobs(env.DB, run.id);
        await rollupRunStatus(env.DB, run.id, env.ANALYTICS, basinSink(env, ctx));
        await audit(env.DB, ident.actor, "run.cancel", `${run.id} ${cancelled}`);
        log("info", "run cancelled", { runId: run.id, cancelled });
        return json({ ok: true, cancelled });
      }
      const statusMatch = /^\/v1\/runs\/([^/]+)\/status$/.exec(url.pathname);
      if (request.method === "POST" && statusMatch) {
        return await handleStatusCallback(request, env, ctx, statusMatch[1]);
      }
      const heartbeatMatch = /^\/v1\/runs\/([^/]+)\/jobs\/([^/]+)\/heartbeat$/.exec(url.pathname);
      if (request.method === "POST" && heartbeatMatch) {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const hbRun = await getRun(env.DB, heartbeatMatch[1]);
        if (!hbRun || !repoAllowed(ident, hbRun.repo)) return json({ error: "job not found" }, 404);
        const job = await getJob(env.DB, heartbeatMatch[2]);
        if (!job || job.run_id !== heartbeatMatch[1]) return json({ error: "job not found" }, 404);
        await touchJob(env.DB, job.id);
        return json({ ok: true });
      }
      const rerunMatch = /^\/v1\/runs\/([^/]+)\/jobs\/([^/]+)\/rerun$/.exec(url.pathname);
      if (request.method === "POST" && rerunMatch) {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const rerunRun = await getRun(env.DB, rerunMatch[1]);
        if (!rerunRun || !repoAllowed(ident, rerunRun.repo)) return json({ error: "job not found" }, 404);
        const out = await rerunJobAndQueue(env, rerunMatch[1], rerunMatch[2], basinSink(env, ctx));
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
        const ident = await requireScope(request, env, need);
        if (!ident) return json({ error: "unauthorized" }, 401);
        const artifactJob = await getJob(env.DB, artifactMatch[1]);
        if (!artifactJob) return json({ error: "job not found" }, 404);
        const artifactRun = await getRun(env.DB, artifactJob.run_id);
        if (!artifactRun || !repoAllowed(ident, artifactRun.repo)) return json({ error: "job not found" }, 404);
        const name = decodeURIComponent(artifactMatch[2]);
        if (request.method === "PUT") return await handleArtifactPut(env.CACHE, env.DB, artifactMatch[1], name, request);
        return await handleArtifactGet(env.CACHE, artifactMatch[1], name);
      }
      const testsMatch = /^\/v1\/jobs\/([^/]+)\/tests$/.exec(url.pathname);
      if (testsMatch && request.method === "PUT") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const testJob = await getJob(env.DB, testsMatch[1]);
        if (!testJob) return json({ error: "job not found" }, 404);
        const testRun = await getRun(env.DB, testJob.run_id);
        if (!testRun || !repoAllowed(ident, testRun.repo)) return json({ error: "job not found" }, 404);
        const declared = request.headers.get("content-length");
        if (declared && Number(declared) > MAX_JUNIT_BYTES) return json({ error: "test report too large" }, 413);
        const xml = await request.text().catch(() => "");
        if (!xml) return json({ error: "empty body" }, 400);
        if (xml.length > MAX_JUNIT_BYTES) return json({ error: "test report too large" }, 413);
        const parsed = parseJUnit(xml);
        if ("error" in parsed) return json({ error: parsed.error }, 400);
        // Raw XML is the audit trail; parsed rows are the product. A
        // missing bucket still stores parsed rows.
        if (env.CACHE) {
          await env.CACHE.put(`test-reports/${testsMatch[1]}.xml`, xml, {
            httpMetadata: { contentType: "application/xml" },
          }).catch(() => undefined);
        }
        await saveTestReport(env.DB, {
          jobId: testsMatch[1],
          runId: testRun.id,
          passed: parsed.passed,
          failed: parsed.failed,
          errors: parsed.errors,
          skipped: parsed.skipped,
          total: parsed.total,
          durationMs: parsed.durationMs,
          truncated: parsed.truncated,
          cases: parsed.cases,
        });
        log("info", "test report stored", {
          jobId: testsMatch[1],
          total: parsed.total,
          failed: parsed.failed,
          errors: parsed.errors,
        });
        return json({
          ok: true,
          jobId: testsMatch[1],
          total: parsed.total,
          passed: parsed.passed,
          failed: parsed.failed,
          errors: parsed.errors,
          skipped: parsed.skipped,
          truncated: parsed.truncated,
        });
      }
      const runTestsMatch = /^\/v1\/runs\/([^/]+)\/tests$/.exec(url.pathname);
      if (runTestsMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const testsRun = await getRun(env.DB, runTestsMatch[1]);
        if (!testsRun || !repoAllowed(ident, testsRun.repo)) return json({ error: "run not found" }, 404);
        const jobs = await getRunTestJobs(env.DB, runTestsMatch[1]);
        const totals = { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };
        for (const j of jobs) {
          totals.total += j.total;
          totals.passed += j.passed;
          totals.failed += j.failed;
          totals.errors += j.errors;
          totals.skipped += j.skipped;
        }
        const failing = totals.failed + totals.errors > 0 ? await listFailingTests(env.DB, runTestsMatch[1], 50) : [];
        return json({
          runId: runTestsMatch[1],
          totals,
          jobs: jobs.map((j) => ({
            jobId: j.job_id,
            jobName: j.job_name,
            total: j.total,
            passed: j.passed,
            failed: j.failed,
            errors: j.errors,
            skipped: j.skipped,
            durationMs: j.duration_ms,
            truncated: j.truncated === 1,
          })),
          failing: failing.map((f) => ({
            jobId: f.job_id,
            jobName: f.job_name,
            suite: f.suite,
            name: f.name,
            classname: f.classname,
            status: f.status,
            message: f.message,
          })),
        });
      }
      // Per-job egress accounting (measured R2 transfers + interface
      // deltas; true per-domain rows arrive with outbound interception).
      const runEgressMatch = /^\/v1\/runs\/([^/]+)\/egress$/.exec(url.pathname);
      if (runEgressMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const egressRun = await getRun(env.DB, runEgressMatch[1]);
        if (!egressRun || !repoAllowed(ident, egressRun.repo)) return json({ error: "run not found" }, 404);
        const rows = await getRunEgress(env.DB, runEgressMatch[1]);
        const totals = { reqBytes: 0, respBytes: 0 };
        for (const r of rows) {
          totals.reqBytes += r.req_bytes;
          totals.respBytes += r.resp_bytes;
        }
        return json({
          runId: runEgressMatch[1],
          totals,
          jobs: rows.map((r) => ({
            jobId: r.job_id,
            host: r.host,
            reqBytes: r.req_bytes,
            respBytes: r.resp_bytes,
          })),
        });
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
      if (request.method === "GET" && url.pathname === "/v1/admin/cache") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const prefix = url.searchParams.get("prefix") ?? "";
        if (prefix && !/^[\w.\-/]{0,100}$/.test(prefix)) return json({ error: "invalid prefix" }, 400);
        const limit = Number(url.searchParams.get("limit") ?? "100");
        if (!Number.isFinite(limit) || limit < 1 || limit > 500) return json({ error: "limit must be 1-500" }, 400);
        const entries = await listCacheEntries(env.CACHE, prefix, Math.floor(limit));
        if (!entries) return json({ error: "cache storage not configured" }, 501);
        return json({ entries });
      }
      if (request.method === "DELETE" && url.pathname === "/v1/admin/cache") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const prefix = url.searchParams.get("prefix") ?? "";
        if (prefix && !/^[\w.\-/]{0,100}$/.test(prefix)) return json({ error: "invalid prefix" }, 400);
        const out = await purgeCachePrefix(env.CACHE, prefix);
        if (!out) return json({ error: "cache storage not configured" }, 501);
        await audit(env.DB, ident.actor, "cache.purge", `${prefix || "(all)"} ${out.deleted}`);
        log("info", "cache purged", { prefix, deleted: out.deleted, truncated: out.truncated });
        return json(out);
      }
      // Live queue in claim order, plus the active fair-share cap —
      // the fairness simulator's input (see fairness.ts / cli queue).
      if (request.method === "GET" && url.pathname === "/v1/admin/queue") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const limit = Number(url.searchParams.get("limit") ?? "200");
        if (!Number.isFinite(limit) || limit < 1 || limit > 500) return json({ error: "limit must be 1-500" }, 400);
        const fairShare = parseFairSharePerRepo(await getSetting(env.DB, SETTING_KEYS.fairSharePerRepo));
        const jobs = await listQueuedJobs(env.DB, Math.floor(limit));
        return json({
          fairSharePerRepo: "cap" in fairShare ? fairShare.cap : 0,
          jobs: jobs.map((j) => ({
            id: j.id,
            runId: j.run_id,
            name: j.name,
            repo: j.repo,
            priority: j.priority,
            priorMs: j.prior_ms ?? 0,
            labels: j.labels,
            createdAt: j.created_at,
          })),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/usage") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const days = Number(url.searchParams.get("days") ?? "30");
        if (!Number.isFinite(days) || days < 1 || days > 365) return json({ error: "days must be 1-365" }, 400);
        const repo = url.searchParams.get("repo") ?? "";
        if (repo) {
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
          if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
          return json(await usageStats(env.DB, Math.floor(days), [repo]));
        }
        return json(await usageStats(env.DB, Math.floor(days), ident.repos));
      }
      // Real Cloudflare dollars from the Billable Usage API (admin-only:
      // account spend). Unconfigured credentials degrade to
      // {configured:false} so the CLI prints compute-only output.
      if (request.method === "GET" && url.pathname === "/v1/usage/billable") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const days = Number(url.searchParams.get("days") ?? "30");
        if (!Number.isFinite(days) || days < 1 || days > 365) return json({ error: "days must be 1-365" }, 400);
        const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? (await getSetting(env.DB, SETTING_KEYS.cloudflareAccountId));
        let token = env.BILLING_API_TOKEN;
        if (!token) {
          const stored = await getSetting(env.DB, SETTING_KEYS.billingApiToken);
          if (stored) {
            const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
            token = await decryptSettingValue(key, stored).catch(() => "");
          }
        }
        if (!token || !accountId) return json({ configured: false });
        const { from, to } = billableWindow(Math.floor(days));
        try {
          const { rows, skippedRows } = await fetchBillableUsage(token, accountId, from, to);
          return json({ configured: true, ...summarizeBillableUsage(rows, from, to), skippedRows });
        } catch (err) {
          log("warn", "billable usage fetch failed", { error: String(err) });
          return json({ error: "billable usage unavailable" }, 502);
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/flaky") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const repo = url.searchParams.get("repo") ?? "";
        if (!repo) return json({ error: "repo is required" }, 400);
        if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
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
      // Self-service connected apps: any logged-in dashboard user
      // lists and revokes their own OAuth grants. Session-cookie only
      // (Bearer [REDACTED] carry no OAuth user id); cookie mutations are
      // CSRF-checked at the top of fetch.
      if (request.method === "GET" && url.pathname === "/v1/oauth/grants") {
        const session = await oauthSession(request, env);
        if (!session) return json({ error: "unauthorized" }, 401);
        const grants = await listUserOAuthGrants(new D1KV(env.DB), session.userId);
        const { createAuthServer, oauthEnv } = await import("./oauth-server");
        const api = createAuthServer(url.origin).getOAuthApi(oauthEnv(env));
        const out = [];
        for (const grant of grants) {
          const client = await api.lookupClient(grant.clientId).catch(() => null);
          out.push({ ...grant, clientName: client?.clientName ?? null, scopeDescriptions: describeScope(grant.scope) });
        }
        return json({ grants: out });
      }
      if (request.method === "DELETE" && url.pathname === "/v1/oauth/grants") {
        const session = await oauthSession(request, env);
        if (!session) return json({ error: "unauthorized" }, 401);
        const grantId = url.searchParams.get("grantId") ?? "";
        if (!grantId) return json({ error: "grantId is required" }, 400);
        // Ownership first: revokeGrant alone does not verify the grant
        // belongs to the caller, so a forged id must 404, not revoke.
        const mine = await listUserOAuthGrants(new D1KV(env.DB), session.userId);
        if (!mine.some((g) => g.grantId === grantId)) return json({ error: "grant not found" }, 404);
        const { createAuthServer, oauthEnv } = await import("./oauth-server");
        await createAuthServer(url.origin).getOAuthApi(oauthEnv(env)).revokeGrant(grantId, session.userId);
        await audit(env.DB, session.actor, "oauth.revoke", `${session.userId} ${grantId}`);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/oauth-grants") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const page = await listOAuthGrants(new D1KV(env.DB), { limit, cursor });
        // Resolve client display names (bounded by the page size).
        const { createAuthServer, oauthEnv } = await import("./oauth-server");
        const api = createAuthServer(url.origin).getOAuthApi(oauthEnv(env));
        const grants = [];
        for (const grant of page.grants) {
          const client = await api.lookupClient(grant.clientId).catch(() => null);
          grants.push({ ...grant, clientName: client?.clientName ?? null, scopeDescriptions: describeScope(grant.scope) });
        }
        return json({ grants, cursor: page.cursor ?? null, list_complete: page.list_complete });
      }
      if (request.method === "DELETE" && url.pathname === "/v1/admin/oauth-grants") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const grantId = url.searchParams.get("grantId") ?? "";
        const userId = url.searchParams.get("userId") ?? "";
        if (!grantId || !userId) return json({ error: "grantId and userId are required" }, 400);
        const { createAuthServer, oauthEnv } = await import("./oauth-server");
        await createAuthServer(url.origin).getOAuthApi(oauthEnv(env)).revokeGrant(grantId, userId);
        await audit(env.DB, ident.actor, "oauth.revoke", `${userId} ${grantId}`);
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
          // Public widget key (safe pre-login); null hides the widget.
          turnstileSiteKey: await getTurnstileSiteKey(env.DB, env),
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
        const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown; turnstileToken?: unknown };
        const keys = await authThrottleKeys(request);
        if (await authThrottleBlocked(env.DB, keys)) {
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) return await fail(json({ error: captchaErr }, 400));
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
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown; turnstileToken?: unknown };
        const keys = await authThrottleKeys(request, typeof body.email === "string" ? normalizeEmail(body.email) : undefined);
        if (await authThrottleBlocked(env.DB, keys)) {
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) return await fail(json({ error: captchaErr }, 400));
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
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown; turnstileToken?: unknown };
        if (validateEmail(body.email) || typeof body.password !== "string") {
          return json({ error: "invalid email or password" }, 401);
        }
        const email = normalizeEmail(body.email as string);
        const keys = await authThrottleKeys(request, email);
        if (await authThrottleBlocked(env.DB, keys)) {
          log("warn", "login throttled", { email });
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json({ error: captchaErr }, 400);
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
      if (request.method === "POST" && url.pathname === "/v1/admin/reset") {
        // Self-serve reset: generic 200 always (no account-enumeration
        // oracle), delivered only when a sender + EMAIL binding exist.
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; turnstileToken?: unknown };
        const emailErr = validateEmail(body.email);
        const email = emailErr === null ? normalizeEmail(body.email as string) : "";
        const ipKey = await ipThrottleKey(request);
        const keys = [...(email ? [`reset:${email}`] : []), ...(ipKey ? [ipKey] : [])];
        if (await authThrottleBlocked(env.DB, keys)) {
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) return json({ error: captchaErr }, 400);
        if (emailErr !== null) return json({ error: emailErr }, 400);
        // Spam brake: every request counts against its windows.
        await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
        const user = await getUser(env.DB, email);
        const sender = resolveNotifySender(env.NOTIFY_FROM_EMAIL, await getSetting(env.DB, SETTING_KEYS.notifyFromEmail));
        const mailer = env.EMAIL;
        if (user && sender && mailer) {
          try {
            const token = await createResetToken(env.DB, email);
            const link = new URL(`/dashboard?reset=${encodeURIComponent(token)}`, url).toString();
            await mailer.send({
              from: { name: "Flare Actions", email: sender },
              to: email,
              subject: "[flare] Reset your password",
              text: `Someone requested a password reset for ${email}.\n\n${link}\n\nThe link expires in 1 hour and works once. If this was not you, ignore this email.`,
            });
            await audit(env.DB, "reset", "password.reset_sent", email);
            log("info", "password reset sent", { email });
          } catch (err) {
            log("warn", "password reset send failed", { email, error: String(err) });
          }
        } else {
          log("info", "password reset skipped (unknown account or email not configured)", {
            known: !!user,
            sender: !!sender,
            mail: !!mailer,
          });
        }
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/reset/confirm") {
        const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
        const ipKey = await ipThrottleKey(request);
        const keys = ipKey ? [ipKey] : [];
        if (await authThrottleBlocked(env.DB, keys)) {
          return json({ error: "too many attempts — try again later" }, 429);
        }
        if (typeof body.token !== "string" || !body.token) return json({ error: "reset token required" }, 400);
        const pwErr = validatePassword(body.password);
        if (pwErr) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json({ error: pwErr }, 400);
        }
        const email = await consumeResetToken(env.DB, body.token);
        if (!email) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json({ error: "reset link invalid or expired" }, 404);
        }
        const user = await getUser(env.DB, email);
        if (!user) return json({ error: "account not found" }, 404);
        await setUserPassword(env.DB, email, await hashPassword(body.password as string));
        // Reset invalidates every existing session for that account.
        await deleteUserSessions(env.DB, "email", email);
        await clearAuthFailures(env.DB, keys);
        await audit(env.DB, `email:${email}`, "password.reset", "");
        log("info", "password reset completed", { email });
        return json({ ok: true });
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
        const turnstileSource = env.TURNSTILE_SITE_KEY
          ? "env"
          : (await getSetting(env.DB, SETTING_KEYS.turnstileSiteKey)) !== null
            ? "d1"
            : "none";
        const fairShareParsed = parseFairSharePerRepo(await getSetting(env.DB, SETTING_KEYS.fairSharePerRepo));
        const gatewaySource = env.AI_GATEWAY_ID ? "env" : ((await getSetting(env.DB, SETTING_KEYS.aiGatewayId)) ? "d1" : "none");
        const writeConfirmParsed = parseMcpWriteConfirm(await getSetting(env.DB, SETTING_KEYS.mcpWriteConfirm));
        const webSearchParsed = parseTriageWebSearch(await getSetting(env.DB, SETTING_KEYS.triageWebSearch));
        const healParsed = parseHealOnFailure(await getSetting(env.DB, SETTING_KEYS.healOnFailure));
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
          turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? (await getSetting(env.DB, SETTING_KEYS.turnstileSiteKey)) ?? "",
          turnstileSiteSource: turnstileSource,
          turnstileSecretSet: !!env.TURNSTILE_SECRET_KEY || !!(await getSetting(env.DB, SETTING_KEYS.turnstileSecretKey)),
          fairSharePerRepo: "cap" in fairShareParsed ? fairShareParsed.cap : 0,
          aiGatewayId: env.AI_GATEWAY_ID ?? (await getSetting(env.DB, SETTING_KEYS.aiGatewayId)) ?? "",
          aiGatewaySource: gatewaySource,
          mcpWriteConfirm: "on" in writeConfirmParsed ? writeConfirmParsed.on : false,
          triageWebSearch: env.TRIAGE_WEB_SEARCH === "1" ? true : "on" in webSearchParsed ? webSearchParsed.on : false,
          healOnFailure: "on" in healParsed ? healParsed.on : false,
          billingTokenSet: !!env.BILLING_API_TOKEN || !!(await getSetting(env.DB, SETTING_KEYS.billingApiToken)),
          cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID ?? (await getSetting(env.DB, SETTING_KEYS.cloudflareAccountId)) ?? "",
          triageModel: env.TRIAGE_MODEL ?? (await getSetting(env.DB, SETTING_KEYS.triageModel)) ?? TRIAGE_MODEL,
          triageModelSource: env.TRIAGE_MODEL ? "env" : ((await getSetting(env.DB, SETTING_KEYS.triageModel)) ? "d1" : "default"),
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
        if (!repoAllowed(ident, valid.repo)) return json({ error: "token is not scoped to that repo" }, 403);
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
      if (request.method === "GET" && url.pathname === "/v1/admin/monitors") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const monitors = await listMonitors(env.DB);
        return json({
          monitors: monitors.map((m) => ({
            id: m.id,
            name: m.name,
            repo: m.repo,
            branch: m.branch,
            job: m.job,
            trigger: m.trigger,
            result: m.result,
            consecutive: m.consecutive,
            durationSeconds: m.duration_seconds,
            logPattern: m.log_pattern,
            webhookSet: m.webhook_url !== "",
            enabled: m.enabled === 1,
            mutedUntil: m.muted_until,
            streak: m.streak,
            lastFiredAt: m.last_fired_at,
            createdAt: m.created_at,
          })),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/monitors") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateMonitorInput(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        if (!repoAllowed(ident, valid.repo)) return json({ error: "token is not scoped to that repo" }, 403);
        if ((await listMonitors(env.DB)).length >= MAX_MONITORS) {
          return json({ error: `monitor limit reached (${MAX_MONITORS})` }, 400);
        }
        const id = crypto.randomUUID();
        let webhookUrl = "";
        if (valid.webhookUrl) {
          const key = await resolveSecretsKey(env.DB, env.SECRETS_KEY);
          webhookUrl = await encryptSettingValue(key, valid.webhookUrl);
        }
        await createMonitor(env.DB, { id, ...valid, webhookUrl });
        await audit(env.DB, ident.actor, "monitor.create", `${id} ${valid.repo} ${valid.trigger}`);
        log("info", "monitor created", { id, repo: valid.repo, trigger: valid.trigger });
        return json({ id }, 201);
      }
      const monitorMatch = /^\/v1\/admin\/monitors\/([^/]+)$/.exec(url.pathname);
      if (monitorMatch && request.method === "POST") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const existing = await getMonitor(env.DB, monitorMatch[1]);
        if (!existing) return json({ error: "monitor not found" }, 404);
        if (!repoAllowed(ident, existing.repo)) return json({ error: "token is not scoped to that repo" }, 403);
        const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; muteMinutes?: unknown };
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== "boolean") return json({ error: "enabled must be a boolean" }, 400);
          await setMonitorEnabled(env.DB, monitorMatch[1], body.enabled);
        }
        if (body.muteMinutes !== undefined) {
          if (
            body.muteMinutes !== null &&
            (typeof body.muteMinutes !== "number" || !Number.isInteger(body.muteMinutes) || body.muteMinutes < 0)
          ) {
            return json({ error: "muteMinutes must be a non-negative integer or null" }, 400);
          }
          await setMonitorMutedUntil(env.DB, monitorMatch[1], muteUntilIso(body.muteMinutes));
        }
        await audit(env.DB, ident.actor, "monitor.toggle", monitorMatch[1]);
        return json({ ok: true });
      }
      if (monitorMatch && request.method === "DELETE") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const existing = await getMonitor(env.DB, monitorMatch[1]);
        if (!existing) return json({ error: "monitor not found" }, 404);
        if (!repoAllowed(ident, existing.repo)) return json({ error: "token is not scoped to that repo" }, 403);
        await deleteMonitor(env.DB, monitorMatch[1]);
        await audit(env.DB, ident.actor, "monitor.delete", monitorMatch[1]);
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
        const outcome = await runGenerateWithStatus(env.AI, body.prompt, {
          gatewayId: env.AI_GATEWAY_ID ?? (await getSetting(env.DB, SETTING_KEYS.aiGatewayId)) ?? undefined,
        });
        if (outcome.status === "busy") {
          return new Response(JSON.stringify({ error: "model busy, retry later" }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "30" },
          });
        }
        if (outcome.status !== "ok") return json({ error: "generation failed" }, 502);
        await audit(env.DB, ident.actor, "pipeline.generate", body.prompt.slice(0, 80));
        ctx.waitUntil(
          annotateSpan({ actor: ident.actor, "genai.prompt_chars": body.prompt.length, "genai.outcome": outcome.status }),
        );
        return json({ yaml: outcome.yaml });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      log("error", "request failed", { path: url.pathname, error: String(err) });
      ctx.waitUntil(recordSpanException(err));
      return json({ error: "internal error" }, 500);
    }
  },

  async queue(batch: MessageBatch<QueueJobMessage | Record<string, unknown>>, env: WorkerEnv): Promise<void> {
    await ensureSchema(env.DB);
    for (const msg of batch.messages) {
      const body: unknown = msg.body;
      // Artifacts push events arrive on the artifacts queue via an event
      // subscription. Outcomes always ack: the handler dedupes by delivery
      // claim, so a retry would only re-skip as duplicate. Only a throw
      // before the outcome (DB down on claim) retries.
      if (isRecord(body) && typeof body["type"] === "string" && body["type"].startsWith("cf.artifacts.")) {
        try {
          const outcome = await handleArtifactsPush(
            {
              db: env.DB,
              artifacts: env.ARTIFACTS ?? null,
              dispatch: async (input) => {
                const out = await dispatchRun(env, input);
                for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
                return { runId: out.runId };
              },
            },
            body,
          );
          log("info", "artifacts push handled", {
            status: outcome.status,
            ...(outcome.status === "dispatched" ? { runId: outcome.runId } : { reason: outcome.reason }),
          });
          msg.ack();
        } catch (err) {
          log("error", "artifacts push failed, retrying", { error: String(err) });
          msg.retry();
        }
        continue;
      }
      try {
        if (!isQueueJobMessage(body)) {
          log("warn", "queue message of unknown shape, acking");
          msg.ack();
          continue;
        }
        const run = await getRun(env.DB, body.runId);
        if (!run) {
          log("warn", "queue message for unknown run, acking", { runId: body.runId });
          msg.ack();
          continue;
        }
        log("info", "dispatch confirmed", { runId: body.runId, jobId: body.jobId });
        msg.ack();
      } catch (err) {
        log("error", "queue message failed, retrying", { error: String(err) });
        msg.retry();
      }
    }
  },

  // Cron trigger (every minute): fire due schedules. last_run_at guards
  // against trigger redelivery and broken schedules hot-looping.
  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    try {
      await ensureSchema(env.DB);
      // OAuth hygiene runs on every database (the issuer is irrelevant to
      // the purge — it only scans the store — so a dummy one is fine).
      try {
        const { createAuthServer, oauthEnv } = await import("./oauth-server");
        const purged = await createAuthServer("https://oauth-purge.invalid").purgeExpiredData(oauthEnv(env), {
          batchSize: 200,
        });
        if (purged.grantsPurged > 0 || purged.tokensPurged > 0) {
          log("info", "oauth purge", { grantsPurged: purged.grantsPurged, tokensPurged: purged.tokensPurged });
        }
      } catch (err) {
        log("warn", "oauth purge failed", { error: String(err) });
      }
      // Previews share the staging database; only production dispatches.
      if (env.ENVIRONMENT !== "production") return;
      const now = new Date(controller.scheduledTime);
      await evaluateDurationMonitors(env.DB, env);
      const schedules = await listSchedules(env.DB);
      for (const s of schedules) {
        if (s.enabled !== 1 || !cronMatches(s.cron, now)) continue;
        if (s.last_run_at && Date.now() - Date.parse(s.last_run_at) < 60000) continue;
        try {
          const out = await dispatchRun(
            env,
            { repo: s.repo, sha: s.ref, ref: s.ref, event: "schedule", cron: s.cron },
            basinSink(env, ctx),
          );
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
      // Self-heal drain: pending failure claims become draft PRs plus
      // verification runs (bounded per tick; production only like
      // everything above). The toggle lives behind the drain so an
      // off toggle is one cheap indexed read.
      try {
        const creds = await getAppCreds(env);
        if (creds && (await getSetting(env.DB, SETTING_KEYS.healOnFailure)) === "1") {
          const { processed, healed } = await processHealClaims({
            db: env.DB,
            ai: env.AI,
            judge: env.AI ? (text) => judgeFlaky(env.AI, text, { gatewayId: env.AI_GATEWAY_ID }) : undefined,
            installationToken: async (installationId: number) => {
              const jwt = await mintAppJwt(creds.appId, creds.privateKey);
              return getInstallationToken(jwt, installationId);
            },
            gh: {
              treePaths: (token, repo, sha) => getRepoTreePaths(token, repo, sha),
              commitFiles: (token, repo, baseSha, branch, files, message) =>
                commitFilesToNewBranch(token, repo, baseSha, branch, files, message),
              openDraftPr: (token, repo, base, head, title, body) =>
                openDraftPullRequest(token, repo, base, head, title, body),
              defaultBranch: (token, repo) => getDefaultBranch(token, repo),
            },
            verify: async (repo, branch, source) => {
              try {
                const out = await dispatchRun(env, { repo, sha: branch, ref: branch, event: "dispatch", source }, basinSink(env, ctx));
                for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
                await audit(env.DB, "heal", "run.dispatch", `${source} ${out.runId}`);
                return out.runId;
              } catch (err) {
                log("warn", "heal verification dispatch failed", { repo, branch, error: String(err) });
                return null;
              }
            },
            model: env.TRIAGE_MODEL,
            gatewayId: env.AI_GATEWAY_ID,
          });
          if (processed > 0) log("info", "heal drain finished", { processed, healed });
        }
      } catch (err) {
        log("warn", "heal drain failed", { error: String(err) });
      }
      const tick = await runTournamentTick(env);
      if (tick.polled.dispatched > 0 || tick.polled.terminal > 0) {
        log("info", "tournament poll finished", { ...tick.polled });
      }
      if (tick.verdicts.decided > 0) log("info", "tournament verdicts decided", { ...tick.verdicts });
      if (tick.resolved.resolved > 0) log("info", "tournaments resolved", { ...tick.resolved });
      if (tick.pushed.pushed > 0) log("info", "tournaments promoted", { ...tick.pushed });
    } catch (err) {
      log("error", "scheduled handler failed", { error: String(err) });
    }
  },
};
