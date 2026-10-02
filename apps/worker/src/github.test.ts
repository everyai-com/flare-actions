import { describe, expect, it } from "vitest";
import { resolveRefToSha, timingSafeEqualHex, verifyGitHubSignature } from "./github";

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

describe("resolveRefToSha", () => {
  const realFetch = globalThis.fetch;

  function stubFetch(handler: (url: string) => { ok: boolean; body?: unknown }) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const out = handler(String(input));
      return { ok: out.ok, json: async () => out.body ?? null };
    }) as typeof fetch;
  }

  it("resolves branches via heads", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return url.includes("/heads/main")
        ? { ok: true, body: { object: { sha: "abc1234" } } }
        : { ok: false };
    });
    try {
      expect(await resolveRefToSha(null, "o/r", "main")).toBe("abc1234");
      expect(seen[0]).toContain("repos/o/r/git/refs/heads/main");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("falls back to tags and encodes segments", async () => {
    stubFetch((url) =>
      url.includes("/tags/v1")
        ? { ok: true, body: { object: { sha: "def5678" } } }
        : { ok: false },
    );
    try {
      expect(await resolveRefToSha("tok", "o/r", "v1")).toBe("def5678");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns null for unknown refs", async () => {
    stubFetch(() => ({ ok: false }));
    try {
      expect(await resolveRefToSha(null, "o/r", "nope")).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
