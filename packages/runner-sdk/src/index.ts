import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async nextJob(): Promise<FlareJob | null> {
    const res = await fetch(`${this.baseUrl}/v1/jobs/next`, { headers: this.headers() });
    if (!res.ok) throw new Error(`nextJob failed: ${res.status}`);
    const data = (await res.json()) as { job: FlareJob | null };
    return data.job;
  }

  async reportStatus(runId: string, jobId: string, status: string, log?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/runs/${runId}/status`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, status, log }),
    });
    if (!res.ok) throw new Error(`reportStatus failed: ${res.status}`);
  }

  async listRuns(): Promise<FlareRun[]> {
    const res = await fetch(`${this.baseUrl}/v1/runs`, { headers: this.headers() });
    if (!res.ok) throw new Error(`listRuns failed: ${res.status}`);
    const data = (await res.json()) as { runs: FlareRun[] };
    return data.runs;
  }

  async getRun(runId: string): Promise<{ run: FlareRun; jobs: { id: string; status: string; log: string }[] }> {
    const res = await fetch(`${this.baseUrl}/v1/runs/${runId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getRun failed: ${res.status}`);
    return (await res.json()) as { run: FlareRun; jobs: { id: string; status: string; log: string }[] };
  }
}
