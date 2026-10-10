// Forge live feed core (runtime-free): delta coalescing, the ≤10 Hz
// flush schedule, wire messages, and client message parsing. The
// `ForgeFeed` Durable Object (coordinator.ts) persists pending ops in
// its SQLite and broadcasts from an alarm — no timers.
//
// Wire schema (server -> client, JSON text frames):
//   { v: 1, type: "snapshot", seq, snapshot: CoordinatorSnapshot, data: DashboardSnapshot }
//   { v: 1, type: "delta", seq, ops: Array<FeedOp | DashboardOverlapOp> }
//   { v: 1, type: "resync" }   (server hint: re-read GET /v1/forge/snapshot
//                               for the full view: cells, train track, head;
//                               consumes no seq)
//   { v: 1, type: "error", code, message }
// Dashboard view (docs/FORGE-UX.md §10): `data` mirrors the snapshot in
// the REST shape the dashboard reads (intents with footprint.declared/
// actual/drift + path, edges as `overlaps`, snake_case counters); intent
// and counters ops carry the same extra fields, and every edge op is
// paired with an `overlap` op. Coordinator fields are never removed.
// `seq` increases by one per frame. A gap means frames were lost:
// send {"type":"resync"} (or GET the live view) for a fresh snapshot.
// Every op carries the coordinator's monotonic `ver`; ignore ops with
// ver <= snapshot.ver (they predate the snapshot).
// Client -> server: {"type":"resync"} | {"type":"ping"} (auto "pong").
import type { CoordinatorSnapshot, FeedOp, LiveCounters, LiveIntent } from "./coordinator-core";
import { pathsOverlap } from "./intents-core";

// 10 Hz ceiling: at most one delta flush per 100 ms.
export const FEED_FLUSH_MS = 100;
// Ops per frame; larger flushes split into consecutive frames.
export const FEED_MAX_OPS_PER_FRAME = 500;
// Concurrent sockets per repo feed.
export const FEED_MAX_SOCKETS = 1000;
// Snapshot frames stay well under the 1 MiB WebSocket message cap.
export const FEED_SNAPSHOT_MAX_BYTES = 900_000;
export const FEED_SNAPSHOT_INTENTS = 2000;

export const FEED_PING = JSON.stringify({ type: "ping" });
export const FEED_PONG = JSON.stringify({ type: "pong" });

export type DashboardOverlapOp =
  | { op: "upsert"; kind: "overlap"; id: string; ver: number; fields: { a: string; b: string; paths: string[]; state: "overlap"; origin: string } }
  | { op: "remove"; kind: "overlap"; id: string; ver: number };

export type WireOp = FeedOp | DashboardOverlapOp;

export interface DashboardSnapshot {
  repo: string;
  ver: number;
  intents: Array<Record<string, unknown>>;
  overlaps: Array<{ a: string; b: string; paths: string[]; state: "overlap"; _id: string }>;
  counters: Record<string, unknown>;
  truncated: boolean;
}

export type FeedMessage =
  | { v: 1; type: "snapshot"; seq: number; snapshot: CoordinatorSnapshot; data?: DashboardSnapshot }
  | { v: 1; type: "delta"; seq: number; ops: WireOp[] }
  | { v: 1; type: "resync" }
  | { v: 1; type: "error"; code: string; message: string };

export const FEED_RESYNC_HINT = JSON.stringify({ v: 1, type: "resync" });

export function dashboardIntent(l: LiveIntent): Record<string, unknown> {
  const actual = l.actual ?? [];
  return {
    ...l,
    footprint: { paths: l.paths, declared: l.paths, actual, drift: actual.filter((p) => !l.paths.some((d) => pathsOverlap(d, p))) },
    actualFootprint: l.actual ? { paths: l.actual } : null,
    path: actual[0] ?? l.paths[0] ?? "",
  };
}

export function dashboardCounters(c: LiveCounters): Record<string, unknown> {
  return { ...c, overlaps_caught: c.overlapsCaught };
}

