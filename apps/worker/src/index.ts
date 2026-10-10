import {
  audit,
  activeQuarantineNames,
  appendJobLog,
  bottleneckStats,
  cancelGroupJobs,
  cancelQueuedJobs,
  cancelSupersededBranchRuns,
  claimAdminMarker,
  claimNextJob,
  cloudRunningCap,
  claimWebhookDelivery,
  createJob,
  createMonitor,
  countActiveJobs,
  createRun,
  createSchedule,
  createToken,
  createUser,
  deleteMonitor,
  deleteRepoEgressAllow,
  deleteRepoSecret,
  deleteSchedule,
  deleteSession,
  deleteUser,
  deleteUserSessions,
  flakyCandidates,
  flakyStats,
  getJob,
  getJobsForRun,
  getMonitor,
  getNotifyPref,
  getRun,
  getRunEgress,
  getRunSelections,
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
  listQuarantinedFailingTests,
  listMonitors,
  listQuarantinedTests,
  listQueuedJobs,
  listMirrorRows,
  listRepoEgressAllow,
  listRepoSecretNames,
  listRuns,
  listSchedules,
  listTokens,
  listUsers,
  mergedPrCostTrend,
  monthlyComputeMinutes,
  pauseRepo,
  prComputeMinutes,
  pruneOldRuns,
  pruneSeatSnapshots,
  pruneWebhookDeliveries,
  SEAT_SNAPSHOT_MAX_AGE_MS,
  getPausedRepos,
  getRepoEgressAllow,
  isRepoPaused,
  resumeRepo,
  topDispatchActors,
  quarantineDowngrade,
  quarantineTest,
  readNeedsContext,
  recentTestStatuses,
  recentlyFailedTests,
  releaseAdminMarker,
  releaseQuarantinedTest,
  repoUsageByDay,
  rerunJob,
  revokeToken,
  rollupRunStatus,
  saveTestReport,
  saveTestSelection,
  setMonitorEnabled,
  setMonitorMutedUntil,
  setNotifyPref,
  setRepoEgressAllow,
  setRepoSecret,
  setRunPrComment,
  setScheduleEnabled,
  setSetting,
  setUserPassword,
  shouldReinstate,
  suggestQuarantine,
  summarizeUsageAnomalies,
  testTally,
  topAgentForRepo,
  topBranchForRepo,
  touchJob,
  touchScheduleRun,
  trailingWeekStarts,
  updateRunningJob,
  usageStats,
} from "./db";
import { commitFilesToNewBranch, deleteRunner, fetchChangedFiles, fetchJobLogDigest, generateJitConfig, getDefaultBranch, getInstallationToken, getPullRequestHead, getRepoTreePaths, listMergedPulls, MAX_CHANGED_FILES, mergePullRequest, mintAppJwt, openDraftPullRequest, resolveRefToSha, resolveRunnerGroupId, updatePullRequestBranch, verifyGitHubSignature } from "./github";
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
import { SETTING_KEYS, isBadgeHiddenRepo, parseAiGatewayId, parseBadgeHiddenRepos, parseBudgetMinutes, parseBudgetMode, parseBudgetKillMultiplier, parseFairSharePerRepo, parseFairSharePerAgent, parseAgentTag, parseGithubRunnerLabels, parseGithubRunnerMode, parseHealOnFailure, parseMcpWriteConfirm, parseOpenRegistration, parseRunnerGroupCache, parseStoredBudgets, parseSupersedeBranchRuns, parseTriageWebSearch, runnerGroupCacheGet, runnerGroupCacheSet, validateBillingApiToken, validateCloudEntitlements, validateCloudMetering, validateCloudflareAccountId, validateGithubRunnerGroupName, validateNotifyFromEmail, validateNotifyMode, validateNotifyWebhookUrl, validateRunnerVersion, validateTriageModel, validateTurnstileSecretKey, validateTurnstileSiteKey, validateWebhookSecret } from "./settings";
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
  consumeMagicToken,
  consumeResetToken,
  createInvite,
  createMagicToken,
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
  emptyProfiles,
  fetchPipeline,
  parseEgressAllow,
  parsePipelineWithProfiles,
  parseProfileName,
  readJobSpec,
  readRetryPolicy,
  seatEligible,
  selectProfileJobs,
  serializeDefinition,
  type PipelineJob,
  type PipelineProfiles,
} from "./pipeline";
import { applyRepoEgressPolicy, EgressPolicyViolationError } from "./egress-policy";
import { buildCompatJobs, fetchWorkflowFiles, type WorkflowEventContext } from "./actionsCompat";
import { promoteBlockedJobs, maybeRetryJob, reportGitHubStatus, requeueStaleJobs, triageAndStore } from "./finish";
import {
  DEFAULT_NOTIFY_PREFS,
  notifyMessage,
  notifyRunCompleted,
  parseNotifyPrefsInput,
  resolveNotifySender,
  validateNotifyPrefEmail,
} from "./notify";
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
  reposAllow,
  type AuthScope,
} from "./tokens";
import { convertActionsWorkflow, isImportSuccess } from "../../../packages/runner-sdk/src/importActions.ts";
import { initialJobStatus } from "../../../packages/runner-sdk/src/conditions.ts";
import { getTemplate, listTemplateMeta } from "../../../packages/runner-sdk/src/templates.ts";
import { badgeSvg } from "./badge";
import { TOPUP_DEFAULT_TTL_HOURS, createPairingCode, createTopupLink, exchangePairingCode, previewTopupLink, redeemTopupLink } from "./pairing";
import { emitGhaJobCompleted, emitJobTerminal, emitRunDispatched } from "./analytics";
import {
  RESERVED_RUNNER_LABELS,
  claimGhRunnerJob,
  ghRunnerUsage,
  handleWorkflowJobEvent,
  laneLogDigestText,
  listGhRunnerJobs,
  parseStoredLabels,
  releaseGhRunnerJob,
  runnerManagedLabels,
  runnerModeOn,
  setGhJobLogDigest,
  stampGhRunnerId,
  sweepStaleGhRunnerJobs,
  type GhRunnerJobRow,
} from "./ghrunners";
import { basinJobTerminal, basinRunDispatched, basinSink, sendBasin, type BasinSink } from "./basin";
import { ACTIONS_LIST_USD_PER_MIN, jobDurationMs, summarizeRunCost } from "./cost";
import { cloudMetering, creditBalance, grantCredits, hostedMode, parseCloudEntitlements, recentLedger, x402Quote } from "./cloud";
import { runGenerateWithStatus } from "./generate";
import { getCacheStats, handleCacheGet, handleCachePut, listCacheEntries, parseRestoreKeysParam, pruneCacheStats, purgeCachePrefix, recordCacheOutcome } from "./cache";
import { deleteJobArtifacts, handleArtifactGet, handleArtifactPut, listRunArtifacts, pruneOldCache } from "./artifacts";
import { ARTIFACTS_EVENT, handleArtifactsPush } from "./artifacts-push";
import { ensureRepoMirror } from "./artifacts-mirrors";
import {
  claimAttempt,
  createTournament,
  getAttemptRace,
  getTournamentBoard,
  listTournaments,
  pollTournamentAttempts,
  validateTournamentClaim,
  validateTournamentCreate,
} from "./tournaments";
import { verdictPass } from "./verdict";
import {
  decodeRepoParam,
  getRepoBlob,
  getRepoCommits,
  getRepoInfo,
  getRepoTree,
  listAllowedRepos,
  normalizeRepoPath,
  validateRef,
} from "./repos";
import { artifactsRemoteFor, fastForwardPass, resolvePass } from "./promote";
import {
  cancelMergeEntry,
  detectMergeCollisions,
  enqueueMergeEntry,
  getMergeEntry,
  isMergeActive,
  listMergeQueue,
  MERGE_QUEUE_EVENT,
  processMergeQueue,
  toMergeEntry,
  validateMergeEnqueue,
} from "./mergequeue";
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
import { apiError, dispatchErrorCode, type ErrorCode } from "./errors";
import { billableWindow, fetchBillableUsage, fetchR2Bandwidth, summarizeBillableUsage, type R2BandwidthSummary } from "./billing";
import { TRIAGE_MODEL } from "./triage";
import { upsertPrComment } from "./prcomment";
import { decideSelectionMode, DEFAULT_HISTORY_DAYS, parseSelectionReport, readTestSelectionConfig } from "./testselect";
import { deleteSource, handleSourceGet, handleSourcePut, pruneOldSources, SOURCE_ID_RE } from "./sources";
import { buildRunDigest } from "./digest";
import { annotateSpan, recordSpanException } from "./trace";
import { checkTurnstile, getTurnstileSiteKey } from "./turnstile";
import { waitForRunTerminal } from "./wait";
import {
  findAttestationForDispatch,
  getAttestationReceipt,
  parseReceiptJobs,
  planAttestedJobs,
  setRunAttestation,
  verifyAttestationReceipt,
  type AttestationReceiptRow,
} from "./attestation";
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

// Repo-scoped tokens: empty allowlist means every repo (exact
// entries plus `org/*` wildcards — see tokens.reposAllow).
function repoAllowed(ident: { repos: string[] }, repo: string): boolean {
  return reposAllow(ident.repos, repo);
}

