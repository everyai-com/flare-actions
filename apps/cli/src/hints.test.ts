import { describe, expect, it } from "vitest";
import { applyTokenAlias, levenshtein, missingConfigMessage, missingConfigVars, resolveToken, suggestCommand } from "./hints.ts";

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
