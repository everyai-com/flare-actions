import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NeedsContext } from "./outputs.ts";

export { executeSteps, parseDefinition } from "./execute.ts";
export type { ExecStep, ExecuteOptions, StepResult, StepsOutcome } from "./execute.ts";
export { checkoutRepo, gitAvailable } from "./checkout.ts";
export type { CheckoutOptions } from "./checkout.ts";
export { parseJobSpec, matrixEnv } from "./spec.ts";
export type { JobArtifactsSpec, JobCacheSpec, JobServiceSpec, JobSpec, JobTestSelectionSpec } from "./spec.ts";
export {
  evaluateCondition,
  initialJobStatus,
  jobConditionSatisfied,
  normalizeCondition,
  parseCondition,
} from "./conditions.ts";
export type { ConditionContext, ConditionNode, ConditionOperand, ConditionState } from "./conditions.ts";
export {
  buildNeedsEnv,
  capNeedsContext,
  formatOutputsLine,
  isValidOutputName,
  MAX_JOB_OUTPUTS,
  MAX_NEEDS_BYTES,
  MAX_OUTPUT_VALUE_BYTES,
  MAX_STEP_OUTPUTS,
  parseOutputRef,
  parseStepOutputs,
  resolveJobOutputs,
} from "./outputs.ts";
export type { NeedsContext, ParsedStepOutputs, ResolvedJobOutputs } from "./outputs.ts";
export {
  buildImporters,
  canParsePath,
  DEFAULT_TEST_PATTERNS,
  extractTypeScriptImports,
  failureTouchesFile,
  groupGrepLines,
  IMPORT_PARSERS,
  isTestFile,
  matchGlob,
  resolveImport,
  SELECTED_TESTS_ENV,
  SELECTION_MODE_ENV,
  selectTests,
} from "./testselect.ts";
export type { ImportParser, RecentFailure, SelectTestsInput, SkippedTest, TestSelection } from "./testselect.ts";
export { createTar, extractTar, assertSafeTar, restoreCache, safeCachePaths, saveCache } from "./cache.ts";
export type { CacheClient } from "./cache.ts";
export { dockerArgsForService, dockerArgsForStep, dockerAvailable, dockerServicesCtl } from "./services.ts";
export type { ServiceHandle, ServicesCtl } from "./services.ts";
export { collectArtifactFiles, runJob, sanitizeArtifactName } from "./job.ts";
export type { JobClient, RunJobOptions, RunJobResult } from "./job.ts";
export {
  buildFlareEnv,
  cacheObjectKey,
  checkJobParity,
  cloudImageForLane,
  describeStepImage,
  envParityRows,
  isMutableImageTag,
  isValidCacheKey,
  normalizeImageRef,
  resolveStepImage,
  specParityView,
  CACHE_KEY_RE,
  FLARE_ENV_KEYS,
} from "./parity.ts";
export type {
  EnvParityRow,
  FlareEnvInput,
  ParityCacheSummary,
  ParityContext,
  ParityFinding,
  ParityImageSummary,
  ParityResult,
  ParitySpec,
  StepImage,
} from "./parity.ts";
export { hasSecretPlaceholders, interpolateSecrets, maskSecrets } from "./secrets.ts";
export { convertActionsWorkflow, isImportSuccess, mapRunsOn, sanitizeCacheKey } from "./importActions.ts";
export type { ImportFailure, ImportResult, ImportSuccess } from "./importActions.ts";
export { getTemplate, listTemplateMeta, TEMPLATES, templateIds } from "./templates.ts";
export type { PipelineTemplate, TemplateMeta } from "./templates.ts";

// Loads repo-root `.env` (written by `npm run setup`) into process.env.
// Explicit environment variables always win. No dependencies, no-op if absent.
export function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (key && !(key in process.env)) process.env[key] = value;
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export interface FlareJob {
  id: string;
  run_id: string;
  status: string;
  repo: string;
  sha: string;
  name: string;
  definition: string;
  source?: string | null;
  // Branch the run was triggered on ("" for tag/source runs); exposed to
  // steps as FLARE_REF and used by Actions-compatible expressions.
  branch?: string | null;
  // Newline-joined changed files ("" = unknown); exposed as
  // FLARE_CHANGED_FILES for changed-file test selection recipes.
  changed_files?: string | null;
}

