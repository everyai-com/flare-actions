// GitHub step files beyond outputs: $GITHUB_ENV (env for LATER steps of
// the same job), $GITHUB_PATH (PATH prepends for later steps), and
// $GITHUB_STEP_SUMMARY (markdown surfaced in the job log). Each step
// gets fresh files (FLARE_ENV / FLARE_PATH / FLARE_STEP_SUMMARY alias
// them, like FLARE_OUTPUT aliases GITHUB_OUTPUT); the executor reads
// them back after the step and folds them into this job-scoped state.
// Pure and Node-free (seats bundle it; the BYO runner imports it) so
// both executors apply identical rules to identical bytes.
//
// Plain types only (SDK type-stripping rule): no enums or namespaces.

import { parseKeyValueFile } from "./outputs.ts";

// Env identifiers only (no dashes/dots — they could never be read back
// as shell variables anyway).
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Names $GITHUB_ENV may never set, matched case-insensitively:
// - NODE_OPTIONS: GitHub blocks it (code injection into every later
//   node action/tool).
// - PATH: owned by $GITHUB_PATH so prepend order stays coherent.
// - LD_PRELOAD / LD_AUDIT / LD_LIBRARY_PATH / DYLD_*: seats chain the
//   egress shim (and its allowlist enforcement) through LD_PRELOAD;
//   a step must not be able to unhook it for later steps.
// - FLARE_* / GITHUB_* / RUNNER_* prefixes: executor-owned vars (step
//   file paths, run identity, egress config, needs) — GitHub likewise
//   refuses to overwrite its default GITHUB_*/RUNNER_* vars.
// Secrets masking is keyed off the claim's secret values, not env, so
// nothing here can disable it.
export const ENV_DENYLIST: readonly string[] = ["NODE_OPTIONS", "PATH", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"];
export const ENV_DENYLIST_PREFIXES: readonly string[] = ["FLARE_", "GITHUB_", "RUNNER_", "DYLD_"];

// Bounds: per-step file read, per-value size, distinct names per job,
// PATH entries per job, and step-summary bytes per job.
export const MAX_ENV_FILE_BYTES = 64 * 1024;
export const MAX_ENV_VALUE_BYTES = 32 * 1024;
export const MAX_JOB_ENV_VARS = 100;
export const MAX_PATH_ENTRIES = 64;
export const MAX_PATH_ENTRY_BYTES = 4096;
export const MAX_SUMMARY_BYTES = 64 * 1024;

export const STEP_SUMMARY_HEADER = "── step summary ──";

export function isAllowedEnvName(name: string): boolean {
  if (!ENV_NAME_RE.test(name)) return false;
  const upper = name.toUpperCase();
  if (ENV_DENYLIST.includes(upper)) return false;
  return !ENV_DENYLIST_PREFIXES.some((p) => upper.startsWith(p));
}

// Step-file env names (forwarded into container steps).
export const STEP_FILE_ENV_NAMES: readonly string[] = [
  "FLARE_OUTPUT",
  "GITHUB_OUTPUT",
  "FLARE_ENV",
  "GITHUB_ENV",
  "FLARE_PATH",
  "GITHUB_PATH",
  "FLARE_STEP_SUMMARY",
  "GITHUB_STEP_SUMMARY",
];

export interface StepFilePaths {
  output: string;
  env: string;
  path: string;
  summary: string;
}

// Per-step file paths under `dir` (hidden names, index-suffixed).
export function stepFilePaths(dir: string, index: number, hidden: boolean): StepFilePaths {
  const p = (kind: string): string => `${dir}/${hidden ? "." : ""}flare-${kind}-${index}`;
  return { output: p("output"), env: p("env"), path: p("path"), summary: p("summary") };
}

export function stepFileEnv(paths: StepFilePaths): Record<string, string> {
  return {
    FLARE_OUTPUT: paths.output,
    GITHUB_OUTPUT: paths.output,
    FLARE_ENV: paths.env,
    GITHUB_ENV: paths.env,
    FLARE_PATH: paths.path,
    GITHUB_PATH: paths.path,
    FLARE_STEP_SUMMARY: paths.summary,
    GITHUB_STEP_SUMMARY: paths.summary,
  };
}

// Job-scoped accumulation. `env` overlays later steps' env; `pathAdds`
// is the prepend list, highest precedence first.
export interface EnvFileState {
  env: Record<string, string>;
  pathAdds: string[];
  summaryBytes: number;
  summaryTruncated: boolean;
}

export function newEnvFileState(): EnvFileState {
  return { env: {}, pathAdds: [], summaryBytes: 0, summaryTruncated: false };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function capBytes(text: string, max: number): { text: string; cut: boolean } {
  const bytes = enc.encode(text);
  if (bytes.byteLength <= max) return { text, cut: false };
  // Decoding a cut multi-byte sequence yields U+FFFD; drop it.
  return { text: dec.decode(bytes.slice(0, max)).replace(/�$/, ""), cut: true };
}

export interface EnvFileApplied {
  set: string[];
  ignored: string[];
  truncated: string[];
  unparsed: number;
}

// Fold one step's $GITHUB_ENV into the job state. Later assignments
// win (GitHub semantics); denylisted/invalid names are ignored.
export function applyEnvFile(state: EnvFileState, text: string): EnvFileApplied {
  const parsed = parseKeyValueFile(capBytes(text, MAX_ENV_FILE_BYTES).text);
  const out: EnvFileApplied = { set: [], ignored: [], truncated: [], unparsed: parsed.ignored };
  for (const { name, value } of parsed.entries) {
    if (!isAllowedEnvName(name)) {
      out.ignored.push(name.slice(0, 64));
      continue;
    }
    if (!(name in state.env) && Object.keys(state.env).length >= MAX_JOB_ENV_VARS) {
      out.ignored.push(name);
      continue;
    }
    const capped = capBytes(value, MAX_ENV_VALUE_BYTES);
    if (capped.cut) out.truncated.push(name);
    state.env[name] = capped.text;
    if (!out.set.includes(name)) out.set.push(name);
  }
  return out;
}

// Fold one step's $GITHUB_PATH: each non-empty line is prepended, so
// later lines (and later steps) take precedence. Returns added entries.
export function applyPathFile(state: EnvFileState, text: string): string[] {
  const added: string[] = [];
  for (const raw of capBytes(text, MAX_ENV_FILE_BYTES).text.split("\n")) {
    const line = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).trim();
    if (!line || line.includes("\0") || enc.encode(line).byteLength > MAX_PATH_ENTRY_BYTES) continue;
    state.pathAdds.unshift(line);
    added.push(line);
  }
  if (state.pathAdds.length > MAX_PATH_ENTRIES) state.pathAdds.length = MAX_PATH_ENTRIES;
  return added;
}

// PATH for a later step: prepends (highest precedence first) + base.
export function prependedPath(state: EnvFileState, base: string | undefined, delimiter = ":"): string {
  const parts = [...state.pathAdds];
  if (base) parts.push(base);
  return parts.join(delimiter);
}

// Take a step's summary markdown within the per-job byte budget; null
// when nothing (or nothing more) fits. The caller logs the block.
export function takeSummary(state: EnvFileState, text: string): string | null {
  const trimmed = text.trimEnd();
  if (!trimmed.trim()) return null;
  const remaining = MAX_SUMMARY_BYTES - state.summaryBytes;
  if (remaining <= 0) {
    state.summaryTruncated = true;
    return null;
  }
  const capped = capBytes(trimmed, remaining);
  state.summaryBytes += enc.encode(capped.text).byteLength;
  if (capped.cut) state.summaryTruncated = true;
  return capped.cut ? `${capped.text}\n... (step summary truncated at ${MAX_SUMMARY_BYTES} bytes per job)` : capped.text;
}

// Log lines for one step's env/path/summary files (names only for env
// — values may be sensitive beyond the masked secrets).
export function envFileLogLines(
  label: string,
  env: EnvFileApplied | null,
  pathAdded: string[],
  summary: string | null,
): string[] {
  const lines: string[] = [];
  if (env) {
    if (env.set.length > 0) lines.push(`[env] step ${label}: set ${env.set.join(", ")}`);
    if (env.truncated.length > 0) lines.push(`[env] step ${label}: truncated values: ${env.truncated.join(", ")}`);
    if (env.ignored.length > 0) lines.push(`[env] step ${label}: ignored (reserved or invalid names): ${env.ignored.join(", ")}`);
    if (env.unparsed > 0) lines.push(`[env] step ${label}: ignored lines: ${env.unparsed}`);
  }
  if (pathAdded.length > 0) lines.push(`[path] step ${label}: prepended ${pathAdded.join(", ")}`);
  if (summary !== null) lines.push(`${STEP_SUMMARY_HEADER} (${label})\n${summary}`);
  return lines;
}
