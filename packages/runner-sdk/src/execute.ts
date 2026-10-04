import { execFile } from "node:child_process";
import { dockerArgsForStep } from "./services.ts";
import { normalizeStepCondition, stepRuns } from "./spec.ts";

export interface ExecStep {
  run: string;
  // GitHub parity: the step may fail without failing the rest of the job.
  continueOnError?: boolean;
  // Bounded condition subset (always()/success()/failure()/cancelled()
  // and negations); undefined means success().
  if?: string;
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
  // Run every step inside this image; only containerEnv keys cross over.
  container?: string;
  containerEnv?: string[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 32 * 1024;

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n... (truncated, ${s.length - limit} more chars)`;
}

interface RunOneOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimit: number;
  container?: string;
  containerEnv?: string[];
}

function runOne(o: RunOneOptions): Promise<StepResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const finish = (error: unknown, stdout: unknown, stderr: unknown) => {
      const durationMs = Date.now() - started;
      let exitCode = 0;
      if (error) {
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        exitCode = typeof code === "number" ? code : 124;
      }
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      let combined = err ? `${out}\n[stderr]\n${err}` : out;
      if (error && !combined.trim()) combined = (error as Error).message;
      resolve({ command: o.command, exitCode, durationMs, output: truncate(combined.trimEnd(), o.outputLimit) });
    };
    if (o.container) {
      execFile(
        "docker",
        dockerArgsForStep(o.container, o.cwd, o.env, o.containerEnv ?? [], o.command),
        { timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        finish,
      );
      return;
    }
    execFile("sh", ["-c", o.command], { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, finish);
  });
}

export async function executeSteps(steps: ExecStep[], opts: ExecuteOptions): Promise<StepsOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = opts.outputLimitPerStep ?? DEFAULT_OUTPUT_LIMIT;
  const results: StepResult[] = [];
  const logParts: string[] = [];
  // Failure state drives conditionals: default steps stop once the job
  // has failed, while `if: failure()` / `if: always()` steps (cleanup,
  // notifications) still run.
  let anyFailed = false;
  let jobFailed = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!stepRuns(step.if, { anyFailed, jobFailed })) {
      logParts.push(`--- step ${i + 1}: skipped (${step.if}) ---`);
      continue;
    }
    const r = await runOne({
      command: step.run,
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs,
      outputLimit,
      container: opts.container,
      containerEnv: opts.containerEnv,
    });
    results.push(r);
    logParts.push(`--- step ${i + 1}: ${step.run} ---\n${r.output}\n(exit ${r.exitCode}, ${r.durationMs}ms)`);
    if (r.exitCode !== 0) {
      anyFailed = true;
      if (step.continueOnError) {
        logParts.push(`--- step ${i + 1} failed but continue-on-error is set ---`);
      } else {
        jobFailed = true;
      }
    }
  }
  return { success: results.length > 0 && !jobFailed, results, log: logParts.join("\n") };
}

export function parseDefinition(definition: string): ExecStep[] | null {
  try {
    const parsed = JSON.parse(definition) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    const steps: ExecStep[] = [];
    for (const s of parsed.steps) {
      if (typeof s !== "object" || s === null) return null;
      const rec = s as Record<string, unknown>;
      const run = rec.run;
      if (typeof run !== "string" || !run.trim()) return null;
      const step: ExecStep = { run };
      if (rec.continueOnError !== undefined) {
        if (typeof rec.continueOnError !== "boolean") return null;
        step.continueOnError = rec.continueOnError;
      }
      if (rec.if !== undefined) {
        const cond = normalizeStepCondition(rec.if);
        if (!cond) return null;
        step.if = cond;
      }
      steps.push(step);
    }
    return steps;
  } catch {
    return null;
  }
}