export interface FlareStepResult {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface FlareJobDetail {
  id: string;
  status: string;
  log: string;
  name: string;
  result: string;
  triage: string;
}

export interface FlareArtifact {
  jobId: string;
  jobName: string;
  name: string;
  size: number;
  uploaded: string;
}

export interface FlareFlakyStat {
  job: string;
  runs: number;
  failures: number;
  rate: number;
}

export interface FlareQuarantineCandidate {
  name: string;
  reason: string;
  sparkline: string;
}

// "What's blocking the merge": per-check run-time percentiles (ms) and
// median queue wait for a repo over the trailing window.
export interface FlareBottleneck {
  check: string;
  jobs: number;
  p50Ms: number;
  p95Ms: number;
  queueP50Ms: number;
  failures: number;
}

// Flaky-test quarantine row: active tests don't block runs (failures that
// are entirely quarantined land as success with a log note).
export interface FlareQuarantinedTest {
  repo: string;
  name: string;
  status: string;
  reason: string;
  created_at: string;
  updated_at: string;
}

export interface FlareTestTotals {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

export interface FlareTestJob extends FlareTestTotals {
  jobId: string;
  jobName: string;
  durationMs: number;
  truncated: boolean;
}

export interface FlareFailingTest {
  jobId: string;
  jobName: string;
  suite: string;
  name: string;
  classname: string;
  status: string;
  message: string;
}

export interface DryRunPlannedJob {
  name: string;
  base: string;
  needs: string[];
  group: string | null;
  labels: string[];
  status: "queued" | "blocked" | "skipped";
  blockedReason: "needs" | "group" | "if" | null;
  wouldCancelInProgress: boolean;
  priorMs: number;
}

export interface DryRunPlan {
  repo: string;
  sha: string;
  branch: string;
  pipelineSource: string;
  profile: string | null;
  jobs: DryRunPlannedJob[];
  queued: number;
  blocked: number;
  skipped: number;
  totalPriorMs: number;
  paused: boolean;
  pausedAt: string | null;
  budget: { mode: string; usedMinutes: number; cap: number; wouldBlock: boolean } | null;
}

export interface PausedRepo {
  repo: string;
  pausedAt: string;
  cap: number | null;
  usedMinutes: number;
  topActors: { actor: string; dispatches: number }[];
}

export interface FlareRunTests {
  runId: string;
  totals: FlareTestTotals;
  jobs: FlareTestJob[];
  failing: FlareFailingTest[];
}

export interface FlareEgressRow {
  jobId: string;
  host: string;
  reqBytes: number;
  respBytes: number;
}

export interface FlareRunEgress {
  runId: string;
  totals: { reqBytes: number; respBytes: number };
  jobs: FlareEgressRow[];
}

export interface FlareCacheEntry {
  key: string;
  size: number;
  uploaded: string;
}

// Shared-warm-cache stats: trailing-window hit rate overall plus per
// cache scope (the "one cache, ten agents" proof).
export interface FlareCacheScopeStat {
  scope: string;
  hits: number;
  misses: number;
  hitRate: number;
}

export interface FlareCacheStats {
  days: number;
  hits: number;
  misses: number;
  hitRate: number;
  scopes: FlareCacheScopeStat[];
}

export interface FlareQueuedJob {
  id: string;
  runId: string;
  name: string;
  repo: string;
  agent: string;
  priority: number;
  priorMs: number;
  labels: string;
  createdAt: string;
}

export interface FlareQueue {
  fairSharePerRepo: number;
  fairSharePerAgent: number;
  jobs: FlareQueuedJob[];
}

export interface FlareUsage {
  days: number;
  runs: number;
  runsByStatus: Record<string, number>;
  jobs: number;
  computeMinutes: number;
  actionsListUsd: number;
  topRepos: { repo: string; jobs: number; computeMinutes: number }[];
  githubRunnerJobs?: number;
  githubRunnerMinutes?: number;
  githubRunnerListUsd?: number;
}

// Runner mode (the flare lane): one ephemeral JIT-backed GitHub job,
// as served by GET /v1/github/jobs and POST /v1/github/jobs/next.
export interface GithubRunnerJob {
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
}

export interface GithubRunnerClaim {
  job: GithubRunnerJob;
  jitConfig: string;
  runnerName: string;
}

export interface FlareBillableUsage {
  configured: boolean;
  currency?: string;
  from?: string;
  to?: string;
  totalCost?: number;
  families?: { family: string; cost: number; rows: number }[];
  skippedRows?: number;
  truncated?: boolean;
  totalRows?: number;
  r2?: {
    from: string;
    to: string;
    ingressBytes: number;
    egressBytes: number;
    buckets: { bucket: string; ingressBytes: number; egressBytes: number }[];
  } | null;
}

export interface FlareLogHit {
  job_id: string;
  run_id: string;
  repo: string;
  branch: string;
  level: string;
  line: string;
  created_at: string;
}

export interface FlareDigestStep {
  command: string;
  exitCode: number;
  durationMs: number;
  outputTail: string;
}

export interface FlareDigestSelection {
  mode: string;
  reason: string;
  selected: number;
  skipped: number;
}

export interface FlareDigestJob {
  id: string;
  name: string;
  status: string;
  durationMs: number | null;
  stepCount: number;
  failing?: FlareDigestStep;
  triage?: string;
  selection?: FlareDigestSelection;
  peakRssBytes?: number;
  sizeHint?: string;
}

export interface FlareRunDigest {
  runId: string;
  repo: string;
  sha: string;
  branch: string;
  event: string;
  status: string;
  durationMs: number | null;
  totalJobs: number;
  failedJobs: number;
  jobs: FlareDigestJob[];
  testSelection?: { jobs: number; selected: number; skipped: number };
  attestation?: { reused: boolean; receiptId: string; verdict: string };
}

// Content-addressed verdict receipt: this exact tree + suite +
// environment already ran, so dispatch short-circuited to the
// recorded verdict. `verified` re-derives the state hash from the
// recorded run's live rows (null when the run was pruned).
export interface FlareAttestation {
  id: string;
  repo: string;
  sha: string;
  profile: string;
  hash: string;
  verdict: string;
  runId: string;
  jobCount: number;
  jobs: { name: string; status: string }[];
  createdAt: string;
  verified: boolean | null;
  verifyReason: string;
  runStatus: string | null;
}

// Agent merge queue: one serialized verify-then-land lane per repo,
// plus the cross-PR collision radar (shared files between live entries).
export interface FlareMergeEntry {
  id: string;
  repo: string;
  pr: number;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  agent: string;
  status: string;
  runId: string | null;
  files: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlareMergeCollision {
  entries: [string, string];
  prs: [number, number];
  paths: string[];
}

export interface FlareMergeQueue {
  repo: string;
  entries: FlareMergeEntry[];
  collisions: FlareMergeCollision[];
}

// Smart test selection claim decision: the server owns the full-suite
// safety net and the failure history; the executor walks its checkout.
export interface FlareClaimSelection {
  mode: string;
  reason: string;
  recentFailures: { suite: string; name: string; classname: string }[];
}

// Per-job skip report: what ran, what was skipped and why.
export interface FlareSelectionJob {
  jobId: string;
  jobName: string;
  mode: string;
  reason: string;
  selectedCount: number;
  skippedCount: number;
  selected: string[];
  skipped: { file: string; reason: string }[];
}

export interface FlareRunSelection {
  runId: string;
  jobs: FlareSelectionJob[];
}

export interface FlareSelectionReport {
  mode: "full" | "select";
  reason: string;
  selected: string[];
  skipped: { file: string; reason: string }[];
}

export interface FlareRun {
  id: string;
  repo: string;
  sha: string;
  event: string;
  status: string;
  agent: string;
  created_at: string;
  updated_at: string;
}

export interface FlareApiErrorBody {
  error?: unknown;
  code?: unknown;
  hint?: unknown;
}

// Typed API failure: the server's stable `code` + `hint` ride on the
// Error so CLIs and agents can switch on the code and print the next
// step. The message keeps the legacy `<op> failed: <status>` prefix.
export class FlareApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly hint: string | null;

