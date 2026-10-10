import { parse as parseYaml } from "yaml";
import { validatePreviewTemplate } from "../../../packages/runner-sdk/src/browser.ts";
import { normalizeCondition } from "../../../packages/runner-sdk/src/conditions.ts";
import { MAX_JOB_OUTPUTS, isValidOutputName, parseOutputRef } from "../../../packages/runner-sdk/src/outputs.ts";
import { MAX_RESTORE_KEYS, isValidCacheKey, isValidRestoreKey } from "../../../packages/runner-sdk/src/parity.ts";
import { expandMatrix, parseMatrixSpec, type MatrixSpec } from "../../../packages/runner-sdk/src/matrix.ts";
import { outputEnvName } from "../../../packages/runner-sdk/src/outputs.ts";
import { parseTestSelectionConfig, type TestSelectionConfig } from "./testselect.ts";

export interface PipelineStep {
  run: string;
  // Stable handle for outputs (`steps.<id>.outputs.<key>`).
  id?: string;
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

const SHELL_RE = /^[\w./-]{1,32}$/;

// CI profiles: profile names, job tags, and include/exclude entries share
// one slug alphabet (same as agent tags) so CLI/MCP/API validation matches.
export const PROFILE_NAME_RE = /^[\w.-]{1,64}$/;

export function parseProfileName(value: unknown): { profile: string } | { error: string } {
  if (typeof value !== "string" || !PROFILE_NAME_RE.test(value)) {
    return { error: "profile must be 1-64 chars: letters, digits, dot, dash, underscore" };
  }
  return { profile: value };
}

export function normalizeStepCondition(raw: unknown): string | null {
  return normalizeCondition(raw, { allowSteps: true });
}

export function normalizeJobCondition(raw: unknown): string | null {
  return normalizeCondition(raw, { allowSteps: false });
}

export interface PipelineService {
  image: string;
  ports?: string[];
  env?: Record<string, string>;
}

export interface PipelineCache {
  key: string;
  paths: string[];
  restoreKeys?: string[];
}

export interface PipelineArtifacts {
  name?: string;
  paths: string[];
}

export interface PipelineTestReports {
  paths: string[];
}

// Managed seats only: declarative browser checks run worker-side via
// the BROWSER binding (Browser Rendering) after successful steps
// (BYO runners and `cli local` fail closed on them). YAML key:
// `browser-checks`.
export type PipelineBrowserActionKind = "click" | "type" | "wait" | "wait-text";

export interface PipelineBrowserAction {
  kind: PipelineBrowserActionKind;
  // click/type/wait target (CSS selector). Never echoed with values.
  selector?: string;
  // type text / wait-text substring. May carry ${{ secrets.NAME }};
  // never echoed anywhere (assertion reports name the kind only).
  text?: string;
}

export interface PipelineBrowserCheck {
  name: string;
  // May carry preview-URL templates ({branch}, {pr}, {sha},
  // {short_sha}) resolved seat-side from the run row.
  url: string;
  expectTitle?: string;
  expectText?: string;
  screenshot?: boolean;
  // Interactions before the assertions (click/type/wait/wait-text),
  // in order, sharing the check's 30s budget.
  actions?: PipelineBrowserAction[];
}

// Managed seats only: outbound allowlist enforced by the LD_PRELOAD
// shim (BYO runners fail closed). YAML key: `egress: { allow: [...] }`.
// Exact names and subdomains pass; loopback always passes (services);
// unknown IPs fail closed. Absent = observe-only accounting.
export interface PipelineEgress {
  allow: string[];
}

// Smart test selection (job-level opt-in). The executor walks the
// import graph from the run's changed files, boosts recently failed
// tests, sets FLARE_SELECTED_TESTS, and records a skip report.
// YAML key: `test-selection` (`true` or a mapping).
export type PipelineTestSelection = TestSelectionConfig;

// Extended keys are optional and only set when the document defines
// them, so minimal pipelines still parse to exactly { name, steps }.
export interface PipelineJob {
  name: string;
  steps: PipelineStep[];
  // Pre-matrix job name; only set on expanded matrix cells.
  base?: string;
  // Free-form selector labels for CI profiles (YAML `tags`); matched
  // by profile include/exclude entries alongside base job names.
  tags?: string[];
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
  // Job outputs: stable names mapped from step refs (`stepid.key`).
  outputs?: Record<string, string>;
  // Managed seats only: keep the failed container for debugging (BYO
  // runners ignore it). YAML key: `retain-on-failure`.
  retainOnFailure?: boolean;
  browserChecks?: PipelineBrowserCheck[];
  egress?: PipelineEgress;
  testSelection?: PipelineTestSelection;
}

export const MAX_JOBS = 32;
export const MAX_PROFILES = 16;
export const MAX_PROFILE_ENTRIES = 32;
export const MAX_TAGS = 8;
export const MAX_SHARDS = 8;
export const MAX_BROWSER_CHECKS = 10;
export const MAX_BROWSER_ACTIONS = 10;
export const MAX_BROWSER_SELECTOR = 256;
export const MAX_BROWSER_ACTION_TEXT = 1024;
export const MAX_EGRESS_ALLOW = 32;
export const MAX_STEPS_PER_JOB = 100;
export const MAX_RUN_LENGTH = 8000;
export const MAX_DEFINITION_BYTES = 64 * 1024;
export const FETCH_TIMEOUT_MS = 5000;
export const FLARE_YML_PATH = "flare.yml";
// Matrix bounds + include/exclude expansion live in runner-sdk/matrix.ts
// (shared with the Actions importer so it only emits parseable matrices).
export { MAX_MATRIX_KEYS, MAX_MATRIX_VALUES, expandMatrixAxes } from "../../../packages/runner-sdk/src/matrix.ts";
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

export const EGRESS_DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Shared by the YAML parser and the repo-allowlist admin API: one
// hostname alphabet and cap, so the fan-out subset check compares
// normalized lists. Returns the normalized domains, or null.
export function parseEgressAllow(allow: unknown): string[] | null {
  if (!Array.isArray(allow) || allow.length === 0 || allow.length > MAX_EGRESS_ALLOW) return null;
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const d of allow) {
    if (typeof d !== "string") return null;
    const dom = d.trim().toLowerCase();
    if (!EGRESS_DOMAIN_RE.test(dom) || seen.has(dom)) return null;
    seen.add(dom);
    domains.push(dom);
  }
  return domains;
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

// Minimal `${{ matrix.key }}` / `${{ env.KEY }}` interpolation, plus
// output refs rewritten to the step-env reads both executors provide
// (`steps.<id>.outputs.<key>` → `${FLARE_STEPS_<ID>_<KEY>}`,
// `needs.<job>.outputs.<key>|result` → `${FLARE_NEEDS_<JOB>_<KEY>}`), so
// values never get pasted into shell text. In a matrix cell, a key the
// cell lacks (include-only keys) is "" like Actions. Other expressions
// pass through untouched so shell syntax never breaks.
export function interpolateRun(run: string, matrix: Record<string, string>, env: Record<string, string>): string {
  const inMatrix = Object.keys(matrix).length > 0;
  return run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (match, expr: string) => {
    const m = /^matrix\.([A-Za-z_][\w-]*)$/.exec(expr.trim());
    if (m && matrix[m[1]] !== undefined) return matrix[m[1]];
    if (m && inMatrix) return "";
    const so = /^steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(expr.trim());
    if (so) return "${" + outputEnvName("FLARE_STEPS_", so[1], so[2]) + "}";
    const no = /^needs\.([A-Za-z_][\w-]*)\.(?:outputs\.([A-Za-z_][\w-]*)|(result))$/.exec(expr.trim());
    if (no) return "${" + outputEnvName("FLARE_NEEDS_", no[1], no[2] ?? "RESULT") + "}";
    const e = /^env\.([A-Za-z_]\w*)$/.exec(expr.trim());
    if (e && env[e[1]] !== undefined) return env[e[1]];
    return match;
  });
}

