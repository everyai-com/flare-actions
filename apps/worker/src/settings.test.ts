import { describe, expect, it } from "vitest";
import { validateNewPassword, validateWebhookSecret } from "./settings";

describe("validateNewPassword", () => {
  it("accepts 12-256 char passwords", () => {
    expect(validateNewPassword("a".repeat(12))).toBeNull();
    expect(validateNewPassword("a".repeat(256))).toBeNull();
  });

  it("rejects short, long, and non-string input", () => {
    expect(validateNewPassword("short")).not.toBeNull();
    expect(validateNewPassword("a".repeat(257))).not.toBeNull();
    expect(validateNewPassword(42)).not.toBeNull();
    expect(validateNewPassword(undefined)).not.toBeNull();
  });
});

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
