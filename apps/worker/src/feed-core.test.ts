import { describe, expect, it } from "vitest";
import type { CoordinatorSnapshot, FeedOp, LiveIntent } from "./coordinator-core";
import {
  coalesceOps,
  dashboardOps,
  dashboardSnapshot,
  deltaFrames,
  FEED_FLUSH_MS,
  FEED_MAX_OPS_PER_FRAME,
  flushAt,
  opKey,
  parseClientMessage,
  snapshotFrame,
} from "./feed-core";

function intentOp(id: string, ver: number, state: LiveIntent["state"] = "working"): FeedOp {
  return {
    op: "upsert",
    kind: "intent",
    id,
    ver,
    fields: { id, agent: "a", title: "t", state, goalId: null, forkRepo: null, headSha: "", paths: ["x"], actual: null, leaseExpiresAt: null, risk: 0 },
  };
}

describe("coalesceOps", () => {
  it("keeps the highest ver per (kind, id); remove after upsert wins; late older ops are ignored", () => {
    const pending = new Map<string, FeedOp>();
    coalesceOps(pending, [intentOp("i1", 1, "claimed"), intentOp("i1", 3, "working"), intentOp("i2", 2)]);
    coalesceOps(pending, [{ op: "remove", kind: "intent", id: "i2", ver: 4 }, intentOp("i1", 2, "draft")]);
    expect(pending.size).toBe(2);
    const i1 = pending.get("intent:i1");
    expect(i1?.op === "upsert" && i1.kind === "intent" && i1.fields.state).toBe("working");
    expect(pending.get("intent:i2")?.op).toBe("remove");
    expect(opKey({ op: "remove", kind: "edge", id: "a~b", ver: 1 })).toBe("edge:a~b");
  });
});

describe("flushAt (≤10 Hz)", () => {
  it("flushes now when idle, otherwise one interval after the last flush", () => {
    expect(FEED_FLUSH_MS).toBeGreaterThanOrEqual(100);
    expect(flushAt(null, 1000)).toBe(1000);
    expect(flushAt(1000, 1050)).toBe(1100);
    expect(flushAt(1000, 5000)).toBe(5000);
  });
});

describe("deltaFrames", () => {
  it("orders by ver and splits into consecutive seq frames", () => {
    const ops = Array.from({ length: FEED_MAX_OPS_PER_FRAME + 3 }, (_, i) => intentOp(`i${i}`, 1000 - i));
    const { frames, seq } = deltaFrames(ops, 41);
    expect(seq).toBe(43);
    expect(frames.map((f) => f.type === "delta" && f.seq)).toEqual([42, 43]);
    const first = frames[0];
    expect(first.type === "delta" && first.ops[0].ver).toBe(1000 - (FEED_MAX_OPS_PER_FRAME + 2));
    expect(first.type === "delta" && first.ops.length).toBe(FEED_MAX_OPS_PER_FRAME);
    expect(deltaFrames([], 5)).toEqual({ frames: [], seq: 5 });
  });
});

describe("snapshotFrame", () => {
  const snap = (n: number): CoordinatorSnapshot => ({
    v: 1,
    repo: "demo",
    at: "2026-10-10T00:00:00.000Z",
    ver: 9,
    intents: Array.from({ length: n }, (_, i) => {
      const op = intentOp(`intent-${i}`, i);
      if (op.op !== "upsert" || op.kind !== "intent") throw new Error("unreachable");
      return op.fields;
    }),
    edges: [],
    counters: {
      intents: n,
      agents: 1,
      overlaps: 0,
      overlapsCaught: 0,
      pushOverlaps: 0,
      driftAlerts: 0,
      notesSent: 0,
      pushes: 0,
      declared: n,
      expired: 0,
      byState: {},
    },
    truncated: false,
  });
  it("emits the v1 envelope and halves lists until it fits the byte budget", () => {
    const small = JSON.parse(snapshotFrame(snap(2), 1)) as { v: number; type: string; seq: number; snapshot: CoordinatorSnapshot };
    expect(small).toMatchObject({ v: 1, type: "snapshot", seq: 1 });
    expect(small.snapshot.intents).toHaveLength(2);
    const text = snapshotFrame(snap(400), 2, 20_000);
    expect(text.length).toBeLessThanOrEqual(20_000);
    const big = JSON.parse(text) as { snapshot: CoordinatorSnapshot };
    expect(big.snapshot.truncated).toBe(true);
    expect(big.snapshot.intents.length).toBeLessThan(400);
  });
});

describe("parseClientMessage", () => {
  it("accepts resync/ping only", () => {
    expect(parseClientMessage('{"type":"resync"}')).toEqual({ type: "resync" });
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseClientMessage('{"type":"drop_table"}')).toBeNull();
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage("null")).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseClientMessage(`{"type":"resync","pad":"${"x".repeat(2000)}"}`)).toBeNull();
  });
});

describe("dashboard view fields (the Forge dashboard reads the REST shape)", () => {
  it("adds footprint/path to intent ops, snake_case counters, and an overlap twin per edge op", () => {
    const intent = intentOp("i1", 1);
    const edge: FeedOp = { op: "upsert", kind: "edge", id: "i1~i2", ver: 2, fields: { id: "i1~i2", a: "i1", b: "i2", pairs: [{ a: "x", b: "x" }], origin: "declared", createdAt: "t" } };
    const gone: FeedOp = { op: "remove", kind: "edge", id: "i1~i3", ver: 3 };
    const out = dashboardOps([intent, edge, gone]);
    expect(out).toHaveLength(5);
    const fields = (out[0] as { fields: Record<string, unknown> }).fields;
    expect(fields.footprint).toEqual({ paths: ["x"], declared: ["x"], actual: [], drift: [] });
    expect(fields.path).toBe("x");
    expect(fields.paths).toEqual(["x"]);
    expect(out[2]).toEqual({ op: "upsert", kind: "overlap", id: "i1~i2", ver: 2, fields: { a: "i1", b: "i2", paths: ["x"], state: "overlap", origin: "declared" } });
    expect(out[4]).toEqual({ op: "remove", kind: "overlap", id: "i1~i3", ver: 3 });
  });

  it("puts a REST-shaped `data` view in the snapshot frame next to the coordinator snapshot", () => {
    const fields = (intentOp("i9", 1) as { fields: LiveIntent }).fields;
    const snapshot: CoordinatorSnapshot = {
      v: 1, repo: "demo", at: "t", ver: 4, intents: [{ ...fields, actual: ["x", "y"] }],
      edges: [{ id: "a~b", a: "a", b: "b", pairs: [{ a: "x", b: "x" }], origin: "actual", createdAt: "t" }],
      counters: { intents: 1, agents: 1, overlaps: 1, overlapsCaught: 3, pushOverlaps: 0, driftAlerts: 0, notesSent: 0, pushes: 0, declared: 1, expired: 0, byState: {} },
      truncated: false,
    };
    const d = dashboardSnapshot(snapshot);
    expect(d.intents[0].footprint).toEqual({ paths: ["x"], declared: ["x"], actual: ["x", "y"], drift: ["y"] });
    expect(d.overlaps).toEqual([{ a: "a", b: "b", paths: ["x"], state: "overlap", _id: "a~b" }]);
    expect(d.counters.overlaps_caught).toBe(3);
    const frame = JSON.parse(snapshotFrame(snapshot, 7)) as { snapshot: CoordinatorSnapshot; data: { intents: unknown[] } };
    expect(frame.snapshot.intents).toHaveLength(1);
    expect(frame.data.intents).toHaveLength(1);
  });
});
