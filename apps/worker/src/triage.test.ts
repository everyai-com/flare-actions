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

  it("leads with failing output and maps every step", () => {
    const [, user] = buildTriageMessages({
      ...input,
      steps: [
        { command: "npm ci", exitCode: 0, output: "added 90 packages" },
        { command: "npm test", exitCode: 1, output: "FAIL src/a.test.ts: expected true to be false" },
      ],
    });
    expect(user.content).toContain("Failing output (read first)");
    expect(user.content).toContain("expected true to be false");
    expect(user.content).toContain("ok $ npm ci");
    expect(user.content).toContain("FAIL(1) $ npm test");
    // Full passing output stays out; only the failure carries output.
    expect(user.content).not.toContain("added 90 packages");
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

  it("fronts AI Gateway when a gateway id is set, direct otherwise", async () => {
    const seen: unknown[] = [];
    const fake = {
      run: async (_m: string, _i: unknown, o?: unknown) => {
        seen.push(o);
        return { response: "Cause: x." };
      },
    };
    await runTriage(fake, input, { gatewayId: "prod" });
    await runTriage(fake, input);
    await runTriage(fake, input, { gatewayId: "  " });
    expect(seen).toEqual([{ gateway: { id: "prod" } }, undefined, undefined]);
  });

  it("appends live web context as secondary evidence", async () => {
    let sent: { messages?: { role: string; content: string }[] } = {};
    const fake = {
      run: async (_m: string, i: unknown) => {
        sent = i as typeof sent;
        return { response: "Cause: x." };
      },
    };
    await runTriage(fake, input, { searchContext: "1. Fix X (https://a.example/x)" });
    const user = sent.messages?.[1]?.content ?? "";
    expect(user).toContain("Failing output (read first)");
    expect(user).toContain("Live web context (secondary");
    expect(user).toContain("https://a.example/x");
    expect(user.indexOf("Failing output")).toBeLessThan(user.indexOf("Live web context"));
  });
});
