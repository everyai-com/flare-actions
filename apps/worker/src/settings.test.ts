import { describe, expect, it } from "vitest";
import {
  isBadgeHiddenRepo,
  parseBadgeHiddenRepos,
  validateNotifyFromEmail,
  validateNotifyMode,
  validateNotifyWebhookUrl,
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
