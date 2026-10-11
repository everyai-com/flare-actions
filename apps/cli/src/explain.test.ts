import { describe, expect, it } from "vitest";
import { explainDigest } from "./explain";
import type { FlareRunDigest } from "flare-actions-runner-sdk";

function digest(over: Partial<FlareRunDigest> = {}): FlareRunDigest {
  return {
    runId: "run-1",
    repo: "o/r",
    sha: "abc123def456",
    branch: "main",
    event: "push",
    status: "failure",
    durationMs: 90000,
    totalJobs: 2,
    failedJobs: 1,
    jobs: [
      {
        id: "job-bad",
        name: "test",
        status: "failure",
        durationMs: 60000,
        stepCount: 3,
        failing: { command: "npm test", exitCode: 1, durationMs: 50000, outputTail: "ok 1\nnot ok 2 boom\n" },
        triage: "Assertion failed in auth.test.ts: expected 200, got 500.",
      },
      { id: "job-ok", name: "lint", status: "success", durationMs: 10000, stepCount: 1 },
    ],
    ...over,
  };
}

describe("explainDigest", () => {
  it("tells the failure story with step, tail, triage, and rerun", () => {
    const out = explainDigest(digest());
    expect(out.verdict).toBe("failure");
    expect(out.failing).toEqual([{ jobId: "job-bad", jobName: "test", status: "failure", command: "npm test", exitCode: 1 }]);
    expect(out.narrative).toContain("Run run-1 failed: 1/2 jobs failed in o/r@abc123d (main, push)");
    expect(out.narrative).toContain("Failed: test (1m 0s)");
    expect(out.narrative).toContain("$ npm test (exit 1, 50s)");
    expect(out.narrative).toContain("| not ok 2 boom");
    expect(out.narrative).toContain("triage: Assertion failed");
    expect(out.narrative).toContain("rerun: cli rerun run-1 job-bad");
  });

  it("celebrates green runs and names the slowest job", () => {
    const out = explainDigest(
      digest({
        status: "success",
        failedJobs: 0,
        jobs: [
          { id: "a", name: "test", status: "success", durationMs: 60000, stepCount: 1 },
          { id: "b", name: "lint", status: "success", durationMs: 10000, stepCount: 1 },
        ],
      }),
    );
    expect(out.verdict).toBe("success");
    expect(out.failing).toEqual([]);
    expect(out.narrative).toContain("passed: all 2 jobs green");
    expect(out.narrative).toContain("Slowest job: test (1m 0s).");
  });

  it("names the heaviest job when executors self-reported peaks", () => {
    const out = explainDigest(
      digest({
        status: "success",
        failedJobs: 0,
        jobs: [
          { id: "a", name: "test", status: "success", durationMs: 60000, stepCount: 1, peakRssBytes: 100 * 1024 * 1024 },
          { id: "b", name: "build", status: "success", durationMs: 10000, stepCount: 1, peakRssBytes: 3 * 1024 * 1024 * 1024, sizeHint: "size-l" },
        ],
      }),
    );
    expect(out.narrative).toContain("Heaviest job: build (peak 3 GB, size-l).");
  });

  it("stays silent on resources when nothing was measured", () => {
    expect(explainDigest(digest()).narrative).not.toContain("Heaviest job:");
  });

  it("reports pending runs with a watch hint", () => {
    const out = explainDigest(
      digest({
        status: "running",
        failedJobs: 0,
        jobs: [{ id: "a", name: "test", status: "running", durationMs: null, stepCount: 1 }],
        totalJobs: 1,
      }),
    );
    expect(out.verdict).toBe("pending");
    expect(out.narrative).toContain("is running: 0/1 jobs finished");
    expect(out.narrative).toContain("cli watch run-1");
  });

  it("notes a reused attested verdict", () => {
    const out = explainDigest(
      digest({
        status: "success",
        failedJobs: 0,
        jobs: [{ id: "a", name: "test", status: "success", durationMs: 5, stepCount: 0 }],
        totalJobs: 1,
        attestation: { reused: true, receiptId: "receipt-1", verdict: "success" },
      }),
    );
    expect(out.narrative).toContain("Reused verdict success");
    expect(out.narrative).toContain("cli attestation receipt-1");
  });

  it("caps failing jobs and handles missing steps", () => {
    const jobs = Array.from({ length: 7 }, (_, i) => ({
      id: `j${i}`,
      name: `job${i}`,
      status: "failure",
      durationMs: 1000,
      stepCount: 0,
    }));
    const out = explainDigest(digest({ failedJobs: 7, totalJobs: 7, jobs }));
    expect(out.narrative).toContain("no failing step captured");
    expect(out.narrative).toContain("…and 2 more failing jobs");
  });
});

describe("explain next move", () => {
  it("ends every verdict with exactly one next line", () => {
    const failed = explainDigest(digest(), "npx flare-forge");
    expect(failed.next).toMatch(/^next: fix the failing step, then npx flare-forge run .+ --source/);
    expect(failed.narrative.split("\n").pop()).toBe(failed.next);
    expect(failed.narrative).toContain("rerun: npx flare-forge rerun run-1 job-bad");
    const pending = explainDigest(digest({ status: "running", failedJobs: 0, jobs: digest().jobs.map((j) => ({ ...j, status: "running", failing: undefined })) }));
    expect(pending.next).toBe("next: cli watch run-1");
    const green = explainDigest(digest({ status: "success", failedJobs: 0, jobs: digest().jobs.map((j) => ({ ...j, status: "success", failing: undefined })) }));
    expect(green.next).toMatch(/^next: cli runs/);
    for (const out of [failed, pending, green]) expect(out.narrative.split("\n").filter((l) => l.startsWith("next:"))).toHaveLength(1);
  });
});

