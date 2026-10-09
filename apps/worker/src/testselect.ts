// Smart test selection, worker side: mode decisions at claim time plus
// skip-report validation on the status callback. The import-graph walk
// itself lives in the runner SDK (executors own the checkout); this
// module stays runtime-free so worker, seats, and vitest share it.
//
// Config shape mirrors the SDK walker options; validation here is
// intentionally duplicated (see pipeline.ts strict parse and SDK spec.ts
// — same pattern as the step-condition helpers).

export interface TestSelectionConfig {
  tests?: string[];
  fullOnProfiles?: string[];
  fullOnBranches?: string[];
  historyDays?: number;
}

// A run under one of these profiles always runs everything: the profile
// already means "full suite" (merge candidate / nightly), so selecting
// a subset would silently narrow it.
export const DEFAULT_FULL_ON_PROFILES = ["full"];
export const DEFAULT_HISTORY_DAYS = 7;
export const MAX_HISTORY_DAYS = 30;
export const MAX_CONFIG_PATTERNS = 16;
export const MAX_RECENT_FAILURES = 200;

export type SelectionMode = "off" | "full" | "select";

export interface SelectionDecision {
  mode: SelectionMode;
  reason: string;
}

function strList(raw: unknown, max: number, itemMax: number): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim() || item.length > itemMax) return null;
    out.push(item.trim());
  }
  return [...new Set(out)];
}

// Strict parse for YAML/definition input: null rejects the value.
export function parseTestSelectionConfig(raw: unknown): TestSelectionConfig | null {
  if (raw === true) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const config: TestSelectionConfig = {};
  if (rec.tests !== undefined) {
    const tests = strList(rec.tests, MAX_CONFIG_PATTERNS, 256);
    if (!tests) return null;
    config.tests = tests;
  }
  if (rec["full-on-profiles"] !== undefined) {
    const profiles = strList(rec["full-on-profiles"], MAX_CONFIG_PATTERNS, 64);
    if (!profiles) return null;
    config.fullOnProfiles = profiles;
  }
  if (rec["full-on-branches"] !== undefined) {
    const branches = strList(rec["full-on-branches"], MAX_CONFIG_PATTERNS, 128);
    if (!branches) return null;
    config.fullOnBranches = branches;
  }
  if (rec["history-days"] !== undefined) {
    const days = rec["history-days"];
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_HISTORY_DAYS) return null;
    config.historyDays = days;
  }
  return config;
}

// Tolerant reader for stored definitions: malformed configs read as
// absent (selection off), never as an error.
export function readTestSelectionConfig(definition: string): TestSelectionConfig | null {
  try {
    const parsed = JSON.parse(definition) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = (parsed as { testSelection?: unknown }).testSelection;
    if (raw === undefined || raw === null || raw === false) return null;
    if (raw === true) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const config: TestSelectionConfig = {};
    // Stored shapes use camelCase (serializeDefinition); tolerate the
    // YAML kebab-case too so hand-built definitions behave.
    const tests = rec.tests;
    if (tests !== undefined) {
      if (!Array.isArray(tests) || tests.length > MAX_CONFIG_PATTERNS) return null;
      const out: string[] = [];
      for (const t of tests) {
        if (typeof t !== "string" || !t.trim() || t.length > 256) return null;
        out.push(t.trim());
      }
      config.tests = [...new Set(out)];
    }
    const profiles = rec.fullOnProfiles ?? rec["full-on-profiles"];
    if (profiles !== undefined) {
      if (!Array.isArray(profiles) || profiles.length > MAX_CONFIG_PATTERNS) return null;
      const out: string[] = [];
      for (const p of profiles) {
        if (typeof p !== "string" || !p.trim() || p.length > 64) return null;
        out.push(p.trim());
      }
      config.fullOnProfiles = [...new Set(out)];
    }
    const branches = rec.fullOnBranches ?? rec["full-on-branches"];
    if (branches !== undefined) {
      if (!Array.isArray(branches) || branches.length > MAX_CONFIG_PATTERNS) return null;
      const out: string[] = [];
      for (const b of branches) {
        if (typeof b !== "string" || !b.trim() || b.length > 128) return null;
        out.push(b.trim());
      }
      config.fullOnBranches = [...new Set(out)];
    }
    const days = rec.historyDays ?? rec["history-days"];
    if (days !== undefined) {
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_HISTORY_DAYS) return null;
      config.historyDays = days;
    }
    return config;
  } catch {
    return null;
  }
}

export interface SelectionContext {
  event: string;
  branch: string;
  profile: string | null;
  changedFiles: string[];
}

// Pure: full-suite safety net first (schedule/nightly, merge-candidate
// profiles and branches, unknown diff), selection only when the run is
// a narrow PR/push/dispatch with a known diff.
export function decideSelectionMode(config: TestSelectionConfig | null, ctx: SelectionContext): SelectionDecision {
  if (!config) return { mode: "off", reason: "test selection not configured" };
  if (ctx.event === "schedule") return { mode: "full", reason: "scheduled run (nightly safety net)" };
  const fullProfiles = config.fullOnProfiles ?? DEFAULT_FULL_ON_PROFILES;
  if (ctx.profile && fullProfiles.includes(ctx.profile)) {
    return { mode: "full", reason: `profile "${ctx.profile}" runs the full suite` };
  }
  const fullBranches = config.fullOnBranches ?? [];
  if (ctx.branch && fullBranches.includes(ctx.branch)) {
    return { mode: "full", reason: `branch "${ctx.branch}" runs the full suite` };
  }
  if (ctx.changedFiles.length === 0) return { mode: "full", reason: "changed files unknown" };
  return { mode: "select", reason: "diff mapped to affected tests" };
}

export interface SelectionReport {
  mode: "full" | "select";
  reason: string;
  selected: string[];
  skipped: { file: string; reason: string }[];
}

export const MAX_REPORT_SELECTED = 500;
export const MAX_REPORT_SKIPPED = 200;

// Executor skip reports ride the status callback; invalid shapes are
// dropped (null), never a 500 — a report must not fail a status update.
export function parseSelectionReport(body: unknown): SelectionReport | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  if (rec.mode !== "full" && rec.mode !== "select") return null;
  if (typeof rec.reason !== "string" || !rec.reason.trim() || rec.reason.length > 500) return null;
  const selected = rec.selected ?? [];
  const skipped = rec.skipped ?? [];
  if (!Array.isArray(selected) || selected.length > MAX_REPORT_SELECTED) return null;
  if (!Array.isArray(skipped) || skipped.length > MAX_REPORT_SKIPPED) return null;
  for (const s of selected) {
    if (typeof s !== "string" || !s || s.length > 1024) return null;
  }
  for (const s of skipped) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
    const row = s as Record<string, unknown>;
    if (typeof row.file !== "string" || !row.file || row.file.length > 1024) return null;
    if (typeof row.reason !== "string" || !row.reason || row.reason.length > 500) return null;
  }
  return {
    mode: rec.mode,
    reason: rec.reason.trim(),
    selected: [...selected] as string[],
    skipped: skipped.map((s) => {
      const row = s as { file: string; reason: string };
      return { file: row.file, reason: row.reason };
    }),
  };
}
