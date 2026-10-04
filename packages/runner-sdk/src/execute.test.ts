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

  it("continues past a continue-on-error failure and still succeeds", async () => {
    const out = await executeSteps(
      [{ run: "exit 3", continueOnError: true }, { run: "echo after" }],
      { cwd: "/tmp", env: { ...process.env } },
    );
    expect(out.success).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].exitCode).toBe(3);
    expect(out.log).toContain("after");
    expect(out.log).toContain("continue-on-error");
  });

  it("runs failure() and always() steps after a failure, skipping defaults", async () => {
    const out = await executeSteps(
      [
        { run: "exit 3" },
        { run: "echo default" },
        { run: "echo cleanup", if: "always()" },
        { run: "echo notify", if: "failure()" },
        { run: "echo no", if: "success()" },
      ],
      { cwd: "/tmp", env: { ...process.env } },
    );
    expect(out.success).toBe(false);
    expect(out.log).toContain("skipped (success())");
    expect(out.log).toContain("cleanup");
    expect(out.log).toContain("notify");
    expect(out.log).not.toContain("default");
    expect(out.results.map((r) => r.command)).toEqual(["exit 3", "echo cleanup", "echo notify"]);
  });

  it("treats continue-on-error failures as failure() without failing the job", async () => {
    const out = await executeSteps(
      [{ run: "exit 1", continueOnError: true }, { run: "echo notify", if: "failure()" }, { run: "echo next" }],
      { cwd: "/tmp", env: { ...process.env } },
    );
    expect(out.success).toBe(true);
    expect(out.log).toContain("notify");
    expect(out.log).toContain("next");
  });

  it("runs steps under the requested shell", async () => {
    const out = await executeSteps([{ run: "echo $0", shell: "bash" }], { cwd: "/tmp", env: { ...process.env } });
    expect(out.success).toBe(true);
    expect(out.results[0].output).toContain("bash");
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

  it("round-trips continue-on-error and rejects malformed flags", () => {
    expect(parseDefinition(JSON.stringify({ steps: [{ run: "a", continueOnError: true }] }))).toEqual([
      { run: "a", continueOnError: true },
    ]);
    expect(parseDefinition(JSON.stringify({ steps: [{ run: "a", continueOnError: "yes" }] }))).toBeNull();
  });
});
