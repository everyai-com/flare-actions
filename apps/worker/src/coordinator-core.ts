// Flare Forge Coordinator core: the per-repo hot index of active
// intents (declared + actual footprints), overlap edges, leases and the
// automatic overlap notes. Runtime-free: the Durable Object
// (coordinator.ts) injects its SQLite storage (`SqlStore`), D1 (`Db`),
// a clock, an optional embedder and a feed publisher. Tests drive the
// same code against node:sqlite.
//
// D1 stays the source of truth for intent state: every state change
// goes through intents.ts (conditional writes); this index is rebuilt
// from D1 by `hydrate` and reconciled by `sync`.
//
// Path index: one row per footprint entry keyed by `globBase(entry)`.
// Two entries can only overlap when their literal bases are
// segment-prefix related (literal segments before the first wildcard
// must match), so a query entry with base B needs exactly:
//   - rows whose key is B or an ancestor of B (exact `IN` lookups), and
//   - rows whose key is inside B's subtree (`pathRange(B + "/")`).
// Candidates are confirmed with `pathsOverlap`. No LIKE (DO SQLite caps
// LIKE patterns at 50 bytes) and never more than 100 bound params.
import type { Db } from "./db";
import {
  ancestorPaths,
  driftPaths,
  globBase,
  labelUntrusted,
  LEASED_INTENT_STATES,
  LIMITS,
  normalizePath,
  pathRange,
  pathsOverlap,
  TERMINAL_INTENT_STATES,
  type ForgePolicy,
  type Intent,
  type IntentState,
  type RiskTerm,
} from "./intents-core";
import {
  drainInbox,
  getIntent,
  heartbeatIntent,
  isForgeError,
  recordPush,
  sendMessage,
  toIntent,
  transitionIntent,
  type IntentMessageRow,
  type IntentRow,
} from "./intents";

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

export type SqlValue = string | number | null;

