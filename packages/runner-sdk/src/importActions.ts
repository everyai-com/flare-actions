import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { normalizeStepCondition } from "./spec.ts";
import { MAX_RESTORE_KEYS } from "./parity.ts";

// GitHub Actions workflow -> flare.yml translator. Pure and lossless
// where the models overlap; everything else becomes a warning so the
// operator sees exactly what needs a human eye.

export interface ImportSuccess {
  yaml: string;
  warnings: string[];
}

export interface ImportFailure {
  error: string;
}

export type ImportResult = ImportSuccess | ImportFailure;

export function isImportSuccess(r: ImportResult): r is ImportSuccess {
  return !("error" in r);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strList(v: unknown): string[] | null {
  const list = typeof v === "string" ? v.split("\n").map((s) => s.trim()).filter(Boolean) : v;
  if (!Array.isArray(list) || list.length === 0) return null;
  if (!list.every((s): s is string => typeof s === "string" && !!s.trim())) return null;
  return list.map((s) => s.trim());
}

// Well-known hosted labels become portable runner labels; anything
// else passes through verbatim for label-matched BYO runners.
export function mapRunsOn(v: unknown): string[] | null {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) return null;
    const label = item.trim();
    if (/^ubuntu-/.test(label)) out.push("linux");
    else if (/^macos-/.test(label)) out.push("macos");
    else if (/^windows-/.test(label)) out.push("windows");
    else out.push(label);
  }
  return [...new Set(out)];
}

// Expression-laden keys (runner.os, hashFiles, ...) cannot transfer;
// collapse them into a static, server-legal key and warn.
export function sanitizeCacheKey(raw: string): string {
  const flat = raw
    .replace(/\$\{\{[^}]*\}\}/g, "expr")
    .replace(/[^A-Za-z0-9_.\-/]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-/]+/, "")
    .slice(0, 200);
  return flat || "cache";
}

const TOOLCHAIN_CHECKS: [RegExp, string][] = [
  [/^actions\/setup-node@/i, "node --version"],
  [/^actions\/setup-python@/i, "python3 --version"],
  [/^actions\/setup-go@/i, "go version"],
  [/^actions\/setup-java@/i, "java -version"],
  [/^actions\/setup-ruby@/i, "ruby --version"],
];

interface JobAcc {
  steps: { run: string; "continue-on-error"?: boolean; if?: string; "timeout-minutes"?: number; shell?: string }[];
  env: Record<string, string>;
  cachePaths: string[];
  cacheKey: string | null;
  cacheRestoreKeys: string[];
  artifactPaths: string[];
  artifactName: string | null;
}

