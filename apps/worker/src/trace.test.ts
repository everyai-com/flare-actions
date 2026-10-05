import { describe, expect, it } from "vitest";
import {
  annotateSpan,
  genAiAttributes,
  readAiUsage,
  recordSpanException,
  resetTracingForTests,
  startGenAiSpan,
} from "./trace";

describe("trace", () => {
  it("degrades to a no-op outside the Workers runtime", async () => {
    resetTracingForTests();
    // cloudflare:workers does not resolve under vitest; both helpers
    // must resolve quietly instead of rejecting.
    await expect(annotateSpan({ "run.id": "r1", "job.id": "j1" })).resolves.toBeUndefined();
    await expect(recordSpanException(new Error("boom"))).resolves.toBeUndefined();
    await expect(recordSpanException("string failure")).resolves.toBeUndefined();
  });

  it("builds GenAI convention attributes with Flare correlation", () => {
    expect(genAiAttributes({ operation: "chat", model: "@cf/meta/llama", runId: "r", jobId: "j" })).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "cloudflare",
      "gen_ai.request.model": "@cf/meta/llama",
      "flare.run.id": "r",
      "flare.job.id": "j",
    });
    expect(genAiAttributes({ operation: "invoke_agent", model: "m", agentName: "heal", provider: "acme" })).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.system": "acme",
      "gen_ai.request.model": "m",
      "gen_ai.agent.name": "heal",
    });
  });

  it("hands out a safe no-op span outside Workers", async () => {
    resetTracingForTests();
    const span = await startGenAiSpan({ operation: "chat", model: "m" });
    expect(() => {
      span.setUsage(1, 2);
      span.setUsage(-1, Number.NaN);
      span.setFinishReasons(["stop"]);
      span.recordError(new Error("x"));
      span.end();
      span.end(false);
    }).not.toThrow();
  });

  it("reads usage best-effort, never inventing it", () => {
    expect(readAiUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(readAiUsage({ usage: { input_tokens: 3, output_tokens: 4 } })).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(readAiUsage({ response: "hi" })).toBeNull();
    expect(readAiUsage(null)).toBeNull();
    expect(readAiUsage({ usage: { prompt_tokens: "lots" } })).toBeNull();
  });
});
