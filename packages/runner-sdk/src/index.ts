import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export { executeSteps, parseDefinition } from "./execute.ts";
export type { ExecStep, ExecuteOptions, StepResult, StepsOutcome } from "./execute.ts";
export { checkoutRepo, gitAvailable } from "./checkout.ts";
export type { CheckoutOptions } from "./checkout.ts";
export { parseJobSpec, matrixEnv } from "./spec.ts";
export type { JobArtifactsSpec, JobCacheSpec, JobServiceSpec, JobSpec } from "./spec.ts";
export { createTar, extractTar, assertSafeTar, restoreCache, safeCachePaths, saveCache } from "./cache.ts";
export type { CacheClient } from "./cache.ts";
export { dockerArgsForService, dockerArgsForStep, dockerAvailable, dockerServicesCtl } from "./services.ts";
export type { ServiceHandle, ServicesCtl } from "./services.ts";
export { collectArtifactFiles, runJob, sanitizeArtifactName } from "./job.ts";
export type { JobClient, RunJobOptions, RunJobResult } from "./job.ts";
export { hasSecretPlaceholders, interpolateSecrets, maskSecrets } from "./secrets.ts";
export { convertActionsWorkflow, isImportSuccess, mapRunsOn, sanitizeCacheKey } from "./importActions.ts";
export type { ImportFailure, ImportResult, ImportSuccess } from "./importActions.ts";

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
  status: "queued" | "blocked";
  blockedReason: "needs" | "group" | null;
  wouldCancelInProgress: boolean;
  priorMs: number;
}

export interface DryRunPlan {
  repo: string;
  sha: string;
  branch: string;
  pipelineSource: string;
  jobs: DryRunPlannedJob[];
  queued: number;
  blocked: number;
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

export interface FlareQueuedJob {
  id: string;
  runId: string;
  name: string;
  repo: string;
  priority: number;
  priorMs: number;
  labels: string;
  createdAt: string;
}

export interface FlareQueue {
  fairSharePerRepo: number;
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

export interface FlareDigestJob {
  id: string;
  name: string;
  status: string;
  durationMs: number | null;
  stepCount: number;
  failing?: FlareDigestStep;
  triage?: string;
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
}

export interface FlareRun {
  id: string;
  repo: string;
  sha: string;
  event: string;
  status: string;
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
  // this authenticated claim only) and a flag when stored secrets could
  // not be decrypted.
  async nextClaim(labels: string[] = []): Promise<{
    job: FlareJob | null;
    secrets: Record<string, string>;
    secretsError: boolean;
  }> {
    const qs = labels.length > 0 ? `?labels=${encodeURIComponent(labels.join(","))}` : "";
    const res = await this.call(`/v1/jobs/next${qs}`);
    if (!res.ok) await this.throwApiError("nextJob", res);
    const data = (await res.json()) as {
      job: FlareJob | null;
      secrets?: Record<string, string>;
      secretsError?: boolean;
    };
    const secrets: Record<string, string> = {};
    if (data.secrets && typeof data.secrets === "object") {
      for (const [k, v] of Object.entries(data.secrets)) {
        if (typeof v === "string") secrets[k] = v;
      }
    }
    return { job: data.job, secrets, secretsError: data.secretsError === true };
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
    opts?: { ref?: string; pipeline?: string; priority?: number; source?: string },
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
    opts?: { ref?: string; pipeline?: string; priority?: number; source?: string },
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

  async getFlaky(repo: string, days = 30): Promise<FlareFlakyStat[]> {
    const res = await this.call(`/v1/flaky?repo=${encodeURIComponent(repo)}&days=${days}`);
    if (!res.ok) await this.throwApiError("getFlaky", res);
    const data = (await res.json()) as { stats: FlareFlakyStat[] };
    return data.stats;
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
  ): Promise<void> {
    const res = await this.call(`/v1/runs/${runId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, status, log, result }),
    });
    if (!res.ok) await this.throwApiError("reportStatus", res);
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

  async listRuns(): Promise<FlareRun[]> {
    const res = await this.call("/v1/runs");
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
