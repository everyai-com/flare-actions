// Flare Forge ports: the narrow interfaces the agent surface (REST,
// MCP, CLI) calls for coordination, provenance and trains, plus D1-only
// fallbacks so every route works before the Coordinator DO (stream A),
// why.ts (stream C) and train.ts (stream D) are wired in. Integration
// swaps an adapter in `forgeServiceDeps({ coordinator, why, trains })`;
// nothing else changes. Runtime-free (vitest imports it directly).
import { type Db, nowIso } from "./db";
import {
  DEFAULT_LEASE_TTL_SECONDS,
  getGoal,
  heartbeatIntent,
  listTrains as listTrainsD1,
  getTrain as getTrainD1,
  toIntent,
  type IntentRow,
} from "./intents";
import {
  globBase,
  overlapPairs,
  pathCovers,
  pathsOverlap,
  protectedMatches,
  routeLanding,
  type ForgePolicy,
  type Footprint,
  type Intent,
  type IntentState,
  type LandingRoute,
  type Train,
  type TrainState,
} from "./intents-core";

// Intents that still hold (or may soon hold) a footprint. Drafts count:
// overlaps must surface before any code is written (plan §3.3).
export const LIVE_INTENT_STATES: readonly IntentState[] = [
  "draft",
  "awaiting_plan",
  "claimed",
  "working",
  "ready",
  "in_train",
  "conflicted",
  "replaying",
  "bisected",
];
const LIVE_SCAN_LIMIT = 200;

// ---------------------------------------------------------------------------
// Shapes shared by every port implementation
// ---------------------------------------------------------------------------

export interface OverlapHit {
  intentId: string;
  title: string;
  agent: string;
  state: IntentState;
  reasoning: string;
  // [mine, theirs] footprint entries that can touch the same file.
  paths: Array<[string, string]>;
  leaseExpiresAt: string | null;
}

export interface SimilarHit {
  intentId: string;
  title: string;
  state: IntentState;
  score: number; // 0-1 title token overlap (Jaccard)
}

export interface LiveIntent {
  intentId: string;
  goalId: string | null;
  title: string;
  agent: string;
  state: IntentState;
  reasoning: string;
  footprint: string[];
  actualFootprint: string[] | null;
  headSha: string;
  risk: number;
  leaseExpiresAt: string | null;
  updatedAt: string;
  // Entries of the query paths this intent can touch (empty when the
  // query had no paths).
  matchedPaths: string[];
}

export interface SnapshotCell {
  path: string;
  files: number;
  intents: string[];
  state: "idle" | "working" | "overlap" | "conflict" | "train" | "awaiting_plan";
  overlap_with: Array<[string, string]>;
  protected: boolean;
}

export interface SnapshotDot {
  intent: string;
  agent: string;
  path: string;
  state: IntentState;
}

export interface SnapshotTrain {
  id: string;
  lane: number;
  state: TrainState;
  intents: string[];
  headSha: string;
  runId: string | null;
  updatedAt: string;
}

// The dashboard Live map contract (docs/FORGE-UX.md §10).
export interface ForgeSnapshot {
  repo: string;
  generatedAt: string;
  source: "coordinator" | "d1";
  counters: {
    agents: number;
    intents: number;
    overlaps_caught: number;
    conflicts_open: number;
    landed_today: number;
    main_red_minutes: number;
    human_minutes: number;
  };
  cells: SnapshotCell[];
  dots: SnapshotDot[];
  track: { current: SnapshotTrain | null; recent: SnapshotTrain[] };
  head: string;
}

export interface WhyLink {
  kind: "line" | "commit" | "intent" | "goal" | "reason" | "rejected" | "evidence" | "session";
  id: string;
  text: string;
  links: Record<string, string>;
}

export interface WhyAnswer {
  repo: string;
  path: string;
  line: number | null;
  // true when the chain is anchored on the exact commit that last
  // touched the line (blame + notes); false = footprint best effort.
  exact: boolean;
  source: "notes" | "footprint";
  chain: WhyLink[];
}

export interface ReadyOutcome {
  queued: boolean;
  route: LandingRoute;
  trainId: string | null;
  // Ready intents ahead of this one in the repo (best effort).
  position: number | null;
  note: string;
}

// ---------------------------------------------------------------------------
// Port interfaces (stream A / C / D implement these)
// ---------------------------------------------------------------------------

// Stream A: the per-repo Coordinator DO. Every method is advisory
// coordination; durable intent state still moves through intents.ts.
export interface ForgeCoordinatorPort {
  readonly kind: "coordinator" | "d1";
  declare(repo: string, intent: Intent): Promise<{ overlaps: OverlapHit[]; similar: SimilarHit[] }>;
  heartbeat(repo: string, intentId: string, agent: string, ttlSeconds?: number): Promise<{ leaseExpiresAt: string } | null>;
  reportPush(repo: string, intent: Intent): Promise<{ overlaps: OverlapHit[] }>;
  whatsHappening(repo: string, opts: { paths?: string[]; limit?: number; excludeIntent?: string }): Promise<LiveIntent[]>;
  snapshot(repo: string, opts: { policy: ForgePolicy; head: string; trains: Train[] }): Promise<ForgeSnapshot>;
  release(repo: string, intentId: string): Promise<void>;
}

