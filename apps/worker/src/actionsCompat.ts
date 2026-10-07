import { parse as parseYaml } from "yaml";
import { convertActionsWorkflow, isImportSuccess } from "../../../packages/runner-sdk/src/importActions.ts";
import { MAX_JOBS, normalizeStepCondition, parsePipeline, type PipelineJob } from "./pipeline.ts";

// Native `.github/workflows` compatibility: when a repo has no flare.yml
// at the commit, matching GitHub Actions workflow files are fetched,
// translated with the same converter `cli import` uses, merged into one
// run, and executed. flare.yml always wins when present — this is the
// zero-step migration path, not a replacement.
//
// Deliberately bounded, same policy as the importer: JS/container
// `uses:` steps are dropped with warnings, triggers are matched (not
// evaluated), and expressions outside the supported set are scrubbed
// with warnings instead of guessed at.

export const GHA_WORKFLOWS_DIR = ".github/workflows";
export const MAX_WORKFLOW_FILES = 10;
export const MAX_WORKFLOW_BYTES = 64 * 1024;
export const WORKFLOW_FETCH_TIMEOUT_MS = 5000;
const MAX_PREFIX_LENGTH = 24;
const MAX_COMPAT_NAME_LENGTH = 160;
const MAX_WARNINGS = 50;

export interface WorkflowEventContext {
  // Our run event: "push" | "pull_request" | "dispatch" | "schedule".
  event: string;
  branch?: string;
  // Pull requests match `on.pull_request.branches` against the base ref.
  baseBranch?: string;
  // Tag pushes: branch is empty, the tag name rides here.
  tag?: string;
  // Firing cron for schedule events (strict match against on.schedule).
  cron?: string;
  // owner/name, for `github.repository` guards.
  repo?: string;
  // Changed files (push compare / PR file list); undefined or empty means
  // unknown, and `paths:` filters then run conservatively.
  changedFiles?: string[];
}

export interface WorkflowFile {
  name: string;
  text: string;
}

export interface CompatRun {
  jobs: PipelineJob[] | null;
  warnings: string[];
  // Workflow file names that contributed jobs (for logs).
  used: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): string[] | null {
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item.trim()) return null;
    out.push(item.trim());
  }
  return out;
}

function normalizeCron(cron: string): string {
  return cron.trim().split(/\s+/).join(" ");
}

// Bounded branch glob: `*` stops at `/`, `**` crosses, `?` is one char.
// Patterns are used as-is otherwise (regex-escaped), matching git's
// case-sensitive refs.
export function matchBranchGlob(pattern: string, value: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

// GitHub branch filter lists: a positive match is required when any
// positive pattern exists, and any matching `!` pattern excludes.
function matchBranchPatterns(patterns: string[], branch: string): boolean {
  let hasPositive = false;
  let positive = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    if (!pattern) continue;
    if (matchBranchGlob(pattern, branch)) {
      if (negated) return false;
      positive = true;
    }
    if (!negated) hasPositive = true;
  }
  return hasPositive ? positive : true;
}

function normalizeOn(on: unknown): Record<string, unknown> | null {
  if (typeof on === "string") return on.trim() ? { [on.trim()]: null } : null;
  if (Array.isArray(on)) {
    const map: Record<string, unknown> = {};
    for (const item of on) {
      if (typeof item === "string" && item.trim()) map[item.trim()] = null;
    }
    return Object.keys(map).length > 0 ? map : null;
  }
  if (isRecord(on)) return on;
  return null;
}

function scheduleCrons(schedule: unknown): string[] {
  const list = Array.isArray(schedule) ? schedule : [schedule];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry.trim()) out.push(normalizeCron(entry));
    else if (isRecord(entry) && typeof entry.cron === "string" && entry.cron.trim()) {
      out.push(normalizeCron(entry.cron));
    }
  }
  return out;
}

