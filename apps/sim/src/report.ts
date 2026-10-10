// Bench output: the `GET /v1/forge/bench` document (FORGE-UX §5.8 / §8:
// `{ run, measured_at, sha, modes:[{mode, metrics, projected}] }`) and
// a plain-text table. Simulated runs are labelled `simulated: true` on
// the document and every row, and the table header says SIMULATED.

import { MODE_LABELS, type Mode, type ModeMetrics, type SimResult } from "./sim.ts";

export interface BenchMetrics {
  landed: number;
  abandoned: number;
  changes_per_min: number;
  median_declare_to_land_min: number | null;
  p95_declare_to_land_min: number | null;
  time_to_80pct_landed_min: number | null;
  makespan_min: number;
  conflicts_hit: number;
  conflicts_avoided: number;
  stacked_intents: number;
  replays_attempted: number;
  replays_succeeded: number;
  red_main_min: number;
  escaped_defects: number;
  human_min: number;
  human_breakdown_min: { review: number; rereview: number; plan_approval: number; audit: number; escalation: number };
  routes: { auto: number; audit: number; human: number };
  ci_runs: number;
  trains: number;
  bisections: number;
  artifacts_ops: number | null;
  dollars_per_1k_agents: number | null;
}

export interface BenchModeRow {
  mode: Mode;
  label: string;
  metrics: BenchMetrics;
  projected: false;
  simulated: true;
}

export interface BenchDoc {
  run: string;
  measured_at: string;
  sha: string;
  kind: "simulated";
  simulated: true;
  agents: number;
  seed: number;
  repo_files: number;
  overlap_at_declare: number;
  command: string;
  modes: BenchModeRow[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const finiteOrNull = (n: number): number | null => (Number.isFinite(n) ? r2(n) : null);

export function toBenchMetrics(m: ModeMetrics): BenchMetrics {
  return {
    landed: m.landed,
    abandoned: m.abandoned,
    changes_per_min: r2(m.landedPerMin),
    median_declare_to_land_min: finiteOrNull(m.declareToLandP50Min),
    p95_declare_to_land_min: finiteOrNull(m.declareToLandP95Min),
    time_to_80pct_landed_min: finiteOrNull(m.timeTo80PctMin),
    makespan_min: r2(m.makespanMin),
    conflicts_hit: m.conflictsEncountered,
    conflicts_avoided: m.conflictsAvoided,
    stacked_intents: m.stackedIntents,
    replays_attempted: m.replaysAttempted,
    replays_succeeded: m.replaysSucceeded,
    red_main_min: r2(m.brokenMainMin),
    escaped_defects: m.escapedDefects,
    human_min: r2(m.humanReviewMin),
    human_breakdown_min: {
      review: r2(m.human.review),
      rereview: r2(m.human.rereview),
      plan_approval: r2(m.human.planApproval),
      audit: r2(m.human.audit),
      escalation: r2(m.human.escalation),
    },
    routes: { ...m.routes },
    ci_runs: m.ciRuns,
    trains: m.trains,
    bisections: m.bisections,
    artifacts_ops: m.artifactsOps,
    dollars_per_1k_agents: m.artifactsDollars === null ? null : r2((m.artifactsDollars * 1000) / Math.max(1, m.agents)),
  };
}

export function toBenchDoc(result: SimResult, meta: { sha: string; date: string; command: string }): BenchDoc {
  return {
    run: `sim-s${result.seed}-n${result.agents}`,
    measured_at: meta.date,
    sha: meta.sha,
    kind: "simulated",
    simulated: true,
    agents: result.agents,
    seed: result.seed,
    repo_files: result.fileCount,
    overlap_at_declare: r2(result.overlapAtDeclare * 100) / 100,
    command: meta.command,
    modes: result.modes.map((m) => ({
      mode: m.mode,
      label: MODE_LABELS[m.mode],
      metrics: toBenchMetrics(m),
      projected: false,
      simulated: true,
    })),
  };
}

// "45m", "3h 12m", "12d 4h".
export function formatMinutes(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return "n/a";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${Math.round(min - h * 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

const COLUMNS = [
  "Mode",
  "Landed",
  "Abandoned",
  "Changes/min",
  "80% landed by",
  "p50 declare->land",
  "p95",
  "Conflicts hit / avoided",
  "Red-main min",
  "Human min",
  "CI runs",
  "$ / 1k agents",
] as const;

export function tableRows(doc: BenchDoc): string[][] {
  return doc.modes.map((row) => {
    const m = row.metrics;
    return [
      row.label,
      formatInt(m.landed),
      formatInt(m.abandoned),
      m.changes_per_min.toFixed(2),
      formatMinutes(m.time_to_80pct_landed_min),
      formatMinutes(m.median_declare_to_land_min),
      formatMinutes(m.p95_declare_to_land_min),
      `${formatInt(m.conflicts_hit)} / ${formatInt(m.conflicts_avoided)}`,
      formatInt(m.red_main_min),
      formatInt(m.human_min),
      formatInt(m.ci_runs),
      m.dollars_per_1k_agents === null ? "n/a" : `$${m.dollars_per_1k_agents.toFixed(2)}`,
    ];
  });
}

export function headerLine(doc: BenchDoc): string {
  return (
    `SIMULATED (not a measurement) · ${formatInt(doc.agents)} agents · seed ${doc.seed} · ` +
    `${formatInt(doc.repo_files)}-file repo · ${(doc.overlap_at_declare * 100).toFixed(1)}% overlap at declare · ` +
    `${doc.measured_at} @ ${doc.sha}`
  );
}

export function formatTable(doc: BenchDoc): string {
  const rows = [COLUMNS.slice(), ...tableRows(doc)];
  const widths = COLUMNS.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: readonly string[]): string =>
    r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
  return [headerLine(doc), line(rows[0]), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(line)].join("\n");
}

// Markdown table for docs/FORGE-BENCH.md.
export function formatMarkdown(doc: BenchDoc): string {
  const head = `| ${COLUMNS.join(" | ")} |`;
  const sep = `|${COLUMNS.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`;
  return [head, sep, ...tableRows(doc).map((r) => `| ${r.join(" | ")} |`)].join("\n");
}
