import { describe, expect, it, vi } from "vitest";
import {
  basinJobTerminal,
  basinRunDispatched,
  basinRunTerminal,
  basinSink,
  sendBasin,
  type BasinSink,
  type CiEvent,
} from "./basin";

describe("basin records", () => {
  it("builds a run.dispatched record", () => {
    const rec = basinRunDispatched({ repo: "o/r", runId: "run1", event: "push", jobCount: 3 });
    expect(rec).toMatchObject({ v: 1, event: "run.dispatched", repo: "o/r", run_id: "run1", trigger: "push", count: 3 });
    expect(Date.parse(rec.ts)).not.toBeNaN();
  });

  it("builds a run.terminal record", () => {
    const rec = basinRunTerminal({ repo: "o/r", runId: "run1", event: "push", status: "failure", durationMs: 1234.6, jobCount: 3 });
    expect(rec).toMatchObject({
      event: "run.terminal",
      status: "failure",
      duration_ms: 1235,
      count: 3,
    });
  });

  it("builds a job.terminal record and clamps negatives", () => {
    const rec = basinJobTerminal({
      repo: "o/r",
      runId: "run1",
      jobName: "test",
      status: "success",
      durationMs: -5,
      executor: "seat",
      attempts: 1,
    });
    expect(rec).toMatchObject({ event: "job.terminal", job: "test", executor: "seat", duration_ms: 0, attempts: 1 });
  });
});

describe("basinSink", () => {
  it("returns undefined without a CI_EVENTS binding", () => {
    expect(basinSink({}, { waitUntil: () => undefined })).toBeUndefined();
    expect(basinSink({ CI_EVENTS: undefined }, { waitUntil: () => undefined })).toBeUndefined();
  });

  it("wraps a bound stream with the caller's waitUntil", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn();
    const sink = basinSink({ CI_EVENTS: { send } }, { waitUntil });
    expect(sink?.stream).toBeDefined();
    sendBasin(sink, basinRunDispatched({ repo: "o/r", runId: "r", event: "push", jobCount: 1 }));
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const records = send.mock.calls[0][0] as CiEvent[];
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe("run.dispatched");
  });
});

describe("sendBasin", () => {
  const rec = basinRunDispatched({ repo: "o/r", runId: "r", event: "push", jobCount: 1 });

  it("no-ops without a sink or stream", () => {
    expect(() => sendBasin(undefined, rec)).not.toThrow();
    expect(() => sendBasin({ stream: undefined, waitUntil: () => undefined }, rec)).not.toThrow();
  });

  it("never rejects when the stream send fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("basin down"));
    let held: Promise<unknown> | null = null;
    const sink: BasinSink = { stream: { send }, waitUntil: (p) => { held = p; } };
    expect(() => sendBasin(sink, rec)).not.toThrow();
    await expect(held).resolves.toBeUndefined();
  });

  it("never throws when waitUntil itself throws", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sink: BasinSink = {
      stream: { send },
      waitUntil: () => { throw new Error("no ctx"); },
    };
    expect(() => sendBasin(sink, rec)).not.toThrow();
  });
});