// Path filters (`paths` / `paths-ignore`): a changed-file list that is
// unknown (fetch failed, empty) never filters — a GitHub hiccup must not
// silently skip a workflow. A known list evaluates like Actions: any file
// passing the positive patterns triggers; any file hitting an ignore
// pattern suppresses.
function matchPathFilters(cfg: Record<string, unknown>, ctx: WorkflowEventContext): boolean {
  const paths = strArray(cfg.paths);
  const ignore = strArray(cfg["paths-ignore"]);
  if (!paths && !ignore) return true;
  const files = ctx.changedFiles;
  if (!files || files.length === 0) return true;
  if (paths && !files.some((file) => matchBranchPatterns(paths, file))) return false;
  if (ignore && files.some((file) => matchBranchPatterns(ignore, file))) return false;
  return true;
}

// Pure: does an `on:` block select this run's event? Unknown trigger
// kinds never match — a workflow for an event we do not deliver is
// skipped, never guessed into a run.
export function matchesWorkflowEvent(on: unknown, ctx: WorkflowEventContext): boolean {
  const map = normalizeOn(on);
  if (!map) return false;
  if (ctx.event === "push") {
    if (!("push" in map)) return false;
    const cfg = map.push;
    if (!isRecord(cfg)) return true;
    const branches = strArray(cfg.branches);
    const ignore = strArray(cfg["branches-ignore"]);
    const tags = strArray(cfg.tags);
    if (ctx.branch) {
      if (branches && !matchBranchPatterns(branches, ctx.branch)) return false;
      if (ignore && ignore.some((p) => matchBranchGlob(p, ctx.branch as string))) return false;
      return matchPathFilters(cfg, ctx);
    }
    // Tag push (branch === ""): branch filters never match, tag filters
    // decide when present, and untagged filters alone still run.
    if (branches || ignore) return false;
    if (tags) return ctx.tag ? matchBranchPatterns(tags, ctx.tag) : false;
    return matchPathFilters(cfg, ctx);
  }
  if (ctx.event === "pull_request") {
    if (!("pull_request" in map)) return false;
    const cfg = map.pull_request;
    if (isRecord(cfg)) {
      const target = ctx.baseBranch ?? ctx.branch ?? "";
      const branches = strArray(cfg.branches);
      const ignore = strArray(cfg["branches-ignore"]);
      if (branches && !matchBranchPatterns(branches, target)) return false;
      if (ignore && ignore.some((p) => matchBranchGlob(p, target))) return false;
      if (!matchPathFilters(cfg, ctx)) return false;
    }
    return true;
  }
  if (ctx.event === "dispatch") return "workflow_dispatch" in map;
  if (ctx.event === "schedule") {
    if (!("schedule" in map)) return false;
    if (!ctx.cron) return true;
    const crons = scheduleCrons(map.schedule);
    if (crons.length === 0) return true;
    return crons.some((c) => c === normalizeCron(ctx.cron as string));
  }
  return false;
}

// Bounded evaluator for the common job guards. A guard we cannot
// evaluate would otherwise run a job GitHub would have skipped — for
// deploy/preview jobs that is the difference between a no-op and a
// wrong-branch release, so the shapes every real workflow uses
// (event_name / ref / ref_name / repository comparisons) are decided
// here. Anything else returns undefined and keeps the translator's
// drop-with-warning behavior.
export function evaluateCommonCondition(raw: unknown, ctx: WorkflowEventContext): boolean | undefined {
  if (typeof raw !== "string") return undefined;
  const wrapped = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(raw.trim());
  let expr = (wrapped ? wrapped[1] : raw).trim();
  let negate = false;
  while (expr.startsWith("!")) {
    negate = !negate;
    expr = expr.slice(1).trim();
  }
  const cmp = /^(github\.(?:event_name|ref|ref_name|repository))\s*(==|!=)\s*(.+)$/.exec(expr);
  if (!cmp) return undefined;
  const [, lhs, op, rhsRaw] = cmp;
  const quoted = /^'([^']*)'$/.exec(rhsRaw.trim()) ?? /^"([^"]*)"$/.exec(rhsRaw.trim());
  if (!quoted) return undefined;
  const rhs = quoted[1];
  let actual: string | undefined;
  if (lhs === "github.event_name") {
    actual = ctx.event === "dispatch" ? "workflow_dispatch" : ctx.event;
  } else if (lhs === "github.ref") {
    actual = ctx.branch ? `refs/heads/${ctx.branch}` : ctx.tag ? `refs/tags/${ctx.tag}` : undefined;
  } else if (lhs === "github.ref_name") {
    actual = ctx.branch || ctx.tag || undefined;
  } else {
    actual = ctx.repo;
  }
  if (actual === undefined) return undefined;
  const same = actual === rhs;
  const value = op === "==" ? same : !same;
  return negate ? !value : value;
}

