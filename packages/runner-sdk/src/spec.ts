// Runner-side reader for jobs.definition JSON. Forward-tolerant: steps
// are required, every other field is validated lightly and dropped when
// malformed so old runners keep working against newer servers.
// (Seats-only keys like browserChecks stay strict: dropping them would
// silently skip verification, so malformed means fail closed.)
import { validatePreviewTemplate } from "./browser.ts";

export interface JobServiceSpec {
  image: string;
  ports?: string[];
  env?: Record<string, string>;
}

export interface JobCacheSpec {
  key: string;
  paths: string[];
}

export interface JobArtifactsSpec {
  paths: string[];
  name?: string;
}

export interface JobTestReportsSpec {
  paths: string[];
}

export interface JobSpec {
  steps: { run: string; continueOnError?: boolean; if?: string; timeoutMinutes?: number; shell?: string }[];
  base?: string;
  // Selector labels for CI profiles (mirrors worker pipeline.ts `tags`).
  tags?: string[];
  matrix?: Record<string, string>;
  env?: Record<string, string>;
  container?: string;
  services?: Record<string, JobServiceSpec>;
  cache?: JobCacheSpec;
  artifacts?: JobArtifactsSpec;
  testReports?: JobTestReportsSpec;
  timeoutMinutes?: number;
  // Managed seats only: keep the failed container alive for debugging
  // instead of destroying it (BYO runners ignore this).
  retainOnFailure?: boolean;
  // Managed seats only: declarative browser checks via the BROWSER
  // binding (BYO runners ignore these).
  browserChecks?: JobBrowserCheckSpec[];
  // Managed seats only: outbound allowlist enforced by the LD_PRELOAD
  // shim (BYO runners fail closed).
  egress?: JobEgressSpec;
  testSelection?: JobTestSelectionSpec;
}

export interface JobEgressSpec {
  allow: string[];
}

// Smart test selection (mirrors worker pipeline.ts `test-selection`):
// presence opts the job in; executors walk the import graph, set
// FLARE_SELECTED_TESTS, and record a skip report.
export interface JobTestSelectionSpec {
  tests?: string[];
  fullOnProfiles?: string[];
  fullOnBranches?: string[];
  historyDays?: number;
}

export type JobBrowserActionKind = "click" | "type" | "wait" | "wait-text";

export interface JobBrowserActionSpec {
  kind: JobBrowserActionKind;
  selector?: string;
  text?: string;
}

export interface JobBrowserCheckSpec {
  name: string;
  url: string;
  expectTitle?: string;
  expectText?: string;
  screenshot?: boolean;
  actions?: JobBrowserActionSpec[];
}

// Step conditionals: the bounded GitHub subset that covers cleanup and
// failure-notification steps. `!fn()` negations are allowed; anything
// else (expression soup) is rejected at parse time, never guessed.
export const STEP_CONDITIONS = ["always()", "success()", "failure()", "cancelled()"] as const;

export function normalizeStepCondition(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  const fn = norm.startsWith("!") ? norm.slice(1) : norm;
  return (STEP_CONDITIONS as readonly string[]).includes(fn) ? norm : null;
}

export interface StepRunState {
  // Any earlier step exited non-zero (continue-on-error included).
  anyFailed: boolean;
  // An earlier step failed without continue-on-error: default
  // (success()) steps are skipped from here on, while failure()/always()
  // steps still run.
  jobFailed: boolean;
}

// Tar member safety for untrusted archives (source dispatch): absolute
// paths and `..` traversal are rejected before extraction. Lives here
// (not cache.ts) because the seats bundle must not pull in node:child_process.
export function unsafeTarMember(name: string): boolean {
  return name.startsWith("/") || name.split("/").includes("..");
}

export function stepRuns(condition: string | undefined, state: StepRunState): boolean {
  if (condition === undefined || condition === "") return !state.jobFailed; // default = success()
  const norm = condition.trim().toLowerCase();
  const neg = norm.startsWith("!");
  const fn = neg ? norm.slice(1) : norm;
  let value: boolean;
  switch (fn) {
    case "always()":
      value = true;
      break;
    case "success()":
      value = !state.jobFailed;
      break;
    case "failure()":
      value = state.anyFailed;
      break;
    case "cancelled()":
      value = false;
      break;
    default:
      value = !state.jobFailed;
      break;
  }
  return neg ? !value : value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strMap(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((s): s is string => typeof s === "string" && !!s)) return null;
  return v;
}

