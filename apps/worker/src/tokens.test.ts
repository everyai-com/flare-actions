import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "./dashboard";
import { hashToken, newTokenValue, normalizeScopes, parseScopes, scopesAllow } from "./tokens";

describe("hashToken", () => {
  it("is deterministic and hex-shaped", async () => {
    const a = await hashToken("abc");
    const b = await hashToken("abc");
    const c = await hashToken("abd");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(c);
  });
});

describe("newTokenValue", () => {
  it("generates unique 64-hex values", () => {
    const a = newTokenValue();
    const b = newTokenValue();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("scopes", () => {
  it("parses and filters stored scope strings", () => {
    expect(parseScopes("runner")).toEqual(["runner"]);
    expect(parseScopes("runner, readonly")).toEqual(["runner", "readonly"]);
    expect(parseScopes("admin,runner")).toEqual(["runner"]);
    expect(parseScopes("")).toEqual([]);
  });

  it("runner implies run and read; readonly implies read only", () => {
    expect(scopesAllow(["runner"], "run")).toBe(true);
    expect(scopesAllow(["runner"], "read")).toBe(true);
    expect(scopesAllow(["readonly"], "run")).toBe(false);
    expect(scopesAllow(["readonly"], "read")).toBe(true);
    expect(scopesAllow([], "read")).toBe(false);
  });

  it("normalizes create input strictly", () => {
    expect(normalizeScopes(["runner"])).toEqual(["runner"]);
    expect(normalizeScopes(["readonly", "runner", "runner"])).toEqual(["readonly", "runner"]);
    expect(normalizeScopes([])).toBeNull();
    expect(normalizeScopes(["admin"])).toBeNull();
    expect(normalizeScopes("runner")).toBeNull();
    expect(normalizeScopes([42])).toBeNull();
  });
});

describe("dashboard", () => {
  it("serves a page wired to the admin and runs APIs", () => {
    expect(DASHBOARD_HTML).toContain("<title>Flare Actions</title>");
    expect(DASHBOARD_HTML).toContain("/v1/admin/tokens");
    expect(DASHBOARD_HTML).toContain("/v1/admin/setup");
    expect(DASHBOARD_HTML).toContain("/v1/admin/settings");
    expect(DASHBOARD_HTML).toContain("/v1/runs");
    expect(DASHBOARD_HTML).not.toContain("${");
  });
});