// `${{ github.* }}` has no expression evaluator here; the supported
// keys map onto the executor's FLARE_* environment (runner-sdk and
// seats set them), which keeps the emitted shell valid. `secrets.*`
// stays for executor-side interpolation. Everything else is scrubbed
// with a warning rather than left to break the shell.
const GITHUB_BUILTINS: [RegExp, string][] = [
  [/^github\.sha$/i, "${FLARE_SHA}"],
  [/^github\.repository$/i, "${FLARE_REPO}"],
  [/^github\.run_id$/i, "${FLARE_RUN_ID}"],
  [/^github\.job$/i, "${FLARE_JOB_ID}"],
  [/^github\.ref_name$/i, "${FLARE_REF}"],
  [/^github\.head_ref$/i, "${FLARE_REF}"],
  [/^github\.ref$/i, "refs/heads/${FLARE_REF}"],
  [/^github\.workflow$/i, "${FLARE_WORKFLOW}"],
];

export function mapGithubExpressions(text: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const out = text.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (match, exprRaw: string) => {
    const expr = exprRaw.trim();
    for (const [re, replacement] of GITHUB_BUILTINS) {
      if (re.test(expr)) return replacement;
    }
    if (/^secrets\./i.test(expr) || /^env\./i.test(expr) || /^matrix\./i.test(expr)) return match;
    dropped.push(expr);
    return "";
  });
  return { text: out, dropped };
}

export interface TranslatedWorkflow {
  name: string;
  jobs: PipelineJob[] | null;
  warnings: string[];
}

