import { afterEach, describe, expect, it, vi } from "vitest";
import { FlareApiError, FlareClient } from "./index.ts";

interface Call {
  url: string;
  init?: RequestInit;
}

// Stubs global fetch; each test wires the response it expects and can
// inspect the calls the client made.
function stubFetch(handler: (url: string, init?: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FlareClient", () => {
  it("claims with labels and parses secrets", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        job: { id: "job-1", run_id: "run-1", status: "running", repo: "o/r", sha: "abc", name: "verify", definition: "{}" },
        secrets: { TOKEN: "s3cret", BAD: 42 },
        secretsError: false,
      }),
    );
    const client = new FlareClient("https://ci.example.com", "tok");
    const claim = await client.nextClaim(["linux", "x64"]);
    expect(claim.job?.id).toBe("job-1");
    expect(claim.secrets).toEqual({ TOKEN: "s3cret" });
    expect(claim.secretsError).toBe(false);
    expect(calls[0].url).toBe("https://ci.example.com/v1/jobs/next?labels=linux%2Cx64");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("returns a null job and flags secrets errors", async () => {
    stubFetch(() => jsonResponse({ job: null, secretsError: true }));
    const claim = await new FlareClient("https://x", "t").nextClaim();
    expect(claim.job).toBeNull();
    expect(claim.secretsError).toBe(true);
  });

  it("throws with the status on failed calls", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    await expect(new FlareClient("https://x", "t").listRuns()).rejects.toThrow("listRuns failed: 401");
  });

  it("carries the server code and hint on typed failures", async () => {
    stubFetch(() => jsonResponse({ error: "token is not scoped to that repo", code: "repo_not_allowed", hint: "mint a token" }, 403));
    const err = await new FlareClient("https://x", "t").dispatch("o/r", "abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlareApiError);
    const typed = err as FlareApiError;
    expect(typed.message).toBe("dispatch failed: 403 — token is not scoped to that repo");
    expect(typed.status).toBe(403);
    expect(typed.code).toBe("repo_not_allowed");
    expect(typed.hint).toBe("mint a token");
  });

  it("degrades to null code and hint on uncoded bodies", async () => {
    stubFetch(() => jsonResponse({ error: "boom" }, 500));
    const err = await new FlareClient("https://x", "t").dispatch("o/r", "abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlareApiError);
    const typed = err as FlareApiError;
    expect(typed.code).toBeNull();
    expect(typed.hint).toBeNull();
    expect(typed.message).toBe("dispatch failed: 500 — boom");
  });

  it("reports status with the full body", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true }));
    await new FlareClient("https://x", "t").reportStatus("run-1", "job-1", "success", "done", '{"steps":[]}');
    expect(calls[0].url).toBe("https://x/v1/runs/run-1/status");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      jobId: "job-1",
      status: "success",
      log: "done",
      result: '{"steps":[]}',
    });
  });

  it("reads cache blobs and treats 404 as a miss", async () => {
    let status = 404;
    stubFetch(() => (status === 404 ? new Response("", { status: 404 }) : new Response(new Uint8Array([1, 2, 3]))));
    const client = new FlareClient("https://x", "t");
    expect(await client.getCache("org/repo/key")).toBeNull();
    status = 200;
    expect(Array.from((await client.getCache("org/repo/key")) ?? [])).toEqual([1, 2, 3]);
  });

  it("dispatches by repo and sha and parses run ids", async () => {
    const calls = stubFetch(() => jsonResponse({ runId: "run-9", jobIds: ["a", "b"] }));
    const out = await new FlareClient("https://x", "t").dispatch("o/r", "main", { ref: "main" });
    expect(out).toEqual({ runId: "run-9", jobIds: ["a", "b"] });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ repo: "o/r", sha: "main", ref: "main" });
  });

  it("builds encoded flaky queries", async () => {
    const calls = stubFetch(() => jsonResponse({ stats: [{ job: "test", runs: 2, failures: 1, rate: 0.5 }] }));
    const stats = await new FlareClient("https://x", "t").getFlaky("o/r", 7);
    expect(stats).toHaveLength(1);
    expect(calls[0].url).toBe("https://x/v1/flaky?repo=o%2Fr&days=7");
  });

  it("cancels runs and returns the cancelled count", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, cancelled: 3 }));
    const n = await new FlareClient("https://x", "t").cancelRun("run-1");
    expect(n).toBe(3);
    expect(calls[0].url).toBe("https://x/v1/runs/run-1/cancel");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("waits on runs through the blocking endpoint", async () => {
    const calls = stubFetch(() => jsonResponse({ run: { id: "run-1", status: "running" }, jobs: [], timedOut: true, waitedMs: 30000 }));
    const out = await new FlareClient("https://x", "t").waitRun("run-1", 30);
    expect(out.timedOut).toBe(true);
    expect(calls[0].url).toBe("https://x/v1/runs/run-1/wait?timeout=30");
  });

  it("fetches the compact digest", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        runId: "run-1",
        status: "failure",
        failedJobs: 1,
        jobs: [
          {
            id: "j",
            name: "test",
            status: "failure",
            durationMs: 12,
            stepCount: 1,
            failing: { command: "x", exitCode: 1, durationMs: 5, outputTail: "boom" },
          },
        ],
      }),
    );
    const digest = await new FlareClient("https://x", "t").getRunDigest("run-1");
    expect(digest.failedJobs).toBe(1);
    expect(digest.jobs[0].failing?.outputTail).toBe("boom");
    expect(calls[0].url).toBe("https://x/v1/runs/run-1/digest");
  });

  it("passes priority through dispatch", async () => {
    const calls = stubFetch(() => jsonResponse({ runId: "r", jobIds: [] }));
    await new FlareClient("https://x", "t").dispatch("o/r", "main", { priority: 9 });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ repo: "o/r", sha: "main", priority: 9 });
  });

  it("loads a run with its jobs", async () => {
    stubFetch(() =>
      jsonResponse({
        run: { id: "run-1", repo: "o/r", sha: "abc", event: "push", status: "failure", created_at: "x", updated_at: "y" },
        jobs: [{ id: "job-1", status: "failure", log: "boom", name: "test", result: "", triage: "cause" }],
      }),
    );
    const { run, jobs } = await new FlareClient("https://x", "t").getRun("run-1");
    expect(run.status).toBe("failure");
    expect(jobs[0].triage).toBe("cause");
  });

  it("uploads test reports as xml and parses the summary", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ ok: true, jobId: "job-1", total: 3, passed: 2, failed: 1, errors: 0, skipped: 0, truncated: false }),
    );
    const summary = await new FlareClient("https://x", "t").uploadTestReport("job-1", "<testsuite/>");
    expect(summary).toMatchObject({ total: 3, passed: 2, failed: 1, errors: 0, skipped: 0, truncated: false });
    expect(calls[0].url).toBe("https://x/v1/jobs/job-1/tests");
    expect(calls[0].init?.method).toBe("PUT");
    expect(String(calls[0].init?.body)).toBe("<testsuite/>");
  });

  it("fetches run test summaries with failing tests", async () => {
    stubFetch(() =>
      jsonResponse({
        runId: "run-1",
        totals: { total: 1, passed: 0, failed: 1, errors: 0, skipped: 0 },
        jobs: [],
        failing: [{ jobId: "job-1", jobName: "test", suite: "s", name: "t", classname: "", status: "failed", message: "m" }],
      }),
    );
    const tests = await new FlareClient("https://x", "t").getRunTests("run-1");
    expect(tests.totals.failed).toBe(1);
    expect(tests.failing[0].name).toBe("t");
  });

  it("fetches run egress rows with totals", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        runId: "run-1",
        totals: { reqBytes: 8, respBytes: 9 },
        jobs: [{ jobId: "job-1", host: "r2:cache", reqBytes: 8, respBytes: 9 }],
      }),
    );
    const egress = await new FlareClient("https://x", "t").getRunEgress("run-1");
    expect(calls[0].url).toBe("https://x/v1/runs/run-1/egress");
    expect(egress.totals).toEqual({ reqBytes: 8, respBytes: 9 });
    expect(egress.jobs[0].host).toBe("r2:cache");
  });

  it("lists and purges cache entries", async () => {
    const calls = stubFetch((url, init) =>
      init?.method === "DELETE"
        ? jsonResponse({ deleted: 2, truncated: false })
        : jsonResponse({ entries: [{ key: "k", size: 1, uploaded: "u" }] }),
    );
    const client = new FlareClient("https://x", "t");
    expect(await client.listCache("pre", 10)).toEqual([{ key: "k", size: 1, uploaded: "u" }]);
    expect(calls[0].url).toBe("https://x/v1/admin/cache?prefix=pre&limit=10");
    expect(await client.purgeCache("pre")).toEqual({ deleted: 2, truncated: false });
    expect(calls[1].init?.method).toBe("DELETE");
  });

  it("lists the queue with the fair-share cap", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        fairSharePerRepo: 2,
        jobs: [{ id: "j", runId: "r", name: "n", repo: "o/a", priority: 1, labels: "", createdAt: "c" }],
      }),
    );
    const q = await new FlareClient("https://x", "t").listQueue(50);
    expect(calls[0].url).toBe("https://x/v1/admin/queue?limit=50");
    expect(q.fairSharePerRepo).toBe(2);
    expect(q.jobs[0].repo).toBe("o/a");
  });

  it("fetches usage with optional repo scope", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ days: 7, runs: 1, runsByStatus: { success: 1 }, jobs: 2, computeMinutes: 3, actionsListUsd: 0.024, topRepos: [] }),
    );
    const client = new FlareClient("https://x", "t");
    const u = await client.getUsage(7, "o/r");
    expect(u.jobs).toBe(2);
    expect(calls[0].url).toBe("https://x/v1/usage?days=7&repo=o%2Fr");
  });

  it("fetches billable usage and degrades on 401/502", async () => {
    const calls = stubFetch(() => jsonResponse({ configured: true, totalCost: 4.5, families: [] }));
    const b = await new FlareClient("https://x", "t").getBillableUsage(7);
    expect(b?.totalCost).toBe(4.5);
    expect(calls[0].url).toBe("https://x/v1/usage/billable?days=7");
    stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    await expect(new FlareClient("https://x", "t").getBillableUsage()).resolves.toBeNull();
    stubFetch(() => jsonResponse({ error: "unavailable" }, 502));
    await expect(new FlareClient("https://x", "t").getBillableUsage()).resolves.toBeNull();
  });

  it("searches logs with an encoded query", async () => {
    const hit = { job_id: "j", run_id: "r", repo: "o/r", branch: "main", level: "error", line: "boom", created_at: "c" };
    const calls = stubFetch(() => jsonResponse({ hits: [hit] }));
    const hits = await new FlareClient("https://x", "t").searchLogs("branch:main boom", 10);
    expect(hits).toEqual([hit]);
    expect(calls[0].url).toBe("https://x/v1/search/logs?q=branch%3Amain%20boom&limit=10");
  });
});