// Per-cell `runs-on`: `${{ matrix.os }}` is the common GitHub shape.
// Matrix refs resolve per cell; a label that came from an expression and
// names a GitHub-hosted image maps to the portable OS label the importer
// uses (ubuntu-* → linux, macos-* → macos, windows-* → windows). Literal
// labels never change. Fails closed (null) when a ref resolves to
// nothing or to something that isn't a label: an unlabeled job matches
// any runner, so a dropped label would silently change where it runs.
export function cellLabels(labels: string[], matrix: Record<string, string>): string[] | null {
  const out: string[] = [];
  for (const raw of labels) {
    if (!raw.includes("${{")) { out.push(raw); continue; }
    const label = interpolateRun(raw, matrix, {}).trim();
    // Labels are stored comma-joined, so a comma would split one into two.
    if (!label || label.length > 64 || label.includes("${{") || /[,\s]/.test(label)) return null;
    if (/^ubuntu-/.test(label)) out.push("linux");
    else if (/^macos-/.test(label)) out.push("macos");
    else if (/^windows-/.test(label)) out.push("windows");
    else out.push(label);
  }
  return [...new Set(out)];
}

interface RawJob {
  name: string;
  steps: PipelineStep[];
  tags?: string[];
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
  // Split a long job into N parallel cells (2-8); each cell gets
  // FLARE_SHARD_INDEX / FLARE_SHARD_TOTAL for `vitest --shard=…`-style
  // recipes. Multiplies with a matrix when both are present.
  shards?: number;
  if?: string;
  outputs?: Record<string, string>;
  retainOnFailure?: boolean;
  browserChecks?: PipelineBrowserCheck[];
  egress?: PipelineEgress;
  testSelection?: PipelineTestSelection;
}

