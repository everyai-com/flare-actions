import { describe, expect, it } from "vitest";
import { executeSteps, parseDefinition } from "./execute";

describe("executeSteps", () => {
  it("runs steps and captures output", async () => {
    const out = await executeSteps([{ run: "echo hi" }, { run: "echo bye" }], {
      cwd: "/tmp",
      env: { ...process.env },
    });
    expect(out.success).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].exitCode).toBe(0);
    expect(out.results[0].output).toContain("hi");
    expect(out.log).toContain("--- step 1: echo hi ---");
  });

  it("stops on first failure and reports exit codes", async () => {
    const out = await executeSteps([{ run: "echo before" }, { run: "exit 3" }, { run: "echo after" }], {
      cwd: "/tmp",
      env: { ...process.env },
    });
    expect(out.success).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results[1].exitCode).toBe(3);
    expect(out.log).not.toContain("after");
  });

  it("passes environment through", async () => {
    const out = await executeSteps([{ run: "echo $FLARE_SHA" }], {
      cwd: "/tmp",
      env: { ...process.env, FLARE_SHA: "abc123" },
    });
    expect(out.success).toBe(true);
    expect(out.results[0].output).toContain("abc123");
  });

  it("kills steps past the timeout", async () => {
    const out = await executeSteps([{ run: "sleep 30" }], {
      cwd: "/tmp",
      env: { ...process.env },
      timeoutMs: 200,
    });
    expect(out.success).toBe(false);
    expect(out.results[0].durationMs).toBeLessThan(10000);
  });
});

describe("parseDefinition", () => {
  it("parses stored definitions and rejects junk", () => {
    expect(parseDefinition(JSON.stringify({ steps: [{ run: "echo x" }] }))).toEqual([{ run: "echo x" }]);
    expect(parseDefinition("")).toBeNull();
    expect(parseDefinition("not json")).toBeNull();
    expect(parseDefinition(JSON.stringify({ steps: [] }))).toBeNull();
    expect(parseDefinition(JSON.stringify({ steps: [{ run: "" }] }))).toBeNull();
  });
});