// Runner-mode job over the API: parsed labels, camelCase stamps, and no
// installation id (executor bookkeeping, not client data).
function publicGhJob(row: GhRunnerJobRow): {
  id: string;
  repo: string;
  runId: string;
  runAttempt: number;
  jobName: string;
  workflowName: string;
  headSha: string;
  labels: string[];
  status: string;
  conclusion: string | null;
  runnerId: number | null;
  runnerName: string;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  logDigest: string | null;
} {
  return {
    id: row.id,
    repo: row.repo,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    jobName: row.job_name,
    workflowName: row.workflow_name,
    headSha: row.head_sha,
    labels: parseStoredLabels(row.labels),
    status: row.status,
    conclusion: row.conclusion,
    runnerId: row.runner_id,
    runnerName: row.runner_name,
    attempts: row.attempts,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    logDigest: row.log_digest ?? null,
  };
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
  ctx?: ExecutionContext,
): Promise<Response> {
  const handler = createMcpHandler(() =>
    buildMcpServer({
      db: env.DB,
      ai: env.AI,
      canWrite,
      repos: props.repos,
      isAdmin: props.isAdmin,
      artifacts: env.CACHE,
      gatewayId: env.AI_GATEWAY_ID,
      agent: request.headers.get("X-Flare-Agent") ?? request.headers.get("User-Agent") ?? undefined,
      dispatchRun: async (input) => {
        if (!repoAllowed({ repos: props.repos }, input.repo)) throw new Error("token is not scoped to that repo");
        if (await isRepoPaused(env.DB, input.repo)) throw new Error(`${input.repo} is paused for runaway spend — resume it in dashboard Settings → Budgets`);
        const verdict = await budgetVerdict(env, input.repo);
        if (ctx) await maybeAutoPause(env, ctx, input.repo, props.actor, verdict);
        if (verdict?.mode === "block") {
          await audit(env.DB, props.actor, "budget.blocked", `${input.repo} ${verdict.usedMinutes}/${verdict.cap}`);
          throw new Error(`monthly budget exceeded for ${input.repo} (${verdict.usedMinutes}/${verdict.cap} compute-minutes)`);
        }
        const cloud = await cloudVerdict(env);
        if (cloud) {
          await audit(env.DB, props.actor, "cloud.plan_limited", `${input.repo} ${cloud.used}/${cloud.cap}`);
          throw new Error(`Flare Cloud plan saturated (${cloud.used}/${cloud.cap} concurrent jobs) — raise the cap or wait for jobs to drain`);
        }
        const out = await dispatchRun(env, { repo: input.repo, sha: input.sha, ref: input.ref ?? "", pipeline: input.pipeline, agent: input.agent, profile: input.profile }, basin);
        await audit(env.DB, props.actor, "run.dispatch", out.runId);
        for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
        return { runId: out.runId, jobIds: out.jobIds };
      },
      rerunJob: async (runId, jobId) => {
        const out = await rerunJobAndQueue(env, ctx, props.actor, runId, jobId, basin);
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
    return serveMcpRequest(request, env, props, canWrite, basinSink(env, ctx), ctx);
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

// Open registration (admin toggle, default off): anyone may create a
// non-admin reader account from the dashboard, by email or GitHub.
async function isOpenRegistration(env: WorkerEnv): Promise<boolean> {
  const parsed = parseOpenRegistration(await getSetting(env.DB, SETTING_KEYS.openRegistration));
  return "on" in parsed && parsed.on;
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

// Lane log digest, backgrounded off the workflow_job webhook: download
// the job's logs, keep error lines + tail, store ≤4 KiB. Best-effort
// throughout — a missing App, token, or log row just skips.
async function mirrorLaneLogDigest(env: WorkerEnv, jobId: string, repo: string, installationId: number): Promise<void> {
  try {
    const creds = await getAppCreds(env);
    if (!creds) return;
    const token = await getInstallationToken(await mintAppJwt(creds.appId, creds.privateKey), installationId);
    if (!token) return;
    const text = await fetchJobLogDigest(token, repo, jobId);
    if (!text) return;
    await setGhJobLogDigest(env.DB, jobId, laneLogDigestText(text));
  } catch (err) {
    log("warn", "lane log digest failed", { jobId, error: String(err) });
  }
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

// Which email's notification prefs the caller may read/write: their own
// email session by default, any email for admins (explicit param), and
// admin Bearer [REDACTED] with an explicit email. GitHub sessions carry no
// email recipient, so they must name one (admins) or log in by email.
async function resolveNotifyPrefTarget(
  request: Request,
  env: WorkerEnv,
  emailParam: string | null,
): Promise<{ email: string; actor: string } | Response> {
  const param = (emailParam ?? "").trim().toLowerCase();
  const session = await oauthSession(request, env);
  if (session) {
    const own = session.actor.startsWith("email:") ? session.login.toLowerCase() : null;
    if (param) {
      if (param !== own && !session.isAdmin) {
        return json({ error: "admin required to manage another user's prefs" }, 403);
      }
      const err = validateNotifyPrefEmail(param);
      if (err) return json({ error: err }, 400);
      return { email: param, actor: session.actor };
    }
    if (!own) {
      return json({ error: "email query required: GitHub logins have no email recipient" }, 400);
    }
    return { email: own, actor: session.actor };
  }
  const ident = await authIdentity(request, env);
  if (!ident) return json({ error: "unauthorized" }, 401);
  if (ident.scope !== "admin") return json({ error: "admin token required" }, 403);
  if (!param) return json({ error: "email is required" }, 400);
  const err = validateNotifyPrefEmail(param);
  if (err) return json({ error: err }, 400);
  return { email: param, actor: ident.actor };
}

export interface GitHubWebhookPayload {
  ref?: string;
  before?: string;
  deleted?: boolean;
  repository?: { full_name?: string; private?: boolean };
  after?: string;
  installation?: { id?: number };
  pull_request?: {
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
    number?: number;
  };
  action?: string;
  // Runner mode (`runs-on: flare`): structurally matches ghrunners'
  // WorkflowJobPayload so the parsed body passes through without casts.
  workflow_job?: {
    id?: number;
    run_id?: number;
    run_attempt?: number;
    workflow_name?: string | null;
    head_sha?: string | null;
    name?: string;
    labels?: string[];
    conclusion?: string | null;
    runner_id?: number | null;
    runner_name?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
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

// Which configuration produced a run's jobs. Stored on the run row so
// the dashboard can show what actually ran without re-fetching GitHub.
type PipelineSource = "flare" | "actions" | "default" | "inline" | "source";

// Mint an installation token for a repo's run when App creds exist;
// null when there is no installation or minting fails (callers fall
// back to unauthenticated public-repo paths).
async function mintInstallationTokenFor(env: WorkerEnv, installationId: number | null): Promise<string | null> {
  if (!installationId) return null;
  const creds = await getAppCreds(env);
  if (!creds) return null;
  try {
    const jwt = await mintAppJwt(creds.appId, creds.privateKey);
    return await getInstallationToken(jwt, installationId);
  } catch {
    return null;
  }
}

// Newline-joined changed files, bounded so the env var and the D1 row
// stay small; "" means unknown (never "no changes").
export function serializeChangedFiles(files: string[]): string {
  return files.slice(0, MAX_CHANGED_FILES).join("\n").slice(0, 6000);
}

export function parseChangedFiles(joined: string): string[] {
  return joined ? joined.split("\n").filter(Boolean) : [];
}

function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Spend guardrail verdict for a repo: null when no cap applies or the
// repo is under it; { over, mode, cap, usedMinutes } once it is over.
// `block` refuses the dispatch, `warn` keeps going + audits the overage.
async function budgetVerdict(
  env: WorkerEnv,
  repo: string,
): Promise<{ mode: "warn" | "block"; cap: number; usedMinutes: number } | null> {
  const budgets = parseStoredBudgets(await getSetting(env.DB, SETTING_KEYS.budgetMinutes));
  const cap = budgets[repo];
  if (cap === undefined) return null;
  const usedMinutes = await monthlyComputeMinutes(env.DB, repo, monthStartIso());
  if (usedMinutes < cap) return null;
  const parsed = parseBudgetMode(await getSetting(env.DB, SETTING_KEYS.budgetMode));
  return { mode: "mode" in parsed ? parsed.mode : "warn", cap, usedMinutes };
}

// Flare Cloud entitlement verdict: null on self-hosted deploys (no
// gate, zero queries) and on hosted deploys under (or without) a
// concurrent-runner cap; { cap, used } once the plan is saturated.
// Mirrors budgetVerdict's enforcement points (MCP/API/webhook/schedule).
async function cloudVerdict(env: WorkerEnv): Promise<{ cap: number; used: number } | null> {
  if (!hostedMode(env)) return null;
  const { maxConcurrentJobs } = parseCloudEntitlements(await getSetting(env.DB, SETTING_KEYS.cloudEntitlements));
  if (maxConcurrentJobs === null) return null;
  const used = await countActiveJobs(env.DB);
  if (used < maxConcurrentJobs) return null;
  return { cap: maxConcurrentJobs, used };
}

// Kill switch: when the multiplier is set and a repo burns past
// cap × multiplier, pause it (dispatch/webhook/schedule refuse until
// resume) and alert. Idempotent — only the first trip audits + alerts.
// Runs after the verdict read at every enforcement point, in warn and
// block mode alike: even a blocked loop deserves a visible pause.
async function maybeAutoPause(
  env: WorkerEnv,
  ctx: ExecutionContext,
  repo: string,
  actor: string,
  verdict: { cap: number; usedMinutes: number } | null,
): Promise<void> {
  if (!verdict) return;
  const parsed = parseBudgetKillMultiplier(await getSetting(env.DB, SETTING_KEYS.budgetKillMultiplier));
  const multiplier = "multiplier" in parsed ? parsed.multiplier : 0;
  if (multiplier <= 0 || verdict.usedMinutes < verdict.cap * multiplier) return;
  if (!(await pauseRepo(env.DB, repo))) return;
  const detail = `${repo} ${verdict.usedMinutes}/${verdict.cap} (kill at ${multiplier}x)`;
  await audit(env.DB, actor, "budget.autopause", detail);
  log("warn", "repo auto-paused: runaway budget", { repo, usedMinutes: verdict.usedMinutes, cap: verdict.cap, multiplier });
  ctx.waitUntil(
    notifyMessage(env.DB, env, {
      subject: `Flare auto-paused ${repo} (runaway budget)`,
      text: `${repo} burned ${verdict.usedMinutes} compute-minutes against a ${verdict.cap}-minute cap (kill switch at ${multiplier}x) and is now paused: dispatches, webhooks, and schedules refuse until an admin resumes it in dashboard Settings → Budgets (or \`cli resume ${repo}\`).`,
      html: `<p><strong>${repo}</strong> burned ${verdict.usedMinutes} compute-minutes against a ${verdict.cap}-minute cap (kill switch at ${multiplier}x) and is now paused.</p><p>Resume in dashboard Settings → Budgets, or <code>cli resume ${repo}</code>.</p>`,
      auditTag: "budget.autopause",
      auditTarget: repo,
    }).catch(() => undefined),
  );
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
): Promise<{ jobs: PipelineJob[]; source: "flare" | "actions" | "default"; profiles: PipelineProfiles }> {
  const fallback = { jobs: defaultPipeline(), source: "default" as const, profiles: emptyProfiles() };
  try {
    // Public fast path first (no token minted); fall back to the
    // authenticated API for private repos when App creds exist.
    const direct = await fetchPipeline(repo, sha, null);
    if (direct) {
      const parsed = parsePipelineWithProfiles(direct);
      return parsed ? { jobs: parsed.jobs, source: "flare", profiles: parsed.profiles } : fallback;
    }
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
      if (text) {
        const parsed = parsePipelineWithProfiles(text);
        return parsed ? { jobs: parsed.jobs, source: "flare", profiles: parsed.profiles } : fallback;
      }
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
          return { jobs: compat.jobs, source: "actions", profiles: emptyProfiles() };
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
    return fallback;
  } catch (err) {
    log("warn", "pipeline load failed, using default", { error: String(err) });
    return fallback;
  }
}

// Shared fan-out for webhooks, API dispatch, and MCP: create the run,
// cancel superseded groups, park needs/group-blocked jobs, queue the rest.
// Short-circuited dispatch: the run lands terminal with the recorded
// per-job verdicts, zero queue sends, and an audit row. attested_by
// points the digest at the receipt; the terminal rollup emits the
// usual analytics but files no new receipt (already attested).
async function createAttestedRun(
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
    pipelineSource?: PipelineSource;
    changedFiles?: string;
    prNumber?: number | null;
    agent?: string;
    profile?: string | null;
  },
  receipt: AttestationReceiptRow,
  basin?: BasinSink,
): Promise<{ runId: string; jobIds: string[]; queuedIds: string[]; blocked: number; reused: { receiptId: string; verdict: string } | null }> {
  const runId = crypto.randomUUID();
  await createRun(env.DB, {
    id: runId,
    repo: input.repo,
    sha: input.sha,
    event: input.event,
    installationId: input.installationId,
    profile: input.profile ?? null,
    branch: input.branch,
    source: input.source ?? null,
    pipelineSource: input.pipelineSource,
    changedFiles: input.changedFiles,
    prNumber: input.prNumber ?? null,
    agent: input.agent ?? "",
  });
  await setRunAttestation(env.DB, runId, receipt.id);
  const jobIds: string[] = [];
  for (const planned of planAttestedJobs(receipt, input.jobs)) {
    const jobId = crypto.randomUUID();
    await createJob(env.DB, jobId, runId, {
      name: planned.name,
      definition: planned.definition,
      labels: planned.labels,
      status: planned.status,
      priority: input.priority ?? 0,
    });
    await appendJobLog(env.DB, jobId, `[flare] reused verdict ${planned.status} from attestation ${receipt.id} (identical tree + suite + environment)\n`);
    jobIds.push(jobId);
  }
  await rollupRunStatus(env.DB, runId, env.ANALYTICS, basin, cloudMetering(env));
  await audit(env.DB, "system", "attestation.reused", `${input.repo} ${receipt.id} -> ${runId}`);
  log("info", "run attested: reused recorded verdict", { runId, repo: input.repo, sha: input.sha, receiptId: receipt.id, verdict: receipt.verdict });
  return { runId, jobIds, queuedIds: [], blocked: 0, reused: { receiptId: receipt.id, verdict: receipt.verdict } };
}

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
    pipelineSource?: PipelineSource;
    changedFiles?: string;
    prNumber?: number | null;
    agent?: string;
    profile?: string | null;
    // Pre-loaded repo egress policy (webhook pre-checks it to skip
    // with a 200 instead of throwing); otherwise read inside.
    repoEgress?: string[] | null;
  },
  basin?: BasinSink,
): Promise<{ runId: string; jobIds: string[]; queuedIds: string[]; blocked: number; reused: { receiptId: string; verdict: string } | null }> {
  // Attestation: this exact tree + suite + environment already ran —
  // short-circuit to the recorded verdict instead of fanning out. The
  // lookup is best-effort: on any error the dispatch runs for real.
  const receipt = await findAttestationForDispatch(env.DB, input.repo, input.sha, input.profile ?? null, input.jobs).catch(() => null);
  if (receipt) {
    return createAttestedRun(env, input, receipt, basin);
  }
  // Repo egress floor policy: merged here, the single fan-out choke,
  // before the first write — a violation rejects the whole dispatch
  // with zero rows. (Attested runs execute nothing, so they skip this.)
  const repoEgress = input.repoEgress !== undefined ? input.repoEgress : await getRepoEgressAllow(env.DB, input.repo);
  const policed = applyRepoEgressPolicy(input.jobs, repoEgress);
  if (policed.violations.length > 0) {
    throw new EgressPolicyViolationError(input.repo, repoEgress ?? [], policed.violations);
  }
  const jobs = policed.jobs;
  const runId = crypto.randomUUID();
  await createRun(env.DB, {
    id: runId,
    repo: input.repo,
    sha: input.sha,
    event: input.event,
    installationId: input.installationId,
    profile: input.profile ?? null,
    branch: input.branch,
    source: input.source ?? null,
    pipelineSource: input.pipelineSource,
    changedFiles: input.changedFiles,
    prNumber: input.prNumber ?? null,
    agent: input.agent ?? "",
  });
  const jobIds: string[] = [];
  const queuedIds: string[] = [];
  let blocked = 0;
  let skipped = 0;
  for (const job of jobs) {
    const jobId = crypto.randomUUID();
    const base = job.base ?? job.name;
    const groupBlocked =
      !!job.group && !job.cancelInProgress && (await hasActiveGroupJob(env.DB, input.repo, job.group));
    const verdict = initialJobStatus(job, groupBlocked);
    // A job that will never run must not supersede its group.
    if (job.group && job.cancelInProgress && verdict.status !== "skipped") {
      const cancelled = await cancelGroupJobs(env.DB, input.repo, job.group, runId, env.ANALYTICS, basin, cloudMetering(env));
      if (cancelled.length > 0) log("info", "concurrency cancelled superseded jobs", { group: job.group, cancelled });
    }
    const status = verdict.status;
    if (status === "blocked") blocked += 1;
    if (status === "skipped") skipped += 1;
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
  await rollupRunStatus(env.DB, runId, env.ANALYTICS, basin, cloudMetering(env));
  // Skipped-at-fan-out roots never transition, so without this their
  // dependents would park forever — promote once when any root skipped
  // (promoted jobs queue and wake exactly like fanned-out ones).
  if (skipped > 0 && blocked > 0) {
    const promoted = await promoteBlockedJobs(env.DB, env.RUN_QUEUE, input.repo, undefined, env.ANALYTICS, basin, cloudMetering(env));
    queuedIds.push(...promoted);
  }
  return { runId, jobIds, queuedIds, blocked, reused: null };
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
      return json(apiError("webhook_not_configured", "webhook secret not configured — set it in the dashboard"), 500);
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_WEBHOOK_BYTES) {
      return json(apiError("payload_too_large", "payload too large"), 413);
    }
    const valid = await verifyGitHubSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      secret,
    );
    if (!valid) return json(apiError("bad_signature", "invalid signature"), 401);

    // Idempotency: GitHub retries (and manual redeliveries) reuse the
    // delivery UUID. First claim wins; a duplicate is acknowledged.
    const delivery = request.headers.get("x-github-delivery");
    if (delivery) {
      if (!/^[A-Za-z0-9-]{8,64}$/.test(delivery)) return json(apiError("invalid_delivery", "invalid delivery id"), 400);
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
      return json(apiError("invalid_json", "invalid JSON payload"), 400);
    }
    // Runner mode (`runs-on: flare`): mirror the workflow_job lifecycle
    // into gh_runner_jobs. Always 202 — GitHub retries non-2xx, and a
    // poison event must never redeliver-loop.
    if (event === "workflow_job") {
      try {
        const out = await handleWorkflowJobEvent(env.DB, payload, {
          modeOn: await runnerModeOn(env.DB),
          managedLabels: await runnerManagedLabels(env.DB),
        });
        if (out.handled && out.action === "completed" && out.terminal) {
          emitGhaJobCompleted(env.ANALYTICS, { ...out.terminal });
          // Failed lane jobs get a log digest (error lines + tail) for
          // triage without leaving Flare; the 202 already went out, so
          // the fetch rides waitUntil and never fails the webhook.
          if (out.terminal.conclusion !== "success" && out.terminal.installationId) {
            const digestJobId = out.id;
            const digestRepo = out.terminal.repo;
            const digestInstallation = out.terminal.installationId;
            ctx.waitUntil(mirrorLaneLogDigest(env, digestJobId, digestRepo, digestInstallation));
          }
        }
        log("info", "workflow_job webhook", {
          action: payload.action ?? "",
          handled: out.handled,
          reason: out.handled ? out.action : out.reason,
        });
        return json(out.handled ? { ok: true, action: out.action, id: out.id } : { ok: true, skipped: out.reason }, 202);
      } catch (err) {
        log("warn", "workflow_job ingest failed", { error: String(err) });
        return json({ ok: true, skipped: "ingest failed" }, 202);
      }
    }
    const skip = webhookSkipReason(event, payload);
    if (skip) {
      log("info", "webhook skipped", { event, reason: skip });
      return json({ skipped: skip }, 200);
    }
    const repo = payload.repository?.full_name;
    const sha = payload.after ?? payload.pull_request?.head?.sha;
    if (!repo || !sha) return json(apiError("missing_repo_or_sha", "missing repo or sha"), 400);
    // Kill switch first: paused repos skip silently (200, like block).
    if (await isRepoPaused(env.DB, repo)) {
      log("info", "webhook skipped: repo paused", { repo });
      return json({ skipped: "paused" }, 200);
    }
    // Budget guard: block-mode repos over their monthly cap are skipped
    // (200 so GitHub stops retrying); warn-mode dispatches and audits.
    const verdict = await budgetVerdict(env, repo);
    await maybeAutoPause(env, ctx, repo, "system", verdict);
    if (verdict?.mode === "block") {
      await audit(env.DB, "system", "budget.blocked", `${repo} ${verdict.usedMinutes}/${verdict.cap}`);
      log("warn", "run skipped: monthly budget exceeded", { repo, usedMinutes: verdict.usedMinutes, cap: verdict.cap });
      return json({ skipped: "budget", usedMinutes: verdict.usedMinutes, cap: verdict.cap }, 200);
    }
    if (verdict) {
      await audit(env.DB, "system", "budget.warn", `${repo} ${verdict.usedMinutes}/${verdict.cap}`);
      log("warn", "monthly budget exceeded (warn mode)", { repo, usedMinutes: verdict.usedMinutes, cap: verdict.cap });
    }
    // Plan guard: a saturated hosted plan skips the webhook like a
    // budget block (200 so GitHub stops retrying). Self-hosted: null.
    const cloud = await cloudVerdict(env);
    if (cloud) {
      await audit(env.DB, "system", "cloud.plan_limited", `${repo} ${cloud.used}/${cloud.cap}`);
      log("warn", "run skipped: plan saturated", { repo, used: cloud.used, cap: cloud.cap });
      return json({ skipped: "plan", used: cloud.used, cap: cloud.cap }, 200);
    }
    const branch = branchFromRef(payload.ref) || payload.pull_request?.head?.ref || "";
    const tag = payload.ref?.startsWith("refs/tags/") ? payload.ref.slice("refs/tags/".length) : "";

    const installationId = payload.installation?.id ?? null;
    const prNumber = event === "pull_request" ? (payload.pull_request?.number ?? null) : null;
    // Changed files feed `paths:` trigger filters and FLARE_CHANGED_FILES;
    // best-effort, and empty means unknown (filters stay conservative).
    const changedFiles = await fetchChangedFiles(
      repo,
      { before: payload.before, after: sha, prNumber },
      await mintInstallationTokenFor(env, installationId),
    );
    const loaded = await loadPipelineJobs(env, repo, sha, installationId, {
      event,
      branch,
      baseBranch: payload.pull_request?.base?.ref,
      tag,
      changedFiles,
    });
    // Webhooks take the event's default profile (push/PR). A broken
    // selection runs everything — pushes never fail to dispatch.
    const webhookSelection = selectProfileJobs(loaded.jobs, loaded.profiles, { event });
    if ("error" in webhookSelection) {
      log("warn", "profile selection failed, running all jobs", { repo, event, error: webhookSelection.error });
    }
    const webhookJobs = "error" in webhookSelection ? loaded.jobs : webhookSelection.jobs;
    const webhookProfile = "error" in webhookSelection ? null : webhookSelection.profile;
    // Egress guard: a job outside the repo allowlist skips the webhook
    // (200 so GitHub stops retrying), mirroring the budget guard.
    const webhookEgress = await getRepoEgressAllow(env.DB, repo);
    const webhookPoliced = applyRepoEgressPolicy(webhookJobs, webhookEgress);
    if (webhookPoliced.violations.length > 0) {
      const violating = webhookPoliced.violations.map((v) => v.job);
      await audit(env.DB, "system", "egress-policy.skip", `${repo} ${violating.join(",")}`);
      log("warn", "run skipped: egress policy violation", { repo, jobs: violating });
      return json({ skipped: "egress-policy", jobs: violating }, 200);
    }
    const { runId, jobIds, queuedIds, blocked, reused } = await createRunAndFanOut(env, {
      repo,
      sha,
      branch,
      event,
      installationId,
      jobs: webhookJobs,
      pipelineSource: loaded.source,
      changedFiles: serializeChangedFiles(changedFiles),
      prNumber,
      profile: webhookProfile,
      repoEgress: webhookEgress,
    }, basinSink(env, ctx));

    // Auto-supersede (opt-in): one run per branch head — cancel the
    // still-active jobs of earlier runs on this branch.
    if (event === "push" && branch) {
      const supersede = parseSupersedeBranchRuns(await getSetting(env.DB, SETTING_KEYS.supersedeBranchRuns));
      if ("mode" in supersede && supersede.mode === "push") {
        const cancelled = await cancelSupersededBranchRuns(
          env.DB,
          repo,
          branch,
          runId,
          env.ANALYTICS,
          basinSink(env, ctx),
          cloudMetering(env),
        );
        if (cancelled.length > 0) {
          log("info", "auto-superseded earlier branch runs", { repo, branch, cancelled: cancelled.length });
        }
      }
    }

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
          const staleStats = await pruneCacheStats(env.DB);
          if (staleStats > 0) log("info", "pruned cache stats", { pruned: staleStats });
          const staleSnaps = await pruneSeatSnapshots(
            env.DB,
            new Date(Date.now() - SEAT_SNAPSHOT_MAX_AGE_MS).toISOString(),
          );
          if (staleSnaps > 0) log("info", "pruned seat snapshots", { pruned: staleSnaps });
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
    log("info", "run queued", { runId, jobCount: jobIds.length, blocked, repo, sha, event, profile: webhookProfile, reused: reused?.receiptId ?? null });
    ctx.waitUntil(annotateSpan({ "run.id": runId, repo, "event": event }));
    for (const jobId of queuedIds) await wakeSeat(env, jobId);
    const creds = await getAppCreds(env);
    // Attested runs never go pending: the recorded verdict is the
    // commit status (no job callbacks will follow to update it).
    const ghState = !reused ? "pending" : reused.verdict === "success" ? "success" : "failure";
    ctx.waitUntil(
      reportGitHubStatus({ appId: creds?.appId, privateKey: creds?.privateKey, installationId, repo, sha, state: ghState }),
    );
    // Hands-free mirrors: the first executed push imports the repo
    // into the ARTIFACTS namespace (server-side) so seats check out
    // from it. Post-response and best-effort — dispatch never waits,
    // attested runs check out nothing and skip, and any gap falls
    // back to GitHub. (No binding configured = GitHub-only, silent.)
    if (!reused && (event === "push" || event === "pull_request")) {
      const mirrorPrivate = payload.repository?.private === true;
      ctx.waitUntil(
        (async () => {
          try {
            const token = mirrorPrivate ? await mintInstallationTokenFor(env, installationId) : null;
            const out = await ensureRepoMirror({
              db: env.DB,
              artifacts: env.ARTIFACTS ?? null,
              repo,
              isPrivate: mirrorPrivate,
              installationToken: token,
            });
            if (out.status === "failed") log("warn", "mirror provision failed", { repo, detail: out.detail ?? "" });
            else if (out.status === "ready") log("info", "mirror ready", { repo, mirror: out.mirror });
          } catch (err) {
            log("warn", "mirror provision error", { repo, error: String(err) });
          }
        })(),
      );
    }
    return json(
      { runId, jobId: jobIds[0], jobIds, ...(reused ? { reused: true, receiptId: reused.receiptId, verdict: reused.verdict } : {}) },
      202,
    );
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
    let body: { status?: string; jobId?: string; log?: string; result?: unknown; selection?: unknown };
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
    // Flaky auto-quarantine: an all-quarantined failure is downgraded to
    // success before it lands, so triage/checks/notifications see green.
    const q = await quarantineDowngrade(env.DB, jobId, body.status);
    const effectiveStatus = q.status;
    const effectiveLog = q.note ? `${cappedLog ?? ""}\n${q.note}`.trim() : cappedLog;
    const recorded = await updateRunningJob(env.DB, jobId, { status: effectiveStatus, log: effectiveLog, result });
    if (!recorded) {
      // The row moved on (re-run or stale requeue): this report belongs
      // to a superseded execution, so drop it instead of clobbering.
      log("warn", "status report dropped: job not running", { runId, jobId, status: body.status });
      return json({ ok: true, dropped: true });
    }
    // Smart test selection skip report: best-effort, never blocks the
    // status update (invalid shapes are dropped, not 400s).
    const selectionReport = parseSelectionReport(body.selection);
    if (selectionReport) {
      await saveTestSelection(env.DB, {
        jobId,
        runId,
        mode: selectionReport.mode,
        reason: selectionReport.reason,
        selected: selectionReport.selected,
        skipped: selectionReport.skipped,
      }).catch((err: unknown) => log("warn", "selection report save failed", { runId, jobId, error: String(err) }));
    }
    await rollupRunStatus(env.DB, runId, env.ANALYTICS, basinSink(env, ctx), cloudMetering(env));
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
    log("info", "status updated", { runId, jobId, status: effectiveStatus });
    ctx.waitUntil(annotateSpan({ "run.id": runId, "job.id": jobId, status: effectiveStatus }));
    if (isTerminal(effectiveStatus)) {
      const basin = basinSink(env, ctx);
      const promoted = await promoteBlockedJobs(env.DB, env.RUN_QUEUE, run.repo, (job) => wakeSeat(env, job.jobId), env.ANALYTICS, basin, cloudMetering(env));
      if (promoted.length > 0) log("info", "blocked jobs promoted", { runId, promoted });
      // Result monitors ride the terminal transition (best-effort, never blocking).
      const finishedJob = await getJob(env.DB, jobId);
      if (finishedJob) {
        emitJobTerminal(env.ANALYTICS, {
          repo: run.repo,
          runId,
          jobName: finishedJob.name,
          status: effectiveStatus,
          durationMs: jobDurationMs(finishedJob) ?? 0,
          executor: "runner",
          attempts: finishedJob.attempts,
        });
        if (basin) {
          sendBasin(basin, basinJobTerminal({
            repo: run.repo,
            runId,
            jobName: finishedJob.name,
            status: effectiveStatus,
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
      if (finishedJob && (effectiveStatus === "success" || effectiveStatus === "failure")) {
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
              const quarantined = await listQuarantinedFailingTests(env.DB, runId, run.repo, 15).catch(() => []);
              const selections = await getRunSelections(env.DB, runId).catch(() => []);
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
                quarantined.map((f) => ({ jobName: f.job_name, suite: f.suite, name: f.name, message: f.message })),
                selections.map((s) => ({
                  jobName: jobs.find((j) => j.id === s.job_id)?.name ?? s.job_id.slice(0, 8),
                  mode: s.mode,
                  reason: s.reason,
                  selectedCount: s.selected_count,
                  skippedCount: s.skipped_count,
                })),
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
    if (effectiveStatus === "failure" || effectiveStatus === "error") {
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

export type RegisterInput =
  | { mode: "invite"; token: string; password: string }
  | { mode: "open"; email: string; password: string }
  | { error: string };

// Registration has two doors: an invite token (always), or a bare
// email when the admin enabled open registration. A token wins when
// both are present, so invite links keep working on open deploys.
// Both doors create non-admin accounts only — admin comes solely
// from the first-login claim and bootstrap paths.
export function validateRegisterInput(
  body: Record<string, unknown>,
  openRegistration: boolean,
): RegisterInput {
  const { token, email, password } = body;
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr };
  if (typeof token === "string" && token) return { mode: "invite", token, password: password as string };
  if (!openRegistration) return { error: "invite required" };
  const emailErr = validateEmail(email);
  if (emailErr) return { error: emailErr };
  return { mode: "open", email: normalizeEmail(email as string), password: password as string };
}

export function validateDispatch(
  body: Record<string, unknown>,
): { repo: string; sha: string; ref: string; pipeline?: string; priority: number; source?: string; agent: string; profile?: string } | { error: string } {
  const { repo, sha, ref, pipeline, priority, source, agent, profile } = body;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "repo must be owner/name" };
  if (ref !== undefined && (typeof ref !== "string" || ref.length > 128)) return { error: "invalid ref" };
  if (pipeline !== undefined && (typeof pipeline !== "string" || !pipeline.trim() || pipeline.length > 65536)) {
    return { error: "invalid pipeline" };
  }
  // Agent priority lane: 0 default, 10 urgent (jumps queued batch work).
  if (priority !== undefined && (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 10)) {
    return { error: "priority must be an integer 0-10" };
  }
  // Agent identity tag for per-agent caps and attribution ("" = untagged).
  let parsedAgent = "";
  if (agent !== undefined) {
    const tag = parseAgentTag(agent);
    if ("error" in tag) return { error: tag.error };
    parsedAgent = tag.agent;
  }
  const parsedPriority = typeof priority === "number" ? priority : 0;
  const parsedRef = typeof ref === "string" ? ref : "";
  // Explicit CI profile override (must exist in the resolved pipeline).
  let parsedProfile: string | undefined;
  if (profile !== undefined) {
    const named = parseProfileName(profile);
    if ("error" in named) return { error: named.error };
    parsedProfile = named.profile;
  }
  // Source runs execute an uploaded working tree: no commit, no ref —
  // the inline pipeline is the contract (empty pipeline would silently
  // echo, so require it explicitly).
  if (source !== undefined) {
    if (typeof source !== "string" || !SOURCE_ID_RE.test(source)) return { error: "invalid source id" };
    if (typeof pipeline !== "string") return { error: "source runs need an inline pipeline" };
    return { repo, sha: "", ref: parsedRef, pipeline, priority: parsedPriority, source, agent: parsedAgent, profile: parsedProfile };
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
    agent: parsedAgent,
    profile: parsedProfile,
  };
}

const MAX_MIGRATE_BYTES = 64 * 1024;

export function validateMigrateInput(
  body: Record<string, unknown>,
): { workflow: string; filename: string } | { error: string } {
  const { workflow, filename } = body;
  if (typeof workflow !== "string" || !workflow.trim()) return { error: "workflow must be a non-empty YAML string" };
  if (workflow.length > MAX_MIGRATE_BYTES) return { error: "workflow must be 64 KiB or less" };
  if (filename !== undefined && (typeof filename !== "string" || filename.length > 128)) {
    return { error: "filename must be a string of 128 chars or less" };
  }
  return { workflow, filename: typeof filename === "string" && filename ? filename : "workflow.yml" };
}

export function validateScheduleInput(
  body: Record<string, unknown>,
): { repo: string; ref: string; cron: string; profile?: string } | { error: string } {
  const { repo, ref, cron, profile } = body;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "repo must be owner/name" };
  if (typeof ref !== "string" || !/^[\w./-]+$/.test(ref) || ref.length > 128 || ref.includes("..")) {
    return { error: "ref must be a branch or tag (max 128 chars)" };
  }
  const cronErr = validateCron(cron);
  if (cronErr) return { error: cronErr };
  // Pinned CI profile for the firing run (checked against flare.yml at
  // fire time; unset = the pipeline's schedule default, else all jobs).
  if (profile !== undefined) {
    const named = parseProfileName(profile);
    if ("error" in named) return { error: named.error };
    return { repo, ref, cron: (cron as string).trim(), profile: named.profile };
  }
  return { repo, ref, cron: (cron as string).trim(), profile: undefined };
}

export interface DispatchInput {
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
  agent?: string;
  // Explicit CI profile override (API/MCP/CLI); wins over everything.
  profile?: string;
  // Firing schedule's pinned profile; wins over event defaults.
  scheduleProfile?: string;
}

// Read-only half of a dispatch: resolve the ref and load the pipeline.
// Shared by dispatchRun (which fans out for real) and the dry-run
// planner (which only describes what would happen).
async function loadDispatchJobs(
  env: WorkerEnv,
  input: DispatchInput,
): Promise<{ sha: string; branch: string; installationId: number | null; jobs: PipelineJob[]; pipelineSource: PipelineSource; profile: string | null }> {
  // Dispatch accepts a SHA, branch, or tag: non-SHA refs resolve to the
  // head commit (installation token when the repo has App history, else
  // the public API), so the stored run always pins a real commit. The
  // resolved installation rides into the run row so commit statuses and
  // private pipeline fetches work for scheduled runs too. Source runs
  // skip all of that: they execute the uploaded tree against the inline
  // pipeline.
  let sha = input.sha;
  let installationId: number | null = null;
  let jobs: PipelineJob[] | null;
  let profiles: PipelineProfiles;
  let pipelineSource: PipelineSource;
  const branch = input.source
    ? input.ref || "local"
    : branchFromRef(input.ref) || input.ref || (!isHexSha(input.sha) ? input.sha : "");
  if (input.source) {
    sha = `src-${input.source.slice(0, 8)}`;
    const parsed = input.pipeline ? parsePipelineWithProfiles(input.pipeline) : null;
    if (!parsed) throw new Error("pipeline parse failed");
    jobs = parsed.jobs;
    profiles = parsed.profiles;
    pipelineSource = "source";
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
      const parsed = parsePipelineWithProfiles(input.pipeline);
      if (!parsed) throw new Error("pipeline parse failed");
      jobs = parsed.jobs;
      profiles = parsed.profiles;
      pipelineSource = "inline";
    } else {
      const loaded = await loadPipelineJobs(env, input.repo, sha, installationId, {
        event: input.event ?? "dispatch",
        branch,
        cron: input.cron,
      });
      jobs = loaded.jobs;
      profiles = loaded.profiles;
      pipelineSource = loaded.source;
    }
  }
  // CI profiles: explicit override > schedule pin > event default > all.
  // Failures here are caller-visible (400), never silent widening.
  const selection = selectProfileJobs(jobs, profiles, {
    ...(input.profile ? { override: input.profile } : {}),
    ...(input.scheduleProfile ? { scheduleProfile: input.scheduleProfile } : {}),
    event: input.event ?? "dispatch",
  });
  if ("error" in selection) throw new Error(selection.error);
  return { sha, branch, installationId, jobs: selection.jobs, pipelineSource, profile: selection.profile };
}

export interface PlannedJob {
  name: string;
  base: string;
  needs: string[];
  group: string | null;
  labels: string[];
  status: "queued" | "blocked" | "skipped";
  // Why the job is not queued: parked on needs/group, or skipped by a
  // root `if:` that is already false.
  blockedReason: "needs" | "group" | "if" | null;
  wouldCancelInProgress: boolean;
  // Effective outbound allowlist after the repo floor policy (null =
  // observe-only), plus the violation detail when the job declares
  // domains outside the repo list (a real dispatch would reject).
  egressAllow: string[] | null;
  policyViolation: string | null;
}

// Pure mirror of createRunAndFanOut's per-job status call: needs park
// the job, otherwise an active same-group job parks it unless the job
// cancels in progress (which instead supersedes the group), otherwise a
// root `if:` that is already false skips it. The dry-run route feeds
// live group state and the repo egress policy; unit tests feed fakes.
export function planFanOut(
  jobs: PipelineJob[],
  groupActive: (group: string) => boolean,
  repoAllow: string[] | null = null,
): PlannedJob[] {
  const policed = applyRepoEgressPolicy(jobs, repoAllow);
  const violated = new Map(policed.violations.map((v) => [v.job, v.outside]));
  return policed.jobs.map((job) => {
    const base = job.base ?? job.name;
    const groupBlocked = !!job.group && !job.cancelInProgress && groupActive(job.group);
    const verdict = initialJobStatus(job, groupBlocked);
    const outside = violated.get(job.name) ?? null;
    return {
      name: job.name,
      base,
      needs: job.needs ?? [],
      group: job.group ?? null,
      labels: job.labels ?? [],
      status: verdict.status,
      blockedReason: verdict.blockedReason,
      wouldCancelInProgress: !!job.group && !!job.cancelInProgress,
      egressAllow: job.egress && job.egress.allow.length > 0 ? job.egress.allow : null,
      policyViolation: outside ? `allows [${outside.join(", ")}] outside the repo allowlist` : null,
    };
  });
}

async function dispatchRun(
  env: WorkerEnv,
  input: DispatchInput,
  basin?: BasinSink,
): Promise<{ runId: string; jobIds: string[]; queuedIds: string[]; profile: string | null; reused: { receiptId: string; verdict: string } | null }> {
  const { sha, branch, installationId, jobs, pipelineSource, profile } = await loadDispatchJobs(env, input);
  const { runId, jobIds, queuedIds, reused } = await createRunAndFanOut(env, {
    repo: input.repo,
    sha,
    branch,
    event: input.event ?? "dispatch",
    installationId,
    jobs,
    priority: input.priority ?? 0,
    source: input.source ?? null,
    pipelineSource,
    agent: input.agent ?? "",
    profile,
  }, basin);
  log("info", "run dispatched", { runId, repo: input.repo, sha, event: input.event ?? "dispatch", source: input.source ?? null, profile, reused: reused?.receiptId ?? null });
  emitRunDispatched(env.ANALYTICS, { repo: input.repo, runId, event: input.event ?? "dispatch", jobCount: jobIds.length });
  if (basin) {
    sendBasin(basin, basinRunDispatched({ repo: input.repo, runId, event: input.event ?? "dispatch", jobCount: jobIds.length }));
  }
  return { runId, jobIds, queuedIds, profile, reused };
}

// A rerun spends compute like a dispatch, so it passes the same gates
// (pause, budget block, hosted plan cap) before the job is reset.
async function rerunJobAndQueue(
  env: WorkerEnv,
  ctx: ExecutionContext | undefined,
  actor: string,
  runId: string,
  jobId: string,
  basin?: BasinSink,
): Promise<{ ok: boolean; error?: string; code?: ErrorCode; status?: number }> {
  const job = await getJob(env.DB, jobId);
  if (!job || job.run_id !== runId) return { ok: false, error: "job not found", status: 404 };
  const run = await getRun(env.DB, runId);
  if (!run) return { ok: false, error: "job not found", status: 404 };
  if (await isRepoPaused(env.DB, run.repo)) {
    return { ok: false, code: "repo_paused", error: `${run.repo} is paused for runaway spend`, status: 429 };
  }
  const verdict = await budgetVerdict(env, run.repo);
  if (ctx) await maybeAutoPause(env, ctx, run.repo, actor, verdict);
  if (verdict?.mode === "block") {
    await audit(env.DB, actor, "budget.blocked", `${run.repo} ${verdict.usedMinutes}/${verdict.cap}`);
    return {
      ok: false,
      code: "budget_exceeded",
      error: `monthly budget exceeded for ${run.repo} (${verdict.usedMinutes}/${verdict.cap} compute-minutes)`,
      status: 429,
    };
  }
  const cloud = await cloudVerdict(env);
  if (cloud) {
    await audit(env.DB, actor, "cloud.plan_limited", `${run.repo} ${cloud.used}/${cloud.cap}`);
    return {
      ok: false,
      code: "plan_limit_exceeded",
      error: `Flare Cloud plan saturated (${cloud.used}/${cloud.cap} concurrent jobs)`,
      status: 429,
    };
  }
  const reset = await rerunJob(env.DB, jobId);
  if (!reset) return { ok: false, error: "job not found" };
  await rollupRunStatus(env.DB, runId, env.ANALYTICS, basin, cloudMetering(env));
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

async function handleEgressAllowlist(request: Request, env: WorkerEnv): Promise<Response> {
  const ident = await authIdentity(request, env);
  if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    if (!repo) return json({ allowlists: await listRepoEgressAllow(env.DB) });
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
    if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
    const domains = await getRepoEgressAllow(env.DB, repo);
    if (!domains) return json({ error: "no egress allowlist for that repo" }, 404);
    return json({ repo, domains });
  }
  if (request.method === "DELETE") {
    const repo = url.searchParams.get("repo") ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
    if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
    const deleted = await deleteRepoEgressAllow(env.DB, repo);
    if (!deleted) return json({ error: "no egress allowlist for that repo" }, 404);
    await audit(env.DB, ident.actor, "egress-allowlist.delete", repo);
    return json({ ok: true });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) {
    return json({ error: "repo must be owner/name" }, 400);
  }
  if (!repoAllowed(ident, body.repo)) return json({ error: "token is not scoped to that repo" }, 403);
  const domains = parseEgressAllow(body.domains);
  if (!domains) return json({ error: "domains must be 1-32 unique hostnames" }, 400);
  await setRepoEgressAllow(env.DB, body.repo, domains);
  await audit(env.DB, ident.actor, "egress-allowlist.set", `${body.repo} ${domains.length} domains`);
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
    if (repos === null) return json({ error: "repos must be owner/name or org/* entries (max 50)" }, 400);
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
      fairSharePerAgent?: unknown;
      aiGatewayId?: unknown;
      mcpWriteConfirm?: unknown;
      triageWebSearch?: unknown;
      healOnFailure?: unknown;
      openRegistration?: unknown;
      budgetMinutes?: unknown;
      budgetMode?: unknown;
      budgetKillMultiplier?: unknown;
      supersedeBranchRuns?: unknown;
      githubRunnerMode?: unknown;
      githubRunnerLabels?: unknown;
      githubRunnerGroup?: unknown;
      billingApiToken?: unknown;
      cloudflareAccountId?: unknown;
      triageModel?: unknown;
      runnerVersion?: unknown;
      cloudEntitlements?: unknown;
      cloudMetering?: unknown;
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
    const hasAgentShare = body.fairSharePerAgent !== undefined;
    const hasGateway = body.aiGatewayId !== undefined;
    const hasWriteConfirm = body.mcpWriteConfirm !== undefined;
    const hasWebSearch = body.triageWebSearch !== undefined;
    const hasHeal = body.healOnFailure !== undefined;
    const hasOpenReg = body.openRegistration !== undefined;
    const hasBudget = body.budgetMinutes !== undefined;
    const hasBudgetMode = body.budgetMode !== undefined;
    const hasKillMultiplier = body.budgetKillMultiplier !== undefined;
    const hasSupersede = body.supersedeBranchRuns !== undefined;
    const hasGhMode = body.githubRunnerMode !== undefined;
    const hasGhLabels = body.githubRunnerLabels !== undefined;
    const hasGhGroup = body.githubRunnerGroup !== undefined;
    const hasBillingToken = body.billingApiToken !== undefined;
    const hasAccountId = body.cloudflareAccountId !== undefined;
    const hasTriageModel = body.triageModel !== undefined;
    const hasRunnerVersion = body.runnerVersion !== undefined;
    const hasCloudEnt = body.cloudEntitlements !== undefined;
    const hasCloudMetering = body.cloudMetering !== undefined;
    if (
      !hasWebhook && !hasNotifyFrom && !hasNotifyMode && !hasNotifyWebhook && !hasBadgeHidden &&
      !hasTurnstileSite && !hasTurnstileSecret && !hasFairShare && !hasAgentShare && !hasGateway && !hasWriteConfirm && !hasWebSearch &&
      !hasHeal && !hasOpenReg && !hasBudget && !hasBudgetMode && !hasKillMultiplier && !hasSupersede && !hasGhMode && !hasGhLabels && !hasGhGroup && !hasBillingToken && !hasAccountId && !hasTriageModel && !hasRunnerVersion && !hasCloudEnt && !hasCloudMetering
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
    if (hasAgentShare) {
      const parsed = parseFairSharePerAgent(body.fairSharePerAgent);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.fairSharePerAgent, String(parsed.cap));
      await audit(env.DB, ident.actor, "settings.fair_share_agent", String(parsed.cap));
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
    if (hasOpenReg) {
      const parsed = parseOpenRegistration(body.openRegistration);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.openRegistration, parsed.on ? "1" : "0");
      await audit(env.DB, ident.actor, "settings.open_registration", parsed.on ? "on" : "off");
      log("info", "open registration toggled", { on: parsed.on });
    }
    if (hasBudget) {
      const parsed = parseBudgetMinutes(body.budgetMinutes);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.budgetMinutes, JSON.stringify(parsed.budgets));
      await audit(env.DB, ident.actor, "settings.budgets", `${Object.keys(parsed.budgets).length} repos`);
    }
    if (hasBudgetMode) {
      const parsed = parseBudgetMode(body.budgetMode);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.budgetMode, parsed.mode);
      await audit(env.DB, ident.actor, "settings.budget_mode", parsed.mode);
    }
    if (hasKillMultiplier) {
      const parsed = parseBudgetKillMultiplier(body.budgetKillMultiplier);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.budgetKillMultiplier, String(parsed.multiplier));
      await audit(env.DB, ident.actor, "settings.budget_kill", String(parsed.multiplier));
    }
    if (hasSupersede) {
      const parsed = parseSupersedeBranchRuns(body.supersedeBranchRuns);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.supersedeBranchRuns, parsed.mode);
      await audit(env.DB, ident.actor, "settings.supersede_branch_runs", parsed.mode);
    }
    if (hasGhMode) {
      const parsed = parseGithubRunnerMode(body.githubRunnerMode);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.githubRunnerMode, parsed.mode);
      await audit(env.DB, ident.actor, "settings.github_runner_mode", parsed.mode);
    }
    if (hasGhLabels) {
      const parsed = parseGithubRunnerLabels(body.githubRunnerLabels);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await setSetting(env.DB, SETTING_KEYS.githubRunnerLabels, parsed.labels.join(","));
      await audit(env.DB, ident.actor, "settings.github_runner_labels", parsed.labels.join(","));
    }
    if (hasGhGroup) {
      const value = body.githubRunnerGroup;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.githubRunnerGroup, "");
        await audit(env.DB, ident.actor, "settings.github_runner_group", "cleared");
      } else {
        const err = validateGithubRunnerGroupName(value);
        if (err) return json({ error: err }, 400);
        await setSetting(env.DB, SETTING_KEYS.githubRunnerGroup, (value as string).trim());
        await audit(env.DB, ident.actor, "settings.github_runner_group", (value as string).trim());
      }
      // Re-saving busts the group-id cache (renames resolve fresh).
      await setSetting(env.DB, SETTING_KEYS.githubRunnerGroupIds, "");
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
    if (hasRunnerVersion) {
      const value = body.runnerVersion;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.runnerVersion, "");
        await audit(env.DB, ident.actor, "settings.runner_version", "cleared");
      } else {
        const err = validateRunnerVersion(value);
        if (err) return json({ error: err }, 400);
        await setSetting(env.DB, SETTING_KEYS.runnerVersion, (value as string).trim());
        await audit(env.DB, ident.actor, "settings.runner_version", (value as string).trim());
      }
    }
    if (hasCloudEnt) {
      const value = body.cloudEntitlements;
      if (value === null || value === "") {
        await setSetting(env.DB, SETTING_KEYS.cloudEntitlements, "");
        await audit(env.DB, ident.actor, "settings.cloud_entitlements", "cleared");
      } else {
        const err = validateCloudEntitlements(value);
        if (err) return json({ error: err }, 400);
        await setSetting(env.DB, SETTING_KEYS.cloudEntitlements, (value as string).trim());
        await audit(env.DB, ident.actor, "settings.cloud_entitlements", (value as string).trim());
      }
    }
    if (hasCloudMetering) {
      const value = body.cloudMetering;
      const err = validateCloudMetering(value);
      if (err) return json({ error: err }, 400);
      await setSetting(env.DB, SETTING_KEYS.cloudMetering, value as string);
      await audit(env.DB, ident.actor, "settings.cloud_metering", value as string);
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

// One merge-queue pass: finalize green/red verifications (land, fail,
// or re-queue on a moved base) and start the next queued PR per repo.
// Every GitHub op is best-effort inside processMergeQueue; a tick-level
// throw degrades to zero counts, never a 500.
async function runMergeQueueTick(
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<{ started: number; landed: number; failed: number; requeued: number }> {
  try {
    return await processMergeQueue({
      db: env.DB,
      dispatch: async (input) => {
        const out = await dispatchRun(
          env,
          { repo: input.repo, sha: input.sha, ref: input.ref, event: MERGE_QUEUE_EVENT, agent: input.agent },
          basinSink(env, ctx),
        );
        for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
        return { runId: out.runId };
      },
      github: {
        baseHead: async (repo, branch) => {
          const token = await mintInstallationTokenFor(env, await latestInstallationId(env.DB, repo));
          return resolveRefToSha(token, repo, branch);
        },
        updateBranch: async (repo, pr) => {
          const token = await mintInstallationTokenFor(env, await latestInstallationId(env.DB, repo));
          if (!token) return "failed";
          return updatePullRequestBranch(token, repo, pr);
        },
        prHead: async (repo, pr) => {
          const token = await mintInstallationTokenFor(env, await latestInstallationId(env.DB, repo));
          if (!token) return null;
          return getPullRequestHead(token, repo, pr);
        },
        prFiles: async (repo, pr) => {
          const token = await mintInstallationTokenFor(env, await latestInstallationId(env.DB, repo));
          return fetchChangedFiles(repo, { prNumber: pr }, token);
        },
        mergePr: async (repo, pr, headSha) => {
          const token = await mintInstallationTokenFor(env, await latestInstallationId(env.DB, repo));
          if (!token) return { merged: false, detail: "no GitHub App installation for this repo" };
          return mergePullRequest(token, repo, pr, headSha);
        },
      },
    });
  } catch (err) {
    log("warn", "merge queue tick failed", { error: String(err) });
    return { started: 0, landed: 0, failed: 0, requeued: 0 };
  }
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
            return serveMcpRequest(request, env, props, canWrite, basinSink(env, ctx), ctx);
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
        if (!ident) return json(apiError("unauthorized", "unauthorized", "dispatch needs a run-scope token (or admin): Authorization: Bearer <token>"), 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateDispatch(body);
        if ("error" in valid) return json(apiError("invalid_request", valid.error), 400);
        if (!repoAllowed(ident, valid.repo)) return json(apiError("repo_not_allowed", "token is not scoped to that repo"), 403);
        const pausedAt = (await getPausedRepos(env.DB))[valid.repo];
        if (pausedAt !== undefined) {
          return json(
            { ...apiError("repo_paused", `${valid.repo} is paused for runaway spend`), pausedAt },
            429,
          );
        }
        const verdict = await budgetVerdict(env, valid.repo);
        await maybeAutoPause(env, ctx, valid.repo, ident.actor, verdict);
        if (verdict) {
          const kind = verdict.mode === "block" ? "budget.blocked" : "budget.warn";
          await audit(env.DB, ident.actor, kind, `${valid.repo} ${verdict.usedMinutes}/${verdict.cap}`);
          if (verdict.mode === "block") {
            return json(
              {
                ...apiError("budget_exceeded", `monthly budget exceeded for ${valid.repo} (${verdict.usedMinutes}/${verdict.cap} compute-minutes)`),
                usedMinutes: verdict.usedMinutes,
                cap: verdict.cap,
              },
              429,
            );
          }
        }
        const cloud = await cloudVerdict(env);
        if (cloud) {
          await audit(env.DB, ident.actor, "cloud.plan_limited", `${valid.repo} ${cloud.used}/${cloud.cap}`);
          return json(
            {
              ...apiError("plan_limit_exceeded", `Flare Cloud plan saturated (${cloud.used}/${cloud.cap} concurrent jobs)`),
              used: cloud.used,
              cap: cloud.cap,
            },
            429,
          );
        }
        try {
          const out = await dispatchRun(env, valid, basinSink(env, ctx));
          await audit(env.DB, ident.actor, "run.dispatch", out.runId);
          for (const jobId of out.queuedIds) await wakeSeat(env, jobId);
          ctx.waitUntil(annotateSpan({ "run.id": out.runId, "repo": valid.repo, "actor": ident.actor }));
          return json(
            { runId: out.runId, jobIds: out.jobIds, ...(out.reused ? { reused: true, receiptId: out.reused.receiptId, verdict: out.reused.verdict } : {}) },
            202,
          );
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err);
          return json(apiError(dispatchErrorCode(message), message), 400);
        }
      }
      // Dry-run dispatch: the exact load phase of a real dispatch
      // (ref resolution, pipeline/inline/source resolution, budget
      // verdict, fan-out simulation with live group state and runtime
      // priors) with zero writes, queue sends, analytics, or audits.
      if (request.method === "POST" && url.pathname === "/v1/runs/dispatch/dry-run") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json(apiError("unauthorized", "unauthorized", "dry-run needs a run-scope token (or admin): Authorization: Bearer <token>"), 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        // Source dry-runs plan from the caller's inline pipeline without
        // an upload: the documented "dry-run" placeholder stands in for
        // a tree id. The nil UUID never reaches storage (no writes) and
        // the tree is never fetched on this route.
        if (body.source === "dry-run") body.source = "00000000-0000-0000-0000-000000000000";
        const valid = validateDispatch(body);
        if ("error" in valid) return json(apiError("invalid_request", valid.error), 400);
        if (!repoAllowed(ident, valid.repo)) return json(apiError("repo_not_allowed", "token is not scoped to that repo"), 403);
        try {
          const loaded = await loadDispatchJobs(env, { ...valid, event: "dispatch" });
          const seen: Record<string, boolean> = {};
          const groupActive = (group: string): boolean => seen[group] ?? false;
          for (const job of loaded.jobs) {
            if (job.group && !job.cancelInProgress && seen[job.group] === undefined) {
              try {
                seen[job.group] = await hasActiveGroupJob(env.DB, valid.repo, job.group);
              } catch {
                seen[job.group] = false;
              }
            }
          }
          const dryEgress = await getRepoEgressAllow(env.DB, valid.repo);
          const planned = planFanOut(loaded.jobs, groupActive, dryEgress);
          const jobs = await Promise.all(
            planned.map(async (job) => ({
              ...job,
              priorMs: await lookupPriorMs(env.DB, valid.repo, job.base).catch(() => 0),
            })),
          );
          const verdict = await budgetVerdict(env, valid.repo);
          const dryCloud = await cloudVerdict(env);
          const queued = jobs.filter((job) => job.status === "queued").length;
          const skipped = jobs.filter((job) => job.status === "skipped").length;
          const dryPausedAt = (await getPausedRepos(env.DB))[valid.repo] ?? null;
          return json({
            repo: valid.repo,
            sha: loaded.sha,
            branch: loaded.branch,
            pipelineSource: loaded.pipelineSource,
            profile: loaded.profile,
            jobs,
            queued,
            blocked: jobs.length - queued - skipped,
            skipped,
            totalPriorMs: jobs.reduce((sum, job) => sum + job.priorMs, 0),
            paused: dryPausedAt !== null,
            pausedAt: dryPausedAt,
            budget: verdict
              ? { mode: verdict.mode, usedMinutes: verdict.usedMinutes, cap: verdict.cap, wouldBlock: verdict.mode === "block" }
              : null,
            cloud: dryCloud ? { used: dryCloud.used, cap: dryCloud.cap, wouldBlock: true } : null,
          });
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err);
          return json(apiError(dispatchErrorCode(message), message), 400);
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
        const agentFilter = url.searchParams.get("agent") ?? "";
        if (agentFilter && "error" in parseAgentTag(agentFilter)) {
          return json({ error: "agent must be 1-64 chars: letters, digits, dot, dash, underscore" }, 400);
        }
        const repoFilter = url.searchParams.get("repo") ?? "";
        if (repoFilter && (repoFilter.length > 200 || !/^[\w./-]+$/.test(repoFilter))) {
          return json({ error: "repo must be 1-200 chars: letters, digits, dot, dash, underscore, slash" }, 400);
        }
        return json({
          runs: await listRuns(env.DB, limit, offset, ident.repos, agentFilter || undefined, repoFilter || undefined),
        });
      }
      // Template gallery: bundled starter pipelines per stack (single
      // source in the SDK, shared with `cli init --template`).
      if (request.method === "GET" && url.pathname === "/v1/templates") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        return json({ templates: listTemplateMeta() });
      }
      const templateMatch = /^\/v1\/templates\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && templateMatch) {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const template = getTemplate(templateMatch[1]);
        if (!template) return json({ error: "template not found" }, 404);
        return json(template);
      }
      // Migration wizard: Actions workflow in, flare.yml out. Pure
      // conversion via the SDK importer — zero writes, read scope.
      if (request.method === "POST" && url.pathname === "/v1/migrate") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateMigrateInput(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        const converted = convertActionsWorkflow(valid.workflow);
        if (!isImportSuccess(converted)) return json({ error: converted.error }, 400);
        return json({ filename: valid.filename, yaml: converted.yaml, warnings: converted.warnings });
      }
      // Feed: latest runs across repos with their failed jobs, so the
      // dashboard offers one-click rerun / open-PR / fix per item.
      if (request.method === "GET" && url.pathname === "/v1/feed") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          return json({ error: "limit must be an integer 1-50" }, 400);
        }
        const agentFilter = url.searchParams.get("agent") ?? "";
        if (agentFilter && "error" in parseAgentTag(agentFilter)) {
          return json({ error: "agent must be 1-64 chars: letters, digits, dot, dash, underscore" }, 400);
        }
        const runs = await listRuns(env.DB, limit, 0, ident.repos, agentFilter || undefined);
        const items = await Promise.all(
          runs.map(async (run) => {
            const jobs = await getJobsForRun(env.DB, run.id);
            return {
              run,
              failedJobs: jobs
                .filter((j) => j.status === "failure" || j.status === "error")
                .map((j) => ({ id: j.id, name: j.name })),
            };
          }),
        );
        return json({ items });
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
      // Forge repository browsing over the ARTIFACTS namespace.
      // Token-scoped per repo like tournament sources (`namespace/name`).
      if (request.method === "GET" && url.pathname === "/v1/repos") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        if (!env.ARTIFACTS) return json({ error: "artifacts not configured" }, 503);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return json({ error: "limit must be an integer 1-100" }, 400);
        }
        const cursor = url.searchParams.get("cursor") ?? undefined;
        if (cursor && cursor.length > 500) return json({ error: "cursor too long" }, 400);
        const namespace = env.ARTIFACTS_NAMESPACE ?? "";
        const allow = ident.repos.length > 0 ? (name: string) => repoAllowed(ident, `${namespace}/${name}`) : null;
        return json(await listAllowedRepos(env.ARTIFACTS, limit, cursor, allow));
      }
      const repoTreeMatch = /^\/v1\/repos\/([^/]+)\/tree$/.exec(url.pathname);
      if (repoTreeMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        if (!env.ARTIFACTS) return json({ error: "artifacts not configured" }, 503);
        const repo = decodeRepoParam(repoTreeMatch[1]);
        if (!repo) return json({ error: "invalid repo name" }, 400);
        if (!repoAllowed(ident, `${env.ARTIFACTS_NAMESPACE ?? ""}/${repo}`)) {
          return json({ error: "token is not scoped to that repo" }, 403);
        }
        const ref = validateRef(url.searchParams.get("ref"), "main");
        const path = normalizeRepoPath(url.searchParams.get("path"));
        if (!ref || path === null) return json({ error: "invalid ref or path" }, 400);
        const tree = await getRepoTree(env.ARTIFACTS, repo, ref, path);
        if (!tree) return json({ error: "not found" }, 404);
        return json(tree);
      }
      const repoBlobMatch = /^\/v1\/repos\/([^/]+)\/blob$/.exec(url.pathname);
      if (repoBlobMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        if (!env.ARTIFACTS) return json({ error: "artifacts not configured" }, 503);
        const repo = decodeRepoParam(repoBlobMatch[1]);
        if (!repo) return json({ error: "invalid repo name" }, 400);
        if (!repoAllowed(ident, `${env.ARTIFACTS_NAMESPACE ?? ""}/${repo}`)) {
          return json({ error: "token is not scoped to that repo" }, 403);
        }
        const ref = validateRef(url.searchParams.get("ref"), "main");
        const path = normalizeRepoPath(url.searchParams.get("path"));
        if (!ref || path === null || !path) return json({ error: "invalid ref or path" }, 400);
        const blob = await getRepoBlob(env.ARTIFACTS, repo, ref, path);
        if (!blob) return json({ error: "not found" }, 404);
        return json(blob);
      }
      const repoCommitsMatch = /^\/v1\/repos\/([^/]+)\/commits$/.exec(url.pathname);
      if (repoCommitsMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        if (!env.ARTIFACTS) return json({ error: "artifacts not configured" }, 503);
        const repo = decodeRepoParam(repoCommitsMatch[1]);
        if (!repo) return json({ error: "invalid repo name" }, 400);
        if (!repoAllowed(ident, `${env.ARTIFACTS_NAMESPACE ?? ""}/${repo}`)) {
          return json({ error: "token is not scoped to that repo" }, 403);
        }
        const ref = validateRef(url.searchParams.get("ref"), "main");
        const limit = Number(url.searchParams.get("limit") ?? "20");
        if (!ref || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return json({ error: "invalid ref or limit" }, 400);
        }
        const commits = await getRepoCommits(env.ARTIFACTS, repo, ref, limit);
        if (!commits) return json({ error: "not found" }, 404);
        return json({ commits });
      }
      const repoInfoMatch = /^\/v1\/repos\/([^/]+)$/.exec(url.pathname);
      if (repoInfoMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        if (!env.ARTIFACTS) return json({ error: "artifacts not configured" }, 503);
        const repo = decodeRepoParam(repoInfoMatch[1]);
        if (!repo) return json({ error: "invalid repo name" }, 400);
        if (!repoAllowed(ident, `${env.ARTIFACTS_NAMESPACE ?? ""}/${repo}`)) {
          return json({ error: "token is not scoped to that repo" }, 403);
        }
        const info = await getRepoInfo(env.ARTIFACTS, repo);
        if (!info) return json({ error: "not found" }, 404);
        return json(info);
      }
      // Attestation lookup: a verdict receipt plus independent
      // verification (the state hash recomputed from the recorded
      // run's live rows). Token-scoped to the receipt's repo.
      const attestationMatch = /^\/v1\/attestations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && attestationMatch) {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const receipt = await getAttestationReceipt(env.DB, attestationMatch[1]);
        if (!receipt || !repoAllowed(ident, receipt.repo)) return json({ error: "attestation not found" }, 404);
        const verification = await verifyAttestationReceipt(env.DB, receipt).catch(() => ({
          verified: null as boolean | null,
          reason: "verification failed",
          runStatus: null as string | null,
        }));
        return json({
          id: receipt.id,
          repo: receipt.repo,
          sha: receipt.sha,
          profile: receipt.profile,
          hash: receipt.hash,
          verdict: receipt.verdict,
          runId: receipt.run_id,
          jobCount: receipt.job_count,
          jobs: parseReceiptJobs(receipt.jobs_json, receipt.verdict),
          createdAt: receipt.created_at,
          verified: verification.verified,
          verifyReason: verification.reason,
          runStatus: verification.runStatus,
        });
      }
      // Agent merge queue: enqueue a PR for serialized verify-then-land,
      // list a repo's queue with the collision radar, cancel a live entry.
      if (request.method === "POST" && url.pathname === "/v1/merge-queue") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const valid = validateMergeEnqueue(body);
        if ("error" in valid) return json({ error: valid.error }, 400);
        if (!repoAllowed(ident, valid.repo)) return json({ error: "token is not scoped to that repo" }, 403);
        const out = await enqueueMergeEntry(env.DB, valid);
        if ("error" in out) return json({ error: out.error }, out.error === "duplicate" ? 409 : 429);
        await audit(env.DB, ident.actor, "merge-queue.enqueue", `${valid.repo}#${valid.pr}`);
        return json({ id: out.id }, 201);
      }
      if (request.method === "GET" && url.pathname === "/v1/merge-queue") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const repo = url.searchParams.get("repo") ?? "";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
        if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
        const rows = await listMergeQueue(env.DB, repo);
        const entries = rows.map(toMergeEntry);
        const collisions = detectMergeCollisions(
          entries.filter((e) => isMergeActive(e.status)).map((e) => ({ id: e.id, pr: e.pr, files: e.files })),
        );
        return json({ repo, entries, collisions });
      }
      const mergeQueueMatch = /^\/v1\/merge-queue\/([^/]+)$/.exec(url.pathname);
      if (mergeQueueMatch && request.method === "DELETE") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const row = await getMergeEntry(env.DB, mergeQueueMatch[1]);
        if (!row || !repoAllowed(ident, row.repo)) return json({ error: "queue entry not found" }, 404);
        const cancelled = await cancelMergeEntry(env.DB, row.id);
        if (cancelled) await audit(env.DB, ident.actor, "merge-queue.cancel", `${row.repo}#${row.pr_number}`);
        return json({ ok: true, cancelled });
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runMatch[1]);
        if (!run || !repoAllowed(ident, run.repo)) return json({ error: "run not found" }, 404);
        const jobs = await getJobsForRun(env.DB, run.id);
        const race = await getAttemptRace(env.DB, run.id);
        return json({
          run,
          jobs: jobs.map((j) => ({ ...j, durationMs: jobDurationMs(j) })),
          summary: summarizeRunCost(jobs),
          race,
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
      // Fleet runner version for BYO auto-update: null = unenforced.
      // Polled on a slow cadence by idle runners, never mid-job.
      if (request.method === "GET" && url.pathname === "/v1/runner/version") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const version = await getSetting(env.DB, SETTING_KEYS.runnerVersion);
        return json({ version: version && version.trim() ? version.trim() : null });
      }
      if (request.method === "GET" && url.pathname === "/v1/jobs/next") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json(apiError("unauthorized", "unauthorized", "claiming needs a run-scope token (or admin): Authorization: Bearer <token>"), 401);
        const labels = (url.searchParams.get("labels") ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
        const fairShare = parseFairSharePerRepo(await getSetting(env.DB, SETTING_KEYS.fairSharePerRepo));
        const agentShare = parseFairSharePerAgent(await getSetting(env.DB, SETTING_KEYS.fairSharePerAgent));
        const job = await claimNextJob(env.DB, labels, ident.repos, {
          fairSharePerRepo: "cap" in fairShare ? fairShare.cap : 0,
          fairSharePerAgent: "cap" in agentShare ? agentShare.cap : 0,
          // Hosted plans cap concurrently running jobs at claim time too:
          // dispatch-time checks alone let one dispatch overshoot.
          maxRunning: hostedMode(env) ? await cloudRunningCap(env.DB) : null,
        });
        if (!job) return json({ job: null }, 200);
        await rollupRunStatus(env.DB, job.run_id, env.ANALYTICS, basinSink(env, ctx), cloudMetering(env));
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
        // Smart test selection decision: the server owns the full-suite
        // safety net (event/profile/branch) and the failure history; the
        // executor owns the import-graph walk over its checkout.
        let selection: { mode: string; reason: string; recentFailures: { suite: string; name: string; classname: string }[] } | null = null;
        const selectionConfig = readTestSelectionConfig(job.definition);
        if (selectionConfig) {
          const claimedRun = await getRun(env.DB, job.run_id);
          const decision = decideSelectionMode(selectionConfig, {
            event: claimedRun?.event ?? "",
            branch: claimedRun?.branch ?? "",
            profile: claimedRun?.profile ?? null,
            changedFiles: parseChangedFiles(claimedRun?.changed_files ?? ""),
          });
          let recentFailures: { suite: string; name: string; classname: string }[] = [];
          if (decision.mode === "select") {
            recentFailures = await recentlyFailedTests(
              env.DB,
              job.repo,
              selectionConfig.historyDays ?? DEFAULT_HISTORY_DAYS,
            ).catch(() => []);
          }
          selection = { mode: decision.mode, reason: decision.reason, recentFailures };
        }
        // Settled needs ride the claim (results + outputs for the
        // declared bases, capped); the executor turns them into step
        // env and `if:` context. Empty + untruncated without needs.
        const needsBases = readJobSpec(job.definition, job.name).needs;
        const needsCtx = await readNeedsContext(env.DB, job.run_id, needsBases);
        return json({
          job,
          secrets,
          secretsError,
          selection,
          needs: needsCtx.needs,
          needsTruncated: needsCtx.truncated,
          needsWarnings: needsCtx.warnings,
        });
      }
      // Runner mode (`runs-on: flare`) claim lane: mints an ephemeral
      // JIT config at claim time (1h TTL, single job). The JIT blob is
      // single-use and is never logged.
      if (request.method === "POST" && url.pathname === "/v1/github/jobs/next") {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json(apiError("unauthorized", "unauthorized", "claiming needs a run-scope token (or admin): Authorization: Bearer <token>"), 401);
        if (!(await runnerModeOn(env.DB))) return json({ job: null }, 200);
        const managed = await runnerManagedLabels(env.DB);
        const body = (await request.json().catch(() => ({}))) as { labels?: unknown };
        let labels: string[] = [];
        if (body.labels !== undefined) {
          if (!Array.isArray(body.labels) || body.labels.some((l) => typeof l !== "string")) {
            return json(apiError("invalid_request", "labels must be a string array"), 400);
          }
          labels = (body.labels as string[]).map((l) => l.trim()).filter(Boolean).slice(0, 20);
        }
        const job = await claimGhRunnerJob(env.DB, labels, managed, ident.repos, ident.actor);
        if (!job) return json({ job: null }, 200);
        const token = await mintInstallationTokenFor(env, job.installation_id);
        if (!token) {
          await releaseGhRunnerJob(env.DB, job.id);
          return json(apiError("token_mint_failed", "could not mint an installation token"), 503);
        }
        // The JIT runner's labels must cover the job's runs-on (GitHub
        // matches job labels ⊆ runner labels): keep self-hosted so
        // `runs-on: [self-hosted, flare]` jobs assign, strip OS/arch
        // (implied by the runner binary), keep managed + extra labels.
        const jitLabels = [...new Set(["self-hosted", ...parseStoredLabels(job.labels)])].filter(
          (l) => l.toLowerCase() === "self-hosted" || !RESERVED_RUNNER_LABELS.has(l.toLowerCase()),
        ).slice(0, 20);
        const runnerName = `flare-${job.id}-${crypto.randomUUID().slice(0, 8)}`;
        // Org group routing: a configured group name resolves (cached)
        // to its id; unresolvable fails the claim loudly (release +
        // 503) rather than landing the runner in the wrong group.
        let runnerGroupId = 1;
        const groupName = (await getSetting(env.DB, SETTING_KEYS.githubRunnerGroup))?.trim() || "";
        if (groupName) {
          const org = job.repo.split("/")[0] ?? "";
          const cache = parseRunnerGroupCache(await getSetting(env.DB, SETTING_KEYS.githubRunnerGroupIds));
          const cached = runnerGroupCacheGet(cache, org, groupName, Date.now());
          const resolved = cached ?? (await resolveRunnerGroupId(token, org, groupName));
          if (resolved === null) {
            await releaseGhRunnerJob(env.DB, job.id);
            return json(apiError("runner_group_unknown", `runner group "${groupName}" not found in ${org}`), 503);
          }
          if (cached === null) {
            await setSetting(
              env.DB,
              SETTING_KEYS.githubRunnerGroupIds,
              JSON.stringify(runnerGroupCacheSet(cache, org, groupName, resolved, Date.now())),
            );
          }
          runnerGroupId = resolved;
        }
        const jit = await generateJitConfig(token, job.repo, { name: runnerName, labels: jitLabels, runnerGroupId });
        if (!jit) {
          await releaseGhRunnerJob(env.DB, job.id);
          return json(apiError("jit_mint_failed", "GitHub JIT mint failed"), 503);
        }
        // A concurrent terminal event (GitHub assigned the job
        // elsewhere) wins over the stamp; the unused JIT is deleted so
        // no stray registration lingers.
        if (!(await stampGhRunnerId(env.DB, job.id, jit.runnerId, runnerName))) {
          await deleteRunner(token, job.repo, jit.runnerId);
          return json({ job: null }, 200);
        }
        log("info", "runner-mode job claimed", { jobId: job.id, repo: job.repo, runnerId: jit.runnerId });
        return json({ job: publicGhJob({ ...job, runner_id: jit.runnerId, runner_name: runnerName }), jitConfig: jit.jitConfig, runnerName });
      }
      if (request.method === "GET" && url.pathname === "/v1/github/jobs") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json(apiError("unauthorized", "unauthorized", "listing needs a read-scope token (or admin): Authorization: Bearer <token>"), 401);
        const repo = url.searchParams.get("repo") ?? "";
        if (repo) {
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(apiError("invalid_request", "repo must be owner/name"), 400);
          if (!repoAllowed(ident, repo)) return json(apiError("repo_not_allowed", "token is not scoped to that repo"), 403);
        }
        const limit = Number(url.searchParams.get("limit") ?? "20");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return json(apiError("invalid_request", "limit must be an integer 1-100"), 400);
        }
        const jobs = await listGhRunnerJobs(env.DB, {
          ...(repo ? { repo } : {}),
          limit,
          allowedRepos: ident.repos,
        });
        return json({ jobs: jobs.map(publicGhJob) });
      }
      const runCancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && runCancelMatch) {
        const ident = await requireScope(request, env, "run");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const run = await getRun(env.DB, runCancelMatch[1]);
        if (!run || !repoAllowed(ident, run.repo)) return json({ error: "run not found" }, 404);
        const cancelled = await cancelQueuedJobs(env.DB, run.id);
        await rollupRunStatus(env.DB, run.id, env.ANALYTICS, basinSink(env, ctx), cloudMetering(env));
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
        const out = await rerunJobAndQueue(env, ctx, ident.actor, rerunMatch[1], rerunMatch[2], basinSink(env, ctx));
        if (!out.ok) {
          const message = out.error ?? "rerun failed";
          return json(out.code ? apiError(out.code, message) : { error: message }, out.status ?? 404);
        }
        await audit(env.DB, ident.actor, "job.rerun", rerunMatch[2]);
        await wakeSeat(env, rerunMatch[2]);
        return json({ ok: true });
      }
      // Shared-warm-cache stats come before the key matcher below —
      // `/v1/cache/stats` would otherwise parse as a cache key.
      if (request.method === "GET" && url.pathname === "/v1/cache/stats") {
        if (!(await requireScope(request, env, "read"))) return json({ error: "unauthorized" }, 401);
        return json(await getCacheStats(env.DB));
      }
      const cacheMatch = /^\/v1\/cache\/(.+)$/.exec(url.pathname);
      if (cacheMatch && (request.method === "PUT" || request.method === "GET")) {
        if (!(await requireScope(request, env, "run"))) return json({ error: "unauthorized" }, 401);
        const key = decodeURIComponent(cacheMatch[1]);
        if (request.method === "PUT") return await handleCachePut(env.CACHE, key, request);
        const parsedKeys = parseRestoreKeysParam(url.searchParams);
        if ("error" in parsedKeys) return json({ error: parsedKeys.error }, 400);
        const cached = await handleCacheGet(env.CACHE, key, parsedKeys.keys);
        // Hit/miss outcomes land in the daily-aggregate counters off the
        // hot path; a stats write never fails a cache read.
        if (cached.status === 200 || cached.status === 404) {
          ctx.waitUntil(recordCacheOutcome(env.DB, key, cached.status === 200).catch(() => undefined));
        }
        return cached;
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
      // Smart test selection skip reports: what ran, what was skipped and
      // why, per job. Jobs without the opt-in config have no rows.
      const runSelectionMatch = /^\/v1\/runs\/([^/]+)\/selection$/.exec(url.pathname);
      if (runSelectionMatch && request.method === "GET") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const selectionRun = await getRun(env.DB, runSelectionMatch[1]);
        if (!selectionRun || !repoAllowed(ident, selectionRun.repo)) return json({ error: "run not found" }, 404);
        const selections = await getRunSelections(env.DB, runSelectionMatch[1]);
        const selectionJobs = await getJobsForRun(env.DB, runSelectionMatch[1]);
        const names = new Map(selectionJobs.map((j) => [j.id, j.name]));
        const parseList = (raw: string): string[] => {
          try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
          } catch {
            return [];
          }
        };
        const parseSkipped = (raw: string): { file: string; reason: string }[] => {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
              .filter(
                (s): s is { file: string; reason: string } =>
                  typeof s === "object" &&
                  s !== null &&
                  typeof (s as { file?: unknown }).file === "string" &&
                  typeof (s as { reason?: unknown }).reason === "string",
              )
              .map((s) => ({ file: s.file, reason: s.reason }));
          } catch {
            return [];
          }
        };
        return json({
          runId: runSelectionMatch[1],
          jobs: selections.map((s) => ({
            jobId: s.job_id,
            jobName: names.get(s.job_id) ?? "",
            mode: s.mode,
            reason: s.reason,
            selectedCount: s.selected_count,
            skippedCount: s.skipped_count,
            selected: parseList(s.selected_json),
            skipped: parseSkipped(s.skipped_json),
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
        const agentShare = parseFairSharePerAgent(await getSetting(env.DB, SETTING_KEYS.fairSharePerAgent));
        const jobs = await listQueuedJobs(env.DB, Math.floor(limit));
        return json({
          fairSharePerRepo: "cap" in fairShare ? fairShare.cap : 0,
          fairSharePerAgent: "cap" in agentShare ? agentShare.cap : 0,
          jobs: jobs.map((j) => ({
            id: j.id,
            runId: j.run_id,
            name: j.name,
            repo: j.repo,
            agent: j.agent,
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
          const stats = await usageStats(env.DB, Math.floor(days), [repo]);
          const gh = await ghRunnerUsage(env.DB, Math.floor(days), [repo]);
          return json({ ...stats, githubRunnerJobs: gh.jobs, githubRunnerMinutes: gh.computeMinutes, githubRunnerListUsd: gh.actionsListUsd });
        }
        const stats = await usageStats(env.DB, Math.floor(days), ident.repos);
        const gh = await ghRunnerUsage(env.DB, Math.floor(days), ident.repos);
        return json({ ...stats, githubRunnerJobs: gh.jobs, githubRunnerMinutes: gh.computeMinutes, githubRunnerListUsd: gh.actionsListUsd });
      }
      // Cost-per-merged-PR trend: window CI minutes on PRs, bucketed by
      // merge week via the GitHub API (best-effort, like every GitHub
      // call — but merge detection itself needs the App, hence 501
      // without it rather than a silently empty trend).
      if (request.method === "GET" && url.pathname === "/v1/usage/merged-pr-cost") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const repo = url.searchParams.get("repo") ?? "";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
        if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
        const weeks = Number(url.searchParams.get("weeks") ?? "8");
        if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) return json({ error: "weeks must be an integer 1-26" }, 400);
        const weekStarts = trailingWeekStarts(new Date(), weeks);
        const sinceIso = `${weekStarts[weekStarts.length - 1]}T00:00:00.000Z`;
        const [compute, installationId, creds] = await Promise.all([
          prComputeMinutes(env.DB, repo, sinceIso),
          latestInstallationId(env.DB, repo),
          getAppCreds(env),
        ]);
        if (!installationId || !creds) {
          return json({ error: "merged-PR detection needs the GitHub App connected and a prior App-run for this repo" }, 501);
        }
        const jwt = await mintAppJwt(creds.appId, creds.privateKey);
        const token = await getInstallationToken(jwt, installationId);
        if (!token) return json({ error: "merged-PR detection needs the GitHub App connected and a prior App-run for this repo" }, 501);
        const merged = await listMergedPulls(token, repo, sinceIso);
        const trend = mergedPrCostTrend(compute, merged, weekStarts).map((w) => ({
          ...w,
          actionsListUsd: Math.round(w.computeMinutes * ACTIONS_LIST_USD_PER_MIN * 10000) / 10000,
          costPerPrMinutes: w.mergedPrs > 0 ? Math.round((w.computeMinutes / w.mergedPrs) * 1000) / 1000 : 0,
        }));
        const totals = trend.reduce(
          (acc, w) => ({ mergedPrs: acc.mergedPrs + w.mergedPrs, computeMinutes: acc.computeMinutes + w.computeMinutes }),
          { mergedPrs: 0, computeMinutes: 0 },
        );
        return json({
          repo,
          weeks: trend,
          totals: {
            ...totals,
            computeMinutes: Math.round(totals.computeMinutes * 1000) / 1000,
            costPerPrMinutes: totals.mergedPrs > 0 ? Math.round((totals.computeMinutes / totals.mergedPrs) * 1000) / 1000 : 0,
          },
        });
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
          const { rows, skippedRows, truncated, totalRows } = await fetchBillableUsage(token, accountId, from, to);
          // R2 pairing is best-effort (31d GraphQL cap, needs Account
          // Analytics Read on the billing token): dollars still serve.
          let r2: R2BandwidthSummary | null = null;
          try {
            const r2win = billableWindow(Math.min(Math.floor(days), 31));
            r2 = await fetchR2Bandwidth(token, accountId, r2win.from, r2win.to);
          } catch (err) {
            log("warn", "r2 bandwidth fetch failed", { error: String(err) });
          }
          return json({
            configured: true,
            ...summarizeBillableUsage(rows, from, to, { skippedRows, truncated, totalRows }),
            r2,
          });
        } catch (err) {
          log("warn", "billable usage fetch failed", { error: String(err) });
          return json({ error: "billable usage unavailable" }, 502);
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/bottlenecks") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const repo = url.searchParams.get("repo") ?? "";
        const days = Number(url.searchParams.get("days") ?? "14");
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
        if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          return json({ error: "days must be an integer 1-90" }, 400);
        }
        return json({ repo, days, checks: await bottleneckStats(env.DB, repo, days) });
      }
      if (url.pathname === "/v1/quarantine") {
        if (request.method === "POST") {
          const ident = await requireScope(request, env, "run");
          if (!ident) return json({ error: "unauthorized" }, 401);
          if (ident.scope !== "admin") return json({ error: "admin token required" }, 403);
          const body = (await request.json().catch(() => ({}))) as { repo?: unknown; name?: unknown; action?: unknown };
          const repo = typeof body.repo === "string" ? body.repo : "";
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
          if (!name || name.length > 200) return json({ error: "name must be 1-200 characters" }, 400);
          if (body.action === "remove") {
            await releaseQuarantinedTest(env.DB, repo, name);
            await audit(env.DB, ident.actor, "quarantine.release", `${repo} ${name}`);
            return json({ ok: true, status: "reinstated" });
          }
          if (body.action === "add") {
            await quarantineTest(env.DB, repo, name, "manual");
            await audit(env.DB, ident.actor, "quarantine.add", `${repo} ${name}`);
            return json({ ok: true, status: "active" });
          }
          return json({ error: "action must be add or remove" }, 400);
        }
        if (request.method === "GET") {
          const ident = await requireScope(request, env, "read");
          if (!ident) return json({ error: "unauthorized" }, 401);
          const repo = url.searchParams.get("repo") ?? "";
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
          if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
          return json({ repo, tests: await listQuarantinedTests(env.DB, repo) });
        }
        return json({ error: "method not allowed" }, 405);
      }
      // Per-user notification attention prefs (quiet hours + new-failure
      // dedup), layered on the global notify mode. Dashboard sessions
      // manage their own email; admins (session or token) may target any
      // email via ?email= (GET) or body email (POST). Like the OAuth
      // grants lane, this is self-service by design: readers editing
      // their own prefs is the feature, not a privilege escalation.
      if (url.pathname === "/v1/notify/prefs") {
        if (request.method === "GET") {
          const target = await resolveNotifyPrefTarget(request, env, url.searchParams.get("email"));
          if (target instanceof Response) return target;
          const row = await getNotifyPref(env.DB, target.email);
          return json({
            email: target.email,
            quietStart: row?.quiet_start ?? DEFAULT_NOTIFY_PREFS.quietStart,
            quietEnd: row?.quiet_end ?? DEFAULT_NOTIFY_PREFS.quietEnd,
            newFailuresOnly: (row?.new_failures_only ?? 0) === 1,
          });
        }
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as {
            email?: unknown;
            quietStart?: unknown;
            quietEnd?: unknown;
            newFailuresOnly?: unknown;
          };
          const target = await resolveNotifyPrefTarget(
            request,
            env,
            typeof body.email === "string" ? body.email : null,
          );
          if (target instanceof Response) return target;
          const row = await getNotifyPref(env.DB, target.email);
          const base = row
            ? {
                quietStart: row.quiet_start,
                quietEnd: row.quiet_end,
                newFailuresOnly: row.new_failures_only === 1,
              }
            : DEFAULT_NOTIFY_PREFS;
          const parsed = parseNotifyPrefsInput(body, base);
          if ("error" in parsed) return json({ error: parsed.error }, 400);
          await setNotifyPref(env.DB, { email: target.email, ...parsed.prefs });
          await audit(env.DB, target.actor, "notify.prefs", target.email);
          log("info", "notify prefs saved", { email: target.email });
          return json({ email: target.email, ...parsed.prefs });
        }
        return json({ error: "method not allowed" }, 405);
      }
      // Kill switch state: paused repos with usage + per-identity
      // attribution, and the one-click resume.
      if (url.pathname === "/v1/admin/paused") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        if (request.method === "GET") {
          const paused = await getPausedRepos(env.DB);
          const budgets = parseStoredBudgets(await getSetting(env.DB, SETTING_KEYS.budgetMinutes));
          const repos = await Promise.all(
            Object.entries(paused).map(async ([repo, pausedAt]) => ({
              repo,
              pausedAt,
              cap: budgets[repo] ?? null,
              usedMinutes: await monthlyComputeMinutes(env.DB, repo, monthStartIso()),
              topActors: await topDispatchActors(env.DB, repo),
            })),
          );
          return json({ paused: repos });
        }
        if (request.method === "DELETE") {
          const repo = url.searchParams.get("repo") ?? "";
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
          const ident = await authIdentity(request, env);
          const resumed = await resumeRepo(env.DB, repo);
          if (resumed) await audit(env.DB, ident?.actor ?? "admin", "budget.resume", repo);
          return json({ ok: true, resumed });
        }
        return json({ error: "method not allowed" }, 405);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/mirrors") {
        if (!(await isAdminRequest(request, env))) return json({ error: "unauthorized" }, 401);
        const rows = await listMirrorRows(env.DB);
        return json({
          mirrors: rows.map((r) => ({ repo: r.repo, mirror: r.mirror, status: r.status, detail: r.detail, updatedAt: r.updated_at })),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/flaky") {
        const ident = await requireScope(request, env, "read");
        if (!ident) return json({ error: "unauthorized" }, 401);
        const repo = url.searchParams.get("repo") ?? "";
        if (!repo) return json({ error: "repo is required" }, 400);
        if (!repoAllowed(ident, repo)) return json({ error: "token is not scoped to that repo" }, 403);
        const days = Number(url.searchParams.get("days") ?? "30");
        if (!Number.isFinite(days) || days < 1 || days > 365) return json({ error: "days must be 1-365" }, 400);
        const floored = Math.floor(days);
        const sinceIso = new Date(Date.now() - floored * 86400 * 1000).toISOString();
        return json({
          stats: await flakyStats(env.DB, repo, floored),
          candidates: await suggestQuarantine(env.DB, repo, sinceIso, `${floored}d`),
        });
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
      // Runner pairing, admin half: mint a short single-use code the
      // dashboard shows once. The runner half is POST /v1/pair/exchange.
      if (request.method === "POST" && url.pathname === "/v1/admin/pair-codes") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        const { code, expiresAt } = await createPairingCode(env.DB, ident.actor);
        await audit(env.DB, ident.actor, "pair.create", "");
        return json({ code, expiresAt });
      }
      // Runner pairing, runner half: exchange a code for a runner token.
      // Public by design (the machine has no credentials yet), so it
      // throttles per IP exactly like the login routes.
      if (request.method === "POST" && url.pathname === "/v1/pair/exchange") {
        const body = (await request.json().catch(() => ({}))) as { code?: unknown; name?: unknown };
        const ipKey = await ipThrottleKey(request);
        const keys = ipKey ? [ipKey] : [];
        if (await authThrottleBlocked(env.DB, keys)) {
          return json(apiError("rate_limited", "too many attempts — try again later"), 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        if (typeof body.code !== "string" || !body.code) return await fail(json(apiError("pairing_required", "pairing code required"), 400));
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "paired runner";
        const exchanged = await exchangePairingCode(env.DB, body.code.trim().toUpperCase());
        if (!exchanged.ok) {
          log("info", "pairing exchange denied", { reason: exchanged.reason });
          return await fail(json(apiError("pairing_invalid", "pairing code invalid or expired"), 404));
        }
        const id = crypto.randomUUID();
        const value = newTokenValue();
        await createToken(env.DB, { id, name, tokenHash: await hashToken(value), scopes: "runner", repos: "" });
        await clearAuthFailures(env.DB, keys);
        await audit(env.DB, `pair:${id.slice(0, 8)}`, "pair.exchange", name);
        log("info", "runner paired", { name });
        return json({ token: value, name }, 201);
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
          // Public pre-login: only controls whether the login page
          // offers self-serve signup; the register route re-checks.
          openRegistration: await isOpenRegistration(env),
          // Public widget key (safe pre-login); null hides the widget.
          turnstileSiteKey: await getTurnstileSiteKey(env.DB, env),
          // Deployment hardening detail: admins only, not the pre-login page.
          ...(ident?.scope === "admin" ? { breakGlass: !!env.ADMIN_TOKEN } : {}),
        });
      }
      // Flare Cloud scaffold: public capability probe. Self-hosted
      // deploys answer hosted:false (everything below 501s there).
      if (request.method === "GET" && url.pathname === "/v1/cloud/status") {
        const hosted = hostedMode(env);
        const entitlements = hosted
          ? parseCloudEntitlements(await getSetting(env.DB, SETTING_KEYS.cloudEntitlements))
          : { maxConcurrentJobs: null };
        return json({
          hosted,
          metering: hosted && (await getSetting(env.DB, SETTING_KEYS.cloudMetering)) === "on",
          maxConcurrentJobs: entitlements.maxConcurrentJobs,
        });
      }
      // Prepaid top-up (Cloud ops only): idempotent on ref so a
      // retried billing webhook grants once. Hosted-only 501 in OSS.
      if (request.method === "POST" && url.pathname === "/v1/cloud/credits/grant") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        if (!hostedMode(env)) return json(apiError("hosted_only", "credit grants run on Flare Cloud only"), 501);
        let body: { amountCents?: unknown; memo?: unknown; ref?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
        const out = await grantCredits(
          env.DB,
          body.amountCents as number,
          typeof body.memo === "string" ? body.memo : "",
          typeof body.ref === "string" && body.ref ? body.ref : crypto.randomUUID(),
        );
        if (!out.ok) return json({ error: out.error }, out.conflict ? 409 : 400);
        await audit(env.DB, ident.actor, out.duplicate ? "cloud.grant_replay" : "cloud.grant", `${body.amountCents}c`);
        return json({ ok: true, duplicate: out.duplicate, balanceCents: await creditBalance(env.DB) });
      }
      // Ledger balance + recent rows for `cli credits`. Hosted-only.
      if (request.method === "GET" && url.pathname === "/v1/cloud/credits/balance") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        if (!hostedMode(env)) return json(apiError("hosted_only", "the credit ledger runs on Flare Cloud only"), 501);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        return json({ balanceCents: await creditBalance(env.DB), recent: await recentLedger(env.DB, limit) });
      }
      // Mint a single-use top-up link (admin, hosted-only). The code is
      // shown once — only its hash rests in D1.
      if (request.method === "POST" && url.pathname === "/v1/cloud/topup-links") {
        const ident = await authIdentity(request, env);
        if (!ident || ident.scope !== "admin") return json({ error: "unauthorized" }, 401);
        if (!hostedMode(env)) return json(apiError("hosted_only", "top-up links run on Flare Cloud only"), 501);
        const body = (await request.json().catch(() => ({}))) as { amountCents?: unknown; memo?: unknown; ttlHours?: unknown };
        const out = await createTopupLink(env.DB, {
          amountCents: body.amountCents as number,
          memo: typeof body.memo === "string" ? body.memo : "",
          ttlHours: body.ttlHours === undefined ? TOPUP_DEFAULT_TTL_HOURS : (body.ttlHours as number),
          createdBy: ident.actor,
          origin: url.origin,
        });
        if (!out.ok) return json({ error: out.error }, 400);
        await audit(env.DB, ident.actor, "cloud.topup_mint", `${out.link.amountCents}c`);
        return json(out.link);
      }
      // Approval-link preview: what a click would redeem, WITHOUT
      // consuming (unfurlers must never burn the code). Public +
      // IP-throttled like the pairing exchange, since the holder of
      // the link is the credential.
      if (request.method === "GET" && url.pathname === "/v1/cloud/topup-links/redeem") {
        if (!hostedMode(env)) return json(apiError("hosted_only", "top-up links run on Flare Cloud only"), 501);
        const ipKey = await ipThrottleKey(request);
        const keys = ipKey ? [ipKey] : [];
        if (await authThrottleBlocked(env.DB, keys)) {
          return json(apiError("rate_limited", "too many attempts — try again later"), 429);
        }
        const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
        const preview = await previewTopupLink(env.DB, code);
        if (!preview.ok) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json(apiError("topup_invalid", "top-up link invalid or expired"), 404);
        }
        return json({ amountCents: preview.amountCents, memo: preview.memo, expiresAt: preview.expiresAt });
      }
      // Approval-link redeem: single-use consume + credit grant.
      if (request.method === "POST" && url.pathname === "/v1/cloud/topup-links/redeem") {
        if (!hostedMode(env)) return json(apiError("hosted_only", "top-up links run on Flare Cloud only"), 501);
        const body = (await request.json().catch(() => ({}))) as { code?: unknown };
        const ipKey = await ipThrottleKey(request);
        const keys = ipKey ? [ipKey] : [];
        if (await authThrottleBlocked(env.DB, keys)) {
          return json(apiError("rate_limited", "too many attempts — try again later"), 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        if (typeof body.code !== "string" || !body.code) {
          return await fail(json(apiError("topup_invalid", "top-up code required"), 400));
        }
        const redeemed = await redeemTopupLink(env.DB, body.code.trim().toUpperCase());
        if (!redeemed.ok) {
          log("info", "top-up redeem denied", { reason: redeemed.reason });
          return await fail(json(apiError("topup_invalid", "top-up link invalid or expired"), 404));
        }
        await audit(env.DB, "topup-link", "cloud.topup_redeem", `${redeemed.amountCents}c`);
        return json({ ok: true, amountCents: redeemed.amountCents, balanceCents: await creditBalance(env.DB) });
      }
      // x402 spike: quote whole runner-months (public pricing).
      // payTo stays null until Cloud provisions settlement — the
      // scaffold quotes, it never takes money. See docs/X402-SPIKE.md.
      if (request.method === "POST" && url.pathname === "/v1/cloud/x402/quote") {
        if (!hostedMode(env)) return json(apiError("hosted_only", "x402 quotes run on Flare Cloud only"), 501);
        const body = (await request.json().catch(() => ({}))) as { runners?: unknown };
        const out = x402Quote(body.runners as number);
        if (!out.ok) return json({ error: out.error }, 400);
        return json(out.quote);
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
        const body = (await request.json().catch(() => ({}))) as { token?: unknown; email?: unknown; password?: unknown; turnstileToken?: unknown };
        const keys = await authThrottleKeys(request, typeof body.email === "string" ? normalizeEmail(body.email) : undefined);
        if (await authThrottleBlocked(env.DB, keys)) {
          return json(apiError("rate_limited", "too many attempts — try again later"), 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) return await fail(json(apiError("invalid_request", captchaErr), 400));
        const input = validateRegisterInput(body, await isOpenRegistration(env));
        if ("error" in input) return await fail(json(apiError("invalid_request", input.error), 400));
        let email: string;
        if (input.mode === "invite") {
          const invite = await consumeInvite(env.DB, input.token);
          if (!invite) return await fail(json(apiError("invite_invalid", "invite invalid or expired"), 404));
          email = invite.email;
        } else {
          email = input.email;
        }
        if (await getUser(env.DB, email)) {
          return await fail(json(apiError("email_taken", "that email already has an account"), 409));
        }
        await createUser(env.DB, { email, passwordHash: await hashPassword(input.password), isAdmin: false });
        await clearAuthFailures(env.DB, keys);
        const sessionId = await createLoginSession(env.DB, { kind: "email", login: email, isAdmin: false });
        await audit(env.DB, `email:${email}`, "session.register", "");
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionSetCookie(sessionId, url.protocol === "https:"),
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap") {
        if (await isClaimed(env)) return json(apiError("already_claimed", "already claimed"), 403);
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown; turnstileToken?: unknown };
        const keys = await authThrottleKeys(request, typeof body.email === "string" ? normalizeEmail(body.email) : undefined);
        if (await authThrottleBlocked(env.DB, keys)) {
          return json(apiError("rate_limited", "too many attempts — try again later"), 429);
        }
        const fail = async (res: Response): Promise<Response> => {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return res;
        };
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) return await fail(json(apiError("invalid_request", captchaErr), 400));
        const emailErr = validateEmail(body.email);
        if (emailErr) return await fail(json(apiError("invalid_request", emailErr), 400));
        const pwErr = validatePassword(body.password);
        if (pwErr) return await fail(json(apiError("invalid_request", pwErr), 400));
        const email = normalizeEmail(body.email as string);
        // Atomic gate: concurrent first requests can otherwise both pass
        // the isClaimed() read above and both create an admin.
        if (!(await claimAdminMarker(env.DB))) return json(apiError("already_claimed", "already claimed"), 403);
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
          return json(apiError("invalid_credentials", "invalid email or password"), 401);
        }
        const email = normalizeEmail(body.email as string);
        const keys = await authThrottleKeys(request, email);
        if (await authThrottleBlocked(env.DB, keys)) {
          log("warn", "login throttled", { email });
          return json(apiError("rate_limited", "too many attempts — try again later"), 429);
        }
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json(apiError("invalid_request", captchaErr), 400);
        }
        const user = await getUser(env.DB, email);
        const ok = await verifyPassword(body.password, user?.password_hash ?? dummyPasswordHash());
        if (!user || !ok) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json(apiError("invalid_credentials", "invalid email or password"), 401);
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
      if (request.method === "POST" && url.pathname === "/v1/admin/magic/request") {
        // Magic-link login: generic 200 always (no account-enumeration
        // oracle), delivered only when a sender + EMAIL binding exist and
        // the address can log in (registered, or open registration).
        const body = (await request.json().catch(() => ({}))) as { email?: unknown; turnstileToken?: unknown };
        const emailErr = validateEmail(body.email);
        const email = emailErr === null ? normalizeEmail(body.email as string) : "";
        // Magic keys are namespaced so link requests never spend (or
        // clear) the shared password-login IP window.
        const ipKey = await ipThrottleKey(request);
        const keys = [...(email ? [`magic:${email}`] : []), ...(ipKey ? [`magic-${ipKey}`] : [])];
        if (await authThrottleBlocked(env.DB, keys)) {
          return json({ error: "too many attempts — try again later" }, 429);
        }
        const captchaErr = await checkTurnstile(env.DB, env, body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined);
        if (captchaErr) return json({ error: captchaErr }, 400);
        if (emailErr !== null) return json({ error: emailErr }, 400);
        await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
        const user = await getUser(env.DB, email);
        const sender = resolveNotifySender(env.NOTIFY_FROM_EMAIL, await getSetting(env.DB, SETTING_KEYS.notifyFromEmail));
        const mailer = env.EMAIL;
        const eligible = !!user || (await isOpenRegistration(env));
        if (eligible && sender && mailer) {
          try {
            const token = await createMagicToken(env.DB, email);
            const link = new URL(`/dashboard?magic_token=${encodeURIComponent(token)}`, url).toString();
            await mailer.send({
              from: { name: "Flare Actions", email: sender },
              to: email,
              subject: "[flare] Log in to Flare Actions",
              text: `Log in to Flare Actions as ${email}.\n\n${link}\n\nThe link expires in 15 minutes and works once. If this was not you, ignore this email.`,
            });
            await audit(env.DB, "magic", "session.magic_sent", email);
            log("info", "magic link sent", { email });
          } catch (err) {
            log("warn", "magic link send failed", { email, error: String(err) });
          }
        } else {
          log("info", "magic link skipped (ineligible or email not configured)", {
            known: !!user,
            sender: !!sender,
            mail: !!mailer,
          });
        }
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/magic/consume") {
        // Legacy link shape. A GET never consumes: mail scanners prefetch
        // every link, so redemption needs the explicit POST below.
        const token = url.searchParams.get("token") ?? "";
        const dest = new URL("/dashboard", url);
        if (token) dest.searchParams.set("magic_token", token);
        return new Response(null, { status: 302, headers: { Location: dest.pathname + dest.search, "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/magic/consume") {
        // Redeem from the dashboard confirm screen. JSON + no CORS means a
        // cross-site page cannot submit this (login CSRF); Sec-Fetch-Site
        // is an extra guard where browsers send it.
        const site = request.headers.get("sec-fetch-site");
        if (site !== null && site !== "same-origin" && site !== "none") return json({ error: "cross-site request refused" }, 403);
        const body = (await request.json().catch(() => ({}))) as { token?: unknown };
        const token = typeof body.token === "string" ? body.token : "";
        const ipKey = await ipThrottleKey(request);
        const keys = ipKey ? [`magic-${ipKey}`] : [];
        if (await authThrottleBlocked(env.DB, keys)) return json({ error: "too many attempts — try again later" }, 429);
        const email = await consumeMagicToken(env.DB, token);
        if (!email) {
          await Promise.all(keys.map((k) => recordAuthFailure(env.DB, k)));
          return json({ error: "login link invalid or expired" }, 404);
        }
        let user = await getUser(env.DB, email);
        if (!user) {
          if (!(await isOpenRegistration(env))) return json({ error: "login link invalid or expired" }, 404);
          await createUser(env.DB, { email, passwordHash: await hashPassword(crypto.randomUUID()), isAdmin: false });
          user = await getUser(env.DB, email);
          if (!user) return json({ error: "login link invalid or expired" }, 404);
        }
        const sessionId = await createLoginSession(env.DB, { kind: "email", login: email, isAdmin: user.is_admin === 1 });
        await audit(env.DB, `email:${email}`, "session.login", "");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
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
        const turnstileSource = env.TURNSTILE_SITE_KEY
          ? "env"
          : (await getSetting(env.DB, SETTING_KEYS.turnstileSiteKey)) !== null
            ? "d1"
            : "none";
        const fairShareParsed = parseFairSharePerRepo(await getSetting(env.DB, SETTING_KEYS.fairSharePerRepo));
        const agentShareParsed = parseFairSharePerAgent(await getSetting(env.DB, SETTING_KEYS.fairSharePerAgent));
        const gatewaySource = env.AI_GATEWAY_ID ? "env" : ((await getSetting(env.DB, SETTING_KEYS.aiGatewayId)) ? "d1" : "none");
        const writeConfirmParsed = parseMcpWriteConfirm(await getSetting(env.DB, SETTING_KEYS.mcpWriteConfirm));
        const webSearchParsed = parseTriageWebSearch(await getSetting(env.DB, SETTING_KEYS.triageWebSearch));
        const healParsed = parseHealOnFailure(await getSetting(env.DB, SETTING_KEYS.healOnFailure));
        const openRegParsed = parseOpenRegistration(await getSetting(env.DB, SETTING_KEYS.openRegistration));
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
          fairSharePerAgent: "cap" in agentShareParsed ? agentShareParsed.cap : 0,
          budgetMinutes: (await getSetting(env.DB, SETTING_KEYS.budgetMinutes)) ?? "",
          budgetMode: (await getSetting(env.DB, SETTING_KEYS.budgetMode)) ?? "warn",
          budgetKillMultiplier: (await getSetting(env.DB, SETTING_KEYS.budgetKillMultiplier)) ?? "0",
          supersedeBranchRuns: (await getSetting(env.DB, SETTING_KEYS.supersedeBranchRuns)) ?? "off",
          githubRunnerMode: (await getSetting(env.DB, SETTING_KEYS.githubRunnerMode)) ?? "off",
          githubRunnerLabels: (await getSetting(env.DB, SETTING_KEYS.githubRunnerLabels)) ?? "flare",
          githubRunnerGroup: (await getSetting(env.DB, SETTING_KEYS.githubRunnerGroup)) ?? "",
          aiGatewayId: env.AI_GATEWAY_ID ?? (await getSetting(env.DB, SETTING_KEYS.aiGatewayId)) ?? "",
          aiGatewaySource: gatewaySource,
          mcpWriteConfirm: "on" in writeConfirmParsed ? writeConfirmParsed.on : false,
          triageWebSearch: env.TRIAGE_WEB_SEARCH === "1" ? true : "on" in webSearchParsed ? webSearchParsed.on : false,
          healOnFailure: "on" in healParsed ? healParsed.on : false,
          openRegistration: "on" in openRegParsed ? openRegParsed.on : false,
          billingTokenSet: !!env.BILLING_API_TOKEN || !!(await getSetting(env.DB, SETTING_KEYS.billingApiToken)),
          cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID ?? (await getSetting(env.DB, SETTING_KEYS.cloudflareAccountId)) ?? "",
          triageModel: env.TRIAGE_MODEL ?? (await getSetting(env.DB, SETTING_KEYS.triageModel)) ?? TRIAGE_MODEL,
          triageModelSource: env.TRIAGE_MODEL ? "env" : ((await getSetting(env.DB, SETTING_KEYS.triageModel)) ? "d1" : "default"),
          runnerVersion: (await getSetting(env.DB, SETTING_KEYS.runnerVersion)) ?? "",
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
      if (
        (request.method === "GET" || request.method === "POST" || request.method === "DELETE") &&
        url.pathname === "/v1/admin/egress-allowlist"
      ) {
        return await handleEgressAllowlist(request, env);
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
            profile: s.profile,
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
        await createSchedule(env.DB, { id, repo: valid.repo, ref: valid.ref, cron: valid.cron, profile: valid.profile });
        await audit(env.DB, ident.actor, "schedule.create", `${id} ${valid.repo}@${valid.ref} ${valid.cron}${valid.profile ? ` ${valid.profile}` : ""}`);
        log("info", "schedule created", { id, repo: valid.repo, ref: valid.ref, cron: valid.cron, profile: valid.profile ?? null });
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
      // Runner mode (`runs-on: flare`): requeue claims that never went
      // `running`, deleting each orphaned JIT runner first so a dead
      // machine's registration cannot double-run the job later.
      try {
        const { swept } = await sweepStaleGhRunnerJobs(env.DB, 15, async (stale) => {
          if (!stale.runner_id) return;
          const token = await mintInstallationTokenFor(env, stale.installation_id);
          if (!token) return;
          await deleteRunner(token, stale.repo, stale.runner_id);
        });
        if (swept > 0) log("info", "stale runner-mode claims swept", { swept });
      } catch (err) {
        log("warn", "runner-mode sweep failed", { error: String(err) });
      }
      const schedules = await listSchedules(env.DB);
      for (const s of schedules) {
        if (s.enabled !== 1 || !cronMatches(s.cron, now)) continue;
        if (s.last_run_at && Date.now() - Date.parse(s.last_run_at) < 60000) continue;
        if (await isRepoPaused(env.DB, s.repo)) {
          await touchScheduleRun(env.DB, s.id);
          log("warn", "scheduled run skipped: repo paused", { scheduleId: s.id, repo: s.repo });
          continue;
        }
        const scheduleBudget = await budgetVerdict(env, s.repo);
        await maybeAutoPause(env, ctx, s.repo, "system", scheduleBudget);
        if (scheduleBudget?.mode === "block") {
          await touchScheduleRun(env.DB, s.id);
          await audit(env.DB, "system", "budget.blocked", `${s.repo} ${scheduleBudget.usedMinutes}/${scheduleBudget.cap}`);
          log("warn", "scheduled run skipped: budget", { scheduleId: s.id, repo: s.repo });
          continue;
        }
        const scheduleCloud = await cloudVerdict(env);
        if (scheduleCloud) {
          await touchScheduleRun(env.DB, s.id);
          await audit(env.DB, "system", "cloud.plan_limited", `${s.repo} ${scheduleCloud.used}/${scheduleCloud.cap}`);
          log("warn", "scheduled run skipped: plan saturated", { scheduleId: s.id, repo: s.repo });
          continue;
        }
        try {
          const out = await dispatchRun(
            env,
            { repo: s.repo, sha: s.ref, ref: s.ref, event: "schedule", cron: s.cron, scheduleProfile: s.profile ?? undefined },
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
      // Hourly fleet check: usage anomalies + flaky auto-quarantine. One
      // gate row keeps it to at most once an hour regardless of ticks.
      try {
        const lastCheck = await getSetting(env.DB, SETTING_KEYS.fleetCheckedAt);
        if (!lastCheck || Date.now() - Date.parse(lastCheck) > 3_600_000) {
          await setSetting(env.DB, SETTING_KEYS.fleetCheckedAt, new Date().toISOString());
          const today = new Date().toISOString().slice(0, 10);
          const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
          const anomalies = summarizeUsageAnomalies(await repoUsageByDay(env.DB, 8), { today });
          for (const anomaly of anomalies.slice(0, 3)) {
            const top = await topBranchForRepo(env.DB, anomaly.repo, `${today}T00:00:00.000Z`);
            const topAgent = await topAgentForRepo(env.DB, anomaly.repo, `${today}T00:00:00.000Z`);
            const factor = anomaly.medianMinutes > 0 ? (anomaly.todayMinutes / anomaly.medianMinutes).toFixed(1) : "many";
            const text = [
              `CI usage anomaly: ${anomaly.repo}`,
              `Today: ${anomaly.todayRuns} runs, ${anomaly.todayMinutes} compute-min (trailing median ${anomaly.medianRuns} runs, ${anomaly.medianMinutes} min — ${factor}x).`,
              top ? `Busiest branch today: ${top.branch} (${top.runs} runs).` : "",
              topAgent ? `Top agent today: ${topAgent.agent} (${topAgent.runs} runs).` : "",
              "If this is an agent loop, cap it: dashboard → Settings → Budgets (warn/block).",
            ]
              .filter(Boolean)
              .join("\n");
            await notifyMessage(env.DB, env, {
              subject: `Flare: CI usage anomaly in ${anomaly.repo}`,
              text,
              html: text
                .split("\n")
                .map((line) => `<p>${line.replace(/[<>&]/g, "")}</p>`)
                .join(""),
              auditTag: "anomaly",
            });
            await audit(env.DB, "system", "anomaly.usage", `${anomaly.repo} ${anomaly.todayMinutes}/${anomaly.medianMinutes}min${topAgent ? ` agent:${topAgent.agent}` : ""}`);
          }
          // Flaky auto-quarantine + reinstate, bounded per tick.
          const activeRepos = await env.DB.prepare("SELECT DISTINCT repo FROM runs WHERE created_at >= ? LIMIT 10")
            .bind(weekAgo)
            .all<{ repo: string }>();
          for (const row of activeRepos.results) {
            const active = await activeQuarantineNames(env.DB, row.repo);
            const candidates = flakyCandidates(await testTally(env.DB, row.repo, weekAgo), active);
            for (const candidate of candidates) {
              await quarantineTest(env.DB, row.repo, candidate.name, candidate.reason);
              await audit(env.DB, "system", "quarantine.auto", `${row.repo} ${candidate.name}`);
            }
            let reinstated = 0;
            for (const test of (await listQuarantinedTests(env.DB, row.repo, "active")).slice(0, 50)) {
              if (shouldReinstate(await recentTestStatuses(env.DB, row.repo, test.name, 5))) {
                await releaseQuarantinedTest(env.DB, row.repo, test.name);
                reinstated += 1;
              }
            }
            if (candidates.length > 0 || reinstated > 0) {
              log("info", "quarantine updated", { repo: row.repo, added: candidates.length, reinstated });
            }
          }
        }
      } catch (err) {
        log("warn", "fleet check failed", { error: String(err) });
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
      const mq = await runMergeQueueTick(env, ctx);
      if (mq.started > 0 || mq.landed > 0 || mq.failed > 0 || mq.requeued > 0) {
        log("info", "merge queue tick finished", { ...mq });
      }
    } catch (err) {
      log("error", "scheduled handler failed", { error: String(err) });
    }
  },
};