// The subset of DO `ctx.storage.sql` the core uses. node:sqlite is
// adapted to the same shape in tests.
export interface SqlStore {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const COORDINATOR_LIMITS = {
  // Bound params per statement (DO SQLite and D1 cap at 100).
  paramChunk: 90,
  // Candidate rows scanned per footprint entry before truncating.
  candidatesPerEntry: 5000,
  // Overlaps returned to an agent per call (sorted by pair count).
  overlapsReturned: 50,
  // Pairs kept per overlap / edge.
  pairsPerOverlap: 20,
  // Automatic mailbox notes posted per call.
  notesPerCall: 10,
  // Live-map snapshot caps.
  snapshotIntents: 5000,
  snapshotEdges: 10000,
  // whats_happening caps.
  happeningPaths: 50,
  happeningItems: 50,
  // Rehydrate from D1 when the index is older than this (alarm-driven).
  rehydrateMs: 15 * 60_000,
  hydratePage: 200,
  hydrateMax: 100_000,
  // Expired-lease rows handled per alarm.
  sweepBatch: 100,
  // similar(): embeddings scanned (most recent first) and score floor.
  similarScan: 5000,
  similarMinScore: 0.6,
  similarDefault: 5,
  reasoningPreview: 500,
} as const;

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

const ACTIVE_STATES_SQL = "('landed', 'failed', 'abandoned')";

export function isActiveState(state: IntentState): boolean {
  return !TERMINAL_INTENT_STATES.includes(state);
}

export function isLeasedState(state: IntentState): boolean {
  return LEASED_INTENT_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Schema (DO SQLite; prefixed fc_ so a DO never collides with D1 names)
// ---------------------------------------------------------------------------

export const INDEX_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fc_intents (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    title TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    state TEXT NOT NULL,
    goal_id TEXT,
    fork_repo TEXT,
    head_sha TEXT NOT NULL DEFAULT '',
    footprint_json TEXT NOT NULL,
    actual_json TEXT,
    lease_ms INTEGER,
    risk INTEGER NOT NULL DEFAULT 0,
    declared_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    gen INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS fc_intents_lease ON fc_intents (lease_ms)",
  "CREATE INDEX IF NOT EXISTS fc_intents_updated ON fc_intents (updated_ms)",
  `CREATE TABLE IF NOT EXISTS fc_paths (
    path_key TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    entry TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (path_key, intent_id, entry, kind)
  )`,
  "CREATE INDEX IF NOT EXISTS fc_paths_intent ON fc_paths (intent_id)",
  `CREATE TABLE IF NOT EXISTS fc_edges (
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    pairs_json TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (a, b)
  )`,
  "CREATE INDEX IF NOT EXISTS fc_edges_b ON fc_edges (b)",
  "CREATE TABLE IF NOT EXISTS fc_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS fc_pushes (
    intent_id TEXT NOT NULL,
    sha TEXT NOT NULL,
    seen_ms INTEGER NOT NULL,
    PRIMARY KEY (intent_id, sha)
  )`,
  "CREATE TABLE IF NOT EXISTS fc_embed (id TEXT PRIMARY KEY, vec TEXT NOT NULL, created_ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS fc_embed_created ON fc_embed (created_ms)",
];

export function ensureIndexSchema(sql: SqlStore): void {
  for (const stmt of INDEX_SCHEMA) sql.exec(stmt);
}

// ---------------------------------------------------------------------------
// Meta + counters
// ---------------------------------------------------------------------------

export const COUNTER_KEYS = [
  "declared",
  "overlaps_caught",
  "push_overlaps",
  "drift_alerts",
  "notes_sent",
  "pushes",
  "expired",
] as const;
export type CounterKey = (typeof COUNTER_KEYS)[number];

export function getMeta(sql: SqlStore, key: string): string | null {
  const rows = sql.exec<{ v: string }>("SELECT v FROM fc_meta WHERE k = ?", key).toArray();
  return rows.length ? rows[0].v : null;
}

export function setMeta(sql: SqlStore, key: string, value: string): void {
  sql.exec("INSERT INTO fc_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
}

function metaInt(sql: SqlStore, key: string): number {
  const v = Number(getMeta(sql, key) ?? "0");
  return Number.isFinite(v) ? v : 0;
}

export function bumpCounter(sql: SqlStore, key: CounterKey, by = 1): void {
  if (by === 0) return;
  setMeta(sql, `c:${key}`, String(metaInt(sql, `c:${key}`) + by));
}

// Monotonic op version: feed ops carry it so out-of-order deliveries
// coalesce last-writer-wins and clients drop deltas older than their
// snapshot.
export function nextVersion(sql: SqlStore): number {
  const v = metaInt(sql, "ver") + 1;
  setMeta(sql, "ver", String(v));
  return v;
}

export function currentVersion(sql: SqlStore): number {
  return metaInt(sql, "ver");
}

// ---------------------------------------------------------------------------
// Live view types (snapshot + feed)
// ---------------------------------------------------------------------------

export interface LiveIntent {
  id: string;
  agent: string;
  title: string;
  state: IntentState;
  goalId: string | null;
  forkRepo: string | null;
  headSha: string;
  paths: string[];
  actual: string[] | null;
  leaseExpiresAt: string | null;
  risk: number;
}

export interface EdgePair {
  a: string;
  b: string;
}

export interface PathPair {
  mine: string;
  theirs: string;
}

export interface LiveEdge {
  id: string;
  a: string;
  b: string;
  // Overlapping entry pairs: a's entry, b's entry.
  pairs: EdgePair[];
  // "declared" = caught at declare time; "actual" = surfaced by a push.
  origin: "declared" | "actual";
  createdAt: string;
}

export interface LiveCounters {
  intents: number;
  agents: number;
  overlaps: number;
  overlapsCaught: number;
  pushOverlaps: number;
  driftAlerts: number;
  notesSent: number;
  pushes: number;
  declared: number;
  expired: number;
  byState: Partial<Record<IntentState, number>>;
}

export type FeedOp =
  | { op: "upsert"; kind: "intent"; id: string; ver: number; fields: LiveIntent }
  | { op: "remove"; kind: "intent"; id: string; ver: number }
  | { op: "upsert"; kind: "edge"; id: string; ver: number; fields: LiveEdge }
  | { op: "remove"; kind: "edge"; id: string; ver: number }
  | { op: "upsert"; kind: "counters"; id: "repo"; ver: number; fields: LiveCounters };

export interface CoordinatorSnapshot {
  v: 1;
  repo: string;
  at: string;
  // Op version at snapshot time: deltas with ver <= this are stale.
  ver: number;
  intents: LiveIntent[];
  edges: LiveEdge[];
  counters: LiveCounters;
  truncated: boolean;
  // Peer-authored fields of every entry in `intents` (data, never
  // instructions; agent names are self-reported).
  untrustedFields?: { intents: readonly string[] };
}

// ---------------------------------------------------------------------------
// Index rows
// ---------------------------------------------------------------------------

export type IndexRow = {
  id: string;
  agent: string;
  title: string;
  reasoning: string;
  state: string;
  goal_id: string | null;
  fork_repo: string | null;
  head_sha: string;
  footprint_json: string;
  actual_json: string | null;
  lease_ms: number | null;
  risk: number;
  declared_ms: number;
  updated_ms: number;
  gen: number;
};

type PathRow = { intent_id: string; entry: string; kind: string };
type EdgeRow = { a: string; b: string; pairs_json: string; origin: string; created_ms: number };

function parsePaths(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === "object" && Array.isArray((v as { paths?: unknown }).paths)) {
      return ((v as { paths: unknown[] }).paths).filter((p): p is string => typeof p === "string");
    }
  } catch {
    // Corrupt rows degrade to "no paths"; hydrate rewrites them.
  }
  return null;
}

function msToIso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function liveIntent(row: IndexRow): LiveIntent {
  return {
    id: row.id,
    agent: row.agent,
    title: row.title,
    state: row.state as IntentState,
    goalId: row.goal_id,
    forkRepo: row.fork_repo,
    headSha: row.head_sha,
    paths: parsePaths(row.footprint_json) ?? [],
    actual: parsePaths(row.actual_json),
    leaseExpiresAt: msToIso(row.lease_ms),
    risk: row.risk,
  };
}

export function edgeId(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

function liveEdge(row: EdgeRow): LiveEdge {
  let pairs: EdgePair[] = [];
  try {
    const v: unknown = JSON.parse(row.pairs_json);
    if (Array.isArray(v)) {
      pairs = v.filter(
        (p): p is EdgePair => typeof p === "object" && p !== null && typeof (p as EdgePair).a === "string" && typeof (p as EdgePair).b === "string",
      );
    }
  } catch {
    pairs = [];
  }
  return {
    id: edgeId(row.a, row.b),
    a: row.a,
    b: row.b,
    pairs,
    origin: row.origin === "actual" ? "actual" : "declared",
    createdAt: new Date(row.created_ms).toISOString(),
  };
}

function footprintJson(intent: Intent): string {
  return JSON.stringify({ paths: intent.footprint.paths });
}

function actualJson(intent: Intent): string | null {
  return intent.actualFootprint ? JSON.stringify({ paths: intent.actualFootprint.paths }) : null;
}

export function getIndexed(sql: SqlStore, id: string): IndexRow | null {
  const rows = sql.exec<IndexRow>("SELECT * FROM fc_intents WHERE id = ?", id).toArray();
  return rows.length ? rows[0] : null;
}

function getIndexedMany(sql: SqlStore, ids: string[]): Map<string, IndexRow> {
  const out = new Map<string, IndexRow>();
  for (const chunk of chunks(ids, COORDINATOR_LIMITS.paramChunk)) {
    const qs = chunk.map(() => "?").join(", ");
    for (const row of sql.exec<IndexRow>(`SELECT * FROM fc_intents WHERE id IN (${qs})`, ...chunk).toArray()) {
      out.set(row.id, row);
    }
  }
  return out;
}

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Insert or replace one intent and its path rows. `declared_ms` is
// kept from the first insert. Path rows are rewritten wholesale (≤400).
export function indexUpsert(sql: SqlStore, intent: Intent, gen: number, nowMs: number): void {
  const lease = isLeasedState(intent.state) ? isoToMs(intent.leaseExpiresAt) : null;
  const declaredMs = isoToMs(intent.createdAt) ?? nowMs;
  sql.exec(
    `INSERT INTO fc_intents (id, agent, title, reasoning, state, goal_id, fork_repo, head_sha, footprint_json, actual_json,
       lease_ms, risk, declared_ms, updated_ms, gen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, title = excluded.title, reasoning = excluded.reasoning,
       state = excluded.state, goal_id = excluded.goal_id, fork_repo = excluded.fork_repo, head_sha = excluded.head_sha,
       footprint_json = excluded.footprint_json, actual_json = excluded.actual_json, lease_ms = excluded.lease_ms,
       risk = excluded.risk, updated_ms = excluded.updated_ms, gen = excluded.gen`,
    intent.id,
    intent.agent,
    intent.title,
    intent.reasoning,
    intent.state,
    intent.goalId,
    intent.forkRepo,
    intent.headSha,
    JSON.stringify({ paths: intent.footprint.paths }),
    intent.actualFootprint ? JSON.stringify({ paths: intent.actualFootprint.paths }) : null,
    lease,
    intent.risk,
    declaredMs,
    nowMs,
    gen,
  );
  sql.exec("DELETE FROM fc_paths WHERE intent_id = ?", intent.id);
  const rows: SqlValue[][] = [];
  for (const entry of intent.footprint.paths) rows.push([globBase(entry), intent.id, entry, "d"]);
  for (const entry of intent.actualFootprint?.paths ?? []) rows.push([globBase(entry), intent.id, entry, "a"]);
  // 4 params per row -> 22 rows per statement (88 params).
  for (const chunk of chunks(rows, Math.floor(COORDINATOR_LIMITS.paramChunk / 4))) {
    const qs = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    sql.exec(`INSERT OR IGNORE INTO fc_paths (path_key, intent_id, entry, kind) VALUES ${qs}`, ...chunk.flat());
  }
}

// Remove an intent everywhere in the index. Returns the edge ids that
// disappeared (for the feed).
export function indexRemove(sql: SqlStore, id: string): string[] {
  const edges = edgesOf(sql, id).map((e) => edgeId(e.a, e.b));
  sql.exec("DELETE FROM fc_paths WHERE intent_id = ?", id);
  sql.exec("DELETE FROM fc_edges WHERE a = ?", id);
  sql.exec("DELETE FROM fc_edges WHERE b = ?", id);
  sql.exec("DELETE FROM fc_pushes WHERE intent_id = ?", id);
  sql.exec("DELETE FROM fc_embed WHERE id = ?", id);
  sql.exec("DELETE FROM fc_intents WHERE id = ?", id);
  return edges;
}

function edgesOf(sql: SqlStore, id: string): EdgeRow[] {
  return [
    ...sql.exec<EdgeRow>("SELECT * FROM fc_edges WHERE a = ?", id).toArray(),
    ...sql.exec<EdgeRow>("SELECT * FROM fc_edges WHERE b = ?", id).toArray(),
  ];
}

// ---------------------------------------------------------------------------
// Overlap query
// ---------------------------------------------------------------------------

export interface OverlapPair {
  mine: string;
  theirs: string;
  // Which footprint of the other intent matched.
  kind: "declared" | "actual";
}

export interface OverlapQueryResult {
  hits: Map<string, OverlapPair[]>;
  truncated: boolean;
  candidates: number;
}

// Index keys a query entry must look at: its base, every ancestor of
// the base, and "" (leading-wildcard rows). The subtree is the range.
export function exactKeysFor(entry: string): string[] {
  const base = globBase(entry);
  if (!base) return [];
  return ["", ...ancestorPaths(base), base];
}

export function candidateRows(sql: SqlStore, entry: string, limit: number): { rows: PathRow[]; truncated: boolean } {
  const base = globBase(entry);
  const rows: PathRow[] = [];
  const keys = exactKeysFor(entry);
  for (const chunk of chunks(keys, COORDINATOR_LIMITS.paramChunk)) {
    const qs = chunk.map(() => "?").join(", ");
    rows.push(
      ...sql
        .exec<PathRow>(`SELECT intent_id, entry, kind FROM fc_paths WHERE path_key IN (${qs}) LIMIT ?`, ...chunk, limit + 1)
        .toArray(),
    );
  }
  const [lo, hi] = base ? pathRange(`${base}/`) : pathRange("");
  rows.push(
    ...sql
      .exec<PathRow>("SELECT intent_id, entry, kind FROM fc_paths WHERE path_key >= ? AND path_key < ? LIMIT ?", lo, hi, limit + 1)
      .toArray(),
  );
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
}

// Every indexed intent (except `excludeId`) with at least one entry
// overlapping `entries`. O(candidates): literal-prefix related rows only.
export function queryOverlaps(
  sql: SqlStore,
  entries: readonly string[],
  excludeId: string | null = null,
  perEntryLimit: number = COORDINATOR_LIMITS.candidatesPerEntry,
): OverlapQueryResult {
  const hits = new Map<string, OverlapPair[]>();
  const seen = new Set<string>();
  let truncated = false;
  let candidates = 0;
  for (const mine of entries) {
    const { rows, truncated: t } = candidateRows(sql, mine, perEntryLimit);
    truncated ||= t;
    candidates += rows.length;
    for (const row of rows) {
      if (row.intent_id === excludeId) continue;
      const kind: OverlapPair["kind"] = row.kind === "a" ? "actual" : "declared";
      const key = `${row.intent_id}\u0000${mine}\u0000${row.entry}\u0000${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!pathsOverlap(mine, row.entry)) continue;
      const list = hits.get(row.intent_id) ?? [];
      list.push({ mine, theirs: row.entry, kind });
      hits.set(row.intent_id, list);
    }
  }
  return { hits, truncated, candidates };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface EdgeDelta {
  added: LiveEdge[];
  updated: LiveEdge[];
  removed: string[];
  hits: Map<string, OverlapPair[]>;
  truncated: boolean;
}

function indexedEntries(row: IndexRow): { declared: string[]; actual: string[] } {
  return { declared: parsePaths(row.footprint_json) ?? [], actual: parsePaths(row.actual_json) ?? [] };
}

// Recompute every overlap edge touching `id` from its current declared
// + actual entries against the whole index. Symmetric: the query checks
// this intent's entries against both footprints of every other intent.
export function recomputeEdges(sql: SqlStore, id: string, nowMs: number): EdgeDelta {
  const row = getIndexed(sql, id);
  const before = new Map<string, EdgeRow>();
  for (const e of edgesOf(sql, id)) before.set(e.a === id ? e.b : e.a, e);
  if (!row) {
    sql.exec("DELETE FROM fc_edges WHERE a = ?", id);
    sql.exec("DELETE FROM fc_edges WHERE b = ?", id);
    return { added: [], updated: [], removed: [...before.values()].map((e) => edgeId(e.a, e.b)), hits: new Map(), truncated: false };
  }
  const { declared, actual } = indexedEntries(row);
  const actualSet = new Set(actual);
  const entries = [...new Set([...declared, ...actual])];
  const { hits, truncated } = queryOverlaps(sql, entries, id);
  const delta: EdgeDelta = { added: [], updated: [], removed: [], hits, truncated };
  for (const [other, pairs] of hits) {
    const a = id < other ? id : other;
    const b = id < other ? other : id;
    const oriented: EdgePair[] = pairs
      .slice(0, COORDINATOR_LIMITS.pairsPerOverlap)
      .map((p) => (a === id ? { a: p.mine, b: p.theirs } : { a: p.theirs, b: p.mine }));
    const fromActual = pairs.some((p) => p.kind === "actual" || (actualSet.has(p.mine) && !declared.includes(p.mine)));
    const prev = before.get(other);
    const origin = prev ? (prev.origin === "actual" ? "actual" : "declared") : fromActual ? "actual" : "declared";
    const pairsJson = JSON.stringify(oriented);
    const createdMs = prev ? prev.created_ms : nowMs;
    if (!prev || prev.pairs_json !== pairsJson) {
      sql.exec(
        "INSERT INTO fc_edges (a, b, pairs_json, origin, created_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET pairs_json = excluded.pairs_json",
        a,
        b,
        pairsJson,
        origin,
        createdMs,
      );
      const edge = liveEdge({ a, b, pairs_json: pairsJson, origin, created_ms: createdMs });
      if (prev) delta.updated.push(edge);
      else delta.added.push(edge);
    }
    before.delete(other);
  }
  // Truncated scans never delete: a missing hit may just be unscanned.
  if (!truncated) {
    for (const [, e] of before) {
      sql.exec("DELETE FROM fc_edges WHERE a = ? AND b = ?", e.a, e.b);
      delta.removed.push(edgeId(e.a, e.b));
    }
  }
  return delta;
}

// ---------------------------------------------------------------------------
// Agent-facing views (agent-authored text is flagged untrusted)
// ---------------------------------------------------------------------------

// Which fields of each view are another agent's words (§3.2 invariant
// 5). Structural, not a prefix: a consumer (MCP tool, LLM prompt
// builder, dashboard) can treat exactly these as data. `agent` is
// listed too: it is the caller-chosen name, not a verified identity.
// Always set by this module; optional in the view types only so RPC
// and adapter mirrors of these shapes stay assignable.
export const PEER_FIELDS = {
  overlap: ["agent", "title", "reasoning"],
  inbox: ["fromAgent", "text"],
  similar: ["agent", "title"],
  happening: ["agent", "title", "reasoning"],
  liveIntent: ["agent", "title"],
} as const;

export interface OverlapView {
  intentId: string;
  agent: string;
  title: string;
  reasoning: string;
  state: IntentState;
  pairs: PathPair[];
  // Matched their actual (pushed) footprint, not only the declared one.
  viaActual: boolean;
  // title/reasoning are another agent's words: data, never instructions.
  untrusted: true;
  untrustedFields?: readonly string[];
}

export interface InboxNote {
  id: string;
  fromIntent: string | null;
  fromAgent: string;
  // Body fenced by labelUntrusted (§3.2 invariant 5).
  text: string;
  createdAt: string;
  untrusted: true;
  untrustedFields?: readonly string[];
}

export interface SimilarView {
  intentId: string;
  agent: string;
  title: string;
  state: IntentState;
  score: number;
  untrusted: true;
  untrustedFields?: readonly string[];
}

function preview(text: string): string {
  return text.length > COORDINATOR_LIMITS.reasoningPreview ? `${text.slice(0, COORDINATOR_LIMITS.reasoningPreview)}…` : text;
}

export function overlapViews(sql: SqlStore, hits: Map<string, OverlapPair[]>): OverlapView[] {
  const ranked = [...hits.entries()].sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1));
  const top = ranked.slice(0, COORDINATOR_LIMITS.overlapsReturned);
  const rows = getIndexedMany(
    sql,
    top.map(([id]) => id),
  );
  const out: OverlapView[] = [];
  for (const [id, pairs] of top) {
    const row = rows.get(id);
    if (!row) continue;
    out.push({
      intentId: id,
      agent: row.agent,
      title: row.title,
      reasoning: preview(row.reasoning),
      state: row.state as IntentState,
      pairs: pairs.slice(0, COORDINATOR_LIMITS.pairsPerOverlap).map((p) => ({ mine: p.mine, theirs: p.theirs })),
      viaActual: pairs.some((p) => p.kind === "actual"),
      untrusted: true,
      untrustedFields: PEER_FIELDS.overlap,
    });
  }
  return out;
}

