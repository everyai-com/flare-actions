import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeSteps, parseDefinition } from "./execute";

describe("executeSteps", () => {
  it("exposes earlier steps' outputs to later steps as FLARE_STEPS_* env", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-steps-env-"));
    try {
      const out = await executeSteps(
        [
          { id: "meta", run: 'echo "before=[${FLARE_STEPS_META_TAG:-unset}]"; echo "tag=v1.2; rm -rf x" >> "$GITHUB_OUTPUT"' },
          { run: 'echo "after=[$FLARE_STEPS_META_TAG]"' },
        ],
        { cwd, env: { ...process.env } },
      );
      expect(out.success).toBe(true);
      expect(out.results[0].output).toContain("before=[unset]");
      expect(out.results[1].output).toContain("after=[v1.2; rm -rf x]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

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

  it("collects $FLARE_OUTPUT per step id with a step<N> fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-exec-out-"));
    try {
      const out = await executeSteps(
        [
          { run: 'echo "url=https://x.example" >> "$FLARE_OUTPUT"', id: "deploy" },
          { run: 'echo "sha=abc" >> "$GITHUB_OUTPUT"' },
        ],
        { cwd: dir, env: { ...process.env } },
      );
      expect(out.success).toBe(true);
      expect(out.stepOutputs).toEqual({ deploy: { url: "https://x.example" }, step2: { sha: "abc" } });
      expect(out.log).toContain("[outputs] step deploy: url=https://x.example");
      expect(existsSync(join(dir, ".flare-output-0"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes failed-step outputs but nothing for skipped steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-exec-out-"));
    try {
      const out = await executeSteps(
        [
          { run: 'echo "partial=1" >> "$FLARE_OUTPUT"; exit 3' },
          { run: 'echo "never=1" >> "$FLARE_OUTPUT"' },
        ],
        { cwd: dir, env: { ...process.env } },
      );
      expect(out.success).toBe(false);
      expect(out.stepOutputs).toEqual({ step1: { partial: "1" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates steps on needs and earlier-step outputs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-exec-if-"));
    try {
      const out = await executeSteps(
        [
          { run: 'echo "sha=abc" >> "$FLARE_OUTPUT"', id: "prep" },
          { run: "echo gated-by-steps", if: "steps.prep.outputs.sha == 'abc'" },
          { run: "echo gated-by-needs", if: "needs.build.result == 'success'" },
          { run: "echo skipped-step", if: "needs.build.outputs.tag == 'zzz'" },
        ],
        { cwd: dir, env: { ...process.env }, needs: { build: { result: "success", outputs: { tag: "v1" } } } },
      );
      expect(out.success).toBe(true);
      expect(out.results.map((r) => r.command)).toEqual([
        'echo "sha=abc" >> "$FLARE_OUTPUT"',
        "echo gated-by-steps",
        "echo gated-by-needs",
      ]);
      expect(out.log).toContain("skipped (needs.build.outputs.tag == 'zzz')");
      expect(out.log).not.toContain("echo skipped-step");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notes truncated values and ignored lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-exec-out-"));
    try {
      const out = await executeSteps(
        [
          {
            run: 'python3 -c "print(\'big=\' + \'x\'*2000)" >> "$FLARE_OUTPUT"; echo "garbage line" >> "$FLARE_OUTPUT"; echo "ok=1" >> "$FLARE_OUTPUT"',
          },
        ],
        { cwd: dir, env: { ...process.env } },
      );
      expect(out.success).toBe(true);
      expect(out.stepOutputs.step1?.big?.length).toBe(1024);
      expect(out.stepOutputs.step1?.ok).toBe("1");
      expect(out.log).toContain("truncated values: big");
      expect(out.log).toContain("ignored lines: 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("executeSteps step files", () => {
  it("propagates $GITHUB_ENV (incl. heredoc) to later steps only, ignoring denylisted names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-env-"));
    try {
      const out = await executeSteps(
        [
          { run: 'echo "early=[$ENVFILE_FOO]"' },
          {
            run: 'echo "ENVFILE_FOO=bar" >> "$GITHUB_ENV"; printf "ENVFILE_MULTI<<EOF\\nl1\\nl2\\nEOF\\n" >> "$FLARE_ENV"; echo "NODE_OPTIONS=--inspect" >> "$GITHUB_ENV"; echo "same=[$ENVFILE_FOO]"',
          },
          { run: 'echo "later=[$ENVFILE_FOO] node=[$NODE_OPTIONS]"; echo "$ENVFILE_MULTI"' },
        ],
        { cwd: dir, env: { ...process.env } },
      );
      expect(out.success).toBe(true);
      expect(out.results[0].output).toContain("early=[]");
      expect(out.results[1].output).toContain("same=[]");
      expect(out.results[2].output).toContain("later=[bar] node=[");
      expect(out.results[2].output).not.toContain("--inspect");
      expect(out.results[2].output).toContain("l1\nl2");
      expect(out.log).toContain("[env] step step2: set ENVFILE_FOO, ENVFILE_MULTI");
      expect(out.log).toContain("ignored (reserved or invalid names): NODE_OPTIONS");
      expect(existsSync(join(dir, ".flare-env-1"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leak $GITHUB_ENV across jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-env-"));
    try {
      await executeSteps([{ run: 'echo "ENVFILE_LEAK=1" >> "$GITHUB_ENV"' }], { cwd: dir, env: { ...process.env } });
      const out = await executeSteps([{ run: 'echo "leak=[$ENVFILE_LEAK]"' }], { cwd: dir, env: { ...process.env } });
      expect(out.results[0].output).toContain("leak=[]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepends $GITHUB_PATH entries with later lines first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-path-"));
    try {
      const out = await executeSteps(
        [{ run: 'echo "/opt/a" >> "$GITHUB_PATH"; echo "/opt/b" >> "$GITHUB_PATH"' }, { run: 'echo "path=$PATH"' }],
        { cwd: dir, env: { ...process.env, PATH: "/usr/bin:/bin" } },
      );
      expect(out.results[1].output).toContain("path=/opt/b:/opt/a:/usr/bin:/bin");
      expect(out.log).toContain("[path] step step1: prepended /opt/a, /opt/b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends $GITHUB_STEP_SUMMARY to the log, bounded per job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-sum-"));
    try {
      const out = await executeSteps(
        [
          { run: 'echo "## Results" >> "$GITHUB_STEP_SUMMARY"', id: "report" },
          { run: 'head -c 70000 /dev/zero | tr "\\0" x >> "$FLARE_STEP_SUMMARY"' },
          { run: 'echo "dropped" >> "$GITHUB_STEP_SUMMARY"' },
        ],
        { cwd: dir, env: { ...process.env } },
      );
      expect(out.log).toContain("── step summary ── (report)\n## Results");
      expect(out.log).toContain("step summary truncated");
      expect(out.log).not.toContain("── step summary ── (step3)");
      expect(out.log.length).toBeLessThan(70000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("round-trips step ids and rejects bad or duplicate ones", () => {
    expect(parseDefinition(JSON.stringify({ steps: [{ run: "a", id: "deploy" }] }))).toEqual([{ run: "a", id: "deploy" }]);
    expect(parseDefinition(JSON.stringify({ steps: [{ run: "a", id: "9bad" }] }))).toBeNull();
    expect(parseDefinition(JSON.stringify({ steps: [{ run: "a", id: "x" }, { run: "b", id: "x" }] }))).toBeNull();
  });
});
