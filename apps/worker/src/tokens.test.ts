import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "./dashboard";
import { hashToken, newTokenValue, normalizeRepos, normalizeScopes, parseRepos, parseScopes, scopesAllow } from "./tokens";

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
    expect(parseScopes("admin,runner")).toEqual(["admin", "runner"]);
    expect(parseScopes("")).toEqual([]);
  });

  it("admin implies everything; runner implies run and read; readonly implies read only", () => {
    expect(scopesAllow(["admin"], "admin")).toBe(true);
    expect(scopesAllow(["admin"], "run")).toBe(true);
    expect(scopesAllow(["admin"], "read")).toBe(true);
    expect(scopesAllow(["runner"], "admin")).toBe(false);
    expect(scopesAllow(["runner"], "run")).toBe(true);
    expect(scopesAllow(["runner"], "read")).toBe(true);
    expect(scopesAllow(["readonly"], "run")).toBe(false);
    expect(scopesAllow(["readonly"], "read")).toBe(true);
    expect(scopesAllow([], "read")).toBe(false);
  });

  it("normalizes create input strictly", () => {
    expect(normalizeScopes(["runner"])).toEqual(["runner"]);
    expect(normalizeScopes(["readonly", "runner", "runner"])).toEqual(["readonly", "runner"]);
    expect(normalizeScopes(["admin"])).toEqual(["admin"]);
    expect(normalizeScopes([])).toBeNull();
    expect(normalizeScopes(["superuser"])).toBeNull();
    expect(normalizeScopes("runner")).toBeNull();
    expect(normalizeScopes([42])).toBeNull();
  });
});

describe("repo scoping", () => {
  it("normalizes repo allowlists strictly", () => {
    expect(normalizeRepos(undefined)).toEqual([]);
    expect(normalizeRepos("")).toEqual([]);
    expect(normalizeRepos("o/a, o/b,o/a")).toEqual(["o/a", "o/b"]);
    expect(normalizeRepos(["o/a"])).toEqual(["o/a"]);
    expect(normalizeRepos("nope")).toBeNull();
    expect(normalizeRepos([42])).toBeNull();
    expect(normalizeRepos(Array.from({ length: 51 }, (_, i) => `o/r${i}`))).toBeNull();
    expect(parseRepos("o/a, bad entry, o/b")).toEqual(["o/a", "o/b"]);
    expect(parseRepos("")).toEqual([]);
  });
});

describe("dashboard", () => {
  it("serves a page wired to the admin and runs APIs", () => {
    expect(DASHBOARD_HTML).toContain("<title>Flare Actions</title>");
    expect(DASHBOARD_HTML).toContain("/v1/admin/tokens");
    expect(DASHBOARD_HTML).toContain("/v1/admin/users");
    expect(DASHBOARD_HTML).toContain("/v1/admin/settings");
    expect(DASHBOARD_HTML).toContain("/v1/admin/github/login");
    expect(DASHBOARD_HTML).toContain("Login with GitHub");
    expect(DASHBOARD_HTML).toContain("/v1/admin/login");
    expect(DASHBOARD_HTML).toContain("/v1/admin/bootstrap");
    expect(DASHBOARD_HTML).toContain("/v1/admin/register");
    expect(DASHBOARD_HTML).toContain("/v1/admin/users/invite");
    expect(DASHBOARD_HTML).toContain("AI triage");
    expect(DASHBOARD_HTML).toContain("/v1/runs");
    expect(DASHBOARD_HTML).toContain('rel="icon"');
    expect(DASHBOARD_HTML).toContain("theme-color");
    expect(DASHBOARD_HTML).toContain("prefers-color-scheme");
    expect(DASHBOARD_HTML).toContain("table-scroll");
    expect(DASHBOARD_HTML).toContain('id="runsList"');
    expect(DASHBOARD_HTML).toContain("run-row");
    expect(DASHBOARD_HTML).toContain("installation_id");
    expect(DASHBOARD_HTML).toContain("setup_action");
    expect(DASHBOARD_HTML).toContain("setInterval");
    expect(DASHBOARD_HTML).toContain("details.step");
    expect(DASHBOARD_HTML).toContain('id="runsFilter"');
    expect(DASHBOARD_HTML).toContain('id="runsCount"');
    expect(DASHBOARD_HTML).toContain('id="copyTokenBtn"');
    expect(DASHBOARD_HTML).toContain('id="copyInviteBtn"');
    expect(DASHBOARD_HTML).toContain('"Escape"');
    expect(DASHBOARD_HTML).toContain("prefers-reduced-motion");
    expect(DASHBOARD_HTML).toContain('id="notifyForm"');
    expect(DASHBOARD_HTML).toContain('id="notifyFromInput"');
    expect(DASHBOARD_HTML).toContain('id="notifyModeSelect"');
    expect(DASHBOARD_HTML).toContain('id="notifyWebhookForm"');
    expect(DASHBOARD_HTML).toContain('id="notifyWebhookInput"');
    expect(DASHBOARD_HTML).toContain('id="badgeHiddenForm"');
    expect(DASHBOARD_HTML).toContain('id="badgeHiddenInput"');
    expect(DASHBOARD_HTML).toContain('id="scheduleForm"');
    expect(DASHBOARD_HTML).toContain('id="scheduleList"');
    expect(DASHBOARD_HTML).toContain("/v1/admin/schedules");
    expect(DASHBOARD_HTML).toContain('id="resetPane"');
    expect(DASHBOARD_HTML).toContain('id="resetConfirmPane"');
    expect(DASHBOARD_HTML).toContain('id="forgotBtn"');
    expect(DASHBOARD_HTML).toContain("/v1/admin/reset");
    expect(DASHBOARD_HTML).toContain('id="tokenRepos"');
    expect(DASHBOARD_HTML).toContain("just now");
    expect(DASHBOARD_HTML).not.toContain("${");
  });

  it("ships a syntactically valid inline script", () => {
    // A latent syntax error here blanks the whole dashboard (every pane
    // needs JS to appear), so the served script must always parse.
    const m = /<script>([\s\S]*)<\/script>/.exec(DASHBOARD_HTML);
    if (!m) throw new Error("dashboard has no inline script");
    expect(() => new Function(m[1])).not.toThrow();
  });
});