// Stream C: provenance (why.ts): line -> commit -> notes -> intent.
export interface WhyPort {
  readonly kind: "notes" | "d1";
  why(repo: string, path: string, line: number | null): Promise<WhyAnswer>;
}

// Stream D: trains (train.ts): ready intents ride the next train.
export interface TrainPort {
  readonly kind: "trains" | "d1";
  markReady(repo: string, intent: Intent, policy: ForgePolicy): Promise<ReadyOutcome>;
  listTrains(repo: string, opts: { state?: TrainState; limit?: number }): Promise<Train[]>;
  getTrain(id: string): Promise<Train | null>;
}

// Stream A: the hibernating WebSocket feed. Unset = 501 + poll hint.
export interface FeedPort {
  upgrade(request: Request, repo: string): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Pure helpers (shared by the fallbacks; exported for tests)
// ---------------------------------------------------------------------------

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// The footprint an intent effectively holds: concrete pushed files when
// known (plus its declaration, which is still its claim), else declared.
export function heldFootprint(intent: Intent): Footprint {
  if (!intent.actualFootprint || intent.actualFootprint.paths.length === 0) return intent.footprint;
  return { paths: [...new Set([...intent.footprint.paths, ...intent.actualFootprint.paths])].sort() };
}

export function overlapsFor(intent: Intent, others: readonly Intent[]): OverlapHit[] {
  const mine = heldFootprint(intent);
  const out: OverlapHit[] = [];
  for (const o of others) {
    if (o.id === intent.id) continue;
    const pairs = overlapPairs(mine, heldFootprint(o));
    if (pairs.length === 0) continue;
    out.push({
      intentId: o.id,
      title: o.title,
      agent: o.agent,
      state: o.state,
      reasoning: o.reasoning.slice(0, 500),
      paths: pairs.slice(0, 20),
      leaseExpiresAt: o.leaseExpiresAt,
    });
  }
  return out.sort((a, b) => b.paths.length - a.paths.length || a.intentId.localeCompare(b.intentId));
}

export function similarFor(intent: Intent, others: readonly Intent[], threshold = 0.5): SimilarHit[] {
  const out: SimilarHit[] = [];
  for (const o of others) {
    if (o.id === intent.id) continue;
    const score = titleSimilarity(intent.title, o.title);
    if (score >= threshold) out.push({ intentId: o.id, title: o.title, state: o.state, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score || a.intentId.localeCompare(b.intentId)).slice(0, 10);
}

export function toLiveIntent(intent: Intent, queryPaths: readonly string[]): LiveIntent {
  const held = heldFootprint(intent);
  const matched = queryPaths.filter((q) => held.paths.some((p) => pathsOverlap(p, q)));
  return {
    intentId: intent.id,
    goalId: intent.goalId,
    title: intent.title,
    agent: intent.agent,
    state: intent.state,
    reasoning: intent.reasoning.slice(0, 500),
    footprint: intent.footprint.paths,
    actualFootprint: intent.actualFootprint ? intent.actualFootprint.paths : null,
    headSha: intent.headSha,
    risk: intent.risk,
    leaseExpiresAt: intent.leaseExpiresAt,
    updatedAt: intent.updatedAt,
    matchedPaths: matched,
  };
}

// Directory cell (≤ 2 segments) a footprint entry belongs to on the map.
export function cellOf(entry: string): string {
  const base = globBase(entry);
  const segs = (base || entry).split("/").filter((s) => s && s !== "**");
  if (segs.length === 0) return "/";
  if (segs.length === 1) return segs[0].includes(".") ? "/" : segs[0];
  return segs.slice(0, 2).join("/");
}

function snapTrain(t: Train): SnapshotTrain {
  return { id: t.id, lane: t.lane, state: t.state, intents: t.intentIds, headSha: t.headSha, runId: t.runId, updatedAt: t.updatedAt };
}

const TRAIN_TERMINAL: readonly TrainState[] = ["landed", "failed", "bisected", "aborted"];
const MAX_CELLS = 64;

// Pure Live-map builder over a list of live intents (the D1 fallback;
// the Coordinator can reuse it over its own SQLite rows).
export function buildSnapshot(input: {
  repo: string;
  intents: readonly Intent[];
  policy: ForgePolicy;
  trains: readonly Train[];
  head: string;
  conflictsOpen: number;
  landedToday: number;
  overlapsCaught: number;
  source: ForgeSnapshot["source"];
  now?: string;
}): ForgeSnapshot {
  const byCell = new Map<string, Intent[]>();
  const dots: SnapshotDot[] = [];
  for (const it of input.intents) {
    const held = heldFootprint(it);
    const cells = new Set(held.paths.map(cellOf));
    for (const c of cells) {
      const list = byCell.get(c) ?? [];
      list.push(it);
      byCell.set(c, list);
    }
    dots.push({ intent: it.id, agent: it.agent, path: held.paths[0] ?? "/", state: it.state });
  }
  let cells: SnapshotCell[] = [];
  for (const [path, list] of byCell) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlapPairs(heldFootprint(list[i]), heldFootprint(list[j])).length) {
          pairs.push([list[i].id, list[j].id].sort() as [string, string]);
        }
      }
    }
    const states = new Set(list.map((x) => x.state));
    const state: SnapshotCell["state"] = states.has("conflicted")
      ? "conflict"
      : pairs.length
        ? "overlap"
        : states.has("awaiting_plan")
          ? "awaiting_plan"
          : states.has("in_train")
            ? "train"
            : "working";
    const files = new Set(list.flatMap((x) => (x.actualFootprint?.paths ?? []).filter((p) => cellOf(p) === path))).size;
    cells.push({
      path,
      files,
      intents: list.map((x) => x.id).sort(),
      state,
      overlap_with: pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
      protected: protectedMatches({ paths: [path === "/" ? "*" : path] }, input.policy).length > 0,
    });
  }
  cells.sort((a, b) => b.intents.length - a.intents.length || a.path.localeCompare(b.path));
  if (cells.length > MAX_CELLS) {
    const keep = cells.slice(0, MAX_CELLS - 1);
    const rest = cells.slice(MAX_CELLS - 1);
    keep.push({
      path: "other/",
      files: rest.reduce((s, c) => s + c.files, 0),
      intents: [...new Set(rest.flatMap((c) => c.intents))].sort(),
      state: rest.some((c) => c.state === "conflict") ? "conflict" : rest.some((c) => c.state === "overlap") ? "overlap" : "working",
      overlap_with: rest.flatMap((c) => c.overlap_with).slice(0, 50),
      protected: rest.some((c) => c.protected),
    });
    cells = keep;
  }
  dots.sort((a, b) => a.intent.localeCompare(b.intent));
  const trains = [...input.trains].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const current = trains.find((t) => !TRAIN_TERMINAL.includes(t.state)) ?? null;
  const recent = trains.filter((t) => TRAIN_TERMINAL.includes(t.state)).slice(0, 5);
  const leased = input.intents.filter((x) => x.agent && x.state !== "draft" && x.state !== "awaiting_plan");
  return {
    repo: input.repo,
    generatedAt: input.now ?? nowIso(),
    source: input.source,
    counters: {
      agents: new Set(leased.map((x) => x.agent)).size,
      intents: input.intents.length,
      overlaps_caught: input.overlapsCaught,
      conflicts_open: input.conflictsOpen,
      landed_today: input.landedToday,
      // Invariant 2: main only moves to a CI-green SHA, so main is never
      // red by construction. Reported, not assumed: trains own the CAS.
      main_red_minutes: 0,
      human_minutes: 0,
    },
    cells,
    dots,
    track: { current: current ? snapTrain(current) : null, recent: recent.map(snapTrain) },
    head: input.head,
  };
}

