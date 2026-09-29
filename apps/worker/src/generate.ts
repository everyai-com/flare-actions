import type { AiBinding } from "./triage";
import { TRIAGE_MODEL } from "./triage";

export const GENERATE_MAX_TOKENS = 1024;
export const GENERATE_MAX_PROMPT_CHARS = 2000;

export function buildGenerateMessages(prompt: string): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You write flare.yml CI pipelines. A flare.yml has a top-level `jobs:` map; each job has `steps:` " +
        "with `run:` shell commands, plus optional runs-on labels, env, needs (job names), strategy.matrix, " +
        "concurrency ({group, cancel-in-progress}), container image, services ({image, ports, env}), " +
        "cache ({key, paths}), artifacts ({name, paths}), and timeout-minutes. " +
        "Output ONLY the YAML document, no fences, no explanation.",
    },
    { role: "user", content: prompt.slice(0, GENERATE_MAX_PROMPT_CHARS) },
  ];
}

// Strip code fences when the model adds them despite instructions.
export function extractYaml(text: string): string {
  const fenced = /```(?:ya?ml)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  return body.slice(0, 16384);
}

export async function runGenerate(ai: AiBinding, prompt: string): Promise<string | null> {
  try {
    const out = (await ai.run(TRIAGE_MODEL, {
      messages: buildGenerateMessages(prompt),
      max_tokens: GENERATE_MAX_TOKENS,
    })) as { response?: unknown };
    if (typeof out?.response !== "string" || !out.response.trim()) return null;
    const yaml = extractYaml(out.response);
    return yaml.includes("jobs:") ? yaml : null;
  } catch {
    return null;
  }
}
