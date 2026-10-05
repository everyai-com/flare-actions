import { describe, expect, it } from "vitest";
import {
  emitJobTerminal,
  emitRunDispatched,
  emitRunTerminal,
  runDurationMs,
} from "./analytics";

function fakeBinding(events: AnalyticsEngineDataPoint[]): AnalyticsEngineDataset {
  return {
    writeDataPoint(point?: AnalyticsEngineDataPoint): void {
      events.push(point ?? {});
    },
  };
}

describe("analytics", () => {
  it("maps run and job events onto the documented schema", () => {
    const events: AnalyticsEngineDataPoint[] = [];
    const ds = fakeBinding(events);
    emitRunDispatched(ds, { repo: "o/r", runId: "run1", event: "push", jobCount: 3 });
    emitRunTerminal(ds, { repo: "o/r", runId: "run1", event: "push", status: "failure", durationMs: 42000, jobCount: 3 });
    emitJobTerminal(ds, {
      repo: "o/r",
      runId: "run1",
      jobName: "test",
      status: "failure",
      durationMs: 40000,
      executor: "runner",
      attempts: 1,
    });
    expect(events.map((e) => e.indexes?.[0])).toEqual(["run.dispatched", "run.terminal", "job.terminal"]);
    expect(events[0].blobs).toEqual(["o/r", "run1", "", "", "push", ""]);
    expect(events[0].doubles).toEqual([3, 0]);
    expect(events[1].blobs).toEqual(["o/r", "run1", "", "failure", "push", ""]);
    expect(events[1].doubles).toEqual([42000, 3]);
    expect(events[2].blobs).toEqual(["o/r", "run1", "test", "failure", "", "runner"]);
    expect(events[2].doubles).toEqual([40000, 1]);
  });

  it("skips silently without a binding and never throws", () => {
    expect(() => emitRunDispatched(undefined, { repo: "o/r", runId: "r", event: "push", jobCount: 1 })).not.toThrow();
    const explosive: AnalyticsEngineDataset = {
      writeDataPoint(): void {
        throw new Error("boom");
      },
    };
    expect(() => emitJobTerminal(explosive, {
      repo: "o/r",
      runId: "r",
      jobName: "j",
      status: "success",
      durationMs: 1,
      executor: "seat",
      attempts: 0,
    })).not.toThrow();
  });

  it("bounds blobs and clamps numbers", () => {
    const events: AnalyticsEngineDataPoint[] = [];
    emitRunTerminal(fakeBinding(events), {
      repo: "o/" + "r".repeat(500),
      runId: "run1",
      event: "push",
      status: "success",
      durationMs: Number.NaN,
      jobCount: -2,
    });
    expect((events[0].blobs?.[0] as string).length).toBe(200);
    expect(events[0].doubles).toEqual([0, 0]);
  });

  it("derives stable run durations from job timestamps", () => {
    expect(runDurationMs([])).toBe(0);
    expect(runDurationMs([{ started_at: null, finished_at: null }])).toBe(0);
    expect(
      runDurationMs([
        { started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z" },
        { started_at: "2026-01-01T00:00:30.000Z", finished_at: "2026-01-01T00:02:00.000Z" },
      ]),
    ).toBe(120000);
    // Backwards or unparsable stamps carry no signal.
    expect(runDurationMs([{ started_at: "2026-01-01T00:02:00.000Z", finished_at: "2026-01-01T00:01:00.000Z" }])).toBe(0);
    expect(runDurationMs([{ started_at: "bogus", finished_at: "2026-01-01T00:01:00.000Z" }])).toBe(0);
  });
});
