import { describe, expect, it } from "vitest";
import {
  isBadgeHiddenRepo,
  parseAiGatewayId,
  parseBadgeHiddenRepos,
  parseFairSharePerRepo,
  parseMcpWriteConfirm,
  parseTriageWebSearch,
  validateNotifyFromEmail,
  validateNotifyMode,
  validateNotifyWebhookUrl,
  validateTurnstileSecretKey,
  validateTurnstileSiteKey,
  validateWebhookSecret,
} from "./settings";

describe("validateWebhookSecret", () => {
  it("accepts 16-512 char secrets", () => {
    expect(validateWebhookSecret("s".repeat(16))).toBeNull();
    expect(validateWebhookSecret("s".repeat(512))).toBeNull();
  });

  it("rejects short, long, and non-string input", () => {
    expect(validateWebhookSecret("too-short")).not.toBeNull();
    expect(validateWebhookSecret("s".repeat(513))).not.toBeNull();
    expect(validateWebhookSecret(null)).not.toBeNull();
  });
});

describe("validateNotifyFromEmail", () => {
  it("accepts well-formed sender addresses", () => {
    expect(validateNotifyFromEmail("ci@example.com")).toBeNull();
  });

  it("rejects malformed and non-string input", () => {
    expect(validateNotifyFromEmail("not-an-email")).not.toBeNull();
    expect(validateNotifyFromEmail("a@b")).not.toBeNull();
    expect(validateNotifyFromEmail("")).not.toBeNull();
    expect(validateNotifyFromEmail(null)).not.toBeNull();
  });
});

describe("validateNotifyMode", () => {
  it("accepts the three modes and rejects the rest", () => {
    expect(validateNotifyMode("all")).toBeNull();
    expect(validateNotifyMode("failures")).toBeNull();
    expect(validateNotifyMode("off")).toBeNull();
    expect(validateNotifyMode("sometimes")).not.toBeNull();
    expect(validateNotifyMode(null)).not.toBeNull();
  });
});

describe("validateNotifyWebhookUrl", () => {
  it("accepts https URLs and rejects the rest", () => {
    expect(validateNotifyWebhookUrl("https://hooks.slack.com/services/T/B/X")).toBeNull();
    expect(validateNotifyWebhookUrl("https://discord.com/api/webhooks/1/x")).toBeNull();
    expect(validateNotifyWebhookUrl("http://hooks.slack.com/services/x")).not.toBeNull();
    expect(validateNotifyWebhookUrl("not a url")).not.toBeNull();
    expect(validateNotifyWebhookUrl("https://x")).not.toBeNull();
    expect(validateNotifyWebhookUrl(42)).not.toBeNull();
  });
});

describe("badge visibility", () => {
  it("parses comma strings and arrays, deduping entries", () => {
    expect(parseBadgeHiddenRepos("o/a, o/b")).toEqual({ repos: ["o/a", "o/b"] });
    expect(parseBadgeHiddenRepos(["o/a", "o/a"])).toEqual({ repos: ["o/a"] });
    expect(parseBadgeHiddenRepos("")).toEqual({ repos: [] });
  });

  it("rejects malformed entries", () => {
    expect(parseBadgeHiddenRepos(42)).toHaveProperty("error");
    expect(parseBadgeHiddenRepos(["not a repo"])).toHaveProperty("error");
    expect(parseBadgeHiddenRepos([7])).toHaveProperty("error");
  });

  it("matches case-insensitively and never matches an empty list", () => {
    expect(isBadgeHiddenRepo("o/a,o/b", "O/A")).toBe(true);
    expect(isBadgeHiddenRepo("o/a", "o/b")).toBe(false);
    expect(isBadgeHiddenRepo("", "o/a")).toBe(false);
    expect(isBadgeHiddenRepo(null, "o/a")).toBe(false);
  });
});

describe("turnstile validators", () => {
  it("accepts well-formed keys", () => {
    expect(validateTurnstileSiteKey("0x4AAAAAAAsitekey")).toBeNull();
    expect(validateTurnstileSecretKey("0x4AAAAAAAsecretkeymaterial")).toBeNull();
  });

  it("rejects empty, short, long, and non-string keys", () => {
    expect(validateTurnstileSiteKey("")).not.toBeNull();
    expect(validateTurnstileSiteKey("   ")).not.toBeNull();
    expect(validateTurnstileSiteKey("x".repeat(129))).not.toBeNull();
    expect(validateTurnstileSiteKey(null)).not.toBeNull();
    expect(validateTurnstileSecretKey("short")).not.toBeNull();
    expect(validateTurnstileSecretKey("x".repeat(513))).not.toBeNull();
    expect(validateTurnstileSecretKey(42)).not.toBeNull();
  });
});

describe("parseFairSharePerRepo", () => {
  it("accepts the D1 string form and the admin API number form", () => {
    expect(parseFairSharePerRepo("3")).toEqual({ cap: 3 });
    expect(parseFairSharePerRepo(0)).toEqual({ cap: 0 });
    expect(parseFairSharePerRepo(100)).toEqual({ cap: 100 });
  });

  it("rejects missing, fractional, negative, and oversized values", () => {
    for (const bad of [null, undefined, "", "  ", "x", 1.5, -1, 101, "101", {}, []]) {
      expect("error" in parseFairSharePerRepo(bad)).toBe(true);
    }
  });
});

describe("parseAiGatewayId", () => {
  it("accepts URL slugs and rejects the rest", () => {
    expect(parseAiGatewayId("default")).toEqual({ id: "default" });
    expect(parseAiGatewayId("prod-gw_2")).toEqual({ id: "prod-gw_2" });
    for (const bad of [null, undefined, "", "  ", "Has Caps", "has space", "has/slash", "x".repeat(65), 42]) {
      expect("error" in parseAiGatewayId(bad)).toBe(true);
    }
  });
});

describe("parseMcpWriteConfirm", () => {
  it("accepts booleans and 1/0 spellings", () => {
    expect(parseMcpWriteConfirm(true)).toEqual({ on: true });
    expect(parseMcpWriteConfirm("1")).toEqual({ on: true });
    expect(parseMcpWriteConfirm(false)).toEqual({ on: false });
    expect(parseMcpWriteConfirm("0")).toEqual({ on: false });
    expect(parseMcpWriteConfirm(null)).toEqual({ on: false });
    expect(parseMcpWriteConfirm(undefined)).toEqual({ on: false });
    expect("error" in parseMcpWriteConfirm("sometimes")).toBe(true);
    expect("error" in parseMcpWriteConfirm(2)).toBe(true);
  });
});

describe("parseTriageWebSearch", () => {
  it("accepts booleans and 1/0 spellings", () => {
    expect(parseTriageWebSearch(true)).toEqual({ on: true });
    expect(parseTriageWebSearch("1")).toEqual({ on: true });
    expect(parseTriageWebSearch(false)).toEqual({ on: false });
    expect(parseTriageWebSearch(null)).toEqual({ on: false });
    expect("error" in parseTriageWebSearch("sometimes")).toBe(true);
  });
});
