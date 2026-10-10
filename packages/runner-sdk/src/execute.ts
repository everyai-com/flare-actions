import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { delimiter } from "node:path";
import {
  applyEnvFile,
  applyPathFile,
  envFileLogLines,
  newEnvFileState,
  prependedPath,
  stepFileEnv,
  stepFilePaths,
  takeSummary,
  MAX_ENV_FILE_BYTES,
  MAX_SUMMARY_BYTES,
  STEP_FILE_ENV_NAMES,
} from "./envfiles.ts";
import { buildStepsEnv, formatOutputsLine, isValidOutputName, parseStepOutputs, type NeedsContext } from "./outputs.ts";
import { dockerArgsForStep } from "./services.ts";
import { normalizeStepCondition, stepRuns } from "./spec.ts";

export interface ExecStep {
  run: string;
  // Stable handle for outputs (`steps.<id>.outputs.<key>`); defaults to
  // `step<N>` when absent.
  id?: string;
  // GitHub parity: the step may fail without failing the rest of the job.
  continueOnError?: boolean;
  // Bounded condition subset (always()/success()/failure()/cancelled()
  // and negations); undefined means success().
  if?: string;
  // Per-step bound/override: minutes (1-180) and interpreter (sh default).
  timeoutMinutes?: number;
  shell?: string;
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
  // Collected $FLARE_OUTPUT values by step id (`step<N>` fallback).
  stepOutputs: Record<string, Record<string, string>>;
}

export interface ExecuteOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputLimitPerStep?: number;
  // Run every step inside this image; only containerEnv keys cross over.
  container?: string;
  containerEnv?: string[];
  // Settled needs for `if:` refs (results + outputs).
  needs?: NeedsContext;
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
  shell: string;
  // Container only: earlier steps' $GITHUB_PATH entries.
  pathPrepend?: string[];
}

// Bounded read of a step file; "" when absent (the step wrote nothing).
function readStepFile(path: string, maxBytes: number): string {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
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
        dockerArgsForStep(o.container, o.cwd, o.env, o.containerEnv ?? [], o.command, o.shell, o.pathPrepend),
        { timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        finish,
      );
      return;
    }
    execFile(o.shell, ["-c", o.command], { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, finish);
  });
}

