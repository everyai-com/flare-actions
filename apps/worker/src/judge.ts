// Flaky-vs-real judge for the heal pipeline: a cheap Clef decision
// call that keeps transient failures (timeouts, port collisions,
// auth hiccups) from spending a full heal (inference + branch + PR +
// verification run). verdict >= 0.5 flaky probability = skip the heal.
//
// Model choice comes from scripts/model-eval.mjs (see
// docs/MODEL-EVAL.md): full Clef beats clef-flash on the golden judge
// cases, and typed probabilities beat chat verdicts for automation.
// The judge fails OPEN: a busy model, a malformed answer, or any
// error returns null and the heal proceeds — a judge outage must
// never block repairs.

import { gatewayOptions, isModelBusyError, type AiBinding, type TriageStep } from "./triage";
import { startGenAiSpan } from "./trace";

export const JUDGE_MODEL = "@cf/cloudflare/clef";
export const JUDGE_FLAKY_THRESHOLD = 0.5;
export const JUDGE_MAX_TEXT_CHARS = 2000;

const FLAKY_QUESTION = {
  flaky: {
    type: "noul",
    instructions: "Is this CI failure flaky (transient or environmental, likely to pass on retry)?",
  },
};

// Clef answers carry the probability under the question-type key
// ({type: "noul", noul: 0.01}); accept a bare number too. Anything
// else is malformed (fail open), never guessed.
export function readFlakyProbability(answers: unknown): number | null {
  const v = (answers as Record<string, unknown> | null)?.flaky;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    for (const [key, n] of Object.entries(rec)) {
      if (key !== "type" && typeof n === "number" && Number.isFinite(n)) return n;
    }
    if (typeof rec.probability === "number" && Number.isFinite(rec.probability)) return rec.probability;
  }
  return null;
}

// Compact failure text for the judge: job + failing commands + tail.
// Bounded so a huge log cannot inflate the decision call.
export function buildJudgeText(input: { jobName: string; steps: TriageStep[]; logTail: string; triage: string }): string {
  const failing = input.steps
    .filter((s) => s.exitCode !== 0)
    .slice(0, 2)
    .map((s) => `$ ${s.command.slice(0, 150)} (exit ${s.exitCode})\n${s.output.slice(-400)}`)
    .join("\n");
  const parts = [
    `job: ${input.jobName}`,
    failing ? `failing steps:\n${failing}` : null,
    input.triage ? `triage: ${input.triage.slice(0, 400)}` : null,
    input.logTail ? `tail: ${input.logTail.slice(-400)}` : null,
  ].filter((p): p is string => p !== null);
  return parts.join("\n\n").slice(0, JUDGE_MAX_TEXT_CHARS);
}

export async function judgeFlaky(
  ai: AiBinding,
  text: string,
  opts: { gatewayId?: string; runId?: string; jobId?: string } = {},
): Promise<number | null> {
  try {
    const span = await startGenAiSpan({ operation: "chat", model: JUDGE_MODEL, agentName: "judge", runId: opts.runId, jobId: opts.jobId });
    try {
      const out = (await ai.run(
        JUDGE_MODEL,
        { model: "clef", state: text.slice(0, JUDGE_MAX_TEXT_CHARS), questions: FLAKY_QUESTION },
        gatewayOptions(opts.gatewayId),
      )) as { answers?: unknown };
      const p = readFlakyProbability(out?.answers);
      span.end(p !== null);
      return p;
    } catch (err) {
      span.recordError(err);
      span.end(false);
      throw err;
    }
  } catch (err) {
    // Fail open (see header); busy models stay quiet, real errors log.
    if (!isModelBusyError(err)) {
      console.log(JSON.stringify({ level: "warn", msg: "heal judge failed", error: String(err) }));
    }
    return null;
  }
}
