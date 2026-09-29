import { execFile } from "node:child_process";

export interface ExecStep {
  run: string;
}

export interface StepResult {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface StepsOutcome {
  success: boolean;
  results: StepResult[];
  log: string;
}

export interface ExecuteOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputLimitPerStep?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 32 * 1024;

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n... (truncated, ${s.length - limit} more chars)`;
}

function runOne(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
): Promise<StepResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started;
      let exitCode = 0;
      if (error) {
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        exitCode = typeof code === "number" ? code : 124;
      }
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      const combined = err ? `${out}\n[stderr]\n${err}` : out;
      resolve({ command, exitCode, durationMs, output: truncate(combined.trimEnd(), outputLimit) });
    });
  });
}

export async function executeSteps(steps: ExecStep[], opts: ExecuteOptions): Promise<StepsOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = opts.outputLimitPerStep ?? DEFAULT_OUTPUT_LIMIT;
  const results: StepResult[] = [];
  const logParts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const r = await runOne(step.run, opts.cwd, opts.env, timeoutMs, outputLimit);
    results.push(r);
    logParts.push(`--- step ${i + 1}: ${step.run} ---\n${r.output}\n(exit ${r.exitCode}, ${r.durationMs}ms)`);
    if (r.exitCode !== 0) break;
  }
  return { success: results.length > 0 && results.every((r) => r.exitCode === 0), results, log: logParts.join("\n") };
}

export function parseDefinition(definition: string): ExecStep[] | null {
  try {
    const parsed = JSON.parse(definition) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    const steps: ExecStep[] = [];
    for (const s of parsed.steps) {
      if (typeof s !== "object" || s === null) return null;
      const run = (s as Record<string, unknown>).run;
      if (typeof run !== "string" || !run.trim()) return null;
      steps.push({ run });
    }
    return steps;
  } catch {
    return null;
  }
}
