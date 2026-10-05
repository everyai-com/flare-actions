import { parse as parseYaml } from "yaml";

export interface PipelineStep {
  run: string;
  // GitHub parity: a failing step with continue-on-error marks the step
  // failed but lets the job proceed and still succeed.
  continueOnError?: boolean;
  // Bounded conditional subset (mirrors runner-sdk/spec.ts):
  // always()/success()/failure()/cancelled() and `!fn()` negations.
  if?: string;
  // Per-step bounds/overrides (mirror runner-sdk/spec.ts): minutes (1-180)
  // and the interpreter (sh default; bash when the image has it).
  timeoutMinutes?: number;
  shell?: string;
}

const STEP_CONDITION_FUNCTIONS = ["always()", "success()", "failure()", "cancelled()"];
const SHELL_RE = /^[\w./-]{1,32}$/;

export function normalizeStepCondition(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  const fn = norm.startsWith("!") ? norm.slice(1) : norm;
  return STEP_CONDITION_FUNCTIONS.includes(fn) ? norm : null;
}

export interface PipelineService {
  image: string;
  ports?: string[];
  env?: Record<string, string>;
}

export interface PipelineCache {
  key: string;
  paths: string[];
}

export interface PipelineArtifacts {
  name?: string;
  paths: string[];
}

export interface PipelineTestReports {
  paths: string[];
}

// Extended keys are optional and only set when the document defines
// them, so minimal pipelines still parse to exactly { name, steps }.
export interface PipelineJob {
  name: string;
  steps: PipelineStep[];
  // Pre-matrix job name; only set on expanded matrix cells.
  base?: string;
  labels?: string[];
  matrix?: Record<string, string>;
  env?: Record<string, string>;
  container?: string;
  services?: Record<string, PipelineService>;
  cache?: PipelineCache;
  artifacts?: PipelineArtifacts;
  testReports?: PipelineTestReports;
  needs?: string[];
  group?: string;
  cancelInProgress?: boolean;
  timeoutMinutes?: number;
  // Retries after a failed attempt (0-5); the scheduler requeues while
  // attempts remain. Agent-friendly: flaky suites stop paging humans.
  retry?: number;
  // Job-level condition (bounded subset, same as steps): the scheduling
  // context is needs — `always()`/`failure()` still run after a failed
  // need, `success()` (default) skips.
  if?: string;
  // Managed seats only: keep the failed container for debugging (BYO
  // runners ignore it). YAML key: `retain-on-failure`.
  retainOnFailure?: boolean;
}

export const MAX_JOBS = 32;
export const MAX_STEPS_PER_JOB = 100;
export const MAX_RUN_LENGTH = 8000;
export const MAX_DEFINITION_BYTES = 64 * 1024;
export const FETCH_TIMEOUT_MS = 5000;
export const FLARE_YML_PATH = "flare.yml";
export const MAX_MATRIX_KEYS = 8;
export const MAX_MATRIX_VALUES = 16;
export const MAX_LABELS = 8;
export const MAX_ENV_VARS = 32;
export const MAX_SERVICES = 8;
export const MAX_CACHE_PATHS = 16;
export const MAX_ARTIFACT_PATHS = 32;
export const MAX_TEST_REPORT_PATHS = 16;
export const MAX_GROUP_LENGTH = 128;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown, max: number, itemMax: number): string[] | null {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.length === 0 || list.length > max) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim() || item.length > itemMax) return null;
    out.push(item.trim());
  }
  return out;
}

function asStringMap(v: unknown, max: number, keyRe: RegExp, keyMax: number, valMax: number): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > max) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    if (!keyRe.test(k) || k.length > keyMax || typeof val !== "string" || val.length > valMax) return null;
    out[k] = val;
  }
  return out;
}

function parseMatrix(v: unknown): Record<string, string[]> | null {
  if (!isRecord(v)) return null;
  const entries = Object.entries(v);
  if (entries.length === 0 || entries.length > MAX_MATRIX_KEYS) return null;
  const out: Record<string, string[]> = {};
  for (const [k, vals] of entries) {
    if (!/^[A-Za-z_][\w-]*$/.test(k) || k.length > 32) return null;
    if (!Array.isArray(vals) || vals.length === 0 || vals.length > MAX_MATRIX_VALUES) return null;
    const list: string[] = [];
    for (const val of vals) {
      if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") return null;
      const s = String(val);
      if (!s || s.length > 128) return null;
      list.push(s);
    }
    out[k] = list;
  }
  return out;
}

