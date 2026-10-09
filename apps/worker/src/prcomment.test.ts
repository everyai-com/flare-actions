import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobRow, RunRow } from "./db";
import { buildPrComment, upsertPrComment } from "./prcomment";

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    repo: "o/r",
    sha: "abcdef1234567890",
    event: "pull_request",
    installation_id: 7,
    branch: "feat",
    source: null,
    pr_number: 42,
    pr_comment_id: null,
    heal_branch: null,
    heal_pr_url: null, agent: "",
    status: "failure",
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:01:30.000Z",
    ...over,
    pipeline_source: over.pipeline_source ?? "",
    changed_files: over.changed_files ?? "",
    profile: over.profile ?? null,
  };
}

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "failure",
    log: "noisy full log",
    name: "test",
    definition: "",
    result: JSON.stringify({
      steps: [
        { command: "npm ci", exitCode: 0, durationMs: 10, output: "ok" },
        { command: "npm test", exitCode: 1, durationMs: 20, output: "src/x.ts:3:1: expected 3, got 2" },
      ],
    }),
    triage: "Cause: assertion drift. Fix: update the fixture.",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: "2026-10-02T10:00:10.000Z",
    finished_at: "2026-10-02T10:01:00.000Z",
    retained_until: null,
    prior_ms: 0,
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:01:00.000Z",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPrComment", () => {
  it("summarizes the run, failing step, and triage without full logs", () => {
    const text = buildPrComment(runRow(), [jobRow(), jobRow({ id: "job-2", name: "lint", status: "success" })], "https://ci.example.com/");
    expect(text).toContain("**Flare failed (failure)**");
    expect(text).toContain("`o/r@abcdef1` (feat)");
    expect(text).toContain("2/2 jobs");
    expect(text).toContain("#### test");
    expect(text).toContain("`npm test` exited 1");
    expect(text).toContain("expected 3, got 2");
    expect(text).toContain("> Cause: assertion drift.");
    expect(text).toContain("https://ci.example.com/dashboard");
    expect(text).not.toContain("noisy full log");
  });

  it("handles passes and legacy rows", () => {
    const text = buildPrComment(
      runRow({ status: "success" }),
      [jobRow({ status: "success", result: "junk", triage: "" })],
      "",
    );
    expect(text).toContain("**Flare passed**");
    expect(text).not.toContain("dashboard");
  });

  it("lists failing tests with locations and messages", () => {
    const text = buildPrComment(runRow(), [jobRow()], "", [
      { jobName: "test", suite: "test_auth", name: "test_logout", message: "assert False" },
      { jobName: "", suite: "", name: "test_flake", message: "" },
    ]);
    expect(text).toContain("#### Failing tests (2 shown)");
    expect(text).toContain("`test_logout` — test / test_auth");
    expect(text).toContain("> assert False");
    expect(text).toContain("`test_flake`");
  });

  it("names quarantined failures so the green check is honest", () => {
    const text = buildPrComment(runRow({ status: "success" }), [jobRow({ status: "success" })], "", [],
      [{ jobName: "test", suite: "test_auth", name: "test_flake", message: "timeout" }],
    );
    expect(text).toContain("**Flare passed**");
    expect(text).toContain("#### Quarantined — not blocking (1 shown)");
    expect(text).toContain("`test_flake` — test / test_auth");
    expect(text).toContain("cli quarantine remove");
  });

  it("omits the quarantine section when nothing is quarantined", () => {
    const text = buildPrComment(runRow(), [jobRow()], "");
    expect(text).not.toContain("Quarantined");
  });
});

describe("upsertPrComment", () => {
  async function pem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let bin = "";
    for (const b of pkcs8) bin += String.fromCharCode(b);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;
  }

  it("creates the comment and returns its id", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs" }), { status: 201 });
      calls.push({ method: String(init?.method), url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: 777 }), { status: 201 });
    });
    const id = await upsertPrComment(
      { appId: "42", privateKey: await pem(), installationId: 7, repo: "o/r", prNumber: 42, existingCommentId: null, origin: "" },
      runRow(),
      [jobRow()],
    );
    expect(id).toBe(777);
    expect(calls).toEqual([
      { method: "POST", url: "https://api.github.com/repos/o/r/issues/42/comments", body: { body: expect.stringContaining("Flare") } },
    ]);
  });

  it("edits the existing comment in place", async () => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs" }), { status: 201 });
      calls.push({ method: String(init?.method), url });
      return new Response(JSON.stringify({ id: 555 }), { status: 200 });
    });
    const id = await upsertPrComment(
      { appId: "42", privateKey: await pem(), installationId: 7, repo: "o/r", prNumber: 42, existingCommentId: 555, origin: "" },
      runRow(),
      [jobRow()],
    );
    expect(id).toBe(555);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/issues/comments/555");
  });

  it("skips without credentials and never throws on failures", async () => {
    expect(await upsertPrComment(
      { installationId: null, repo: "o/r", prNumber: 42, existingCommentId: null, origin: "" },
      runRow(),
      [],
    )).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect(
      await upsertPrComment(
        { appId: "42", privateKey: await pem(), installationId: 7, repo: "o/r", prNumber: 42, existingCommentId: null, origin: "" },
        runRow(),
        [],
      ),
    ).toBeNull();
  });
});