// ---------------------------------------------------------------------------
// D1 fallbacks
// ---------------------------------------------------------------------------

export async function listLiveIntents(db: Db, repo: string, limit = LIVE_SCAN_LIMIT): Promise<Intent[]> {
  const res = await db
    .prepare(
      "SELECT * FROM intents WHERE repo = ? AND state NOT IN ('landed', 'failed', 'abandoned', 'expired') ORDER BY updated_at DESC, id DESC LIMIT ?",
    )
    .bind(repo, Math.max(1, Math.min(LIVE_SCAN_LIMIT, limit)))
    .all<IntentRow>();
  return res.results.map(toIntent);
}

function startOfUtcDay(now: string): string {
  return `${now.slice(0, 10)}T00:00:00.000Z`;
}

async function count(db: Db, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return typeof row?.n === "number" ? row.n : 0;
}

export function d1Coordinator(db: Db): ForgeCoordinatorPort {
  return {
    kind: "d1",
    async declare(repo, intent) {
      const live = await listLiveIntents(db, repo);
      return { overlaps: overlapsFor(intent, live), similar: similarFor(intent, live) };
    },
    async heartbeat(_repo, intentId, agent, ttlSeconds) {
      const lease = await heartbeatIntent(db, intentId, agent, ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS);
      return lease ? { leaseExpiresAt: lease } : null;
    },
    async reportPush(repo, intent) {
      const live = await listLiveIntents(db, repo);
      return { overlaps: overlapsFor(intent, live) };
    },
    async whatsHappening(repo, opts) {
      const live = await listLiveIntents(db, repo);
      const paths = opts.paths ?? [];
      const rows = live
        .filter((x) => x.id !== opts.excludeIntent)
        .map((x) => toLiveIntent(x, paths))
        .filter((x) => paths.length === 0 || x.matchedPaths.length > 0);
      return rows.slice(0, Math.max(1, Math.min(LIVE_SCAN_LIMIT, opts.limit ?? 50)));
    },
    async snapshot(repo, opts) {
      const now = nowIso();
      const today = startOfUtcDay(now);
      const [intents, conflictsOpen, landedToday, overlapsCaught] = await Promise.all([
        listLiveIntents(db, repo),
        count(db, "SELECT COUNT(*) AS n FROM conflicts WHERE repo = ? AND state IN ('open', 'claimed')", repo),
        count(db, "SELECT COUNT(*) AS n FROM intents WHERE repo = ? AND state = 'landed' AND updated_at >= ?", repo, today),
        count(db, "SELECT COUNT(*) AS n FROM forge_ledger WHERE repo = ? AND kind = 'overlap_caught' AND created_at >= ?", repo, today),
      ]);
      return buildSnapshot({
        repo,
        intents,
        policy: opts.policy,
        trains: opts.trains,
        head: opts.head,
        conflictsOpen,
        landedToday,
        overlapsCaught,
        source: "d1",
        now,
      });
    },
    async release() {
      // D1 leases lapse on their own (expireLeases); nothing to drop.
    },
  };
}