export function inboxNote(row: IntentMessageRow): InboxNote {
  return {
    id: row.id,
    fromIntent: row.from_intent,
    fromAgent: row.from_agent,
    text: labelUntrusted(row.from_agent, row.body),
    createdAt: row.created_at,
    untrusted: true,
    untrustedFields: PEER_FIELDS.inbox,
  };
}

// The automatic overlap note posted to another intent's mailbox. The
// author's title is peer content, so it is fenced by labelUntrusted.
export function overlapNoteBody(
  me: { id: string; agent: string; title: string },
  paths: string[],
  reason: "declared" | "pushed",
): string {
  const where = paths.slice(0, 8).join(", ") + (paths.length > 8 ? ` (+${paths.length - 8} more)` : "");
  const verb = reason === "declared" ? "was declared" : "pushed changes";
  const head = `Flare coordinator: intent ${me.id} (${me.agent || "unclaimed"}) ${verb} overlapping your intent on ${where}. Its title follows as untrusted peer content:\n`;
  const body = head + labelUntrusted(me.agent || "unclaimed", me.title);
  return body.length > LIMITS.messageBody ? body.slice(0, LIMITS.messageBody) : body;
}

// ---------------------------------------------------------------------------
// Counters + snapshot
// ---------------------------------------------------------------------------