function parseOneJob(name: string, def: unknown): (RawJob & { matrixSpec?: MatrixSpec }) | null {
  if (!name || name.length > 64 || !isRecord(def)) return null;
  const stepsRaw = def.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0 || stepsRaw.length > MAX_STEPS_PER_JOB) return null;
  const steps: PipelineStep[] = [];
  const seenIds = new Set<string>();
  for (const s of stepsRaw) {
    if (!isRecord(s)) return null;
    const run = s.run;
    if (typeof run !== "string" || !run.trim() || run.length > MAX_RUN_LENGTH) return null;
    const step: PipelineStep = { run: run.trim() };
    if (s.id !== undefined) {
      if (typeof s.id !== "string" || !isValidOutputName(s.id) || seenIds.has(s.id)) return null;
      seenIds.add(s.id);
      step.id = s.id;
    }
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
  const job: RawJob & { matrixSpec?: MatrixSpec } = { name, steps, env: {}, needs: [], cancelInProgress: false };
  if (def.tags !== undefined) {
    const tags = asStringArray(def.tags, MAX_TAGS, 64);
    if (!tags || tags.some((t) => !PROFILE_NAME_RE.test(t))) return null;
    job.tags = [...new Set(tags)];
  }
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
    if (typeof key !== "string" || !isValidCacheKey(key)) return null;
    const paths = asStringArray(def.cache.paths, MAX_CACHE_PATHS, 256);
    if (!paths) return null;
    let restoreKeys: string[] | undefined;
    if (def.cache["restore-keys"] !== undefined) {
      const raw = asStringArray(def.cache["restore-keys"], MAX_RESTORE_KEYS, 200);
      if (!raw || !raw.every(isValidRestoreKey)) return null;
      restoreKeys = raw;
    }
    job.cache = restoreKeys ? { key, paths, restoreKeys } : { key, paths };
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
  if (def.shards !== undefined) {
    const n = def.shards;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 2 || n > MAX_SHARDS) return null;
    job.shards = n;
  }
  if (def.if !== undefined) {
    const cond = normalizeJobCondition(def.if);
    if (!cond) return null;
    job.if = cond;
  }
  if (def.outputs !== undefined) {
    if (!isRecord(def.outputs)) return null;
    const entries = Object.entries(def.outputs);
    if (entries.length === 0 || entries.length > MAX_JOB_OUTPUTS) return null;
    const outputs: Record<string, string> = {};
    for (const [name, ref] of entries) {
      if (!isValidOutputName(name) || typeof ref !== "string" || !parseOutputRef(ref)) return null;
      outputs[name] = ref;
    }
    job.outputs = outputs;
  }
  if (def["retain-on-failure"] !== undefined) {
    if (typeof def["retain-on-failure"] !== "boolean") return null;
    if (def["retain-on-failure"]) job.retainOnFailure = true;
  }
  if (def["browser-checks"] !== undefined) {
    if (!Array.isArray(def["browser-checks"])) return null;
    if (def["browser-checks"].length === 0 || def["browser-checks"].length > MAX_BROWSER_CHECKS) return null;
    const checks: PipelineBrowserCheck[] = [];
    const seen = new Set<string>();
    for (const c of def["browser-checks"]) {
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
      // https only: seats cannot reach operator localhost, and
      // plain-http assertions against staging hosts are a downgrade
      // footgun. Previews and prod are https.
      if (protocol !== "https:") return null;
      // Preview-URL templates ({branch}, {pr}, {sha}, {short_sha});
      // unknown vars and malformed braces fail the file, not the run.
      if (validatePreviewTemplate(c.url) !== null) return null;
      const check: PipelineBrowserCheck = { name: c.name, url: c.url };
      for (const [yamlKey, field] of [
        ["expect-title", "expectTitle"],
        ["expect-text", "expectText"],
      ] as const) {
        const v = c[yamlKey];
        if (v !== undefined) {
          if (typeof v !== "string" || !v || v.length > 512) return null;
          check[field] = v;
        }
      }
      // A check asserting nothing still bills a browser session —
      // fail closed so typos can't buy no-ops.
      if (check.expectTitle === undefined && check.expectText === undefined) return null;
      if (c.screenshot !== undefined) {
        if (typeof c.screenshot !== "boolean") return null;
        check.screenshot = c.screenshot;
      }
      if (c.actions !== undefined) {
        if (!Array.isArray(c.actions) || c.actions.length === 0 || c.actions.length > MAX_BROWSER_ACTIONS) return null;
        const actions: PipelineBrowserAction[] = [];
        for (const a of c.actions) {
          if (!isRecord(a)) return null;
          // Exactly one kind key; `text` rides `type` only (a text on
          // click/wait is a typo, not a comment — fail it).
          const kinds = (["click", "type", "wait", "wait-text"] as const).filter((k) => a[k] !== undefined);
          if (kinds.length !== 1) return null;
          const kind = kinds[0];
          if (kind === "wait-text") {
            const text = a[kind];
            if (typeof text !== "string" || !text || text.length > 512) return null;
            if (a.text !== undefined) return null;
            actions.push({ kind, text });
            continue;
          }
          const selector = a[kind];
          if (typeof selector !== "string" || !selector.trim() || selector.length > MAX_BROWSER_SELECTOR) return null;
          if (kind === "type") {
            if (typeof a.text !== "string" || !a.text || a.text.length > MAX_BROWSER_ACTION_TEXT) return null;
            actions.push({ kind, selector, text: a.text });
          } else {
            if (a.text !== undefined) return null;
            actions.push({ kind, selector });
          }
        }
        check.actions = actions;
      }
      checks.push(check);
    }
    job.browserChecks = checks;
  }
  if (def.egress !== undefined) {
    if (!isRecord(def.egress)) return null;
    const domains = parseEgressAllow(def.egress.allow);
    if (!domains) return null;
    job.egress = { allow: domains };
  }
  if (def["test-selection"] !== undefined) {
    // Explicit `false` disables; anything else must parse strictly.
    if (def["test-selection"] !== false) {
      const selection = parseTestSelectionConfig(def["test-selection"]);
      if (!selection) return null;
      job.testSelection = selection;
    }
  }
  if (def.strategy !== undefined) {
    if (!isRecord(def.strategy) || def.strategy.matrix === undefined) return null;
    const spec = parseMatrixSpec(def.strategy.matrix);
    if (typeof spec === "string") return null;
    job.matrixSpec = spec;
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

// CI profiles ($0-bill pattern): an optional `profiles` block maps a
// profile name to a job selection. Each include/exclude entry matches a
// job's base (pre-matrix) name or one of its `tags`. Absent include =
// every job; excludes apply after includes. A `defaults` mapping picks
// the profile per dispatch event; without any match every job runs, so
// pipelines without profiles behave exactly as before.
export interface PipelineProfile {
  include?: string[];
  exclude?: string[];
}

export const PROFILE_EVENTS = ["push", "pull_request", "schedule", "dispatch", "source"] as const;
export type ProfileEvent = (typeof PROFILE_EVENTS)[number];

export interface PipelineProfiles {
  profiles: Record<string, PipelineProfile>;
  defaults: Partial<Record<ProfileEvent, string>>;
}

export function emptyProfiles(): PipelineProfiles {
  return { profiles: {}, defaults: {} };
}

// Reserved inside `profiles`: the per-event default map, not a profile.
const DEFAULTS_KEY = "defaults";

function parseProfilesBlock(v: unknown): PipelineProfiles | null {
  if (v === undefined) return emptyProfiles();
  if (!isRecord(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > MAX_PROFILES + 1) return null;
  const profiles: Record<string, PipelineProfile> = {};
  let defaults: Partial<Record<ProfileEvent, string>> = {};
  for (const [name, def] of entries) {
    if (name === DEFAULTS_KEY) {
      if (!isRecord(def)) return null;
      const parsed: Partial<Record<ProfileEvent, string>> = {};
      for (const [event, target] of Object.entries(def)) {
        if (!(PROFILE_EVENTS as readonly string[]).includes(event)) return null;
        if (typeof target !== "string" || !PROFILE_NAME_RE.test(target)) return null;
        parsed[event as ProfileEvent] = target;
      }
      defaults = parsed;
      continue;
    }
    if (!PROFILE_NAME_RE.test(name)) return null;
    // A bare `name:` (null) selects everything, like an empty body.
    if (def === null) {
      profiles[name] = {};
      continue;
    }
    if (!isRecord(def)) return null;
    const profile: PipelineProfile = {};
    for (const key of ["include", "exclude"] as const) {
      const raw = def[key];
      if (raw === undefined) continue;
      const list = asStringArray(raw, MAX_PROFILE_ENTRIES, 64);
      if (!list) return null;
      profile[key] = [...new Set(list)];
    }
    profiles[name] = profile;
  }
  if (Object.keys(profiles).length > MAX_PROFILES) return null;
  // Event defaults must name a profile defined in the same block.
  for (const target of Object.values(defaults)) {
    if (!profiles[target]) return null;
  }
  return { profiles, defaults };
}

export interface ParsedPipeline {
  jobs: PipelineJob[];
  profiles: PipelineProfiles;
}

// Pure: parse + validate a flare.yml document. Returns null on any
// problem — the caller falls back to the default pipeline.
export function parsePipelineWithProfiles(text: string): ParsedPipeline | null {
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
  const parsedProfiles = parseProfilesBlock(doc.profiles);
  if (!parsedProfiles) return null;
  const entries = Object.entries(jobs);
  if (entries.length === 0 || entries.length > MAX_JOBS) return null;
  const raws: (RawJob & { matrixSpec?: MatrixSpec })[] = [];
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
  // Expand matrices and shards; the expanded total obeys the job cap.
  const out: PipelineJob[] = [];
  for (const r of raws) {
    const combos = r.matrixSpec ? expandMatrix(r.matrixSpec) : [null];
    const shardCount = r.shards ?? 1;
    for (const combo of combos) {
      const matrix = combo ?? undefined;
      for (let shard = 1; shard <= shardCount; shard++) {
        const parts: string[] = [];
        if (combo) parts.push(...Object.entries(combo).map(([k, v]) => `${k}=${v}`));
        if (shardCount > 1) parts.push(`shard=${shard}/${shardCount}`);
        const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        const name = `${r.name}${suffix}`;
        if (name.length > 128) return null;
        const steps = r.steps.map((s) => ({ ...s, run: interpolateRun(s.run, matrix ?? {}, r.env) }));
        const job: PipelineJob = { name, steps };
        if (combo || shardCount > 1) job.base = r.name;
        if (r.tags) job.tags = r.tags;
        if (r.labels) {
          const labels = matrix ? cellLabels(r.labels, matrix) : r.labels;
          if (!labels) return null;
          job.labels = labels;
        }
        if (matrix) job.matrix = matrix;
        const env = { ...r.env };
        if (shardCount > 1) {
          env.FLARE_SHARD_INDEX = String(shard);
          env.FLARE_SHARD_TOTAL = String(shardCount);
        }
        if (Object.keys(env).length > 0) job.env = env;
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
        if (r.outputs) job.outputs = r.outputs;
        if (r.retainOnFailure !== undefined) job.retainOnFailure = r.retainOnFailure;
        if (r.browserChecks) job.browserChecks = r.browserChecks;
        if (r.egress) job.egress = r.egress;
        if (r.testSelection) job.testSelection = r.testSelection;
        out.push(job);
      }
    }
  }
  if (out.length > MAX_JOBS) return null;
  return { jobs: out, profiles: parsedProfiles };
}

export function parsePipeline(text: string): PipelineJob[] | null {
  return parsePipelineWithProfiles(text)?.jobs ?? null;
}

export interface ProfileSelection {
  // Explicit override (API/MCP/CLI `--profile`); wins over everything.
  override?: string;
  // Firing schedule's pinned profile; wins over event defaults.
  scheduleProfile?: string;
  // Dispatch event; picks the `defaults` mapping.
  event?: string;
}

function profileMatches(job: PipelineJob, entry: string): boolean {
  if ((job.base ?? job.name) === entry) return true;
  return (job.tags ?? []).includes(entry);
}

// Pure: narrow expanded jobs to one profile. No match (no override, no
// schedule profile, no event default) returns the input untouched, so
// pipelines without profiles behave exactly as before. `needs` edges
// into excluded jobs are dropped — excluded jobs never run, so a
// surviving job must not wait on them.
export function selectProfileJobs(
  jobs: PipelineJob[],
  doc: PipelineProfiles,
  selection: ProfileSelection,
): { jobs: PipelineJob[]; profile: string | null } | { error: string } {
  const available = Object.keys(doc.profiles);
  const unknown = (name: string): string =>
    available.length === 0
      ? `unknown profile "${name}" (pipeline defines no profiles)`
      : `unknown profile "${name}" (available: ${available.join(", ")})`;
  let name: string | null = null;
  if (selection.override) {
    if (!doc.profiles[selection.override]) return { error: unknown(selection.override) };
    name = selection.override;
  } else if (selection.scheduleProfile) {
    if (!doc.profiles[selection.scheduleProfile]) return { error: unknown(selection.scheduleProfile) };
    name = selection.scheduleProfile;
  } else if (selection.event && doc.defaults[selection.event as ProfileEvent]) {
    const target = doc.defaults[selection.event as ProfileEvent];
    if (target === undefined || !doc.profiles[target]) return { error: unknown(target ?? selection.event) };
    name = target;
  }
  if (!name) return { jobs, profile: null };
  const profile = doc.profiles[name];
  let selected = jobs;
  const include = profile.include;
  if (include && include.length > 0) {
    selected = selected.filter((job) => include.some((entry) => profileMatches(job, entry)));
  }
  const exclude = profile.exclude;
  if (exclude && exclude.length > 0) {
    selected = selected.filter((job) => !exclude.some((entry) => profileMatches(job, entry)));
  }
  if (selected.length === 0) return { error: `profile "${name}" selected no jobs` };
  const bases = new Set(selected.map((job) => job.base ?? job.name));
  const out = selected.map((job) => {
    if (!job.needs) return job;
    return { ...job, needs: job.needs.filter((dep) => bases.has(dep)) };
  });
  return { jobs: out, profile: name };
}

// The JSON stored in jobs.definition: everything the runner and the
// scheduler need. `base` is the pre-matrix job name for needs matching.
export function serializeDefinition(job: PipelineJob, baseName: string): string {
  return JSON.stringify({
    steps: job.steps,
    base: baseName,
    tags: job.tags,
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
    outputs: job.outputs,
    retainOnFailure: job.retainOnFailure,
    browserChecks: job.browserChecks,
    egress: job.egress,
    testSelection: job.testSelection,
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
    const cond = normalizeJobCondition(parsed["if"]);
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
