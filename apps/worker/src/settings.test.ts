import { describe, expect, it } from "vitest";
import { validateNotifyFromEmail, validateNotifyMode, validateWebhookSecret } from "./settings";

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