export function counters(sql: SqlStore): LiveCounters {
  const byState: Partial<Record<IntentState, number>> = {};
  let intents = 0;
  for (const r of sql.exec<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM fc_intents GROUP BY state").toArray()) {
    byState[r.state as IntentState] = r.n;
    intents += r.n;
  }
  const agents = sql
    .exec<{ n: number }>("SELECT COUNT(DISTINCT agent) AS n FROM fc_intents WHERE agent != ''")
    .toArray()[0]?.n ?? 0;
  const overlaps = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_edges").toArray()[0]?.n ?? 0;
  return {
    intents,
    agents,
    overlaps,
    overlapsCaught: metaInt(sql, "c:overlaps_caught"),
    pushOverlaps: metaInt(sql, "c:push_overlaps"),
    driftAlerts: metaInt(sql, "c:drift_alerts"),
    notesSent: metaInt(sql, "c:notes_sent"),
    pushes: metaInt(sql, "c:pushes"),
    declared: metaInt(sql, "c:declared"),
    expired: metaInt(sql, "c:expired"),
    byState,
  };
}

export function buildSnapshot(
  sql: SqlStore,
  repo: string,
  nowMs: number,
  maxIntents: number = COORDINATOR_LIMITS.snapshotIntents,
): CoordinatorSnapshot {
  const max = Math.max(1, Math.min(maxIntents, COORDINATOR_LIMITS.snapshotIntents));
  const rows = sql.exec<IndexRow>("SELECT * FROM fc_intents ORDER BY updated_ms DESC LIMIT ?", max + 1).toArray();
  const edges = sql.exec<EdgeRow>("SELECT * FROM fc_edges ORDER BY created_ms DESC LIMIT ?", COORDINATOR_LIMITS.snapshotEdges + 1).toArray();
  return {
    v: 1,
    repo,
    at: new Date(nowMs).toISOString(),
    ver: currentVersion(sql),
    intents: rows.slice(0, max).map(liveIntent),
    edges: edges.slice(0, COORDINATOR_LIMITS.snapshotEdges).map(liveEdge),
    counters: counters(sql),
    truncated: rows.length > max || edges.length > COORDINATOR_LIMITS.snapshotEdges,
    untrustedFields: { intents: PEER_FIELDS.liveIntent },
  };
}

