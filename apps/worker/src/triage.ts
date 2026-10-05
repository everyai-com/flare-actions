import { readAiUsage, startGenAiSpan } from "./trace";

export const TRIAGE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
export const TRIAGE_MAX_LOG_CHARS = 6000;
export const TRIAGE_MAX_TOKENS = 512;
export const TRIAGE_MAX_STORED_CHARS = 4096;

export interface TriageStep {
  command: string;
  exitCode: number;
  output: string;
}

export interface TriageInput {
  repo: string;
  sha: string;
  jobName: string;
  steps: TriageStep[];
  logTail: string;
  runId?: string;
  jobId?: string;
}

export interface TriageMessage {
  role: "system" | "user";
  content: string;
}

export function buildTriageMessages(input: TriageInput): TriageMessage[] {
  const failing = input.steps.filter((s) => s.exitCode !== 0);
  // Failing output first (tails — tools summarize failures at the end),
  // then a one-line-per-step map so the model sees order without noise.
  const failLines = failing
    .map((s) => `$ ${s.command}\n(exit ${s.exitCode})\n${s.output.slice(-3000)}`)
    .join("\n\n")
    .slice(0, TRIAGE_MAX_LOG_CHARS);
  const summary = input.steps
    .map((s) => `${s.exitCode === 0 ? "ok" : `FAIL(${s.exitCode})`} $ ${s.command}`.slice(0, 160))
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You triage CI failures. Reply in ≤120 words with exactly these sections, no preamble: " +
        "Cause: one sentence naming the failing test or assertion and its exact error. " +
        "Culprit: file path with line when visible, else the failing command, else 'unknown'. " +
        "Fix: one concrete next step — a command to reproduce or the precise change. " +
        "Cite evidence from the output; generic advice like 'review the test' is a wrong answer.",
    },
    {
      role: "user",
      content:
        `Repo ${input.repo} @ ${input.sha.slice(0, 12)}, job "${input.jobName}", ` +
        `${failing.length} failing step(s).\n\nFailing output (read first):\n${failLines}\n\nAll steps:\n${summary}\n\nLog tail:\n${input.logTail.slice(0, 2000)}`,
    },
  ];
}

export interface AiRunOptions {
  gateway?: { id: string };
}

export interface AiBinding {
  run(model: string, input: unknown, options?: AiRunOptions): Promise<unknown>;
  // Present on the real AI binding; absent on fakes and older runtimes.
  websearch?(request: { gatewayId: string; query: string; limit?: number; provider?: string }): Promise<Response>;
}

// Gateway options for an inference call. Centralized so triage and
// generate front AI Gateway identically (unified billing, logging,
// cost attribution); unset id = direct inference, zero-config default.
export function gatewayOptions(gatewayId: string | undefined): AiRunOptions | undefined {
  const id = gatewayId?.trim();
  return id ? { gateway: { id } } : undefined;
}

// Workers AI sync inference rejects when busy (Sept 17): classify
// capacity errors by message so callers degrade deliberately (retryable
// 503 on direct APIs, silent skip in background triage) instead of
// lumping them with real failures.
export function isModelBusyError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.name} ${err.message}`
      : typeof err === "string"
        ? err
        : typeof err === "object" && err !== null
          ? JSON.stringify(err)
          : "";
  return /\b(busy|overloaded|capacity|rate.?limit|too many|temporar(y|ily)|429|503)\b/i.test(text.slice(0, 500));
}

export async function runTriage(
  ai: AiBinding,
  input: TriageInput,
  opts: { gatewayId?: string; searchContext?: string; model?: string } = {},
): Promise<string | null> {
  try {
    const model = opts.model?.trim() || TRIAGE_MODEL;
    const messages = buildTriageMessages(input);
    // Live web context grounds the model past its training cutoff; the
    // failing output stays primary (read first), the web section is
    // explicitly secondary so a stale snippet cannot override evidence.
    if (opts.searchContext?.trim()) {
      const last = messages[messages.length - 1];
      last.content += `\n\nLive web context (secondary — failing output above wins conflicts):\n${opts.searchContext.trim().slice(0, 1500)}`;
    }
    const span = await startGenAiSpan({
      operation: "chat",
      model,
      agentName: "triage",
      runId: input.runId,
      jobId: input.jobId,
    });
    try {
      const out = (await ai.run(
        model,
        {
          messages,
          max_tokens: TRIAGE_MAX_TOKENS,
        },
        gatewayOptions(opts.gatewayId),
      )) as { response?: unknown };
      const usage = readAiUsage(out);
      if (usage) span.setUsage(usage.inputTokens, usage.outputTokens);
      if (typeof out?.response !== "string" || !out.response.trim()) {
        span.end(false);
        return null;
      }
      span.end(true);
      return out.response.trim().slice(0, TRIAGE_MAX_STORED_CHARS);
    } catch (err) {
      span.recordError(err);
      span.end(false);
      throw err;
    }
  } catch (err) {
    // Background triage always skips on error; a busy model gets its
    // own log line so capacity skips are visible, not silent.
    if (isModelBusyError(err)) {
      console.log(JSON.stringify({ level: "warn", msg: "triage skipped: model busy", repo: input.repo }));
    }
    return null;
  }
}
