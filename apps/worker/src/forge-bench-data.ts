// GET /v1/forge/bench: the recorded simulator run (docs/bench/
// forge-sim-seed7.json, docs/FORGE-BENCH.md), bundled at build time.
// Every run is `simulated: true` — model outputs under stated constants,
// not measurements — and the payload keeps that flag visible.
import seed7 from "../../../docs/bench/forge-sim-seed7.json";

interface BenchRun {
  run: string;
  measured_at: string;
  sha: string;
  agents: number;
  simulated?: boolean;
  modes: unknown[];
  [k: string]: unknown;
}

const runs: BenchRun[] = Array.isArray((seed7 as { runs?: unknown }).runs) ? (seed7 as { runs: BenchRun[] }).runs : [];

// The dashboard renders one run: the 10k-agent one when present.
export function benchPayload(agents?: number): Record<string, unknown> | null {
  const pick = (agents ? runs.find((r) => r.agents === agents) : undefined) ?? runs.find((r) => r.agents === 10000) ?? runs[0];
  if (!pick) return null;
  // Dashboard column names (seconds, usd) next to the recorded ones.
  const modes = pick.modes.map((m) => {
    if (!m || typeof m !== "object") return m;
    const metrics = (m as { metrics?: Record<string, unknown> }).metrics ?? {};
    const min = metrics.median_declare_to_land_min;
    return {
      ...m,
      metrics: {
        ...metrics,
        median_declare_to_land_s: typeof min === "number" ? Math.round(min * 60) : null,
        usd_per_1k_agents: metrics.dollars_per_1k_agents ?? null,
      },
    };
  });
  return {
    ...pick,
    modes,
    simulated: true,
    kind: "simulated",
    note: (seed7 as { note?: string }).note ?? "SIMULATED: not measurements.",
    runs: runs.map((r) => ({ run: r.run, agents: r.agents })),
    source: "docs/bench/forge-sim-seed7.json",
  };
}
