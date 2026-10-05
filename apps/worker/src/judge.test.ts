import { describe, expect, it, vi } from "vitest";
import { buildJudgeText, judgeFlaky, JUDGE_MODEL, readFlakyProbability } from "./judge";

describe("readFlakyProbability", () => {
  it("reads noul answers, bare numbers, and probability members", () => {
    expect(readFlakyProbability({ flaky: { type: "noul", noul: 0.01 } })).toBe(0.01);
    expect(readFlakyProbability({ flaky: 0.87 })).toBe(0.87);
    expect(readFlakyProbability({ flaky: { probability: 0.3 } })).toBe(0.3);
  });

  it("returns null for malformed answers (fail open)", () => {
    expect(readFlakyProbability(null)).toBeNull();
    expect(readFlakyProbability({})).toBeNull();
    expect(readFlakyProbability({ flaky: { type: "noul" } })).toBeNull();
    expect(readFlakyProbability({ flaky: "yes" })).toBeNull();
    expect(readFlakyProbability({ flaky: Number.NaN })).toBeNull();
  });
});

describe("buildJudgeText", () => {
  it("packs job, failing commands, triage, and tail within bounds", () => {
    const text = buildJudgeText({
      jobName: "e2e",
      steps: [
        { command: "npm ci", exitCode: 0, output: "ok" },
        { command: "npm run e2e", exitCode: 1, output: "timeout 30s waiting for confirm" },
      ],
      logTail: "1 failed",
      triage: "possible flake",
    });
    expect(text).toContain("job: e2e");
    expect(text).toContain("npm run e2e");
    expect(text).toContain("timeout 30s");
    expect(text).not.toContain("npm ci");
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});

describe("judgeFlaky", () => {
  it("calls Clef with the decision shape and returns p(flaky)", async () => {
    const run = vi.fn().mockResolvedValue({ answers: { flaky: { type: "noul", noul: 0.92 } } });
    const p = await judgeFlaky({ run }, "FAIL e2e timeout");
    expect(p).toBe(0.92);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input] = run.mock.calls[0] as [string, Record<string, unknown>];
    expect(model).toBe(JUDGE_MODEL);
    expect(input).toMatchObject({ model: "clef" });
    expect(input.questions).toEqual({
      flaky: { type: "noul", instructions: expect.stringContaining("flaky") as string },
    });
  });

  it("fails open (null) on model errors and malformed answers", async () => {
    const failing = { run: vi.fn().mockRejectedValue(new Error("busy")) };
    await expect(judgeFlaky(failing, "x")).resolves.toBeNull();
    const malformed = { run: vi.fn().mockResolvedValue({ answers: { flaky: "maybe" } }) };
    await expect(judgeFlaky(malformed, "x")).resolves.toBeNull();
  });
});