// Cartesian product of matrix axes: [{node:'18',os:'linux'}, ...].
export function expandMatrixAxes(axes: Record<string, string[]>): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}

// Minimal `${{ matrix.key }}` / `${{ env.KEY }}` interpolation. Unknown
// expressions pass through untouched so shell syntax never breaks.
export function interpolateRun(run: string, matrix: Record<string, string>, env: Record<string, string>): string {
  return run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (match, expr: string) => {
    const m = /^matrix\.([A-Za-z_][\w-]*)$/.exec(expr.trim());
    if (m && matrix[m[1]] !== undefined) return matrix[m[1]];
    const e = /^env\.([A-Za-z_]\w*)$/.exec(expr.trim());
    if (e && env[e[1]] !== undefined) return env[e[1]];
    return match;
  });
}

interface RawJob {
  name: string;
  steps: PipelineStep[];
  labels?: string[];
  matrix?: Record<string, string>;
  env: Record<string, string>;
  container?: string;
  services?: Record<string, PipelineService>;
  cache?: PipelineCache;
  artifacts?: PipelineArtifacts;
  testReports?: PipelineTestReports;
  needs: string[];
  group?: string;
  cancelInProgress: boolean;
  timeoutMinutes?: number;
  retry?: number;
  if?: string;
  retainOnFailure?: boolean;
}

