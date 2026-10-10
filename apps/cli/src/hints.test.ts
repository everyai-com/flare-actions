import { describe, expect, it } from "vitest";
import {
  applyTokenAlias,
  cliInvocation,
  levenshtein,
  missingConfigMessage,
  missingConfigVars,
  nextAfterError,
  nextAfterRun,
  resolveToken,
  suggestCommand,
} from "./hints.ts";

const COMMANDS = ["runs", "logs", "run", "watch", "dispatch", "doctor", "login", "status-x"];

describe("token alias", () => {
  it("fills RUNNER_TOKEN from FLARE_TOKEN when unset or empty", () => {
    const env: Record<string, string | undefined> = { FLARE_TOKEN: "f" };
    expect(applyTokenAlias(env)).toBe(true);
    expect(env["RUNNER_TOKEN"]).toBe("f");
    const empty: Record<string, string | undefined> = { RUNNER_TOKEN: "", FLARE_TOKEN: "f" };
    expect(applyTokenAlias(empty)).toBe(true);
    expect(empty["RUNNER_TOKEN"]).toBe("f");
  });

  it("never overrides an explicit RUNNER_TOKEN", () => {
    const env: Record<string, string | undefined> = { RUNNER_TOKEN: "r", FLARE_TOKEN: "f" };
    expect(applyTokenAlias(env)).toBe(false);
    expect(resolveToken(env)).toBe("r");
  });
});

describe("missing config", () => {
  it("names each missing variable and the .env search", () => {
    expect(missingConfigVars({ FLARE_ACTIONS_URL: "https://x", FLARE_TOKEN: "t" })).toEqual([]);
    const missing = missingConfigVars({ FLARE_ACTIONS_URL: " " });
    expect(missing).toEqual(["FLARE_ACTIONS_URL", "RUNNER_TOKEN (or FLARE_TOKEN)"]);
    const msg = missingConfigMessage(missing, { path: null, searchedFrom: "/tmp/w" });
    expect(msg).toContain("missing FLARE_ACTIONS_URL and RUNNER_TOKEN (or FLARE_TOKEN)");
    expect(msg).toContain("none found in /tmp/w");
    expect(msg).toContain("npm run cli -- login");
    expect(msg).toContain("npm run setup");
    expect(missingConfigMessage(["FLARE_ACTIONS_URL"], { path: "/r/.env", searchedFrom: "/r" })).toContain("read /r/.env");
  });
});

describe("suggestCommand", () => {
  it("computes edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });

  it("suggests close typos and prefixes", () => {
    expect(suggestCommand("rnus", COMMANDS)).toBe("runs");
    expect(suggestCommand("doctr", COMMANDS)).toBe("doctor");
    expect(suggestCommand("disp", COMMANDS)).toBe("dispatch");
    expect(suggestCommand("LOGIN", COMMANDS)).toBe("login");
  });

  it("stays quiet when nothing is close", () => {
    expect(suggestCommand("zzzzzzzz", COMMANDS)).toBeNull();
    expect(suggestCommand("x", COMMANDS)).toBeNull();
  });
});

describe("next-move helpers", () => {
  it("detects how the CLI was invoked", () => {
    expect(cliInvocation(["node", "/r/apps/cli/src/index.ts"], { npm_lifecycle_event: "cli" })).toBe("npm run cli --");
    expect(cliInvocation(["node", "/x/node_modules/.bin/flare-forge"], { npm_command: "exec" })).toBe("npx flare-forge");
    expect(cliInvocation(["node", "/usr/local/bin/flare"], {})).toBe("flare");
    expect(cliInvocation(["node", "/usr/local/bin/flare-forge"], {})).toBe("flare-forge");
    expect(cliInvocation(["node", "/p/dist/cli.mjs"], {})).toBe("npx flare-forge");
    expect(cliInvocation(["node", "/r/apps/cli/src/index.ts"], {})).toBe("npm run cli --");
  });

  it("missing config ends with one login next line in the caller's form", () => {
    const msg = missingConfigMessage(["FLARE_ACTIONS_URL"], undefined, "flare-forge");
    expect(msg.split("\n").pop()).toMatch(/^next: flare-forge login/);
  });

  it("after a run: failed → explain, running → watch, green → runs", () => {
    expect(nextAfterRun("cli", { runId: "r1", status: "failure", repo: "o/r" })).toMatch(/^next: cli explain r1/);
    expect(nextAfterRun("cli", { runId: "r1", status: "running", repo: "o/r" })).toMatch(/^next: cli watch r1/);
    expect(nextAfterRun("cli", { runId: "r1", status: "success", repo: "o/r" })).toMatch(/^next: cli runs/);
  });

  it("after an error: auth → doctor, unknown id → runs, budget → usage", () => {
    expect(nextAfterError("cli", null)).toMatch(/^next: cli doctor/);
    expect(nextAfterError("cli", { status: 401, code: null })).toMatch(/^next: cli doctor/);
    expect(nextAfterError("cli", { status: 404, code: "run_not_found" })).toMatch(/^next: cli runs/);
    expect(nextAfterError("cli", { status: 429, code: "budget_exceeded" })).toMatch(/^next: cli usage/);
    expect(nextAfterError("cli", { status: 409, code: "repo_paused" })).toMatch(/^next: cli paused/);
  });
});