// ---------------------------------------------------------------------------
// Embeddings (similar intents)
// ---------------------------------------------------------------------------

export function encodeVector(vec: readonly number[]): string {
  const f = new Float32Array(vec);
  const bytes = new Uint8Array(f.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function decodeVector(b64: string): Float32Array | null {
  try {
    const s = atob(b64);
    if (s.length % 4 !== 0) return null;
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function intentText(i: { title: string; reasoning: string }): string {
  return `${i.title}\n${i.reasoning}`.slice(0, 2000);
}

export function rankSimilar(sql: SqlStore, query: ArrayLike<number>, limit: number, excludeId: string | null): SimilarView[] {
  const rows = sql
    .exec<{ id: string; vec: string; agent: string; title: string; state: string }>(
      `SELECT e.id AS id, e.vec AS vec, i.agent AS agent, i.title AS title, i.state AS state
         FROM fc_embed e JOIN fc_intents i ON i.id = e.id ORDER BY e.created_ms DESC LIMIT ?`,
      COORDINATOR_LIMITS.similarScan,
    )
    .toArray();
  const scored: SimilarView[] = [];
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const vec = decodeVector(r.vec);
    if (!vec) continue;
    const score = cosine(query, vec);
    if (score < COORDINATOR_LIMITS.similarMinScore) continue;
    scored.push({ intentId: r.id, agent: r.agent, title: r.title, state: r.state as IntentState, score: Math.round(score * 1000) / 1000, untrusted: true, untrustedFields: PEER_FIELDS.similar });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(1, Math.min(limit, 20)));
}

// ---------------------------------------------------------------------------
// Service: the Coordinator's operations over injected dependencies
// ---------------------------------------------------------------------------

export type LogFn = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface CoordinatorDeps {
  sql: SqlStore;
  db: Db;
  repo: string;
  now: () => number;
  // Fire-and-forget fan-out to the live feed (the DO wraps it in waitUntil).
  publish: (ops: FeedOp[]) => void;
  // Workers AI embedder; absent or failing = similar() returns [].
  embed?: ((texts: string[]) => Promise<number[][]>) | null;
  log: LogFn;
}

export type CoordinatorError = { ok: false; error: string; message: string };

export interface DeclareResult {
  ok: true;
  intentId: string;
  state: IntentState;
  overlaps: OverlapView[];
  // Overlap scan hit a candidate cap; more overlaps may exist.
  truncated: boolean;
  similar: SimilarView[];
  inbox: InboxNote[];
}

export interface HeartbeatResult {
  ok: true;
  leaseExpiresAt: string;
  state: IntentState;
  inbox: InboxNote[];
  drift: string[];
  overlaps: number;
}

export interface ReportPushInput {
  // Owner agent; omitted by the push trigger (the intent's agent is used).
  agent?: string;
  headSha: string;
  actualFootprint: unknown;
  policy?: ForgePolicy;
  source?: "agent" | "trigger";
}

export interface ReportPushResult {
  ok: true;
  duplicate: boolean;
  state: IntentState;
  drift: string[];
  newOverlaps: OverlapView[];
  // Every overlap the intent holds after this push (new or not).
  overlaps: OverlapView[];
  risk: number;
  riskTerms: RiskTerm[];
}

export interface HappeningItem {
  intentId: string;
  agent: string;
  title: string;
  reasoning: string;
  state: IntentState;
  paths: string[];
  actual: string[] | null;
  headSha: string;
  leaseExpiresAt: string | null;
  risk: number;
  goalId: string | null;
  updatedAt: string | null;
  // mine = the query path (empty when no paths were given).
  matched: PathPair[];
  untrusted: true;
  untrustedFields?: readonly string[];
}

export interface HappeningResult {
  items: HappeningItem[];
  invalid: string[];
  truncated: boolean;
}

function err(error: string, message: string): CoordinatorError {
  return { ok: false, error, message };
}

function genOf(sql: SqlStore): number {
  return metaInt(sql, "gen");
}

// Collects feed ops during one call and publishes them once.
class OpBatch {
  ops: FeedOp[] = [];
  private readonly sql: SqlStore;
  constructor(sql: SqlStore) {
    this.sql = sql;
  }
  intent(row: IndexRow | null, id: string): void {
    const ver = nextVersion(this.sql);
    this.ops.push(row ? { op: "upsert", kind: "intent", id, ver, fields: liveIntent(row) } : { op: "remove", kind: "intent", id, ver });
  }
  edges(delta: { added: LiveEdge[]; updated: LiveEdge[]; removed: string[] }): void {
    for (const e of [...delta.added, ...delta.updated]) {
      this.ops.push({ op: "upsert", kind: "edge", id: e.id, ver: nextVersion(this.sql), fields: e });
    }
    for (const id of delta.removed) this.ops.push({ op: "remove", kind: "edge", id, ver: nextVersion(this.sql) });
  }
  flush(deps: CoordinatorDeps): void {
    if (!this.ops.length) return;
    this.ops.push({ op: "upsert", kind: "counters", id: "repo", ver: nextVersion(this.sql), fields: counters(this.sql) });
    try {
      deps.publish(this.ops);
    } catch (e) {
      deps.log("warn", "coordinator publish failed", { error: String(e) });
    }
    this.ops = [];
  }
}

function otherId(edge: LiveEdge, me: string): string {
  return edge.a === me ? edge.b : edge.a;
}

function myPathsOf(edge: LiveEdge, me: string): string[] {
  return [...new Set(edge.pairs.map((p) => (edge.a === me ? p.a : p.b)))];
}

// Post the automatic overlap note to each newly overlapping intent
// (bounded). Best effort: a failed note never fails the call.
async function notifyOverlaps(
  deps: CoordinatorDeps,
  me: IndexRow,
  added: LiveEdge[],
  reason: "declared" | "pushed",
): Promise<number> {
  let sent = 0;
  for (const edge of added.slice(0, COORDINATOR_LIMITS.notesPerCall)) {
    const to = otherId(edge, me.id);
    try {
      const res = await sendMessage(deps.db, {
        toIntent: to,
        fromIntent: me.id,
        fromAgent: "flare-coordinator",
        body: overlapNoteBody({ id: me.id, agent: me.agent, title: me.title }, myPathsOf(edge, me.id), reason),
      });
      if (!isForgeError(res)) sent++;
    } catch (e) {
      deps.log("warn", "coordinator overlap note failed", { to, error: String(e) });
    }
  }
  if (sent) bumpCounter(deps.sql, "notes_sent", sent);
  return sent;
}

async function drain(deps: CoordinatorDeps, id: string): Promise<InboxNote[]> {
  try {
    return (await drainInbox(deps.db, id)).map(inboxNote);
  } catch (e) {
    deps.log("warn", "coordinator inbox drain failed", { id, error: String(e) });
    return [];
  }
}

async function embedOne(deps: CoordinatorDeps, text: string): Promise<number[] | null> {
  if (!deps.embed) return null;
  try {
    const out = await deps.embed([text]);
    const v = out[0];
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? v : null;
  } catch (e) {
    deps.log("warn", "coordinator embed failed", { error: String(e) });
    return null;
  }
}

// Index (or re-index) an intent from its D1 snapshot and return the
// overlaps the declarer must see before writing code, similar intents,
// and its pending inbox. Newly found overlaps notify the other owners.
export async function declare(deps: CoordinatorDeps, intent: Intent): Promise<DeclareResult | CoordinatorError> {
  if (intent.repo !== deps.repo) return err("wrong-repo", `intent belongs to ${intent.repo}, not ${deps.repo}`);
  const { sql } = deps;
  const batch = new OpBatch(sql);
  if (!isActiveState(intent.state)) {
    const removed = indexRemove(sql, intent.id);
    batch.intent(null, intent.id);
    batch.edges({ added: [], updated: [], removed });
    batch.flush(deps);
    return { ok: true, intentId: intent.id, state: intent.state, overlaps: [], truncated: false, similar: [], inbox: [] };
  }
  const now = deps.now();
  const known = getIndexed(sql, intent.id) !== null;
  indexUpsert(sql, intent, genOf(sql), now);
  const delta = recomputeEdges(sql, intent.id, now);
  if (!known) bumpCounter(sql, "declared");
  bumpCounter(sql, "overlaps_caught", delta.added.length);
  const row = getIndexed(sql, intent.id);
  batch.intent(row, intent.id);
  batch.edges(delta);
  const overlaps = overlapViews(sql, delta.hits);

  let similar: SimilarView[] = [];
  const vec = await embedOne(deps, intentText(intent));
  if (vec) {
    similar = rankSimilar(sql, vec, COORDINATOR_LIMITS.similarDefault, intent.id);
    if (getIndexed(sql, intent.id)) {
      sql.exec(
        "INSERT INTO fc_embed (id, vec, created_ms) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET vec = excluded.vec",
        intent.id,
        encodeVector(vec),
        now,
      );
    }
  }
  if (row) await notifyOverlaps(deps, row, delta.added, "declared");
  const inbox = await drain(deps, intent.id);
  batch.flush(deps);
  return { ok: true, intentId: intent.id, state: intent.state, overlaps, truncated: delta.truncated, similar, inbox };
}

// Re-read one intent from D1 and reconcile the index (state changes
// made by other modules: claim, ready, trains, abandon). Returns the
// current state, or null when it left the index.
export async function sync(deps: CoordinatorDeps, id: string): Promise<IntentState | null> {
  const intent = await getIntent(deps.db, id);
  const batch = new OpBatch(deps.sql);
  if (!intent || intent.repo !== deps.repo || !isActiveState(intent.state)) {
    if (getIndexed(deps.sql, id)) {
      const removed = indexRemove(deps.sql, id);
      batch.intent(null, id);
      batch.edges({ added: [], updated: [], removed });
      batch.flush(deps);
    }
    return null;
  }
  const prev = getIndexed(deps.sql, id);
  indexUpsert(deps.sql, intent, genOf(deps.sql), deps.now());
  const footprintChanged =
    !prev ||
    prev.footprint_json !== JSON.stringify({ paths: intent.footprint.paths }) ||
    prev.actual_json !== (intent.actualFootprint ? JSON.stringify({ paths: intent.actualFootprint.paths }) : null);
  if (footprintChanged) batch.edges(recomputeEdges(deps.sql, id, deps.now()));
  batch.intent(getIndexed(deps.sql, id), id);
  batch.flush(deps);
  return intent.state;
}

// Drop an intent from the hot index (landed/abandoned/failed). D1 is
// untouched: the caller already moved state there.
export function release(deps: CoordinatorDeps, id: string): boolean {
  if (!getIndexed(deps.sql, id)) return false;
  const batch = new OpBatch(deps.sql);
  const removed = indexRemove(deps.sql, id);
  batch.intent(null, id);
  batch.edges({ added: [], updated: [], removed });
  batch.flush(deps);
  return true;
}

// Renew the lease (D1 conditional write), mirror it locally, and hand
// back the inbox + current drift. Lease-only changes are not published.
export async function heartbeat(
  deps: CoordinatorDeps,
  id: string,
  agent: string,
  ttlSeconds?: number,
): Promise<HeartbeatResult | CoordinatorError> {
  const lease = await heartbeatIntent(deps.db, id, agent, ttlSeconds);
  if (!lease) {
    const state = await sync(deps, id);
    return err("not-leased", state ? `intent is ${state} and not leased by ${agent}` : "intent is not active");
  }
  let row = getIndexed(deps.sql, id);
  if (!row) {
    await sync(deps, id);
    row = getIndexed(deps.sql, id);
  } else if (isLeasedState(row.state as IntentState)) {
    deps.sql.exec("UPDATE fc_intents SET lease_ms = ? WHERE id = ?", isoToMs(lease), id);
  }
  const inbox = await drain(deps, id);
  let drift: string[] = [];
  let overlaps = 0;
  if (row) {
    const { declared, actual } = indexedEntries(row);
    drift = driftPaths({ paths: declared }, { paths: actual });
    overlaps = edgesOf(deps.sql, id).length;
  }
  return { ok: true, leaseExpiresAt: lease, state: (row?.state ?? "claimed") as IntentState, inbox, drift, overlaps };
}

function pushSeen(sql: SqlStore, id: string, sha: string): boolean {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_pushes WHERE intent_id = ? AND sha = ?", id, sha).toArray()[0].n > 0;
}

// report_push (agent fast path) and the namespace push trigger share
// this: dedupe on (intent, sha) — a fork maps 1:1 to an intent, so this
// is the (repo, after) key — then recordPush in D1, re-index the actual
// footprint, and notify owners of overlaps the push newly created.
export async function reportPush(
  deps: CoordinatorDeps,
  id: string,
  input: ReportPushInput,
): Promise<ReportPushResult | CoordinatorError> {
  const sha = typeof input.headSha === "string" ? input.headSha.toLowerCase() : "";
  if (!sha) return err("invalid-sha", "headSha is required");
  const { sql } = deps;
  if (pushSeen(sql, id, sha)) {
    const row = getIndexed(sql, id);
    const { declared, actual } = row ? indexedEntries(row) : { declared: [], actual: [] };
    return {
      ok: true,
      duplicate: true,
      state: (row?.state ?? "working") as IntentState,
      drift: driftPaths({ paths: declared }, { paths: actual }),
      newOverlaps: [],
      overlaps: [],
      risk: row?.risk ?? 0,
      riskTerms: [],
    };
  }
  let agent = input.agent;
  if (!agent) {
    const current = await getIntent(deps.db, id);
    if (!current) return err("not-found", "intent not found");
    agent = current.agent;
  }
  const res = await recordPush(deps.db, { id, agent, headSha: sha, actualFootprint: input.actualFootprint, policy: input.policy });
  if (isForgeError(res)) return err(res.error, res.message);
  if (res.intent.repo !== deps.repo) return err("wrong-repo", `intent belongs to ${res.intent.repo}`);
  return applyPush(deps, res.intent, sha, { drift: res.drift, risk: res.risk, riskTerms: res.riskTerms, source: input.source ?? "agent" });
}

// The agent path (forge-service report_push) records the push in D1
// itself (it verified the sha against the fork first); this only
// re-indexes the recorded intent and marks (intent, sha) seen, so a
// later namespace push trigger for the same sha dedupes instead of
// recording it twice.
export async function indexPush(
  deps: CoordinatorDeps,
  intent: Intent,
  input: { drift: string[]; risk: number; riskTerms: RiskTerm[] },
): Promise<ReportPushResult | CoordinatorError> {
  if (intent.repo !== deps.repo) return err("wrong-repo", `intent belongs to ${intent.repo}, not ${deps.repo}`);
  const sha = intent.headSha.toLowerCase();
  if (!sha) return err("invalid-sha", "intent has no recorded head");
  if (pushSeen(deps.sql, intent.id, sha)) {
    const row = getIndexed(deps.sql, intent.id);
    return {
      ok: true,
      duplicate: true,
      state: (row?.state ?? intent.state) as IntentState,
      drift: input.drift,
      newOverlaps: [],
      overlaps: overlapViews(deps.sql, new Map(queryOverlaps(deps.sql, indexedEntriesAll(row), intent.id).hits)),
      risk: input.risk,
      riskTerms: input.riskTerms,
    };
  }
  return applyPush(deps, intent, sha, { ...input, source: "agent" });
}

function indexedEntriesAll(row: IndexRow | null): string[] {
  if (!row) return [];
  const { declared, actual } = indexedEntries(row);
  return [...new Set([...declared, ...actual])];
}

async function applyPush(
  deps: CoordinatorDeps,
  intent: Intent,
  sha: string,
  input: { drift: string[]; risk: number; riskTerms: RiskTerm[]; source: "agent" | "trigger" },
): Promise<ReportPushResult> {
  const { sql } = deps;
  const id = intent.id;
  const now = deps.now();
  sql.exec("INSERT OR IGNORE INTO fc_pushes (intent_id, sha, seen_ms) VALUES (?, ?, ?)", id, sha, now);
  const batch = new OpBatch(sql);
  indexUpsert(sql, intent, genOf(sql), now);
  const delta = recomputeEdges(sql, id, now);
  bumpCounter(sql, "pushes");
  bumpCounter(sql, "push_overlaps", delta.added.length);
  if (input.drift.length) bumpCounter(sql, "drift_alerts");
  const row = getIndexed(sql, id);
  batch.intent(row, id);
  batch.edges(delta);
  const addedIds = new Set(delta.added.map((e) => otherId(e, id)));
  const newHits = new Map([...delta.hits].filter(([other]) => addedIds.has(other)));
  const newOverlaps = overlapViews(sql, newHits);
  if (row) await notifyOverlaps(deps, row, delta.added, "pushed");
  batch.flush(deps);
  deps.log("info", "coordinator push", {
    repo: deps.repo,
    intent: id,
    sha,
    source: input.source,
    drift: input.drift.length,
    newOverlaps: delta.added.length,
  });
  return {
    ok: true,
    duplicate: false,
    state: intent.state,
    drift: input.drift,
    newOverlaps,
    overlaps: overlapViews(sql, delta.hits),
    risk: input.risk,
    riskTerms: input.riskTerms,
  };
}

// Similar active intents by embedding (degrades to []).
export async function similar(deps: CoordinatorDeps, text: string, limit: number = COORDINATOR_LIMITS.similarDefault): Promise<SimilarView[]> {
  if (typeof text !== "string" || !text.trim()) return [];
  const vec = await embedOne(deps, text.slice(0, 4000));
  if (!vec) return [];
  try {
    return rankSimilar(deps.sql, vec, limit, null);
  } catch (e) {
    deps.log("warn", "coordinator similar failed", { error: String(e) });
    return [];
  }
}

// whats_happening: live intents touching `paths` (or the most recently
// active ones when no paths are given).
export function whatsHappening(deps: CoordinatorDeps, paths?: readonly unknown[]): HappeningResult {
  const { sql } = deps;
  const toItem = (row: IndexRow, matched: PathPair[]): HappeningItem => {
    const live = liveIntent(row);
    return {
      intentId: row.id,
      agent: row.agent,
      title: row.title,
      reasoning: preview(row.reasoning),
      state: live.state,
      paths: live.paths,
      actual: live.actual,
      headSha: row.head_sha,
      leaseExpiresAt: live.leaseExpiresAt,
      risk: row.risk,
      goalId: row.goal_id,
      updatedAt: msToIso(row.updated_ms),
      matched,
      untrusted: true,
      untrustedFields: PEER_FIELDS.happening,
    };
  };
  if (!paths || paths.length === 0) {
    const rows = sql.exec<IndexRow>("SELECT * FROM fc_intents ORDER BY updated_ms DESC LIMIT ?", COORDINATOR_LIMITS.happeningItems).toArray();
    return { items: rows.map((r) => toItem(r, [])), invalid: [], truncated: false };
  }
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of paths.slice(0, COORDINATOR_LIMITS.happeningPaths)) {
    const p = normalizePath(raw);
    if (p.ok) valid.push(p.value);
    else invalid.push(typeof raw === "string" ? raw.slice(0, 100) : String(raw).slice(0, 100));
  }
  const { hits, truncated } = queryOverlaps(sql, [...new Set(valid)]);
  const ranked = [...hits.entries()].sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1));
  const top = ranked.slice(0, COORDINATOR_LIMITS.happeningItems);
  const rows = getIndexedMany(
    sql,
    top.map(([id]) => id),
  );
  const items: HappeningItem[] = [];
  for (const [id, pairs] of top) {
    const row = rows.get(id);
    if (row) items.push(toItem(row, pairs.slice(0, COORDINATOR_LIMITS.pairsPerOverlap).map((p) => ({ mine: p.mine, theirs: p.theirs }))));
  }
  return { items, invalid, truncated: truncated || ranked.length > top.length };
}