  constructor(op: string, status: number, body: FlareApiErrorBody) {
    const serverError = typeof body.error === "string" && body.error ? body.error : null;
    super(serverError ? `${op} failed: ${status} — ${serverError}` : `${op} failed: ${status}`);
    this.name = "FlareApiError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : null;
    this.hint = typeof body.hint === "string" ? body.hint : null;
  }
}

// Tolerant claim-decision reader: unknown shapes read as null (no
// selection) so old runners keep working against newer servers.
function parseClaimSelection(raw: unknown): FlareClaimSelection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.mode !== "string" || typeof rec.reason !== "string") return null;
  if (rec.mode !== "full" && rec.mode !== "select") return null;
  const failures: FlareClaimSelection["recentFailures"] = [];
  if (Array.isArray(rec.recentFailures)) {
    for (const f of rec.recentFailures.slice(0, 200)) {
      if (typeof f !== "object" || f === null || Array.isArray(f)) continue;
      const row = f as Record<string, unknown>;
      failures.push({
        suite: typeof row.suite === "string" ? row.suite : "",
        name: typeof row.name === "string" ? row.name : "",
        classname: typeof row.classname === "string" ? row.classname : "",
      });
    }
  }
  return { mode: rec.mode, reason: rec.reason, recentFailures: failures };
}