export async function executeSteps(steps: ExecStep[], opts: ExecuteOptions): Promise<StepsOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = opts.outputLimitPerStep ?? DEFAULT_OUTPUT_LIMIT;
  const results: StepResult[] = [];
  const logParts: string[] = [];
  const stepOutputs: Record<string, Record<string, string>> = {};
  // Failure state drives conditionals: default steps stop once the job
  // has failed, while `if: failure()` / `if: always()` steps (cleanup,
  // notifications) still run.
  let anyFailed = false;
  let jobFailed = false;
  // $GITHUB_ENV / $GITHUB_PATH / summary state, scoped to this job.
  const envState = newEnvFileState();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // `if:` sees the settled needs plus this job's earlier steps (a
    // step can only ref outputs published before it runs).
    if (!stepRuns(step.if, { anyFailed, jobFailed }, { needs: opts.needs ?? {}, steps: stepOutputs })) {
      logParts.push(`--- step ${i + 1}: skipped (${step.if}) ---`);
      continue;
    }
    // Step files ($GITHUB_OUTPUT/ENV/PATH/STEP_SUMMARY + FLARE_
    // aliases): hidden files under the workdir both sides can see
    // (container steps run with cwd mounted at /work, so the in-step
    // path differs but the bytes land in the same file). Fresh per step.
    const host = stepFilePaths(opts.cwd, i, true);
    const inStep = opts.container ? stepFilePaths("/work", i, true) : host;
    const hostFiles = [host.output, host.env, host.path, host.summary];
    for (const f of hostFiles) {
      try {
        rmSync(f, { force: true });
      } catch {
        // Best effort; `>>` recreates it either way.
      }
    }
    // Earlier steps' $GITHUB_ENV overlays the job env (later steps
    // only); $GITHUB_PATH prepends to PATH (host) or to the
    // container's own PATH (trampoline in dockerArgsForStep).
    const stepsEnv = buildStepsEnv(stepOutputs);
    const stepEnv: NodeJS.ProcessEnv = { ...opts.env, ...stepsEnv, ...envState.env, ...stepFileEnv(inStep) };
    if (!opts.container && envState.pathAdds.length > 0) stepEnv.PATH = prependedPath(envState, opts.env.PATH, delimiter);
    const r = await runOne({
      command: step.run,
      cwd: opts.cwd,
      env: stepEnv,
      timeoutMs: step.timeoutMinutes !== undefined ? step.timeoutMinutes * 60000 : timeoutMs,
      outputLimit,
      container: opts.container,
      containerEnv: opts.container
        ? [...new Set([...(opts.containerEnv ?? []), ...Object.keys(stepsEnv), ...Object.keys(envState.env), ...STEP_FILE_ENV_NAMES])]
        : opts.containerEnv,
      shell: step.shell ?? "sh",
      pathPrepend: opts.container ? [...envState.pathAdds] : undefined,
    });
    results.push(r);
    logParts.push(`--- step ${i + 1}: ${step.run} ---\n${r.output}\n(exit ${r.exitCode}, ${r.durationMs}ms)`);
    // Failed steps still publish what they wrote before dying (skipped
    // steps never ran, so they publish nothing).
    const label = step.id ?? `step${i + 1}`;
    try {
      const parsed = parseStepOutputs(readFileSync(host.output, "utf8"));
      const names = Object.keys(parsed.outputs);
      if (names.length > 0) {
        stepOutputs[label] = parsed.outputs;
        logParts.push(`[outputs] step ${label}: ${formatOutputsLine(parsed.outputs)}`);
      }
      if (parsed.truncated.length > 0 || parsed.ignored > 0) {
        logParts.push(
          `[outputs] step ${label}: ${parsed.truncated.length > 0 ? `truncated values: ${parsed.truncated.join(", ")}; ` : ""}ignored lines: ${parsed.ignored}`,
        );
      }
    } catch {
      // No outputs file: the step published nothing.
    }
    const envText = readStepFile(host.env, MAX_ENV_FILE_BYTES);
    const envApplied = envText ? applyEnvFile(envState, envText) : null;
    const pathAdded = applyPathFile(envState, readStepFile(host.path, MAX_ENV_FILE_BYTES));
    const summary = takeSummary(envState, readStepFile(host.summary, MAX_SUMMARY_BYTES));
    logParts.push(...envFileLogLines(label, envApplied, pathAdded, summary));
    for (const f of hostFiles) {
      try {
        rmSync(f, { force: true });
      } catch {
        // Best effort; a stale file never affects the next step.
      }
    }
    if (r.exitCode !== 0) {
      anyFailed = true;
      if (step.continueOnError) {
        logParts.push(`--- step ${i + 1} failed but continue-on-error is set ---`);
      } else {
        jobFailed = true;
      }
    }
  }
  return { success: results.length > 0 && !jobFailed, results, log: logParts.join("\n"), stepOutputs };
}

export function parseDefinition(definition: string): ExecStep[] | null {
  try {
    const parsed = JSON.parse(definition) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    const steps: ExecStep[] = [];
    const seenIds = new Set<string>();
    for (const s of parsed.steps) {
      if (typeof s !== "object" || s === null) return null;
      const rec = s as Record<string, unknown>;
      const run = rec.run;
      if (typeof run !== "string" || !run.trim()) return null;
      const step: ExecStep = { run };
      if (rec.id !== undefined) {
        if (typeof rec.id !== "string" || !isValidOutputName(rec.id) || seenIds.has(rec.id)) return null;
        seenIds.add(rec.id);
        step.id = rec.id;
      }
      if (rec.continueOnError !== undefined) {
        if (typeof rec.continueOnError !== "boolean") return null;
        step.continueOnError = rec.continueOnError;
      }
      if (rec.if !== undefined) {
        const cond = normalizeStepCondition(rec.if);
        if (!cond) return null;
        step.if = cond;
      }
      if (rec.timeoutMinutes !== undefined) {
        if (typeof rec.timeoutMinutes !== "number" || !Number.isInteger(rec.timeoutMinutes) || rec.timeoutMinutes < 1 || rec.timeoutMinutes > 180) {
          return null;
        }
        step.timeoutMinutes = rec.timeoutMinutes;
      }
      if (rec.shell !== undefined) {
        if (typeof rec.shell !== "string" || !/^[\w./-]{1,32}$/.test(rec.shell.trim())) return null;
        step.shell = rec.shell.trim();
      }
      steps.push(step);
    }
    return steps;
  } catch {
    return null;
  }
}