export function snapshot(deps: CoordinatorDeps, maxIntents?: number): CoordinatorSnapshot {
  return buildSnapshot(deps.sql, deps.repo, deps.now(), maxIntents);
}

// Rebuild the index from D1 (source of truth): page every non-terminal
// intent of this repo (keyset on created_at, id), stamp a new
// generation, drop rows D1 no longer has as active, then recompute the
// edges of new or changed intents. Concurrent upserts carry the new
// generation too.
export async function hydrate(deps: CoordinatorDeps): Promise<{ indexed: number; removed: number; edges: number; truncated: boolean }> {
  const { sql, db } = deps;
  const gen = genOf(sql) + 1;
  setMeta(sql, "gen", String(gen));
  const now = deps.now();
  let indexed = 0;
  let cursor: { createdAt: string; id: string } | null = null;
  let truncated = false;
  const dirty: string[] = [];
  for (;;) {
    const page: { results: IntentRow[] } = cursor
      ? await db
          .prepare(
            `SELECT * FROM intents WHERE repo = ? AND state NOT IN ${ACTIVE_STATES_SQL}
               AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?`,
          )
          .bind(deps.repo, cursor.createdAt, cursor.createdAt, cursor.id, COORDINATOR_LIMITS.hydratePage)
          .all<IntentRow>()
      : await db
          .prepare(`SELECT * FROM intents WHERE repo = ? AND state NOT IN ${ACTIVE_STATES_SQL} ORDER BY created_at ASC, id ASC LIMIT ?`)
          .bind(deps.repo, COORDINATOR_LIMITS.hydratePage)
          .all<IntentRow>();
    for (const r of page.results) {
      const intent = toIntent(r);
      const prev = getIndexed(sql, intent.id);
      if (!prev || prev.footprint_json !== footprintJson(intent) || prev.actual_json !== actualJson(intent)) dirty.push(intent.id);
      indexUpsert(sql, intent, gen, now);
      indexed++;
    }
    const last = page.results[page.results.length - 1];
    if (!last || page.results.length < COORDINATOR_LIMITS.hydratePage) break;
    if (indexed >= COORDINATOR_LIMITS.hydrateMax) {
      truncated = true;
      break;
    }
    cursor = { createdAt: last.created_at, id: last.id };
  }
  let removed = 0;
  if (!truncated) {
    const stale = sql.exec<{ id: string }>("SELECT id FROM fc_intents WHERE gen < ?", gen).toArray();
    for (const s of stale) {
      indexRemove(sql, s.id);
      removed++;
    }
  }
  // Edges persist in DO storage, so only intents that are new or whose
  // footprints changed are recomputed (symmetric: that also fixes the
  // other endpoint). A wiped DO marks everything dirty = full rebuild.
  for (const id of dirty) recomputeEdges(sql, id, now);
  const edges = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_edges").toArray()[0]?.n ?? 0;
  setMeta(sql, "hydrated_ms", String(deps.now()));
  deps.log("info", "coordinator hydrated", { repo: deps.repo, indexed, removed, edges, truncated });
  return { indexed, removed, edges, truncated };
}