// Tolerant needs-context reader: unknown shapes read as empty (no
// needs) so old runners keep working against newer servers.
function parseClaimNeeds(raw: unknown): NeedsContext {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: NeedsContext = {};
  for (const [base, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.result !== "string") continue;
    const outputs: Record<string, string> = {};
    if (rec.outputs && typeof rec.outputs === "object" && !Array.isArray(rec.outputs)) {
      for (const [k, v] of Object.entries(rec.outputs as Record<string, unknown>)) {
        if (typeof v === "string") outputs[k] = v;
      }
    }
    out[base] = { result: rec.result, outputs };
  }
  return out;
}

export class FlareClient {
  private baseUrl: string;
  private token: string;
  private timeoutMs: number;

  constructor(baseUrl: string, token: string, timeoutMs = 30000) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  // Throw a typed error for a non-2xx response, preserving the legacy
  // message prefix. Non-JSON bodies degrade to the bare status.
  private async throwApiError(op: string, res: Response): Promise<never> {
    const body = ((await res.json().catch(() => ({}))) ?? {}) as FlareApiErrorBody;
    throw new FlareApiError(op, res.status, body);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  // Every call is bounded: a runner that polls forever must never hang
  // forever on one stalled connection. Blob transfers get their own,
  // longer budget.
  private async call(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
  }

  async nextJob(labels: string[] = []): Promise<FlareJob | null> {
    return (await this.nextClaim(labels)).job;
  }

  // Full claim: the job plus its repo secrets (decrypted server-side for
  // this authenticated claim only), a flag when stored secrets could
  // not be decrypted, the smart test selection decision (null when
  // the job didn't opt in), and the settled needs context (results +
  // outputs for the declared bases).
  async nextClaim(labels: string[] = []): Promise<{
    job: FlareJob | null;
    secrets: Record<string, string>;
    secretsError: boolean;
    selection: FlareClaimSelection | null;
    needs: NeedsContext;
    needsTruncated: boolean;
    needsWarnings: string[];
  }> {
    const qs = labels.length > 0 ? `?labels=${encodeURIComponent(labels.join(","))}` : "";
    const res = await this.call(`/v1/jobs/next${qs}`);
    if (!res.ok) await this.throwApiError("nextJob", res);
    const data = (await res.json()) as {
      job: FlareJob | null;
      secrets?: Record<string, string>;
      secretsError?: boolean;
      selection?: unknown;
      needs?: unknown;
      needsTruncated?: unknown;
      needsWarnings?: unknown;
    };
    const secrets: Record<string, string> = {};
    if (data.secrets && typeof data.secrets === "object") {
      for (const [k, v] of Object.entries(data.secrets)) {
        if (typeof v === "string") secrets[k] = v;
      }
    }
    return {
      job: data.job,
      secrets,
      secretsError: data.secretsError === true,
      selection: parseClaimSelection(data.selection),
      needs: parseClaimNeeds(data.needs),
      needsTruncated: data.needsTruncated === true,
      needsWarnings: Array.isArray(data.needsWarnings) ? data.needsWarnings.filter((w): w is string => typeof w === "string") : [],
    };
  }

  private static encodeKey(key: string): string {
    return key
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
  }

  async getCache(key: string): Promise<Uint8Array | null> {
    const res = await this.call(`/v1/cache/${FlareClient.encodeKey(key)}`, undefined, 300000);
    if (res.status === 404) return null;
    if (!res.ok) await this.throwApiError("getCache", res);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getCacheOrPrefix(key: string, restoreKeys: string[]): Promise<{ data: Uint8Array; key: string } | null> {
    const query = restoreKeys.map((p) => `restore_key=${encodeURIComponent(p)}`).join("&");
    const res = await this.call(`/v1/cache/${FlareClient.encodeKey(key)}${query ? `?${query}` : ""}`, undefined, 300000);
    if (res.status === 404) return null;
    if (!res.ok) await this.throwApiError("getCacheOrPrefix", res);
    // Old servers predate the header and only serve exact hits, so a
    // missing header means the requested key — skew-safe by design.
    const matched = res.headers.get("X-Flare-Cache-Key") || key;
    return { data: new Uint8Array(await res.arrayBuffer()), key: matched };
  }

  async putCache(key: string, data: Uint8Array): Promise<void> {
    const res = await this.call(`/v1/cache/${FlareClient.encodeKey(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as unknown as BodyInit,
    }, 300000);
    if (!res.ok) await this.throwApiError("putCache", res);
  }

  async uploadArtifact(jobId: string, name: string, data: Uint8Array): Promise<void> {
    const res = await this.call(`/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as unknown as BodyInit,
    }, 300000);
    if (!res.ok) await this.throwApiError("uploadArtifact", res);
  }

  async uploadTestReport(
    jobId: string,
    xml: string,
  ): Promise<{ total: number; passed: number; failed: number; errors: number; skipped: number; truncated: boolean }> {
    const res = await this.call(`/v1/jobs/${jobId}/tests`, {
      method: "PUT",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });
    if (!res.ok) await this.throwApiError("uploadTestReport", res);
    return (await res.json()) as {
      total: number;
      passed: number;
      failed: number;
      errors: number;
      skipped: number;
      truncated: boolean;
    };
  }

  async getRunTests(runId: string): Promise<FlareRunTests> {
    const res = await this.call(`/v1/runs/${runId}/tests`);
    if (!res.ok) await this.throwApiError("getRunTests", res);
    return (await res.json()) as FlareRunTests;
  }

  async getRunEgress(runId: string): Promise<FlareRunEgress> {
    const res = await this.call(`/v1/runs/${runId}/egress`);
    if (!res.ok) await this.throwApiError("getRunEgress", res);
    return (await res.json()) as FlareRunEgress;
  }

  async listCache(prefix = "", limit = 100): Promise<FlareCacheEntry[]> {
    const res = await this.call(`/v1/admin/cache?prefix=${encodeURIComponent(prefix)}&limit=${limit}`);
    if (!res.ok) await this.throwApiError("listCache", res);
    const data = (await res.json()) as { entries: FlareCacheEntry[] };
    return data.entries;
  }

  async purgeCache(prefix = ""): Promise<{ deleted: number; truncated: boolean }> {
    const res = await this.call(`/v1/admin/cache?prefix=${encodeURIComponent(prefix)}`, { method: "DELETE" });
    if (!res.ok) await this.throwApiError("purgeCache", res);
    return (await res.json()) as { deleted: number; truncated: boolean };
  }

  async getCacheStats(): Promise<FlareCacheStats> {
    const res = await this.call("/v1/cache/stats");
    if (!res.ok) await this.throwApiError("getCacheStats", res);
    return (await res.json()) as FlareCacheStats;
  }

  async listQueue(limit = 200): Promise<FlareQueue> {
    const res = await this.call(`/v1/admin/queue?limit=${limit}`);
    if (!res.ok) await this.throwApiError("listQueue", res);
    return (await res.json()) as FlareQueue;
  }

  async searchLogs(query: string, limit = 50): Promise<FlareLogHit[]> {
    const res = await this.call(`/v1/search/logs?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) await this.throwApiError("searchLogs", res);
    const data = (await res.json()) as { hits: FlareLogHit[] };
    return data.hits;
  }

  async getBillableUsage(days = 30): Promise<FlareBillableUsage | null> {
    const res = await this.call(`/v1/usage/billable?days=${days}`);
    // Non-admin tokens (401) and upstream outages (502) degrade to
    // compute-only output; only the shape below throws.
    if (res.status === 401 || res.status === 502) return null;
    if (!res.ok) await this.throwApiError("getBillableUsage", res);
    return (await res.json()) as FlareBillableUsage;
  }

  async getUsage(days = 30, repo?: string): Promise<FlareUsage> {
    const qs = `days=${days}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
    const res = await this.call(`/v1/usage?${qs}`);
    if (!res.ok) await this.throwApiError("getUsage", res);
    return (await res.json()) as FlareUsage;
  }

  async listArtifacts(runId: string): Promise<FlareArtifact[]> {
    const res = await this.call(`/v1/runs/${runId}/artifacts`);
    if (!res.ok) await this.throwApiError("listArtifacts", res);
    const data = (await res.json()) as { artifacts: FlareArtifact[] };
    return data.artifacts;
  }

  async dispatch(
    repo: string,
    sha: string,
    opts?: { ref?: string; pipeline?: string; priority?: number; source?: string; agent?: string; profile?: string },
  ): Promise<{ runId: string; jobIds: string[] }> {
    const res = await this.call("/v1/runs/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, sha, ...opts }),
    });
    if (!res.ok) await this.throwApiError("dispatch", res);
    return (await res.json()) as { runId: string; jobIds: string[] };
  }

  // Kill switch state: paused repos + the one-click resume.
  async listPaused(): Promise<PausedRepo[]> {
    const res = await this.call("/v1/admin/paused");
    if (!res.ok) await this.throwApiError("listPaused", res);
    return ((await res.json()) as { paused: PausedRepo[] }).paused;
  }

  async resumeRepo(repo: string): Promise<boolean> {
    const res = await this.call(`/v1/admin/paused?repo=${encodeURIComponent(repo)}`, { method: "DELETE" });
    if (!res.ok) await this.throwApiError("resumeRepo", res);
    return ((await res.json()) as { resumed?: unknown }).resumed === true;
  }

  // Dry-run dispatch: resolved pipeline plan with zero writes.
  async dryRunDispatch(
    repo: string,
    sha: string,
    opts?: { ref?: string; pipeline?: string; priority?: number; source?: string; profile?: string },
  ): Promise<DryRunPlan> {
    const res = await this.call("/v1/runs/dispatch/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, sha, ...opts }),
    });
    if (!res.ok) await this.throwApiError("dryRunDispatch", res);
    return (await res.json()) as DryRunPlan;
  }

