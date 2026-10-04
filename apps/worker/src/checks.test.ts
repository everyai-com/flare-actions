import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAnnotations, checkConclusion, checkOutput, reportJobCheck } from "./checks";
import type { JobRow } from "./db";

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "failure",
    log: "",
    name: "test",
    definition: "",
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: "2026-10-02T10:00:00.000Z",
    finished_at: "2026-10-02T10:01:00.000Z",
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:01:00.000Z",
    ...over,
  };
}

function resultJson(steps: { command: string; exitCode: number; output?: string }[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ steps: steps.map((s) => ({ ...s, durationMs: 5 })), ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkConclusion", () => {
  it("maps statuses, distinguishing timeouts", () => {
    expect(checkConclusion(jobRow({ status: "success" }))).toBe("success");
    expect(checkConclusion(jobRow({ status: "cancelled" }))).toBe("cancelled");
    expect(checkConclusion(jobRow({ status: "skipped" }))).toBe("skipped");
    expect(checkConclusion(jobRow({ status: "running" }))).toBe("neutral");
    expect(checkConclusion(jobRow({ status: "failure" }))).toBe("failure");
    expect(checkConclusion(jobRow({ status: "error" }))).toBe("failure");
    expect(checkConclusion(jobRow({ status: "failure", result: JSON.stringify({ steps: [], timedOut: true }) }))).toBe(
      "timed_out",
    );
  });
});

describe("checkAnnotations", () => {
  it("extracts colon and paren location formats, deduping", () => {
    const out = checkAnnotations(
      [
        "src/app.ts:12:5: error TS2322: nope",
        "src/lib/util.ts(44,9): error TS1005: ';' expected",
        "src/app.ts:12:5: duplicate of the first",
        "tests/spec.py:7: assert failed",
      ].join("\n"),
    );
    expect(out).toEqual([
      { path: "src/app.ts", start_line: 12, end_line: 12, annotation_level: "failure", message: "src/app.ts:12:5: error TS2322: nope" },
      { path: "src/lib/util.ts", start_line: 44, end_line: 44, annotation_level: "failure", message: "src/lib/util.ts(44,9): error TS1005: ';' expected" },
      { path: "tests/spec.py", start_line: 7, end_line: 7, annotation_level: "failure", message: "tests/spec.py:7: assert failed" },
    ]);
  });

  it("skips URLs, absolute paths, traversal, and caps the list", () => {
    const junk = [
      "see https://example.com:8080/docs for details",
      "/abs/path.ts:3:1: nope",
      "../outside.ts:2:1: nope",
    ].join("\n");
    expect(checkAnnotations(junk)).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts:1:1: error`).join("\n");
    expect(checkAnnotations(many)).toHaveLength(10);
  });
});

describe("checkOutput", () => {
  it("names the failing command, exit code, and bounded tail", () => {
    const job = jobRow({
      result: resultJson([
        { command: "npm ci", exitCode: 0, output: "ok" },
        { command: "npm test", exitCode: 1, output: "A".repeat(4000) + "BOOM" },
      ]),
      triage: "Cause: assertion. Fix: update the fixture.",
    });
    const out = checkOutput(job);
    expect(out.title).toContain("npm test");
    expect(out.title).toContain("exit 1");
    expect(out.summary).toContain("`npm test` exited 1");
    expect(out.summary).toContain("Cause: assertion.");
    expect(out.summary.endsWith("BOOM\n```")).toBe(true);
    expect(out.summary.length).toBeLessThan(4000);
  });

  it("falls back to status and triage without structured steps", () => {
    const out = checkOutput(jobRow({ result: "junk", triage: "triage text" }));
    expect(out.title).toBe("test: failure");
    expect(out.summary).toBe("triage text");
    const bare = checkOutput(jobRow({ result: "", triage: "" }));
    expect(bare.summary).toBe("job failure");
  });
});

describe("reportJobCheck", () => {
  it("mints a token and posts a completed check run", async () => {
    // Real keypair so mintAppJwt's PKCS#8 import exercises the real path.
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let bin = "";
    for (const b of pkcs8) bin += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;

    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_test" }), { status: 201 });
      if (url.endsWith("/check-runs")) {
        calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response("{}", { status: 201 });
      }
      return new Response("nope", { status: 404 });
    });

    const job = jobRow({
      result: resultJson([{ command: "npm test", exitCode: 1, output: "src/x.ts:3:1: error TS0001: expected 3, got 2" }]),
      triage: "Cause: fixture drift.",
    });
    const ok = await reportJobCheck(
      { appId: "42", privateKey: pem, installationId: 7, repo: "o/r", sha: "abc123", origin: "https://ci.example.com" },
      job,
    );
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/check-runs");
    expect(calls[0].body.name).toBe("flare / test");
    expect(calls[0].body.head_sha).toBe("abc123");
    expect(calls[0].body.status).toBe("completed");
    expect(calls[0].body.conclusion).toBe("failure");
    expect(calls[0].body.details_url).toBe("https://ci.example.com/dashboard");
    const output = calls[0].body.output as { title: string; summary: string; annotations?: { path: string; start_line: number }[] };
    expect(output.title).toContain("npm test");
    expect(output.summary).toContain("expected 3, got 2");
    expect(output.annotations).toEqual([
      { path: "src/x.ts", start_line: 3, end_line: 3, annotation_level: "failure", message: "src/x.ts:3:1: error TS0001: expected 3, got 2" },
    ]);
  });

  it("skips without credentials and never throws on failures", async () => {
    expect(await reportJobCheck({ installationId: null, repo: "o/r", sha: "x" }, jobRow())).toBe(false);
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect(
      await reportJobCheck({ appId: "42", privateKey: "not-a-key", installationId: 7, repo: "o/r", sha: "x" }, jobRow()),
    ).toBe(false);
  });
});
