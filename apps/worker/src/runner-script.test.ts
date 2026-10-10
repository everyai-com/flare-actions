import { describe, expect, it } from "vitest";
import { RUNNER_REPO_URL, runnerScript } from "./runner-script";

describe("runnerScript", () => {
  it("pins the origin and keeps shell variables literal", () => {
    const s = runnerScript("https://flare.example.workers.dev");
    expect(s).not.toBeNull();
    const script = s ?? "";
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('URL="https://flare.example.workers.dev"');
    expect(script).toContain('CODE="${1:-}"');
    expect(script).toContain('DIR="${FLARE_RUNNER_DIR:-$HOME/flare-runner}"');
    expect(script).toContain(RUNNER_REPO_URL);
    expect(script).toContain('--pair "$CODE"');
    expect(script).toContain("Node.js 22.6 or newer");
  });

  it("refuses origins that could inject into the script", () => {
    expect(runnerScript('https://x.dev"; rm -rf ~; "')).toBeNull();
    expect(runnerScript("https://x.dev/path")).toBeNull();
    expect(runnerScript("javascript:alert(1)")).toBeNull();
    expect(runnerScript("http://localhost:8787")).not.toBeNull();
  });
});