export function hydratedAt(sql: SqlStore): number | null {
  const v = getMeta(sql, "hydrated_ms");
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Lease sweep: for local leases past due, re-read D1 (a heartbeat may
// have landed through the D1 fallback), expire via a conditional
// transition when still lapsed, and reconcile the index.
export async function sweepLeases(deps: CoordinatorDeps): Promise<{ expired: string[]; refreshed: number }> {
  const now = deps.now();
  const due = deps.sql
    .exec<{ id: string }>(
      "SELECT id FROM fc_intents WHERE lease_ms IS NOT NULL AND lease_ms <= ? ORDER BY lease_ms ASC LIMIT ?",
      now,
      COORDINATOR_LIMITS.sweepBatch,
    )
    .toArray();
  const expired: string[] = [];
  let refreshed = 0;
  for (const { id } of due) {
    const intent = await getIntent(deps.db, id);
    if (intent && isLeasedState(intent.state)) {
      const leaseMs = isoToMs(intent.leaseExpiresAt);
      if (leaseMs === null || leaseMs <= now) {
        const ok = await transitionIntent(deps.db, id, intent.state, "expired", {}, "flare-coordinator");
        if (ok) {
          expired.push(id);
          bumpCounter(deps.sql, "expired");
        }
      }
    }
    await sync(deps, id);
    // A row still lapsed after sync (e.g. lost race) must not hot-loop.
    const after = getIndexed(deps.sql, id);
    if (after && after.lease_ms !== null && after.lease_ms <= now) {
      deps.sql.exec("UPDATE fc_intents SET lease_ms = NULL WHERE id = ?", id);
    }
    refreshed++;
  }
  return { expired, refreshed };
}

// Single alarm: the earliest lease expiry, or the next rehydrate when
// the index holds active intents. Null = no alarm needed.
export function nextAlarmAt(sql: SqlStore): number | null {
  const lease = sql.exec<{ m: number | null }>("SELECT MIN(lease_ms) AS m FROM fc_intents WHERE lease_ms IS NOT NULL").toArray()[0]?.m ?? null;
  const any = (sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fc_intents").toArray()[0]?.n ?? 0) > 0;
  const h = hydratedAt(sql);
  const rehydrate = any && h !== null ? h + COORDINATOR_LIMITS.rehydrateMs : null;
  if (lease === null) return rehydrate;
  if (rehydrate === null) return lease;
  return Math.min(lease, rehydrate);
}

// ---------------------------------------------------------------------------
// LeaseShard (design stub; docs/FORGE.md "Scaling: LeaseShard")
// ---------------------------------------------------------------------------
//
// When one repo's coordinator runs hot (sustained >~500 req/s or
// >~1M path rows), path rows + leases split across `LeaseShard` DOs
// named `${repo}#${bucket}`. The coordinator stays the router, mailbox
// and feed owner. Not wired yet: the single-DO index is what ships.

export const LEASE_SHARD_BUCKETS_MAX = 64;

// The shard that owns an entry: FNV-1a of the first literal segment of
// its glob base, so a whole top-level directory lands in one bucket and
// subtree range queries never cross shards. Entries with no literal
// base (leading wildcard) must be checked against every shard: "all".
export function shardBucket(entry: string, buckets: number): number | "all" {
  const n = Math.max(1, Math.min(LEASE_SHARD_BUCKETS_MAX, Math.floor(buckets)));
  const base = globBase(entry);
  if (!base) return "all";
  const top = base.split("/")[0];
  let h = 0x811c9dc5;
  for (let i = 0; i < top.length; i++) {
    h ^= top.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % n;
}

// RPC surface a LeaseShard would expose to its coordinator.
export interface LeaseShardApi {
  index(
    intent: { id: string; state: IntentState; leaseMs: number | null },
    entries: { declared: string[]; actual: string[] },
  ): Promise<void>;
  remove(intentId: string): Promise<void>;
  overlaps(entries: string[], excludeId: string | null): Promise<Array<{ intentId: string; pairs: PathPair[]; viaActual: boolean }>>;
  heartbeat(intentId: string, leaseMs: number): Promise<boolean>;
  dueLeases(nowMs: number, limit: number): Promise<string[]>;
}