// Translate one workflow file into validated PipelineJobs. Returns
// null jobs (with warnings) for invalid or unconvertible files so one
// bad workflow cannot kill a whole run.
export function translateWorkflow(
  text: string,
  fallbackName: string,
  ctx: WorkflowEventContext | null = null,
): TranslatedWorkflow {
  const warnings: string[] = [];
  let name = fallbackName;
  let doc: unknown;
  try {
    doc = parseYaml(text);
    if (isRecord(doc) && typeof doc.name === "string" && doc.name.trim()) {
      name = doc.name.trim().slice(0, 60);
    }
  } catch {
    // convertActionsWorkflow reports the parse error below
  }
  // Job guards outside the bounded subset are evaluated when possible: a
  // false guard skips the job exactly like Actions would, instead of
  // running a deploy the author gated to another event.
  const skipped = new Set<string>();
  if (ctx && isRecord(doc) && isRecord(doc.jobs)) {
    for (const [jobId, def] of Object.entries(doc.jobs)) {
      if (!isRecord(def) || def.if === undefined) continue;
      if (normalizeStepCondition(def.if)) continue;
      if (evaluateCommonCondition(def.if, ctx) === false) {
        skipped.add(jobId);
        warnings.push(`${name}: job ${jobId} skipped (condition \`${String(def.if)}\` is false for this event)`);
      }
    }
  }
  const converted = convertActionsWorkflow(text);
  if (!isImportSuccess(converted)) {
    return { name, jobs: null, warnings: [`${fallbackName}: skipped (${converted.error})`] };
  }
  warnings.push(...converted.warnings.map((w) => `${name}: ${w}`));
  const parsed = parsePipeline(converted.yaml);
  if (!parsed) {
    return { name, jobs: null, warnings: [...warnings, `${name}: skipped (translated pipeline failed validation)`] };
  }
  const dropped = new Set<string>();
  const jobs: PipelineJob[] = [];
  for (const job of parsed) {
    if (skipped.has(job.base ?? job.name)) continue;
    const steps = [];
    for (const step of job.steps) {
      const mapped = mapGithubExpressions(step.run);
      step.run = mapped.text.trim();
      for (const expr of mapped.dropped) dropped.add(expr);
      if (step.run) steps.push(step);
      else warnings.push(`${name}: dropped a step whose run was only unsupported expressions`);
    }
    if (steps.length === 0) {
      warnings.push(`${name}: dropped job ${job.name} (no runnable steps after expression mapping)`);
      continue;
    }
    const env = { ...(job.env ?? {}) };
    for (const [key, value] of Object.entries(env)) {
      const mapped = mapGithubExpressions(value);
      env[key] = mapped.text;
      for (const expr of mapped.dropped) dropped.add(expr);
    }
    jobs.push({ ...job, steps, ...(Object.keys(env).length > 0 ? { env } : {}) });
  }
  if (dropped.size > 0) {
    const list = [...dropped].slice(0, 8).join(", ");
    warnings.push(`${name}: unsupported expressions scrubbed: ${list}${dropped.size > 8 ? ", …" : ""}`);
  }
  return { name, jobs: jobs.length > 0 ? jobs : null, warnings };
}

// Merge per-file translations into one job list. Multiple files get a
// `<workflow>: ` prefix on base names and needs (Actions `needs` is
// workflow-scoped, so per-file validation then prefixing is exact);
// FLARE_WORKFLOW rides each job's env either way.
export function mergeWorkflows(items: { name: string; jobs: PipelineJob[] }[]): {
  jobs: PipelineJob[] | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (items.length === 0) return { jobs: null, warnings };
  const single = items.length === 1;
  const out: PipelineJob[] = [];
  for (const item of items) {
    const prefix = single ? "" : `${item.name.slice(0, MAX_PREFIX_LENGTH)}: `;
    for (const job of item.jobs) {
      const name = prefix + job.name;
      if (name.length > MAX_COMPAT_NAME_LENGTH) {
        return { jobs: null, warnings: [...warnings, `${item.name}: job names exceed the supported length after prefixing`] };
      }
      const merged: PipelineJob = { ...job, name, steps: job.steps.map((s) => ({ ...s })) };
      if (job.base) merged.base = prefix + job.base;
      if (job.needs) merged.needs = job.needs.map((n) => prefix + n);
      merged.env = { ...(job.env ?? {}) };
      if (!merged.env.FLARE_WORKFLOW) merged.env.FLARE_WORKFLOW = item.name;
      out.push(merged);
    }
  }
  if (out.length > MAX_JOBS) {
    return { jobs: null, warnings: [...warnings, `merged workflows exceed the ${MAX_JOBS}-job cap`] };
  }
  return { jobs: out, warnings };
}

// Pure: pick + translate + merge. `ctx` null runs every file (used by
// the local CLI, where the developer is the trigger).
export function buildCompatJobs(files: WorkflowFile[], ctx: WorkflowEventContext | null): CompatRun {
  const warnings: string[] = [];
  const translated: { name: string; jobs: PipelineJob[] }[] = [];
  const used: string[] = [];
  for (const file of files) {
    const fallback = file.name.replace(/\.ya?ml$/i, "");
    let on: unknown;
    try {
      const doc = parseYaml(file.text);
      on = isRecord(doc) ? doc.on : undefined;
    } catch {
      warnings.push(`${file.name}: skipped (invalid YAML)`);
      continue;
    }
    if (on === undefined) {
      warnings.push(`${file.name}: skipped (no on: triggers)`);
      continue;
    }
    if (ctx && !matchesWorkflowEvent(on, ctx)) continue;
    const result = translateWorkflow(file.text, fallback, ctx);
    warnings.push(...result.warnings);
    if (!result.jobs) continue;
    translated.push({ name: result.name, jobs: result.jobs });
    used.push(file.name);
  }
  if (translated.length === 0) {
    return { jobs: null, warnings: warnings.slice(0, MAX_WARNINGS), used };
  }
  const merged = mergeWorkflows(translated);
  warnings.push(...merged.warnings);
  return { jobs: merged.jobs, warnings: warnings.slice(0, MAX_WARNINGS), used };
}

