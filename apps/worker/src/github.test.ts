import { describe, expect, it } from "vitest";
import { deleteRunner, fetchChangedFiles, generateJitConfig, resolveRefToSha, timingSafeEqualHex, verifyGitHubSignature } from "./github";

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

describe("fetchChangedFiles", () => {
  const realFetch = globalThis.fetch;

  function stub(handler: (url: string, headers: Record<string, string>) => { ok: boolean; status?: number; body?: unknown }) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers });
      const out = handler(url, headers);
      return {
        ok: out.ok,
        status: out.status ?? (out.ok ? 200 : 500),
        json: async () => out.body ?? null,
      };
    }) as typeof fetch;
    return calls;
  }

  it("reads push compares and PR file lists, deduping results", async () => {
    stub(() => ({
      ok: true,
      body: { files: [{ filename: "src/a.ts" }, { filename: "src/a.ts" }, { filename: "docs/b.md" }] },
    }));
    try {
      expect(await fetchChangedFiles("o/r", { before: "abc1234", after: "def5678" }, null)).toEqual([
        "src/a.ts",
        "docs/b.md",
      ]);
      expect(await fetchChangedFiles("o/r", { prNumber: 7 }, null)).toEqual(["src/a.ts", "docs/b.md"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns [] without fetching for zero-SHA pushes", async () => {
    const calls = stub(() => ({ ok: true, body: { files: [{ filename: "a.ts" }] } }));
    try {
      expect(await fetchChangedFiles("o/r", { before: "0".repeat(40), after: "def5678" }, null)).toEqual([]);
      expect(calls.length).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("treats 404 as definitive and falls back from a bad token", async () => {
    const notFound = stub(() => ({ ok: false, status: 404 }));
    try {
      expect(await fetchChangedFiles("o/r", { prNumber: 7 }, "tok")).toEqual([]);
      expect(notFound.length).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    const forbidden = stub((_url, headers) =>
      headers.Authorization ? { ok: false, status: 403 } : { ok: true, body: [{ filename: "src/x.ts" }] },
    );
    try {
      expect(await fetchChangedFiles("o/r", { prNumber: 7 }, "tok")).toEqual(["src/x.ts"]);
      expect(forbidden.length).toBe(2);
      expect(forbidden[0].headers.Authorization).toBe("Bearer tok");
      expect(forbidden[1].headers.Authorization).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("jit runners", () => {
  const realFetch = globalThis.fetch;

  function stub(handler: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body?: unknown }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const out = handler(String(input), init);
      return { ok: out.ok, status: out.status ?? (out.ok ? 200 : 500), json: async () => out.body ?? null };
    }) as typeof fetch;
    return calls;
  }

  it("mints a JIT config and returns the runner id", async () => {
    const calls = stub((url) => {
      if (!url.endsWith("/repos/o/r/actions/runners/generate-jitconfig")) return { ok: false, status: 404 };
      return { ok: true, body: { runner: { id: 77 }, encoded_jit_config: "blob" } };
    });
    try {
      const out = await generateJitConfig("tok", "o/r", { name: "flare-1", labels: ["self-hosted", "flare"] });
      expect(out).toEqual({ runnerId: 77, jitConfig: "blob" });
      expect(calls).toHaveLength(1);
      expect(calls[0].init?.method).toBe("POST");
      expect(String(calls[0].init?.body)).toContain("flare-1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns null when the mint fails or the blob is missing", async () => {
    stub(() => ({ ok: false, status: 403 }));
    try {
      expect(await generateJitConfig("tok", "o/r", { name: "n", labels: [] })).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
    const calls = stub(() => ({ ok: true, body: { runner: { id: 1 } } }));
    try {
      expect(await generateJitConfig("tok", "o/r", { name: "n", labels: [] })).toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("deletes runners, treating gone as done and errors as failed", async () => {
    let calls = stub(() => ({ ok: true }));
    try {
      expect(await deleteRunner("tok", "o/r", 77)).toBe(true);
      expect(calls[0].url).toContain("/repos/o/r/actions/runners/77");
      expect(calls[0].init?.method).toBe("DELETE");
    } finally {
      globalThis.fetch = realFetch;
    }
    calls = stub(() => ({ ok: false, status: 404 }));
    try {
      expect(await deleteRunner("tok", "o/r", 77)).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    try {
      expect(await deleteRunner("tok", "o/r", 77)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
