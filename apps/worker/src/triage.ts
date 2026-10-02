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

export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export async function runTriage(ai: AiBinding, input: TriageInput): Promise<string | null> {
  try {
    const out = (await ai.run(TRIAGE_MODEL, {
      messages: buildTriageMessages(input),
      max_tokens: TRIAGE_MAX_TOKENS,
    })) as { response?: unknown };
    if (typeof out?.response !== "string" || !out.response.trim()) return null;
    return out.response.trim().slice(0, TRIAGE_MAX_STORED_CHARS);
  } catch {
    return null;
  }
}
