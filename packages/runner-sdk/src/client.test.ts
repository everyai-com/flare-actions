import { afterEach, describe, expect, it, vi } from "vitest";
import { FlareClient } from "./index.ts";

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
});