function convertUses(
  uses: string,
  withBlock: Record<string, unknown>,
  acc: JobAcc,
  warnings: string[],
  jobId: string,
  cond?: string,
): void {
  if (/^actions\/checkout@/i.test(uses)) {
    warnings.push(`${jobId}: dropped actions/checkout (flare checks out natively)`);
    return;
  }
  for (const [re, check] of TOOLCHAIN_CHECKS) {
    if (re.test(uses)) {
      const ver = withBlock["node-version"] ?? withBlock["python-version"] ?? withBlock["go-version"] ?? withBlock["java-version"] ?? withBlock["ruby-version"];
      warnings.push(
        `${jobId}: ${uses} became \`${check}\` — install the toolchain on your runner${ver ? ` (wanted ${String(ver)})` : ""}`,
      );
      acc.steps.push({ run: check, ...(cond ? { if: cond } : {}) });
      return;
    }
  }
  if (/^actions\/cache@|^actions\/cache\/(restore|save)@/i.test(uses)) {
    const paths = strList(withBlock.path);
    const key = typeof withBlock.key === "string" ? withBlock.key : null;
    if (paths && key) {
      acc.cachePaths.push(...paths);
      if (!acc.cacheKey) acc.cacheKey = sanitizeCacheKey(key);
      if (/\$\{\{/.test(key)) warnings.push(`${jobId}: cache key had expressions, staticized to \`${sanitizeCacheKey(key)}\``);
      // restore-keys is usually a multiline string; strList splits it.
      // Sanitized like keys (same charset), capped so the imported
      // file always validates.
      const restores = strList(withBlock["restore-keys"]);
      if (restores) {
        for (const r of restores) {
          const clean = sanitizeCacheKey(r);
          if (!acc.cacheRestoreKeys.includes(clean)) acc.cacheRestoreKeys.push(clean);
        }
        if (acc.cacheRestoreKeys.length > MAX_RESTORE_KEYS) {
          warnings.push(`${jobId}: trimmed restore-keys to ${MAX_RESTORE_KEYS}`);
          acc.cacheRestoreKeys.length = MAX_RESTORE_KEYS;
        }
      }
    } else {
      warnings.push(`${jobId}: dropped actions/cache (needs path + key)`);
    }
    return;
  }
  if (/^actions\/upload-artifact@/i.test(uses)) {
    const paths = strList(withBlock.path);
    if (paths) {
      acc.artifactPaths.push(...paths);
      if (!acc.artifactName && typeof withBlock.name === "string" && withBlock.name.trim()) {
        acc.artifactName = withBlock.name.trim().slice(0, 128);
      }
    } else {
      warnings.push(`${jobId}: dropped upload-artifact (needs path)`);
    }
    return;
  }
  warnings.push(`${jobId}: dropped unsupported action ${uses}`);
}

function convertStep(step: unknown, acc: JobAcc, warnings: string[], jobId: string, workdir: string | null): void {
  if (!isRecord(step)) {
    warnings.push(`${jobId}: dropped a malformed step`);
    return;
  }
  // Bounded conditional subset: translate the supported forms, warn on
  // anything else instead of guessing at expression soup.
  let cond: string | undefined;
  if (step.if !== undefined) {
    const norm = normalizeStepCondition(step.if);
    if (norm) cond = norm;
    else warnings.push(`${jobId}: dropped unsupported step condition \`${String(step.if)}\``);
  }
  const shell =
    typeof step.shell === "string" && /^(sh|bash)$/i.test(step.shell.trim()) ? step.shell.trim().toLowerCase() : undefined;
  if (step.shell !== undefined && shell === undefined) {
    warnings.push(`${jobId}: dropped unsupported step shell \`${String(step.shell)}\``);
  }
  let stepTimeout: number | undefined;
  if (step["timeout-minutes"] !== undefined) {
    const t = step["timeout-minutes"];
    if (typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= 180) {
      stepTimeout = t;
    } else {
      warnings.push(`${jobId}: dropped invalid step timeout-minutes`);
    }
  }
  const stepEnv = isRecord(step.env) ? step.env : null;
  if (stepEnv) {
    for (const [k, v] of Object.entries(stepEnv)) {
      if (acc.env[k] !== undefined) warnings.push(`${jobId}: step env ${k} overrode job env`);
      acc.env[k] = String(v);
    }
  }
  if (typeof step.uses === "string" && step.uses.trim()) {
    convertUses(step.uses.trim(), isRecord(step.with) ? step.with : {}, acc, warnings, jobId, cond);
    return;
  }
  if (typeof step.run === "string" && step.run.trim()) {
    let run = step.run.trim();
    if (workdir) run = `(cd ${JSON.stringify(workdir)} &&\n${run}\n)`;
    const out: { run: string; "continue-on-error"?: boolean; if?: string; "timeout-minutes"?: number; shell?: string } = { run };
    if (step["continue-on-error"] === true) {
      out["continue-on-error"] = true;
    } else if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false) {
      warnings.push(`${jobId}: non-boolean continue-on-error ignored`);
    }
    if (cond) out.if = cond;
    if (stepTimeout !== undefined) out["timeout-minutes"] = stepTimeout;
    if (shell) out.shell = shell;
    acc.steps.push(out);
    return;
  }
  warnings.push(`${jobId}: dropped a step with neither run nor uses`);
}

export function convertActionsWorkflow(text: string): ImportResult {
  if (!text.trim()) return { error: "empty workflow" };
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { error: `invalid YAML: ${String(err).slice(0, 200)}` };
  }
  if (!isRecord(doc) || !isRecord(doc.jobs) || Object.keys(doc.jobs).length === 0) {
    return { error: "no jobs map found" };
  }
  const warnings: string[] = [];
  if (doc.on !== undefined) {
    const on = doc.on;
    const hasSchedule =
      (isRecord(on) && on.schedule !== undefined) || (Array.isArray(on) && on.includes("schedule")) || on === "schedule";
    warnings.push(
      hasSchedule
        ? "triggers (on:) ignored — configure cron schedules in the dashboard (Settings → Schedules)"
        : "triggers (on:) ignored — flare runs on push/PR webhooks",
    );
  }
  if (doc.permissions !== undefined) warnings.push("top-level permissions ignored — flare uses GitHub App permissions");
  const topEnv = isRecord(doc.env) ? doc.env : null;
  const topConcurrency = doc.concurrency;

  const jobs: Record<string, unknown> = {};
  for (const [jobId, jobDef] of Object.entries(doc.jobs)) {
    if (!isRecord(jobDef)) {
      warnings.push(`${jobId}: dropped (not a map)`);
      continue;
    }
    const acc: JobAcc = { steps: [], env: {}, cachePaths: [], cacheKey: null, cacheRestoreKeys: [], artifactPaths: [], artifactName: null };
    if (topEnv) for (const [k, v] of Object.entries(topEnv)) acc.env[k] = String(v);
    if (isRecord(jobDef.env)) for (const [k, v] of Object.entries(jobDef.env)) acc.env[k] = String(v);
    const workdir =
      isRecord(jobDef.defaults) && isRecord(jobDef.defaults.run) && typeof jobDef.defaults.run["working-directory"] === "string"
        ? (jobDef.defaults.run["working-directory"] as string)
        : null;
    if (workdir) warnings.push(`${jobId}: working-directory \`${workdir}\` wrapped into cd subshells`);
    if (isRecord(jobDef.defaults) && isRecord(jobDef.defaults.run) && jobDef.defaults.run.shell !== undefined) {
      warnings.push(`${jobId}: custom default shell ignored (steps run under sh)`);
    }
    const steps = Array.isArray(jobDef.steps) ? jobDef.steps : [];
    for (const step of steps) convertStep(step, acc, warnings, jobId, workdir);
    if (acc.steps.length === 0) {
      warnings.push(`${jobId}: dropped (no runnable steps left)`);
      continue;
    }
    const out: Record<string, unknown> = {};
    if (jobDef["runs-on"] !== undefined) {
      const labels = mapRunsOn(jobDef["runs-on"]);
      if (labels) out["runs-on"] = labels.length === 1 ? labels[0] : labels;
      else warnings.push(`${jobId}: dropped unparseable runs-on`);
    }
    if (Object.keys(acc.env).length > 0) out.env = acc.env;
    if (jobDef.needs !== undefined) {
      const needs = strList(typeof jobDef.needs === "string" ? [jobDef.needs] : jobDef.needs);
      if (needs) out.needs = needs.length === 1 ? needs[0] : needs;
      else warnings.push(`${jobId}: dropped unparseable needs`);
    }
    if (isRecord(jobDef.strategy) && isRecord(jobDef.strategy.matrix)) {
      const matrix: Record<string, unknown[]> = {};
      for (const [k, vals] of Object.entries(jobDef.strategy.matrix)) {
        if (Array.isArray(vals) && vals.length > 0) matrix[k] = vals;
        else warnings.push(`${jobId}: dropped matrix axis ${k} (needs a non-empty list)`);
      }
      if (Object.keys(matrix).length > 0) out.strategy = { matrix };
      if (jobDef.strategy["fail-fast"] !== undefined) warnings.push(`${jobId}: strategy.fail-fast ignored`);
      if (jobDef.strategy["max-parallel"] !== undefined) warnings.push(`${jobId}: strategy.max-parallel ignored`);
    }
    const concurrency = jobDef.concurrency ?? topConcurrency;
    if (typeof concurrency === "string" && concurrency.trim()) out.concurrency = concurrency.trim();
    else if (isRecord(concurrency) && typeof concurrency.group === "string" && concurrency.group.trim()) {
      const c: Record<string, unknown> = { group: concurrency.group.trim() };
      if (concurrency["cancel-in-progress"] === true) c["cancel-in-progress"] = true;
      out.concurrency = c;
    }
    if (typeof jobDef.container === "string" && jobDef.container.trim()) {
      out.container = jobDef.container.trim();
    } else if (isRecord(jobDef.container) && typeof jobDef.container.image === "string") {
      out.container = jobDef.container.image;
      warnings.push(`${jobId}: container options/volumes ignored (image kept)`);
    }
    if (isRecord(jobDef.services)) {
      const services: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(jobDef.services)) {
        if (!isRecord(def) || typeof def.image !== "string") {
          warnings.push(`${jobId}: dropped service ${name} (needs image)`);
          continue;
        }
        const svc: Record<string, unknown> = { image: def.image };
        const ports = strList(def.ports);
        if (ports) svc.ports = ports.map(String);
        if (isRecord(def.env)) {
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(def.env)) env[k] = String(v);
          svc.env = env;
        }
        services[name] = svc;
      }
      if (Object.keys(services).length > 0) out.services = services;
    }
    if (acc.cacheKey && acc.cachePaths.length > 0) {
      out.cache = {
        key: acc.cacheKey,
        paths: [...new Set(acc.cachePaths)],
        ...(acc.cacheRestoreKeys.length > 0 ? { "restore-keys": acc.cacheRestoreKeys } : {}),
      };
    }
    if (acc.artifactPaths.length > 0) {
      const artifacts: Record<string, unknown> = { paths: [...new Set(acc.artifactPaths)] };
      if (acc.artifactName) artifacts.name = acc.artifactName;
      out.artifacts = artifacts;
    }
    if (typeof jobDef["timeout-minutes"] === "number" && jobDef["timeout-minutes"] > 0) {
      out["timeout-minutes"] = Math.floor(jobDef["timeout-minutes"]);
    }
    // Bounded job-level condition, same subset as steps: the scheduler
    // treats `success()` (default) as skip-after-failed-need and
    // `always()`/`failure()` as run. Everything else is warned.
    if (jobDef.if !== undefined) {
      const norm = normalizeStepCondition(jobDef.if);
      if (norm) out.if = norm;
      else warnings.push(`${jobId}: dropped unsupported job condition \`${String(jobDef.if)}\``);
    }
    if (jobDef.outputs !== undefined) warnings.push(`${jobId}: job outputs ignored`);
    out.steps = acc.steps;
    jobs[jobId] = out;
  }
  if (Object.keys(jobs).length === 0) return { error: "no convertible jobs (see warnings)" };
  return { yaml: stringifyYaml({ jobs }), warnings: warnings.slice(0, 50) };
}
