import { describe, expect, it } from "vitest";
import { jobDurationMs, summarizeRunCost } from "./cost";

describe("cost", () => {
  it("computes job durations null-safely", () => {
    expect(jobDurationMs({ status: "success", started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:02:00.000Z" })).toBe(
      120000,
    );
    expect(jobDurationMs({ status: "running", started_at: "2026-01-01T00:00:00.000Z", finished_at: null })).toBeNull();
    expect(jobDurationMs({ status: "queued", started_at: null, finished_at: null })).toBeNull();
    expect(jobDurationMs({ status: "success", started_at: "bogus", finished_at: "bogus" })).toBeNull();
  });

  it("summarizes run cost against Actions list price", () => {
    const summary = summarizeRunCost([
      { status: "success", started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:10:00.000Z" },
      { status: "queued", started_at: null, finished_at: null },
    ]);
    expect(summary).toEqual({ jobs: 2, finishedJobs: 1, durationMs: 600000, computeMinutes: 10, actionsListUsd: 0.08 });
  });
});
