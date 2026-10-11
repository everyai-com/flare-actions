import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginMissingArgs, mergeLoginEnv, runLogin } from "./login.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("mergeLoginEnv", () => {
  it("creates .env with both keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-login-"));
    const path = mergeLoginEnv(cwd, "https://w.example", "tok123");
    expect(path).toBe(join(cwd, ".env"));
    expect(readFileSync(path, "utf8")).toBe("FLARE_ACTIONS_URL=https://w.example\nRUNNER_TOKEN=tok123\n");
  });

  it("replaces managed keys and preserves unknown lines", () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-login-"));
    writeFileSync(join(cwd, ".env"), "FLARE_ACTIONS_URL=https://old\nCUSTOM=keep\nRUNNER_TOKEN=old\n");
    mergeLoginEnv(cwd, "https://new", "tok");
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("FLARE_ACTIONS_URL=https://new\nCUSTOM=keep\nRUNNER_TOKEN=tok\n");
  });
});

describe("runLogin", () => {
  it("exchanges a code and writes .env", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-login-"));
    const seen: string[] = [];
    const out = await runLogin({
      cwd,
      baseUrl: "worker.example/",
      code: "abcd-1234",
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(String(url));
        expect(JSON.parse(String(init?.body))).toEqual({ code: "ABCD-1234" });
        return jsonResponse(200, { token: "tok", name: "agent-1" });
      }) as typeof fetch,
    });
    expect(out).toEqual({ token: "tok", name: "agent-1", envPath: join(cwd, ".env"), baseUrl: "https://worker.example" });
    expect(seen).toEqual(["https://worker.example/v1/pair/exchange"]);
    expect(readFileSync(join(cwd, ".env"), "utf8")).toContain("RUNNER_TOKEN=tok");
  });

  it("prompts for missing url and code", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-login-"));
    const saved = process.env["FLARE_ACTIONS_URL"];
    Reflect.deleteProperty(process.env, "FLARE_ACTIONS_URL");
    try {
    const asked: string[] = [];
    const out = await runLogin({
      cwd,
      fetchFn: (async () => jsonResponse(200, { token: "t" })) as typeof fetch,
      prompt: async (q: string) => {
        asked.push(q);
        return asked.length === 1 ? "https://w.example" : "ZZ-YY";
      },
    });
    expect(asked.length).toBe(2);
    expect(out.baseUrl).toBe("https://w.example");
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "FLARE_ACTIONS_URL");
      else process.env["FLARE_ACTIONS_URL"] = saved;
    }
  });

  it("maps 404 to a mint-a-fresh-code error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-login-"));
    await expect(
      runLogin({
        cwd,
        baseUrl: "https://w.example",
        code: "NOPE-0000",
        fetchFn: (async () => jsonResponse(404, { error: "nope" })) as typeof fetch,
      }),
    ).rejects.toThrow("mint a fresh one");
  });

  it("maps 429 to a try-later error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-login-"));
    await expect(
      runLogin({
        cwd,
        baseUrl: "https://w.example",
        code: "AAAA-1111",
        fetchFn: (async () => jsonResponse(429, { error: "slow" })) as typeof fetch,
      }),
    ).rejects.toThrow("try again later");
  });

  it("prefers the server hint when present", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "flare-login-"));
    await expect(
      runLogin({
        cwd,
        baseUrl: "https://w.example",
        code: "AAAA-1111",
        fetchFn: (async () => jsonResponse(500, { hint: "seats are down" })) as typeof fetch,
      }),
    ).rejects.toThrow("seats are down");
  });
});

describe("loginMissingArgs", () => {
  it("names the flags a non-interactive login needs", () => {
    expect(loginMissingArgs({}, {})).toEqual(["--url <worker-url>", "--code <pairing-code>"]);
    expect(loginMissingArgs({}, { FLARE_ACTIONS_URL: "https://w" })).toEqual(["--code <pairing-code>"]);
    expect(loginMissingArgs({ baseUrl: "w", code: "AB-CD" }, {})).toEqual([]);
  });
});
