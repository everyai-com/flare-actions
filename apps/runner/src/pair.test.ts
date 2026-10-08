import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exchangePairingCode, mergeEnvFile, pairRunner } from "./pair.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-pair-"));
  dirs.push(dir);
  return dir;
}

describe("exchangePairingCode", () => {
  it("posts the normalized code and returns the token", async () => {
    const seen: { url: string; body: string }[] = [];
    const out = await exchangePairingCode({
      baseUrl: "https://ci.example/",
      code: "k7md-q2xa",
      name: "laptop",
      cwd: tempDir(),
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({ token: "tok123", name: "laptop" }), { status: 201 });
      }) as typeof fetch,
    });
    expect(out).toEqual({ token: "tok123", name: "laptop" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://ci.example/v1/pair/exchange");
    expect(JSON.parse(seen[0].body)).toEqual({ code: "K7MD-Q2XA", name: "laptop" });
  });

  it("translates failure statuses into actionable errors", async () => {
    const failing = (status: number) =>
      exchangePairingCode({
        baseUrl: "https://ci.example",
        code: "AAAA-BBBB",
        cwd: tempDir(),
        fetchFn: (async () => new Response("{}", { status })) as typeof fetch,
      });
    await expect(failing(404)).rejects.toThrow("invalid or expired");
    await expect(failing(429)).rejects.toThrow("too many pairing attempts");
    await expect(failing(500)).rejects.toThrow("HTTP 500");
  });

  it("prefers the server hint when the body carries one", async () => {
    const run = exchangePairingCode({
      baseUrl: "https://ci.example",
      code: "AAAA-BBBB",
      cwd: tempDir(),
      fetchFn: (async () =>
        new Response(JSON.stringify({ error: "pairing code invalid or expired", code: "pairing_invalid", hint: "server says mint fresh" }), {
          status: 404,
        })) as typeof fetch,
    });
    await expect(run).rejects.toThrow("server says mint fresh");
  });
});

describe("mergeEnvFile", () => {
  it("merges wanted keys and preserves unknown lines", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "FLARE_ACTIONS_URL=https://old.example\nCUSTOM=keepme\n\n");
    const path = mergeEnvFile(dir, { FLARE_ACTIONS_URL: "https://new.example", RUNNER_TOKEN: "tok" });
    expect(path).toBe(join(dir, ".env"));
    expect(readFileSync(path, "utf8")).toBe("FLARE_ACTIONS_URL=https://new.example\nCUSTOM=keepme\nRUNNER_TOKEN=tok\n");
  });

  it("creates the file when missing", async () => {
    const dir = tempDir();
    mergeEnvFile(dir, { FLARE_ACTIONS_URL: "https://x.example", RUNNER_TOKEN: "tok" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("RUNNER_TOKEN=tok");
  });
});

describe("pairRunner", () => {
  it("exchanges then persists, end to end", async () => {
    const dir = tempDir();
    const out = await pairRunner({
      baseUrl: "https://ci.example",
      code: "K7MD-Q2XA",
      cwd: dir,
      fetchFn: (async () => new Response(JSON.stringify({ token: "tok", name: "n" }), { status: 201 })) as typeof fetch,
    });
    expect(out.envPath).toBe(join(dir, ".env"));
    expect(readFileSync(out.envPath, "utf8")).toContain("RUNNER_TOKEN=tok");
  });
});