export function dashboardSnapshot(s: CoordinatorSnapshot): DashboardSnapshot {
  return {
    repo: s.repo,
    ver: s.ver,
    intents: s.intents.map(dashboardIntent),
    overlaps: s.edges.map((e) => ({ a: e.a, b: e.b, paths: [...new Set(e.pairs.flatMap((x) => [x.a, x.b]))], state: "overlap", _id: e.id })),
    counters: dashboardCounters(s.counters),
    truncated: s.truncated,
  };
}

// Ops with the dashboard fields added (see the header); same order, edge
// ops followed by their overlap twin with the same ver.
export function dashboardOps(ops: readonly FeedOp[]): WireOp[] {
  const out: WireOp[] = [];
  for (const op of ops) {
    if (op.kind === "intent" && op.op === "upsert") {
      out.push({ ...op, fields: { ...op.fields, ...dashboardIntent(op.fields) } as LiveIntent });
    } else if (op.kind === "counters") {
      out.push({ ...op, fields: { ...op.fields, ...dashboardCounters(op.fields) } as LiveCounters });
    } else if (op.kind === "edge") {
      out.push(op);
      out.push(
        op.op === "upsert"
          ? {
              op: "upsert",
              kind: "overlap",
              id: op.id,
              ver: op.ver,
              fields: { a: op.fields.a, b: op.fields.b, paths: [...new Set(op.fields.pairs.flatMap((x) => [x.a, x.b]))], state: "overlap", origin: op.fields.origin },
            }
          : { op: "remove", kind: "overlap", id: op.id, ver: op.ver },
      );
    } else {
      out.push(op);
    }
  }
  return out;
}

export function opKey(op: FeedOp): string {
  return `${op.kind}:${op.id}`;
}

// Last-writer-wins by `ver` per (kind, id): an upsert followed by a
// remove collapses to the remove, and a late older op never overwrites
// a newer one.
export function coalesceOps(pending: Map<string, FeedOp>, incoming: readonly FeedOp[]): Map<string, FeedOp> {
  for (const op of incoming) {
    const key = opKey(op);
    const prev = pending.get(key);
    if (!prev || op.ver > prev.ver) pending.set(key, op);
  }
  return pending;
}

// When the next flush may run: immediately if the last flush is at
// least FEED_FLUSH_MS old, otherwise at last + FEED_FLUSH_MS.
export function flushAt(lastFlushMs: number | null, nowMs: number): number {
  if (lastFlushMs === null) return nowMs;
  return Math.max(nowMs, lastFlushMs + FEED_FLUSH_MS);
}

// Split ordered ops into frames with consecutive seq numbers starting
// after `seq`. Returns the frames and the new last seq.
export function deltaFrames(ops: readonly WireOp[], seq: number): { frames: FeedMessage[]; seq: number } {
  const ordered = [...ops].sort((a, b) => a.ver - b.ver);
  const frames: FeedMessage[] = [];
  let s = seq;
  for (let i = 0; i < ordered.length; i += FEED_MAX_OPS_PER_FRAME) {
    s++;
    frames.push({ v: 1, type: "delta", seq: s, ops: ordered.slice(i, i + FEED_MAX_OPS_PER_FRAME) });
  }
  return { frames, seq: s };
}

// Serialize a snapshot frame, halving the intent/edge lists until it
// fits the frame budget (truncated is set when anything was dropped).
export function snapshotFrame(snapshot: CoordinatorSnapshot, seq: number, maxBytes: number = FEED_SNAPSHOT_MAX_BYTES): string {
  let snap = snapshot;
  for (;;) {
    const text = JSON.stringify({ v: 1, type: "snapshot", seq, snapshot: snap, data: dashboardSnapshot(snap) } satisfies FeedMessage);
    if (text.length <= maxBytes || (snap.intents.length === 0 && snap.edges.length === 0)) return text;
    snap = {
      ...snap,
      intents: snap.intents.slice(0, Math.floor(snap.intents.length / 2)),
      edges: snap.edges.slice(0, Math.floor(snap.edges.length / 2)),
      truncated: true,
    };
  }
}

export type ClientMessage = { type: "resync" } | { type: "ping" };

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > 1024) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const t = (v as { type?: unknown }).type;
    if (t === "resync" || t === "ping") return { type: t };
  } catch {
    return null;
  }
  return null;
}
