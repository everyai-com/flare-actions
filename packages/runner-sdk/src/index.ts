import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export { executeSteps, parseDefinition } from "./execute.ts";
export type { ExecStep, ExecuteOptions, StepResult, StepsOutcome } from "./execute.ts";
export { checkoutRepo, gitAvailable } from "./checkout.ts";
export type { CheckoutOptions } from "./checkout.ts";
export { parseJobSpec, matrixEnv } from "./spec.ts";
export type { JobArtifactsSpec, JobCacheSpec, JobServiceSpec, JobSpec } from "./spec.ts";
export { createTar, extractTar, restoreCache, safeCachePaths, saveCache } from "./cache.ts";
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

export interface FlareRun {
  id: string;
  repo: string;
  sha: string;
  event: string;
  status: string;
  created_at: string;
  updated_at: string;
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
    if (!res.ok) throw new Error(`nextJob failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`getCache failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async putCache(key: string, data: Uint8Array): Promise<void> {
    const res = await this.call(`/v1/cache/${FlareClient.encodeKey(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as unknown as BodyInit,
    }, 300000);
    if (!res.ok) throw new Error(`putCache failed: ${res.status}`);
  }

  async uploadArtifact(jobId: string, name: string, data: Uint8Array): Promise<void> {
    const res = await this.call(`/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as unknown as BodyInit,
    }, 300000);
    if (!res.ok) throw new Error(`uploadArtifact failed: ${res.status}`);
  }

  async listArtifacts(runId: string): Promise<FlareArtifact[]> {
    const res = await this.call(`/v1/runs/${runId}/artifacts`);
    if (!res.ok) throw new Error(`listArtifacts failed: ${res.status}`);
    const data = (await res.json()) as { artifacts: FlareArtifact[] };
    return data.artifacts;
  }

  async dispatch(repo: string, sha: string, opts?: { ref?: string; pipeline?: string }): Promise<{ runId: string; jobIds: string[] }> {
    const res = await this.call("/v1/runs/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, sha, ...opts }),
    });
    if (!res.ok) throw new Error(`dispatch failed: ${res.status}`);
    return (await res.json()) as { runId: string; jobIds: string[] };
  }

  async rerun(runId: string, jobId: string): Promise<void> {
    const res = await this.call(`/v1/runs/${runId}/jobs/${jobId}/rerun`, { method: "POST" });
    if (!res.ok) throw new Error(`rerun failed: ${res.status}`);
  }

  async getFlaky(repo: string, days = 30): Promise<FlareFlakyStat[]> {
    const res = await this.call(`/v1/flaky?repo=${encodeURIComponent(repo)}&days=${days}`);
    if (!res.ok) throw new Error(`getFlaky failed: ${res.status}`);
    const data = (await res.json()) as { stats: FlareFlakyStat[] };
    return data.stats;
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
    if (!res.ok) throw new Error(`reportStatus failed: ${res.status}`);
  }

  // Liveness proof while a job runs: servers requeue running jobs that
  // go quiet past the stale horizon, so call this about every minute.
  async heartbeat(runId: string, jobId: string): Promise<void> {
    const res = await this.call(
      `/v1/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      { method: "POST" },
    );
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`);
  }

  async listRuns(): Promise<FlareRun[]> {
    const res = await this.call("/v1/runs");
    if (!res.ok) throw new Error(`listRuns failed: ${res.status}`);
    const data = (await res.json()) as { runs: FlareRun[] };
    return data.runs;
  }

  async getRun(runId: string): Promise<{ run: FlareRun; jobs: FlareJobDetail[] }> {
    const res = await this.call(`/v1/runs/${runId}`);
    if (!res.ok) throw new Error(`getRun failed: ${res.status}`);
    return (await res.json()) as { run: FlareRun; jobs: FlareJobDetail[] };
  }
}
