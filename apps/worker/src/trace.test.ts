import { describe, expect, it } from "vitest";
import { annotateSpan, recordSpanException, resetTracingForTests } from "./trace";

describe("trace", () => {
  it("degrades to a no-op outside the Workers runtime", async () => {
    resetTracingForTests();
    // cloudflare:workers does not resolve under vitest; both helpers
    // must resolve quietly instead of rejecting.
    await expect(annotateSpan({ "run.id": "r1", "job.id": "j1" })).resolves.toBeUndefined();
    await expect(recordSpanException(new Error("boom"))).resolves.toBeUndefined();
    await expect(recordSpanException("string failure")).resolves.toBeUndefined();
  });
});
