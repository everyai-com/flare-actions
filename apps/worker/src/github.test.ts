import { describe, expect, it } from "vitest";
import { timingSafeEqualHex, verifyGitHubSignature } from "./github";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifyGitHubSignature", () => {
  it("accepts a valid signature", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await sign("secret123", body);
    const ok = await verifyGitHubSignature(
      new TextEncoder().encode(body).buffer as ArrayBuffer,
      `sha256=${sig}`,
      "secret123",
    );
    expect(ok).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await sign("secret123", body);
    const ok = await verifyGitHubSignature(
      new TextEncoder().encode(body).buffer as ArrayBuffer,
      `sha256=${sig}`,
      "wrong",
    );
    expect(ok).toBe(false);
  });

  it("rejects a missing header", async () => {
    const ok = await verifyGitHubSignature(
      new TextEncoder().encode("{}").buffer as ArrayBuffer,
      null,
      "secret123",
    );
    expect(ok).toBe(false);
  });
});

describe("timingSafeEqualHex", () => {
  it("compares equal and unequal hex", () => {
    expect(timingSafeEqualHex("ab12", "ab12")).toBe(true);
    expect(timingSafeEqualHex("ab12", "ab13")).toBe(false);
    expect(timingSafeEqualHex("ab12", "ab1")).toBe(false);
  });
});
