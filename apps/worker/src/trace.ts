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