function parseOneJob(name: string, def: unknown): (RawJob & { axes?: Record<string, string[]> }) | null {
  if (!name || name.length > 64 || !isRecord(def)) return null;
  const stepsRaw = def.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0 || stepsRaw.length > MAX_STEPS_PER_JOB) return null;
  const steps: PipelineStep[] = [];
  for (const s of stepsRaw) {
    if (!isRecord(s)) return null;
    const run = s.run;
    if (typeof run !== "string" || !run.trim() || run.length > MAX_RUN_LENGTH) return null;
    const step: PipelineStep = { run: run.trim() };
    if (s["continue-on-error"] !== undefined) {
      if (typeof s["continue-on-error"] !== "boolean") return null;
      step.continueOnError = s["continue-on-error"];
    }
    if (s.if !== undefined) {
      const cond = normalizeStepCondition(s.if);
      if (!cond) return null;
      step.if = cond;
    }
    if (s["timeout-minutes"] !== undefined) {
      const t = s["timeout-minutes"];
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 180) return null;
      step.timeoutMinutes = t;
    }
    if (s.shell !== undefined) {
      if (typeof s.shell !== "string" || !SHELL_RE.test(s.shell.trim())) return null;
      step.shell = s.shell.trim();
    }
    steps.push(step);
  }
  const job: RawJob & { axes?: Record<string, string[]> } = { name, steps, env: {}, needs: [], cancelInProgress: false };
  if (def["runs-on"] !== undefined) {
    const labels = asStringArray(def["runs-on"], MAX_LABELS, 64);
    if (!labels) return null;
    job.labels = labels;
  }
  if (def.env !== undefined) {
    const env = asStringMap(def.env, MAX_ENV_VARS, /^[A-Za-z_]\w*$/, 64, 4096);
    if (!env) return null;
    job.env = env;
  }
  if (def.container !== undefined) {
    if (typeof def.container !== "string" || !def.container.trim() || def.container.length > 256) return null;
    job.container = def.container.trim();
  }
  if (def.services !== undefined) {
    if (!isRecord(def.services)) return null;
    const entries = Object.entries(def.services);
    if (entries.length > MAX_SERVICES) return null;
    const services: Record<string, PipelineService> = {};
    for (const [svcName, svcDef] of entries) {
      if (!/^[\w.-]{1,64}$/.test(svcName) || !isRecord(svcDef)) return null;
      const image = svcDef.image;
      if (typeof image !== "string" || !image.trim() || image.length > 256) return null;
      const svc: PipelineService = { image: image.trim() };
      if (svcDef.ports !== undefined) {
        const ports = asStringArray(svcDef.ports, 16, 32);
        if (!ports) return null;
        svc.ports = ports;
      }
      if (svcDef.env !== undefined) {
        const svcEnv = asStringMap(svcDef.env, MAX_ENV_VARS, /^[A-Za-z_]\w*$/, 64, 4096);
        if (!svcEnv) return null;
        svc.env = svcEnv;
      }
      services[svcName] = svc;
    }
    job.services = services;
  }
  if (def.cache !== undefined) {
    if (!isRecord(def.cache)) return null;
    const key = def.cache.key;
    if (typeof key !== "string" || !/^[\w][\w.\-/]{0,199}$/.test(key)) return null;
    const paths = asStringArray(def.cache.paths, MAX_CACHE_PATHS, 256);
    if (!paths) return null;
    job.cache = { key, paths };
  }
  if (def.artifacts !== undefined) {
    if (!isRecord(def.artifacts)) return null;
    const paths = asStringArray(def.artifacts.paths, MAX_ARTIFACT_PATHS, 256);
    if (!paths) return null;
    const artifacts: PipelineArtifacts = { paths };
    if (def.artifacts.name !== undefined) {
      if (typeof def.artifacts.name !== "string" || !def.artifacts.name.trim() || def.artifacts.name.length > 128) {
        return null;
      }
      artifacts.name = def.artifacts.name.trim();
    }
    job.artifacts = artifacts;
  }
  if (def["test-reports"] !== undefined) {
    if (!isRecord(def["test-reports"])) return null;
    const paths = asStringArray(def["test-reports"].paths, MAX_TEST_REPORT_PATHS, 256);
    if (!paths) return null;
    job.testReports = { paths };
  }
  if (def.needs !== undefined) {
    const needs = asStringArray(def.needs, MAX_JOBS, 64);
    if (!needs) return null;
    job.needs = [...new Set(needs)];
  }
  if (def.concurrency !== undefined) {
    const c = def.concurrency;
    if (typeof c === "string") {
      if (!c.trim() || c.length > MAX_GROUP_LENGTH) return null;
      job.group = c.trim();
    } else if (isRecord(c)) {
      if (typeof c.group !== "string" || !c.group.trim() || c.group.length > MAX_GROUP_LENGTH) return null;
      job.group = c.group.trim();
      if (c["cancel-in-progress"] !== undefined) {
        if (typeof c["cancel-in-progress"] !== "boolean") return null;
        job.cancelInProgress = c["cancel-in-progress"];
      }
    } else {
      return null;
    }
  }
  if (def["timeout-minutes"] !== undefined) {
    const t = def["timeout-minutes"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 1440) return null;
    job.timeoutMinutes = t;
  }
  if (def.retry !== undefined) {
    const r = def.retry;
    if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r > 5) return null;
    job.retry = r;
  }
  if (def.if !== undefined) {
    const cond = normalizeStepCondition(def.if);
    if (!cond) return null;
    job.if = cond;
  }
  if (def["retain-on-failure"] !== undefined) {
    if (typeof def["retain-on-failure"] !== "boolean") return null;
    if (def["retain-on-failure"]) job.retainOnFailure = true;
  }
  if (def.strategy !== undefined) {
    if (!isRecord(def.strategy) || def.strategy.matrix === undefined) return null;
    const axes = parseMatrix(def.strategy.matrix);
    if (!axes) return null;
    job.axes = axes;
  }
  return job;
}