export function parseJobSpec(definition: string): JobSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  const steps: { run: string; continueOnError?: boolean; if?: string; timeoutMinutes?: number; shell?: string }[] = [];
  for (const s of parsed.steps) {
    if (!isRecord(s) || typeof s.run !== "string" || !s.run.trim()) return null;
    const step: { run: string; continueOnError?: boolean; if?: string; timeoutMinutes?: number; shell?: string } = {
      run: s.run,
    };
    if (s.continueOnError !== undefined) {
      if (typeof s.continueOnError !== "boolean") return null;
      step.continueOnError = s.continueOnError;
    }
    if (s.if !== undefined) {
      const cond = normalizeStepCondition(s.if);
      if (!cond) return null;
      step.if = cond;
    }
    if (s.timeoutMinutes !== undefined) {
      if (typeof s.timeoutMinutes !== "number" || !Number.isInteger(s.timeoutMinutes) || s.timeoutMinutes < 1 || s.timeoutMinutes > 180) {
        return null;
      }
      step.timeoutMinutes = s.timeoutMinutes;
    }
    if (s.shell !== undefined) {
      if (typeof s.shell !== "string" || !/^[\w./-]{1,32}$/.test(s.shell.trim())) return null;
      step.shell = s.shell.trim();
    }
    steps.push(step);
  }
  const spec: JobSpec = { steps };
  if (typeof parsed.base === "string" && parsed.base) spec.base = parsed.base;
  if (parsed.tags !== undefined) {
    if (
      !Array.isArray(parsed.tags) ||
      parsed.tags.length === 0 ||
      parsed.tags.length > 8 ||
      !parsed.tags.every((t): t is string => typeof t === "string" && !!t && t.length <= 64)
    ) {
      return null;
    }
    spec.tags = [...parsed.tags];
  }
  const matrix = parsed.matrix === undefined ? null : strMap(parsed.matrix);
  if (parsed.matrix !== undefined && !matrix) return null;
  if (matrix) spec.matrix = matrix;
  const env = parsed.env === undefined ? null : strMap(parsed.env);
  if (parsed.env !== undefined && !env) return null;
  if (env) spec.env = env;
  if (parsed.container !== undefined) {
    if (typeof parsed.container !== "string" || !parsed.container.trim()) return null;
    spec.container = parsed.container;
  }
  if (parsed.services !== undefined) {
    if (!isRecord(parsed.services)) return null;
    const services: Record<string, JobServiceSpec> = {};
    for (const [name, def] of Object.entries(parsed.services)) {
      if (!isRecord(def) || typeof def.image !== "string" || !def.image.trim()) return null;
      const svc: JobServiceSpec = { image: def.image };
      if (def.ports !== undefined) {
        const ports = strList(def.ports);
        if (!ports) return null;
        svc.ports = ports;
      }
      if (def.env !== undefined) {
        const svcEnv = strMap(def.env);
        if (!svcEnv) return null;
        svc.env = svcEnv;
      }
      services[name] = svc;
    }
    spec.services = services;
  }
  if (parsed.cache !== undefined) {
    if (!isRecord(parsed.cache) || typeof parsed.cache.key !== "string" || !parsed.cache.key) return null;
    const paths = strList(parsed.cache.paths);
    if (!paths) return null;
    spec.cache = { key: parsed.cache.key, paths };
  }
  if (parsed.artifacts !== undefined) {
    if (!isRecord(parsed.artifacts)) return null;
    const paths = strList(parsed.artifacts.paths);
    if (!paths) return null;
    spec.artifacts = { paths };
    if (parsed.artifacts.name !== undefined) {
      if (typeof parsed.artifacts.name !== "string" || !parsed.artifacts.name.trim()) return null;
      spec.artifacts.name = parsed.artifacts.name;
    }
  }
  if (parsed.timeoutMinutes !== undefined) {
    if (typeof parsed.timeoutMinutes !== "number" || parsed.timeoutMinutes < 1) return null;
    spec.timeoutMinutes = Math.floor(parsed.timeoutMinutes);
  }
  if (parsed.testReports !== undefined) {
    if (!isRecord(parsed.testReports)) return null;
    const paths = strList(parsed.testReports.paths);
    if (!paths) return null;
    spec.testReports = { paths };
  }
  if (parsed.retainOnFailure !== undefined) {
    if (typeof parsed.retainOnFailure !== "boolean") return null;
    if (parsed.retainOnFailure) spec.retainOnFailure = true;
  }
  if (parsed.browserChecks !== undefined) {
    if (!Array.isArray(parsed.browserChecks) || parsed.browserChecks.length === 0 || parsed.browserChecks.length > 10) {
      return null;
    }
    const checks: JobBrowserCheckSpec[] = [];
    const seen = new Set<string>();
    for (const c of parsed.browserChecks) {
      if (!isRecord(c)) return null;
      if (typeof c.name !== "string" || !/^[\w.-]{1,64}$/.test(c.name) || seen.has(c.name)) return null;
      seen.add(c.name);
      if (typeof c.url !== "string" || c.url.length === 0 || c.url.length > 2048) return null;
      let protocol: string;
      try {
        protocol = new URL(c.url).protocol;
      } catch {
        return null;
      }
      if (protocol !== "https:") return null;
      if (validatePreviewTemplate(c.url) !== null) return null;
      const check: JobBrowserCheckSpec = { name: c.name, url: c.url };
      for (const field of ["expectTitle", "expectText"] as const) {
        const v = c[field];
        if (v !== undefined) {
          if (typeof v !== "string" || !v || v.length > 512) return null;
          check[field] = v;
        }
      }
      if (check.expectTitle === undefined && check.expectText === undefined) return null;
      if (c.screenshot !== undefined) {
        if (typeof c.screenshot !== "boolean") return null;
        check.screenshot = c.screenshot;
      }
      if (c.actions !== undefined) {
        if (!Array.isArray(c.actions) || c.actions.length === 0 || c.actions.length > 10) return null;
        const actions: JobBrowserActionSpec[] = [];
        for (const a of c.actions) {
          if (!isRecord(a)) return null;
          const kind = a.kind;
          if (kind !== "click" && kind !== "type" && kind !== "wait" && kind !== "wait-text") return null;
          if (kind === "wait-text") {
            if (typeof a.text !== "string" || !a.text || a.text.length > 512) return null;
            if (a.selector !== undefined) return null;
            actions.push({ kind, text: a.text });
            continue;
          }
          if (typeof a.selector !== "string" || !a.selector.trim() || a.selector.length > 256) return null;
          if (kind === "type") {
            if (typeof a.text !== "string" || !a.text || a.text.length > 1024) return null;
            actions.push({ kind, selector: a.selector, text: a.text });
          } else {
            if (a.text !== undefined) return null;
            actions.push({ kind, selector: a.selector });
          }
        }
        check.actions = actions;
      }
      checks.push(check);
    }
    spec.browserChecks = checks;
  }
  if (parsed.egress !== undefined) {
    if (!isRecord(parsed.egress)) return null;
    const allow = parsed.egress.allow;
    if (!Array.isArray(allow) || allow.length === 0 || allow.length > 32) return null;
    const domains: string[] = [];
    const seen = new Set<string>();
    for (const d of allow) {
      if (typeof d !== "string") return null;
      const dom = d.trim().toLowerCase();
      if (
        !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(dom) ||
        seen.has(dom)
      ) {
        return null;
      }
      seen.add(dom);
      domains.push(dom);
    }
    spec.egress = { allow: domains };
  }
  if (parsed.testSelection !== undefined) {
    const sel = parseTestSelection(parsed.testSelection);
    if (!sel) return null;
    spec.testSelection = sel;
  }
  return spec;
}