export interface WorkflowFetch {
  files: WorkflowFile[];
  warnings: string[];
}

interface WorkflowListing {
  name: string;
  downloadUrl: string | null;
  path: string | null;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(WORKFLOW_FETCH_TIMEOUT_MS) });
}

// List `.github/workflows` at repo@sha and fetch each YAML file. Mirrors
// fetchPipeline's split: unauthenticated works for public repos, the
// installation token is required for private ones. A 404 is definitive
// (no workflows); other failures fall through to the next attempt.
export async function fetchWorkflowFiles(
  repo: string,
  sha: string,
  installationToken: string | null,
): Promise<WorkflowFetch | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w.-]+$/.test(sha)) return null;
  const listingUrl = `https://api.github.com/repos/${repo}/contents/${GHA_WORKFLOWS_DIR}?ref=${sha}`;
  const attempts: (string | null)[] = installationToken ? [installationToken, null] : [null];
  let entries: unknown = null;
  for (const token of attempts) {
    try {
      const headers: Record<string, string> = {
        "User-Agent": "flare-actions",
        Accept: "application/vnd.github+json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetchWithTimeout(listingUrl, headers);
      if (res.status === 404) return null;
      if (!res.ok) continue;
      entries = await res.json();
      break;
    } catch {
      continue;
    }
  }
  if (!Array.isArray(entries)) return null;
  const warnings: string[] = [];
  const listed: WorkflowListing[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "file" || typeof entry.name !== "string") continue;
    if (!/\.ya?ml$/i.test(entry.name)) continue;
    listed.push({
      name: entry.name,
      downloadUrl: typeof entry.download_url === "string" ? entry.download_url : null,
      path: typeof entry.path === "string" ? entry.path : null,
    });
  }
  listed.sort((a, b) => a.name.localeCompare(b.name));
  if (listed.length === 0) return null;
  const picked = listed.slice(0, MAX_WORKFLOW_FILES);
  if (listed.length > MAX_WORKFLOW_FILES) {
    warnings.push(`${GHA_WORKFLOWS_DIR}: using the first ${MAX_WORKFLOW_FILES} of ${listed.length} workflow files`);
  }
  const files: WorkflowFile[] = [];
  for (const item of picked) {
    let text: string | null = null;
    if (item.downloadUrl) {
      try {
        const res = await fetchWithTimeout(item.downloadUrl, { "User-Agent": "flare-actions" });
        if (res.ok) text = await res.text();
      } catch {
        text = null;
      }
    }
    if (text === null && installationToken && item.path) {
      try {
        const res = await fetchWithTimeout(
          `https://api.github.com/repos/${repo}/contents/${item.path}?ref=${sha}`,
          {
            Authorization: `Bearer ${installationToken}`,
            Accept: "application/vnd.github.raw+json",
            "User-Agent": "flare-actions",
          },
        );
        if (res.ok) text = await res.text();
      } catch {
        text = null;
      }
    }
    if (text === null) {
      warnings.push(`${item.name}: fetch failed`);
      continue;
    }
    if (text.length > MAX_WORKFLOW_BYTES) {
      warnings.push(`${item.name}: skipped (larger than 64 KiB)`);
      continue;
    }
    files.push({ name: item.name, text });
  }
  return { files, warnings };
}
