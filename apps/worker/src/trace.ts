// Root-span annotations via the Workers tracing API. The value import
// of `cloudflare:workers` breaks vitest, so the module loads lazily at
// runtime and every helper degrades to a no-op outside it. (Tracing is
// a workers-types global, so no import is needed for the types.)
// Callers must never await these on the hot path — `ctx.waitUntil()` them.

export type TraceAttributes = Record<string, string | number | boolean | undefined>;

let cached: Promise<Tracing | null> | null = null; // Isolate-cached loader; safe to memoize (no request state).

async function loadTracing(): Promise<Tracing | null> {
  if (!cached) {
    cached = import("cloudflare:workers")
      .then((mod) => mod.tracing ?? null)
      .catch(() => null);
  }
  return cached;
}

// Test hook: forget the memoized loader so each test starts clean.
export function resetTracingForTests(): void {
  cached = null;
}

// Annotate the invocation's root span (run/job/actor ids). Resolves
// once attempted; never rejects.
export async function annotateSpan(attrs: TraceAttributes): Promise<void> {
  try {
    const tracing = await loadTracing();
    tracing?.getActiveSpan()?.setAttributes(attrs);
  } catch {
    // Tracing is best-effort telemetry, never a failure mode.
  }
}

// Record an exception event on the current span. Prefer this in
// catch-all handlers next to the structured error log.
export async function recordSpanException(err: unknown): Promise<void> {
  try {
    const tracing = await loadTracing();
    const span = tracing?.getActiveSpan();
    if (!span) return;
    if (err instanceof Error) {
      span.recordException({ name: err.name || "Error", message: err.message, stack: err.stack });
    } else {
      span.recordException(String(err));
    }
  } catch {
    // See above.
  }
}

export interface GenAiSpanOptions {
  operation: "chat" | "invoke_agent";
  model: string;
  provider?: string;
  agentName?: string;
  runId?: string;
  jobId?: string;
}

// OTel GenAI semantic-convention attributes for an inference/agent
// span, plus Flare correlation ids so warm boxes and heal-agents are
// replayable from a run. Pure (tested); the span wrapper below is the
// only part that touches the runtime.
export function genAiAttributes(opts: GenAiSpanOptions): Record<string, string> {
  const attrs: Record<string, string> = {
    "gen_ai.operation.name": opts.operation,
    "gen_ai.system": opts.provider?.trim() || "cloudflare",
    "gen_ai.request.model": opts.model,
  };
  if (opts.agentName?.trim()) attrs["gen_ai.agent.name"] = opts.agentName.trim();
  if (opts.runId) attrs["flare.run.id"] = opts.runId;
  if (opts.jobId) attrs["flare.job.id"] = opts.jobId;
  return attrs;
}

export interface GenAiSpan {
  setUsage(inputTokens: number, outputTokens: number): void;
  setFinishReasons(reasons: string[]): void;
  recordError(err: unknown): void;
  end(ok?: boolean): void;
}

const noopGenAiSpan: GenAiSpan = {
  setUsage: () => undefined,
  setFinishReasons: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

// Start a GenAI span parented to the active span (or a no-op outside
// Workers). Usage/finish reasons are set best-effort — Workers AI
// responses don't always carry them, and spans must never invent data.
export async function startGenAiSpan(opts: GenAiSpanOptions): Promise<GenAiSpan> {
  try {
    const tracing = await loadTracing();
    if (!tracing) return noopGenAiSpan;
    const name = opts.operation === "chat" ? `chat ${opts.model}` : `invoke_agent ${opts.agentName ?? opts.model}`;
    const span = tracing.startSpan(name);
    span.setAttributes(genAiAttributes(opts));
    return {
      setUsage(inputTokens: number, outputTokens: number): void {
        try {
          if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens) && inputTokens >= 0 && outputTokens >= 0) {
            span.setAttributes({ "gen_ai.usage.input_tokens": inputTokens, "gen_ai.usage.output_tokens": outputTokens });
          }
        } catch {
          // Telemetry only.
        }
      },
      setFinishReasons(reasons: string[]): void {
        try {
          if (reasons.length > 0) span.setAttribute("gen_ai.response.finish_reasons", reasons.slice(0, 4).join(","));
        } catch {
          // Telemetry only.
        }
      },
      recordError(err: unknown): void {
        try {
          if (err instanceof Error) {
            span.recordException({ name: err.name || "Error", message: err.message });
          } else {
            span.recordException(String(err));
          }
          span.setStatus({ code: "error" });
        } catch {
          // Telemetry only.
        }
      },
      end(ok = true): void {
        try {
          span.setStatus({ code: ok ? "ok" : "error" });
          span.end();
        } catch {
          // Telemetry only.
        }
      },
    };
  } catch {
    return noopGenAiSpan;
  }
}

// Best-effort usage extraction from a Workers AI chat response (shape
// varies by model; absent = unknown, never estimated).
export function readAiUsage(out: unknown): { inputTokens: number; outputTokens: number } | null {
  if (typeof out !== "object" || out === null) return null;
  const usage = (out as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const rec = usage as Record<string, unknown>;
  const inputTokens = rec.prompt_tokens ?? rec.input_tokens;
  const outputTokens = rec.completion_tokens ?? rec.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return { inputTokens, outputTokens };
}
