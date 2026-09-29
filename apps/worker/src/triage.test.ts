import { describe, expect, it } from "vitest";
import { buildTriageMessages, runTriage, TRIAGE_MODEL } from "./triage";

const input = {
  repo: "octo/app",
  sha: "abc123",
  jobName: "test",
  steps: [{ command: "npm test", exitCode: 1, output: "Error: Cannot find module 'express'" }],
  logTail: "tail",
};

describe("buildTriageMessages", () => {
  it("builds a capped, structured prompt", () => {
    const [sys, user] = buildTriageMessages(input);
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("Cause:");
    expect(user.content).toContain("octo/app");
    expect(user.content).toContain("Cannot find module");
    const big = buildTriageMessages({ ...input, logTail: "x".repeat(100000) });
    expect(big[1].content.length).toBeLessThan(20000);
  });
});

describe("runTriage", () => {
  it("returns trimmed model text", async () => {
    const seen: { model?: string; input?: unknown } = {};
    const fake = {
      run: async (model: string, req: unknown) => {
        seen.model = model;
        seen.input = req;
        return { response: "  Cause: missing dep.  " };
      },
    };
    await expect(runTriage(fake, input)).resolves.toBe("Cause: missing dep.");
    expect(seen.model).toBe(TRIAGE_MODEL);
    expect(JSON.stringify(seen.input)).toContain("max_tokens");
  });

  it("returns null on empty, malformed, or failed calls", async () => {
    await expect(runTriage({ run: async () => ({ response: "  " }) }, input)).resolves.toBeNull();
    await expect(runTriage({ run: async () => ({ nope: 1 }) }, input)).resolves.toBeNull();
    await expect(
      runTriage(
        {
          run: async () => {
            throw new Error("boom");
          },
        },
        input,
      ),
    ).resolves.toBeNull();
  });
});