function selectionStrList(v: unknown, max: number, itemMax: number): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item.trim() || item.length > itemMax) return null;
    out.push(item.trim());
  }
  return [...new Set(out)];
}

// Stored definitions carry camelCase (serializeDefinition); the YAML
// kebab-case is tolerated so hand-built definitions behave.
function parseTestSelection(v: unknown): JobTestSelectionSpec | null {
  if (v === true) return {};
  if (!isRecord(v)) return null;
  const spec: JobTestSelectionSpec = {};
  if (v.tests !== undefined) {
    const tests = selectionStrList(v.tests, 16, 256);
    if (!tests) return null;
    spec.tests = tests;
  }
  const profiles = v.fullOnProfiles ?? v["full-on-profiles"];
  if (profiles !== undefined) {
    const list = selectionStrList(profiles, 16, 64);
    if (!list) return null;
    spec.fullOnProfiles = list;
  }
  const branches = v.fullOnBranches ?? v["full-on-branches"];
  if (branches !== undefined) {
    const list = selectionStrList(branches, 16, 128);
    if (!list) return null;
    spec.fullOnBranches = list;
  }
  const days = v.historyDays ?? v["history-days"];
  if (days !== undefined) {
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 30) return null;
    spec.historyDays = days;
  }
  return spec;
}

// Matrix values as step env: {node: '20'} -> {FLARE_MATRIX_NODE: '20'}.
export function matrixEnv(matrix: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(matrix ?? {})) {
    out[`FLARE_MATRIX_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
  }
  return out;
}
