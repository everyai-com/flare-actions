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
  const stepLines = input.steps
    .map((s) => `$ ${s.command}\n(exit ${s.exitCode})\n${s.output.slice(0, 1500)}`)
    .join("\n\n")
    .slice(0, TRIAGE_MAX_LOG_CHARS);
  return [
    {
      role: "system",
      content:
        "You triage CI failures. Reply in ≤120 words with exactly these sections: " +
        "Cause: one sentence on the most likely cause. Culprit: file/command or 'unknown'. " +
        "Fix: one concrete next step. Be specific, no preamble.",
    },
    {
      role: "user",
      content:
        `Repo ${input.repo} @ ${input.sha.slice(0, 12)}, job "${input.jobName}", ` +
        `${failing.length} failing step(s).\n\n${stepLines}\n\nLog tail:\n${input.logTail.slice(0, 2000)}`,
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
