// Where a check's minutes go: the wait / setup / run split behind
// /v1/bottlenecks. Most slow CI is not slow tests; it is a job waiting
// for a machine, a cold dependency cache, or setup nobody watches.
// Each finished job splits into:
//   wait     — created → claimed (queue)
//   overhead — claimed → finished minus every step (checkout, cache
//              restore/save, services, artifacts, report)
//   setup    — steps that prepare the job (installs, toolchains)
//   run      — steps that check something (lint, typecheck, tests)
// Import-free so the CLI and scripts can share it.

export type StepPhase = "setup" | "run";

export interface PhaseStep {
  command: string;
  durationMs: number;
}

export interface JobPhases {
  overheadMs: number;
  setupMs: number;
  runMs: number;
}

// Dependency installs, toolchain setup and history fetches: the work a
// warm cache or a better image removes. Builds stay "run" — a compile
// is a check in its own right.
const SETUP_SEGMENT_RE = new RegExp(
  "^(?:sudo\\s+)?(?:" +
    [
      "npm\\s+(?:ci|install|i)\\b",
      "pnpm\\s+(?:install|i|fetch)\\b",
      "yarn(?:\\s+install)?(?:\\s+--(?:frozen-lockfile|immutable)\\b.*)?$",
      "bun\\s+install\\b",
      "(?:python3?\\s+-m\\s+)?pip3?\\s+install\\b",
      "uv\\s+(?:sync|pip\\s+install)\\b",
      "poetry\\s+install\\b",
      "bundle\\s+install\\b",
      "go\\s+mod\\s+download\\b",
      "cargo\\s+fetch\\b",
      "apt(?:-get)?\\s+(?:update|install)\\b",
      "brew\\s+install\\b",
      "corepack\\s+(?:enable|prepare)\\b",
      "nvm\\s+(?:install|use)\\b",
      "rustup\\b",
      "git\\s+(?:submodule|fetch|lfs\\s+pull)\\b",
      "npx\\s+playwright\\s+install\\b",
    ].join("|") +
    ")",
);

// Shell plumbing that neither prepares nor checks anything.
const NEUTRAL_SEGMENT_RE = /^(?:cd|export|echo|set|true|:)\b/;

// Decide whether a step prepares the job or checks something. Input is
// the step's shell command as the executor recorded it (secrets masked,
// possibly multi-line, cut to 120 chars by the bottleneck query).
// A step is setup only when every meaningful segment is: `npm ci &&
// npm test` is a check, because calling a test "setup" would hide the
// real work and send the reader off to cache dependencies.
export function classifyStep(command: string): StepPhase {
  const segments = command
    .split(/\n|&&|\|\||;/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#") && !NEUTRAL_SEGMENT_RE.test(s));
  if (segments.length === 0) return "run";
  return segments.every((s) => SETUP_SEGMENT_RE.test(s)) ? "setup" : "run";
}

// Executors record steps as [{command, durationMs, ...}]; the bottleneck
// query ships them compactly as [[command, durationMs], ...]. Null means
// "no step data" (legacy row, timeout, setup failure before any step),
// which must not read as "all overhead".
export function parseStepPairs(raw: string | null | undefined): PhaseStep[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: PhaseStep[] = [];
  for (const pair of parsed) {
    if (!Array.isArray(pair)) continue;
    const [command, durationMs] = pair as unknown[];
    if (typeof command !== "string" || typeof durationMs !== "number" || !Number.isFinite(durationMs)) continue;
    out.push({ command, durationMs: Math.max(0, durationMs) });
  }
  return out.length > 0 ? out : null;
}

// Split one job's executed time (claimed → finished). Step durations are
// measured on the executor and the wall time on the worker, so a step
// sum can overshoot by clock noise; overhead floors at zero rather than
// going negative.
export function splitJobPhases(
  executedMs: number,
  steps: PhaseStep[],
  classify: (command: string) => StepPhase = classifyStep,
): JobPhases {
  let setupMs = 0;
  let runMs = 0;
  for (const step of steps) {
    if (classify(step.command) === "setup") setupMs += step.durationMs;
    else runMs += step.durationMs;
  }
  return { overheadMs: Math.max(0, executedMs - setupMs - runMs), setupMs, runMs };
}

export interface PhaseSummary {
  queueP50Ms: number;
  overheadP50Ms: number | null;
  setupP50Ms: number | null;
  runP50Ms: number | null;
  cacheHitRate: number | null;
  cacheSamples: number;
}

// Below these, a phase is not worth a sentence: a 3s install on a 4s
// lint job is "setup outweighs the check" but nobody should act on it.
const HINT_WAIT_MS = 30_000;
const HINT_PHASE_MS = 15_000;
const HINT_CACHE_RATE = 0.8;
const HINT_CACHE_SAMPLES = 5;

function secs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

// The single biggest lever for one check, or null. Ordered by how much
// each usually buys: a machine wait multiplies every other phase, a
// missing cache turns into setup on every run, and setup/overhead only
// matter once they rival the checks themselves.
export function bottleneckHint(s: PhaseSummary): string | null {
  if (s.queueP50Ms >= HINT_WAIT_MS) {
    return `waits ${secs(s.queueP50Ms)} for a machine at p50: add runners for its labels or move it to managed seats`;
  }
  if (s.cacheHitRate !== null && s.cacheSamples >= HINT_CACHE_SAMPLES && s.cacheHitRate < HINT_CACHE_RATE) {
    const missPct = Math.round((1 - s.cacheHitRate) * 100);
    return `cache misses ${missPct}% of runs: key it on the lockfile and add restore-keys so branches fall back to main's entry`;
  }
  const run = s.runP50Ms ?? 0;
  if (s.setupP50Ms !== null && s.setupP50Ms >= HINT_PHASE_MS && s.setupP50Ms > run) {
    return `installs take ${secs(s.setupP50Ms)}, more than the checks (${secs(run)}): cache dependencies (node_modules, ~/.cache) and skip reinstalling on a hit`;
  }
  if (s.overheadP50Ms !== null && s.overheadP50Ms >= HINT_PHASE_MS && s.overheadP50Ms > run) {
    return `checkout, cache transfer and services take ${secs(s.overheadP50Ms)}, more than the checks (${secs(run)}): trim cached paths and unused services`;
  }
  return null;
}