function hasCycle(names: string[], needsOf: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (n: string): boolean => {
    if (done.has(n)) return false;
    if (visiting.has(n)) return true;
    visiting.add(n);
    for (const dep of needsOf.get(n) ?? []) {
      if (visit(dep)) return true;
    }
    visiting.delete(n);
    done.add(n);
    return false;
  };
  return names.some(visit);
}

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
  if (!isRecord(doc)) return null;
  const jobs = doc.jobs;
  if (!isRecord(jobs)) return null;
  const entries = Object.entries(jobs);
  if (entries.length === 0 || entries.length > MAX_JOBS) return null;
  const raws: (RawJob & { axes?: Record<string, string[]> })[] = [];
  for (const [name, def] of entries) {
    const parsed = parseOneJob(name, def);
    if (!parsed) return null;
    raws.push(parsed);
  }
  // needs must reference other jobs in this document, acyclically.
  const names = new Set(raws.map((r) => r.name));
  const needsOf = new Map<string, string[]>();
  for (const r of raws) {
    for (const dep of r.needs) {
      if (dep === r.name || !names.has(dep)) return null;
    }
    needsOf.set(r.name, r.needs);
  }
  if (hasCycle([...names], needsOf)) return null;
  // Expand matrices; the expanded total obeys the job cap.
  const out: PipelineJob[] = [];
  for (const r of raws) {
    const combos = r.axes ? expandMatrixAxes(r.axes) : [null];
    for (const combo of combos) {
      const matrix = combo ?? undefined;
      const suffix = combo ? ` (${Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(", ")})` : "";
      const name = `${r.name}${suffix}`;
      if (name.length > 128) return null;
      const steps = r.steps.map((s) => ({ ...s, run: interpolateRun(s.run, matrix ?? {}, r.env) }));
      const job: PipelineJob = { name, steps };
      if (combo) job.base = r.name;
      if (r.labels) job.labels = r.labels;
      if (matrix) job.matrix = matrix;
      if (Object.keys(r.env).length > 0) job.env = r.env;
      if (r.container) job.container = r.container;
      if (r.services) job.services = r.services;
      if (r.cache) job.cache = r.cache;
      if (r.artifacts) job.artifacts = r.artifacts;
      if (r.testReports) job.testReports = r.testReports;
      if (r.needs.length > 0) job.needs = r.needs;
      if (r.group) job.group = r.group;
      if (r.cancelInProgress) job.cancelInProgress = true;
      if (r.timeoutMinutes !== undefined) job.timeoutMinutes = r.timeoutMinutes;
      if (r.retry !== undefined) job.retry = r.retry;
      if (r.if !== undefined) job.if = r.if;
      if (r.retainOnFailure !== undefined) job.retainOnFailure = r.retainOnFailure;
      out.push(job);
    }
  }
  if (out.length > MAX_JOBS) return null;
  return out;
}

// The JSON stored in jobs.definition: everything the runner and the
// scheduler need. `base` is the pre-matrix job name for needs matching.
export function serializeDefinition(job: PipelineJob, baseName: string): string {
  return JSON.stringify({
    steps: job.steps,
    base: baseName,
    labels: job.labels,
    matrix: job.matrix,
    env: job.env,
    container: job.container,
    services: job.services,
    cache: job.cache,
    artifacts: job.artifacts,
    testReports: job.testReports,
    needs: job.needs,
    group: job.group,
    timeoutMinutes: job.timeoutMinutes,
    retry: job.retry,
    if: job.if,
    retainOnFailure: job.retainOnFailure,
  });
}

// Retry policy from a stored definition; tolerant of legacy shapes.
export function readRetryPolicy(definition: string): number {
  try {
    const parsed = JSON.parse(definition) as { retry?: unknown };
    const retry = parsed?.retry;
    return typeof retry === "number" && Number.isInteger(retry) && retry >= 0 && retry <= 5 ? retry : 0;
  } catch {
    return 0;
  }
}

export interface JobSpecSchedule {
  base: string;
  needs: string[];
  group?: string;
  // Job-level condition (bounded subset); validated at parse time, kept
  // tolerant here so legacy definitions schedule as before.
  if?: string;
}

// Seats are Linux containers without docker: eligible jobs need no
// special labels, no nested container, and no services. Everything else
// stays on BYO runners. Unknown/legacy definitions are eligible — they
// predate all three features.
export function seatEligible(definition: string): boolean {
  try {
    const parsed = JSON.parse(definition) as Record<string, unknown>;
    if (!isRecord(parsed)) return true;
    if (typeof parsed.container === "string" && parsed.container) return false;
    if (isRecord(parsed.services) && Object.keys(parsed.services).length > 0) return false;
    if (parsed.labels !== undefined) {
      if (!Array.isArray(parsed.labels)) return false;
      for (const label of parsed.labels) {
        if (label !== "linux") return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

// Tolerant reader for scheduling: legacy `{ steps }` definitions yield
// empty needs and no group instead of failing.
export function readJobSpec(definition: string, fallbackName: string): JobSpecSchedule {
  const fallback: JobSpecSchedule = { base: fallbackName, needs: [] };
  try {
    const parsed = JSON.parse(definition) as Record<string, unknown>;
    if (!isRecord(parsed)) return fallback;
    const needs = Array.isArray(parsed.needs)
      ? parsed.needs.filter((n): n is string => typeof n === "string")
      : [];
    const group = typeof parsed.group === "string" && parsed.group ? parsed.group : undefined;
    const base = typeof parsed.base === "string" && parsed.base ? parsed.base : fallbackName;
    const cond = normalizeStepCondition(parsed["if"]);
    return cond ? { base, needs, group, if: cond } : { base, needs, group };
  } catch {
    return fallback;
  }
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
