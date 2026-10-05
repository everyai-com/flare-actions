import { TRIAGE_MODEL, gatewayOptions, isModelBusyError, type AiBinding } from "./triage";
import { readAiUsage, startGenAiSpan } from "./trace";

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

export type GenerateOutcome = { status: "ok"; yaml: string } | { status: "busy" } | { status: "failed" };

export async function runGenerateWithStatus(
  ai: AiBinding,
  prompt: string,
  opts: { gatewayId?: string } = {},
): Promise<GenerateOutcome> {
  const span = await startGenAiSpan({ operation: "chat", model: TRIAGE_MODEL, agentName: "generate_pipeline" });
  try {
    const out = (await ai.run(
      TRIAGE_MODEL,
      {
        messages: buildGenerateMessages(prompt),
        max_tokens: GENERATE_MAX_TOKENS,
      },
      gatewayOptions(opts.gatewayId),
    )) as { response?: unknown };
    const usage = readAiUsage(out);
    if (usage) span.setUsage(usage.inputTokens, usage.outputTokens);
    if (typeof out?.response !== "string" || !out.response.trim()) {
      span.end(false);
      return { status: "failed" };
    }
    const yaml = extractYaml(out.response);
    const ok = yaml.includes("jobs:");
    span.end(ok);
    return ok ? { status: "ok", yaml } : { status: "failed" };
  } catch (err) {
    span.recordError(err);
    span.end(false);
    return isModelBusyError(err) ? { status: "busy" } : { status: "failed" };
  }
}

export async function runGenerate(
  ai: AiBinding,
  prompt: string,
  opts: { gatewayId?: string } = {},
): Promise<string | null> {
  const out = await runGenerateWithStatus(ai, prompt, opts);
  return out.status === "ok" ? out.yaml : null;
}
