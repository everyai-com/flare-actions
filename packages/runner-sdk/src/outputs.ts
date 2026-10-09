// Step/job outputs: steps append KEY=VALUE lines to $FLARE_OUTPUT
// ($GITHUB_OUTPUT aliases it); the executor parses (bounded), the job
// `outputs:` mapping promotes step refs under stable names, and the
// mapping lands in resultJson for downstream `needs` consumers.
// Pure and Node-free (seats and the worker bundle it) so every
// executor resolves the same bytes to the same values.
export const OUTPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const MAX_STEP_OUTPUTS = 16;
export const MAX_OUTPUT_VALUE_BYTES = 1024;
export const MAX_JOB_OUTPUTS = 16;

// Step ids, output names, and job output names share one alphabet so
// refs (`stepid.key`) split unambiguously on the single dot.
export function isValidOutputName(name: string): boolean {
  return OUTPUT_NAME_RE.test(name);
}

export interface ParsedStepOutputs {
  outputs: Record<string, string>;
  // Values cut to MAX_OUTPUT_VALUE_BYTES (names kept, noted in logs).
  truncated: string[];
  // Lines dropped: garbage, bad names, duplicates (first wins), overflow.
  ignored: number;
}

export function parseStepOutputs(text: string): ParsedStepOutputs {
  const outputs: Record<string, string> = {};
  const truncated: string[] = [];
  let ignored = 0;
  let count = 0;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      ignored++;
      continue;
    }
    const name = line.slice(0, eq);
    if (!isValidOutputName(name) || name in outputs || count >= MAX_STEP_OUTPUTS) {
      ignored++;
      continue;
    }
    let value = line.slice(eq + 1);
    const bytes = enc.encode(value);
    if (bytes.byteLength > MAX_OUTPUT_VALUE_BYTES) {
      value = dec.decode(bytes.slice(0, MAX_OUTPUT_VALUE_BYTES));
      truncated.push(name);
    }
    outputs[name] = value;
    count++;
  }
  return { outputs, truncated, ignored };
}

// A job-output ref (`stepid.key`, static — no expression engine).
export function parseOutputRef(ref: string): { stepId: string; key: string } | null {
  const dot = ref.indexOf(".");
  if (dot <= 0) return null;
  const stepId = ref.slice(0, dot);
  const key = ref.slice(dot + 1);
  if (!isValidOutputName(stepId) || !isValidOutputName(key)) return null;
  return { stepId, key };
}

export interface ResolvedJobOutputs {
  outputs: Record<string, string>;
  // Mapping names whose step never emitted the key (absent, logged).
  missing: string[];
}

export function resolveJobOutputs(
  mapping: Record<string, string>,
  steps: Record<string, Record<string, string>>,
): ResolvedJobOutputs {
  const outputs: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, ref] of Object.entries(mapping)) {
    const parsed = parseOutputRef(ref);
    const value = parsed ? steps[parsed.stepId]?.[parsed.key] : undefined;
    if (value === undefined) missing.push(name);
    else outputs[name] = value;
  }
  return { outputs, missing };
}

// One-line log rendering: names always, values shortened (full values
// persist in resultJson, never in the log tail).
export function formatOutputsLine(outputs: Record<string, string>): string {
  return Object.entries(outputs)
    .map(([k, v]) => `${k}=${v.length > 120 ? `${v.slice(0, 120)}…` : v}`)
    .join(" ");
}

// Settled needs consumed by `if:` refs and step env. Results use the
// fixed vocabulary (success/failure/cancelled/skipped); outputs are
// the needs' resolved job-output mappings.
export interface NeedsContext {
  [base: string]: { result: string; outputs: Record<string, string> };
}

// Claim-payload budget for needs outputs (results always ride — they
// are tiny and gating depends on them).
export const MAX_NEEDS_BYTES = 64 * 1024;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// Deterministic cap: bases and keys sorted, results always kept,
// outputs filled until the byte budget runs out.
export function capNeedsContext(needs: NeedsContext): { needs: NeedsContext; truncated: boolean } {
  const out: NeedsContext = {};
  let bytes = 0;
  let truncated = false;
  for (const base of Object.keys(needs).sort()) {
    const entry = needs[base] as { result: string; outputs: Record<string, string> };
    const kept: Record<string, string> = {};
    for (const key of Object.keys(entry.outputs).sort()) {
      const value = entry.outputs[key] as string;
      const size = utf8Length(base) + utf8Length(key) + utf8Length(value);
      if (bytes + size > MAX_NEEDS_BYTES) {
        truncated = true;
        continue;
      }
      bytes += size;
      kept[key] = value;
    }
    out[base] = { result: entry.result, outputs: kept };
  }
  return { needs: out, truncated };
}

function needsEnvName(prefix: string, base: string, key: string): string {
  return `${prefix}${base}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

// Needs as step env (`FLARE_NEEDS_<BASE>_<KEY>` + `..._RESULT`).
// Mangling can collide (`a-b` vs `a.b`); first sorted name wins and
// the losers come back skipped so the executor can warn.
export function buildNeedsEnv(needs: NeedsContext): { env: Record<string, string>; skipped: string[] } {
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  const claim = (name: string, value: string, label: string): void => {
    if (name in env) {
      skipped.push(label);
      return;
    }
    env[name] = value;
  };
  for (const base of Object.keys(needs).sort()) {
    const entry = needs[base] as { result: string; outputs: Record<string, string> };
    claim(needsEnvName("FLARE_NEEDS_", base, "RESULT"), entry.result, `needs.${base}.result`);
    for (const key of Object.keys(entry.outputs).sort()) {
      claim(needsEnvName("FLARE_NEEDS_", base, key), entry.outputs[key] as string, `needs.${base}.outputs.${key}`);
    }
  }
  return { env, skipped };
}
