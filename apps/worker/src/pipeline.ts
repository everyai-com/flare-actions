import { parse as parseYaml } from "yaml";

export interface PipelineStep {
  run: string;
}

export interface PipelineJob {
  name: string;
  steps: PipelineStep[];
}

export const MAX_JOBS = 32;
export const MAX_STEPS_PER_JOB = 100;
export const MAX_RUN_LENGTH = 8000;
export const MAX_DEFINITION_BYTES = 64 * 1024;
export const FETCH_TIMEOUT_MS = 5000;
export const FLARE_YML_PATH = "flare.yml";

// Pure: parse + validate a flare.yml document. Returns null on any
// problem — the caller falls back to the default pipeline.
export function parsePipeline(text: string): PipelineJob[] | null {
  if (text.length > MAX_DEFINITION_BYTES) return null;
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const jobs = (doc as Record<string, unknown>).jobs;
  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) return null;
  const entries = Object.entries(jobs);
  if (entries.length === 0 || entries.length > MAX_JOBS) return null;
  const out: PipelineJob[] = [];
  for (const [name, def] of entries) {
    if (!name || name.length > 64) return null;
    if (typeof def !== "object" || def === null || Array.isArray(def)) return null;
    const steps = (def as Record<string, unknown>).steps;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS_PER_JOB) return null;
    const parsed: PipelineStep[] = [];
    for (const s of steps) {
      if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
      const run = (s as Record<string, unknown>).run;
      if (typeof run !== "string" || !run.trim() || run.length > MAX_RUN_LENGTH) return null;
      parsed.push({ run: run.trim() });
    }
    out.push({ name, steps: parsed });
  }
  return out;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch flare.yml at repo@sha. Public fast path needs no auth; the
// contents API with an installation token covers private repos.
export async function fetchPipeline(
  repo: string,
  sha: string,
  installationToken: string | null,
): Promise<string | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w.-]+$/.test(sha)) return null;
  try {
    const res = await fetchWithTimeout(
      `https://raw.githubusercontent.com/${repo}/${sha}/${FLARE_YML_PATH}`,
      { headers: { "User-Agent": "flare-actions" } },
      FETCH_TIMEOUT_MS,
    );
    if (res.ok) {
      const text = await res.text();
      if (text.length <= MAX_DEFINITION_BYTES) return text;
      return null;
    }
  } catch {
    // fall through to the authenticated API
  }
  if (!installationToken) return null;
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/contents/${FLARE_YML_PATH}?ref=${sha}`,
      {
        headers: {
          Authorization: `Bearer ${installationToken}`,
          Accept: "application/vnd.github.raw+json",
          "User-Agent": "flare-actions",
        },
      },
      FETCH_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const text = await res.text();
    return text.length <= MAX_DEFINITION_BYTES ? text : null;
  } catch {
    return null;
  }
}

// Default single job when no pipeline is defined (backward compatible).
export function defaultPipeline(): PipelineJob[] {
  return [{ name: "main", steps: [{ run: "echo hello from flare-actions" }] }];
}
