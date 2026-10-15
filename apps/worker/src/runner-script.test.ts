import { describe, expect, it } from "vitest";
import { RUNNER_DEFAULT_REF, RUNNER_REPO_URL, resolveRunnerRef, runnerScript } from "./runner-script";

describe("runnerScript", () => {
  it("pins the origin and keeps shell variables literal", () => {
    const s = runnerScript("https://flare.example.workers.dev");
    expect(s).not.toBeNull();
    const script = s ?? "";
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('URL="https://flare.example.workers.dev"');
    expect(script).toContain('CODE="${FLARE_PAIR_CODE:-${1:-}}"');
    expect(script).toContain('DIR="${FLARE_RUNNER_DIR:-$HOME/flare-runner}"');
    expect(script).toContain(RUNNER_REPO_URL);
    expect(script).toContain("Node.js 22.6 or newer");
  });

  it("refuses origins that could inject into the script", () => {
    expect(runnerScript('https://x.dev"; rm -rf ~; "')).toBeNull();
    expect(runnerScript("https://x.dev/path")).toBeNull();
    expect(runnerScript("javascript:alert(1)")).toBeNull();
    expect(runnerScript("http://localhost:8787")).not.toBeNull();
  });

  it("pins the runner checkout to a tag or full SHA, never a moving branch", () => {
    const sha = "a".repeat(40);
    const script = runnerScript("https://x.dev", sha) ?? "";
    expect(script).toContain('REF="${FLARE_RUNNER_REF:-' + sha + '}"');
    expect(script).toContain('fetch --depth 1 --quiet origin "$REF"');
    expect(script).toContain("checkout --quiet --detach FETCH_HEAD");
    // A SHA pin is verified against the checkout before anything runs.
    expect(script).toContain('[ "$(git -C "$DIR" rev-parse HEAD)" = "$REF" ]');
    expect(script).not.toMatch(/git clone|pull --ff-only|--branch|\bmain\b/);
    expect(runnerScript("https://x.dev", "v0.3.0")).toContain("v0.3.0");
    for (const bad of ["main", "HEAD", "v1", "abc123", "v1.2.3; rm -rf ~", "a".repeat(39)]) {
      expect(runnerScript("https://x.dev", bad)).toBeNull();
    }
  });

  it("never puts the pairing code in a process's argv", () => {
    const script = runnerScript("https://x.dev") ?? "";
    expect(script).toContain("| FLARE_PAIR_CODE=<CODE> sh");
    // The code reaches the pairing step only through the environment...
    expect(script).toContain('FLARE_PAIR_CODE="$CODE"');
    expect(script).toContain("code: e.FLARE_PAIR_CODE");
    // ...never as a --pair argument, and is unset before the runner starts.
    expect(script).not.toContain("--pair");
    const lines = script.split("\n");
    const unset = lines.indexOf("unset CODE FLARE_PAIR_CODE");
    const start = lines.findIndex((l) => l.includes("exec npm run --silent runner"));
    expect(unset).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(unset);
    // Only the guard and the env-prefixed pairing step mention $CODE.
    const codeUses = lines.filter((l) => l.includes("$CODE"));
    expect(codeUses).toEqual([
      'if [ -n "$CODE" ]; then',
      expect.stringContaining('FLARE_PAIR_CODE="$CODE" FLARE_PAIR_NAME="$NAME" node '),
    ]);
  });
});

describe("resolveRunnerRef", () => {
  it("prefers the deployment ref, then the fleet version tag, then the default", () => {
    const sha = "b".repeat(40);
    expect(resolveRunnerRef(sha, "0.4.0")).toBe(sha);
    expect(resolveRunnerRef("v0.5.0", null)).toBe("v0.5.0");
    expect(resolveRunnerRef("main", "0.4.0")).toBe("v0.4.0");
    expect(resolveRunnerRef(undefined, "0.4.0-rc.1")).toBe("v0.4.0-rc.1");
    expect(resolveRunnerRef(undefined, "")).toBe(RUNNER_DEFAULT_REF);
    expect(resolveRunnerRef("", "nope")).toBe(RUNNER_DEFAULT_REF);
    expect(RUNNER_DEFAULT_REF).toMatch(/^[0-9a-f]{40}$/);
  });
});