  // Source dispatch: upload a gzipped tarball of a working tree, then
  // dispatch with `source: id` and an inline pipeline.
  async putSource(data: Uint8Array): Promise<string> {
    const res = await this.call(
      "/v1/source",
      {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: data as unknown as BodyInit,
      },
      300000,
    );
    if (!res.ok) await this.throwApiError("putSource", res);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async getSource(id: string): Promise<Uint8Array> {
    const res = await this.call(`/v1/source/${encodeURIComponent(id)}`, undefined, 300000);
    if (!res.ok) await this.throwApiError("getSource", res);
    return new Uint8Array(await res.arrayBuffer());
  }

  async rerun(runId: string, jobId: string): Promise<void> {
    const res = await this.call(`/v1/runs/${runId}/jobs/${jobId}/rerun`, { method: "POST" });
    if (!res.ok) await this.throwApiError("rerun", res);
  }

  // Explicit cancellation: queued/blocked jobs stop; running jobs have no
  // interrupt channel and finish naturally.
  async cancelRun(runId: string): Promise<number> {
    const res = await this.call(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    if (!res.ok) await this.throwApiError("cancelRun", res);
    const body = (await res.json()) as { cancelled?: unknown };
    return typeof body.cancelled === "number" ? body.cancelled : 0;
  }

  async getFlaky(repo: string, days = 30): Promise<{ stats: FlareFlakyStat[]; candidates: FlareQuarantineCandidate[] }> {
    const res = await this.call(`/v1/flaky?repo=${encodeURIComponent(repo)}&days=${days}`);
    if (!res.ok) await this.throwApiError("getFlaky", res);
    const data = (await res.json()) as { stats: FlareFlakyStat[]; candidates?: FlareQuarantineCandidate[] };
    return { stats: data.stats, candidates: data.candidates ?? [] };
  }

  async getBottlenecks(repo: string, days = 14): Promise<FlareBottleneck[]> {
    const res = await this.call(`/v1/bottlenecks?repo=${encodeURIComponent(repo)}&days=${days}`);
    if (!res.ok) await this.throwApiError("getBottlenecks", res);
    const data = (await res.json()) as { checks: FlareBottleneck[] };
    return data.checks;
  }

  async getQuarantine(repo: string): Promise<FlareQuarantinedTest[]> {
    const res = await this.call(`/v1/quarantine?repo=${encodeURIComponent(repo)}`);
    if (!res.ok) await this.throwApiError("getQuarantine", res);
    const data = (await res.json()) as { tests: FlareQuarantinedTest[] };
    return data.tests;
  }

  async setQuarantine(repo: string, name: string, action: "add" | "remove"): Promise<void> {
    const res = await this.call("/v1/quarantine", {
      method: "POST",
      body: JSON.stringify({ repo, name, action }),
    });
    if (!res.ok) await this.throwApiError("setQuarantine", res);
  }

  async reportStatus(
    runId: string,
    jobId: string,
    status: string,
    log?: string,
    result?: string,
    opts?: { selection?: FlareSelectionReport },
  ): Promise<void> {
    const res = await this.call(`/v1/runs/${runId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, status, log, result, selection: opts?.selection }),
    });
    if (!res.ok) await this.throwApiError("reportStatus", res);
  }

  // Smart test selection skip reports for a run (jobs that opted in).
  async getRunSelection(runId: string): Promise<FlareRunSelection> {
    const res = await this.call(`/v1/runs/${encodeURIComponent(runId)}/selection`);
    if (!res.ok) await this.throwApiError("getRunSelection", res);
    return (await res.json()) as FlareRunSelection;
  }

  async getAttestation(receiptId: string): Promise<FlareAttestation> {
    const res = await this.call(`/v1/attestations/${encodeURIComponent(receiptId)}`);
    if (!res.ok) await this.throwApiError("getAttestation", res);
    return (await res.json()) as FlareAttestation;
  }

  async enqueueMerge(
    repo: string,
    pr: number,
    headSha: string,
    opts?: { baseBranch?: string; agent?: string },
  ): Promise<{ id: string }> {
    const res = await this.call("/v1/merge-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, pr, headSha, ...opts }),
    });
    if (!res.ok) await this.throwApiError("enqueueMerge", res);
    return (await res.json()) as { id: string };
  }

  async getMergeQueue(repo: string): Promise<FlareMergeQueue> {
    const res = await this.call(`/v1/merge-queue?repo=${encodeURIComponent(repo)}`);
    if (!res.ok) await this.throwApiError("getMergeQueue", res);
    return (await res.json()) as FlareMergeQueue;
  }

  async cancelMerge(entryId: string): Promise<{ ok: boolean; cancelled: boolean }> {
    const res = await this.call(`/v1/merge-queue/${encodeURIComponent(entryId)}`, { method: "DELETE" });
    if (!res.ok) await this.throwApiError("cancelMerge", res);
    return (await res.json()) as { ok: boolean; cancelled: boolean };
  }

  // Liveness proof while a job runs: servers requeue running jobs that
  // go quiet past the stale horizon, so call this about every minute.
  async heartbeat(runId: string, jobId: string): Promise<void> {
    const res = await this.call(
      `/v1/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      { method: "POST" },
    );
    if (!res.ok) await this.throwApiError("heartbeat", res);
  }

  async listRuns(agent?: string): Promise<FlareRun[]> {
    const res = await this.call(agent ? `/v1/runs?agent=${encodeURIComponent(agent)}` : "/v1/runs");
    if (!res.ok) await this.throwApiError("listRuns", res);
    const data = (await res.json()) as { runs: FlareRun[] };
    return data.runs;
  }

  async getRun(runId: string): Promise<{ run: FlareRun; jobs: FlareJobDetail[] }> {
    const res = await this.call(`/v1/runs/${runId}`);
    if (!res.ok) await this.throwApiError("getRun", res);
    return (await res.json()) as { run: FlareRun; jobs: FlareJobDetail[] };
  }

  // Blocking wait: the server holds the request until the run is terminal
  // (or the budget runs out). One call per check instead of a sleep loop;
  // `timedOut` means call again.
  async waitRun(
    runId: string,
    timeoutSeconds = 45,
  ): Promise<{ run: FlareRun; jobs: FlareJobDetail[]; timedOut: boolean; waitedMs: number }> {
    const res = await this.call(
      `/v1/runs/${encodeURIComponent(runId)}/wait?timeout=${timeoutSeconds}`,
      undefined,
      (timeoutSeconds + 15) * 1000,
    );
    if (!res.ok) await this.throwApiError("waitRun", res);
    return (await res.json()) as { run: FlareRun; jobs: FlareJobDetail[]; timedOut: boolean; waitedMs: number };
  }

  // Compact, token-efficient result: failing step command/exit, bounded
  // output tail, triage. The payload agents should feed their context loop.
  async getRunDigest(runId: string): Promise<FlareRunDigest> {
    const res = await this.call(`/v1/runs/${encodeURIComponent(runId)}/digest`);
    if (!res.ok) await this.throwApiError("getRunDigest", res);
    return (await res.json()) as FlareRunDigest;
  }

  // Runner mode claim: the job plus its single-use JIT blob (1h TTL).
  // Callers must never log the blob.
  async claimGithubJob(labels: string[] = []): Promise<GithubRunnerClaim | null> {
    const res = await this.call("/v1/github/jobs/next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels }),
    });
    if (!res.ok) await this.throwApiError("claimGithubJob", res);
    const data = (await res.json()) as { job: GithubRunnerJob | null; jitConfig?: string; runnerName?: string };
    if (!data.job) return null;
    if (typeof data.jitConfig !== "string" || !data.jitConfig) throw new Error("claimGithubJob: missing jitConfig");
    return { job: data.job, jitConfig: data.jitConfig, runnerName: data.runnerName ?? "" };
  }

  async listGithubJobs(repo?: string, limit = 20): Promise<GithubRunnerJob[]> {
    const qs = `${repo ? `repo=${encodeURIComponent(repo)}&` : ""}limit=${limit}`;
    const res = await this.call(`/v1/github/jobs?${qs}`);
    if (!res.ok) await this.throwApiError("listGithubJobs", res);
    const data = (await res.json()) as { jobs: GithubRunnerJob[] };
    return Array.isArray(data.jobs) ? data.jobs : [];
  }
}