// Why without blame/notes: intents whose footprint covers the path,
// landed first, newest first. `exact: false` tells the caller so.
export function d1Why(db: Db): WhyPort {
  return {
    kind: "d1",
    async why(repo, path, line) {
      const res = await db
        .prepare(
          "SELECT * FROM intents WHERE repo = ? AND state NOT IN ('abandoned', 'failed') ORDER BY (state = 'landed') DESC, updated_at DESC LIMIT 200",
        )
        .bind(repo)
        .all<IntentRow>();
      const hits = res.results.map(toIntent).filter((it) => heldFootprint(it).paths.some((e) => pathCovers(e, path)));
      const chain: WhyLink[] = [{ kind: "line", id: `${path}${line ? `:${line}` : ""}`, text: path, links: {} }];
      const top = hits[0];
      if (top) {
        if (top.landedSha) chain.push({ kind: "commit", id: top.landedSha, text: `landed by train ${top.trainId ?? "?"}`, links: {} });
        chain.push({ kind: "intent", id: top.id, text: top.title, links: { self: `/v1/forge/intents/${top.id}` } });
        if (top.goalId) {
          const goal = await getGoal(db, top.goalId);
          if (goal) chain.push({ kind: "goal", id: goal.id, text: goal.text.slice(0, 500), links: { self: `/v1/forge/goals/${goal.id}` } });
        }
        if (top.reasoning) chain.push({ kind: "reason", id: top.id, text: top.reasoning.slice(0, 1000), links: {} });
        if (top.trainId) chain.push({ kind: "evidence", id: top.trainId, text: `train ${top.trainId}`, links: { self: `/v1/forge/trains/${top.trainId}` } });
        if (top.forkRepo) chain.push({ kind: "session", id: top.forkRepo, text: `fork ${top.forkRepo} (flare/session branch)`, links: {} });
        for (const other of hits.slice(1, 4)) {
          chain.push({ kind: "intent", id: other.id, text: `also touched by: ${other.title} (${other.state})`, links: { self: `/v1/forge/intents/${other.id}` } });
        }
      }
      return { repo, path, line, exact: false, source: "footprint", chain };
    },
  };
}

// Deterministic uniform [0,1) per intent: the audit-sample roll must be
// stable across reads so the inbox never reshuffles.
export function auditRoll(intentId: string): number {
  let h = 2166136261;
  for (let i = 0; i < intentId.length; i++) {
    h ^= intentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function d1Trains(db: Db): TrainPort {
  return {
    kind: "d1",
    async markReady(repo, intent, policy) {
      const ahead = await count(
        db,
        "SELECT COUNT(*) AS n FROM intents WHERE repo = ? AND state = 'ready' AND updated_at < ?",
        repo,
        intent.updatedAt,
      );
      return {
        queued: true,
        route: routeLanding(intent.risk, policy, auditRoll(intent.id)),
        trainId: null,
        position: ahead,
        note: "queued for the next train (train runner not connected on this deployment: the intent waits in ready)",
      };
    },
    async listTrains(repo, opts) {
      return listTrainsD1(db, repo, opts);
    },
    async getTrain(id) {
      return getTrainD1(db, id);
    },
  };
}
