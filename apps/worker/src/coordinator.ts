// Flare Forge Durable Objects: `RepoCoordinator` (one per repo, the hot
// overlap index + lease alarm + mailbox fan-out) and `ForgeFeed` (one
// per repo, hibernating WebSockets with ≤10 Hz batched deltas). Kept
// separate so broadcasting never stalls lease traffic.
//
// All logic lives in coordinator-core.ts / feed-core.ts (runtime-free,
// vitest-covered); this file only binds storage, D1, Workers AI and
// alarms. Callers use `coordinatorFor(env, repo)` (typed RPC facade) and
// `handleForgeFeedUpgrade(request, env, repo)` (auth is the caller's
// job). RPC contracts: docs/FORGE.md "Coordinator".
import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "./env";
import type { Intent } from "./intents-core";
import { validateRepo } from "./intents";
import {
  declare as coreDeclare,
  ensureIndexSchema,
  EMBED_MODEL,
  getMeta,
  heartbeat as coreHeartbeat,
  hydrate as coreHydrate,
  hydratedAt,
  nextAlarmAt,
  release as coreRelease,
  reportPush as coreReportPush,
  setMeta,
  similar as coreSimilar,
  snapshot as coreSnapshot,
  sweepLeases,
  sync as coreSync,
  whatsHappening as coreWhatsHappening,
  COORDINATOR_LIMITS,
  type CoordinatorDeps,
  type CoordinatorError,
  type CoordinatorSnapshot,
  type DeclareResult,
  type FeedOp,
  type HappeningResult,
  type HeartbeatResult,
  type ReportPushInput,
  type ReportPushResult,
  type SimilarView,
  type SqlStore,
} from "./coordinator-core";
import {
  coalesceOps,
  deltaFrames,
  FEED_MAX_SOCKETS,
  FEED_PING,
  FEED_PONG,
  FEED_SNAPSHOT_INTENTS,
  flushAt,
  opKey,
  parseClientMessage,
  snapshotFrame,
} from "./feed-core";

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

// After a publish finds no listeners, skip feed calls for this long
// (reset whenever the feed asks for a snapshot, i.e. a client connects).
const FEED_QUIET_MS = 2000;
// Never arm the lease alarm closer than this (no hot loops).
const MIN_ALARM_DELAY_MS = 250;
const REPO_HEADER = "X-Flare-Forge-Repo";

function embedderFor(env: WorkerEnv): ((texts: string[]) => Promise<number[][]>) | null {
  const ai = env.AI;
  if (!ai) return null;
  return async (texts: string[]) => {
    const out: unknown = await ai.run(EMBED_MODEL, { text: texts });
    const data = typeof out === "object" && out !== null ? (out as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) return [];
    return data.filter((row): row is number[] => Array.isArray(row) && row.every((x) => typeof x === "number"));
  };
}

// ---------------------------------------------------------------------------
// RepoCoordinator
// ---------------------------------------------------------------------------

export class RepoCoordinator extends DurableObject<WorkerEnv> {
  private readonly sql: SqlStore;
  // Isolate-scoped caches (not request state): the bound repo name, the
  // first-hydrate promise, and the feed quiet window.
  private repo: string | null = null;
  private hydrating: Promise<unknown> | null = null;
  private feedQuietUntil = 0;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // SQLite storage is synchronous: schema setup needs no concurrency block.
    ensureIndexSchema(this.sql);
    this.repo = getMeta(this.sql, "repo");
  }

  private deps(repo: string): CoordinatorDeps {
    return {
      sql: this.sql,
      db: this.env.DB,
      repo,
      now: () => Date.now(),
      publish: (ops) => this.ctx.waitUntil(this.sendToFeed(repo, ops)),
      embed: embedderFor(this.env),
      log,
    };
  }

  private async sendToFeed(repo: string, ops: FeedOp[]): Promise<void> {
    if (!this.env.FORGE_FEED || Date.now() < this.feedQuietUntil) return;
    try {
      const stub = this.env.FORGE_FEED.get(this.env.FORGE_FEED.idFromName(repo));
      const listeners = await stub.publish(repo, ops);
      if (listeners === 0) this.feedQuietUntil = Date.now() + FEED_QUIET_MS;
    } catch (e) {
      log("warn", "coordinator feed publish failed", { repo, error: String(e) });
    }
  }

  // Bind this instance to its repo on first use and hydrate from D1 when
  // the index has never been built (fresh or wiped storage).
  private async ready(repo: string): Promise<CoordinatorDeps> {
    if (!validateRepo(repo)) throw new Error("invalid repo");
    if (this.repo === null) {
      const stored = getMeta(this.sql, "repo");
      if (stored === null) setMeta(this.sql, "repo", repo);
      this.repo = stored ?? repo;
    }
    if (this.repo !== repo) throw new Error(`coordinator is bound to ${this.repo}`);
    const deps = this.deps(repo);
    if (hydratedAt(this.sql) === null) {
      this.hydrating ??= this.ctx.blockConcurrencyWhile(() => coreHydrate(deps)).finally(() => {
        this.hydrating = null;
      });
      await this.hydrating;
    }
    return deps;
  }

  private async rearm(): Promise<void> {
    const at = nextAlarmAt(this.sql);
    const current = await this.ctx.storage.getAlarm();
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const target = Math.max(at, Date.now() + MIN_ALARM_DELAY_MS);
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }

  async declare(repo: string, intent: Intent): Promise<DeclareResult | CoordinatorError> {
    const out = await coreDeclare(await this.ready(repo), intent);
    await this.rearm();
    return out;
  }

  async sync(repo: string, intentId: string): Promise<string | null> {
    const out = await coreSync(await this.ready(repo), intentId);
    await this.rearm();
    return out;
  }

  async heartbeat(repo: string, intentId: string, agent: string, ttlSeconds?: number): Promise<HeartbeatResult | CoordinatorError> {
    const out = await coreHeartbeat(await this.ready(repo), intentId, agent, ttlSeconds);
    await this.rearm();
    return out;
  }

  async reportPush(repo: string, intentId: string, input: ReportPushInput): Promise<ReportPushResult | CoordinatorError> {
    const out = await coreReportPush(await this.ready(repo), intentId, input);
    await this.rearm();
    return out;
  }

  async release(repo: string, intentId: string): Promise<boolean> {
    const out = coreRelease(await this.ready(repo), intentId);
    await this.rearm();
    return out;
  }

  async similar(repo: string, goalText: string, limit?: number): Promise<SimilarView[]> {
    return coreSimilar(await this.ready(repo), goalText, limit);
  }

  // `forFeed` re-opens the feed quiet window (a client just connected).
  async snapshot(repo: string, opts: { maxIntents?: number; forFeed?: boolean } = {}): Promise<CoordinatorSnapshot> {
    const deps = await this.ready(repo);
    if (opts.forFeed) this.feedQuietUntil = 0;
    return coreSnapshot(deps, opts.maxIntents);
  }

  async whatsHappening(repo: string, paths?: string[]): Promise<HappeningResult> {
    return coreWhatsHappening(await this.ready(repo), paths);
  }

  // Force a rebuild from D1 (operator / reconcile tool).
  async hydrate(repo: string): Promise<{ indexed: number; removed: number; edges: number; truncated: boolean }> {
    const out = await coreHydrate(await this.ready(repo));
    await this.rearm();
    return out;
  }

  async alarm(): Promise<void> {
    const repo = this.repo ?? getMeta(this.sql, "repo");
    if (!repo) return;
    try {
      const deps = await this.ready(repo);
      const swept = await sweepLeases(deps);
      if (swept.expired.length) log("info", "coordinator leases expired", { repo, expired: swept.expired.length });
      const h = hydratedAt(this.sql);
      if (h === null || Date.now() - h >= COORDINATOR_LIMITS.rehydrateMs) await coreHydrate(deps);
    } catch (e) {
      log("error", "coordinator alarm failed", { repo, error: String(e) });
    }
    await this.rearm();
  }
}

// ---------------------------------------------------------------------------
// ForgeFeed
// ---------------------------------------------------------------------------

type PendingRow = { k: string; ver: number; op_json: string };

export class ForgeFeed extends DurableObject<WorkerEnv> {
  private readonly sql: SqlStore;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(FEED_PING, FEED_PONG));
    this.sql.exec("CREATE TABLE IF NOT EXISTS fd_pending (k TEXT PRIMARY KEY, ver INTEGER NOT NULL, op_json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS fd_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  private meta(key: string): number | null {
    const rows = this.sql.exec<{ v: string }>("SELECT v FROM fd_meta WHERE k = ?", key).toArray();
    const n = rows.length ? Number(rows[0].v) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  private setMetaValue(key: string, value: string): void {
    this.sql.exec("INSERT INTO fd_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }

  private nextSeq(): number {
    const seq = (this.meta("seq") ?? 0) + 1;
    this.setMetaValue("seq", String(seq));
    return seq;
  }

  private repoName(): string | null {
    const rows = this.sql.exec<{ v: string }>("SELECT v FROM fd_meta WHERE k = 'repo'").toArray();
    return rows.length ? rows[0].v : null;
  }

  private async sendSnapshot(ws: WebSocket, repo: string): Promise<void> {
    try {
      const snap = await coordinatorFor(this.env, repo).snapshot({ maxIntents: FEED_SNAPSHOT_INTENTS, forFeed: true });
      ws.send(snapshotFrame(snap, this.nextSeq()));
    } catch (e) {
      log("warn", "feed snapshot failed", { repo, error: String(e) });
      ws.send(JSON.stringify({ v: 1, type: "error", code: "snapshot_failed", message: "snapshot unavailable; retry with resync" }));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const repo = request.headers.get(REPO_HEADER) ?? "";
    if (!validateRepo(repo)) return new Response("invalid repo", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= FEED_MAX_SOCKETS) return new Response("feed full", { status: 503 });
    this.setMetaValue("repo", repo);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [repo]);
    await this.sendSnapshot(server, repo);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Coordinator -> feed. Returns the listener count (0 lets the
  // coordinator stop calling for a while). Ops coalesce per (kind, id).
  async publish(repo: string, ops: FeedOp[]): Promise<number> {
    const listeners = this.ctx.getWebSockets().length;
    if (listeners === 0 || !ops.length) return listeners;
    const keys = [...new Set(ops.map(opKey))];
    const pending = new Map<string, FeedOp>();
    for (const key of keys) {
      const row = this.sql.exec<PendingRow>("SELECT * FROM fd_pending WHERE k = ?", key).toArray()[0];
      if (row) pending.set(key, JSON.parse(row.op_json) as FeedOp);
    }
    coalesceOps(pending, ops);
    for (const [k, op] of pending) {
      this.sql.exec(
        "INSERT INTO fd_pending (k, ver, op_json) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET ver = excluded.ver, op_json = excluded.op_json",
        k,
        op.ver,
        JSON.stringify(op),
      );
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(flushAt(this.meta("last_flush_ms"), Date.now()));
    }
    if (!this.repoName()) this.setMetaValue("repo", repo);
    return listeners;
  }

  async alarm(): Promise<void> {
    const rows = this.sql.exec<PendingRow>("SELECT * FROM fd_pending ORDER BY ver ASC").toArray();
    this.sql.exec("DELETE FROM fd_pending");
    this.setMetaValue("last_flush_ms", String(Date.now()));
    const sockets = this.ctx.getWebSockets();
    if (!rows.length || !sockets.length) return;
    const ops = rows.map((r) => JSON.parse(r.op_json) as FeedOp);
    const { frames, seq } = deltaFrames(ops, this.meta("seq") ?? 0);
    this.setMetaValue("seq", String(seq));
    const texts = frames.map((f) => JSON.stringify(f));
    for (const ws of sockets) {
      for (const text of texts) {
        try {
          ws.send(text);
        } catch {
          // A dead socket is reaped by webSocketClose/webSocketError.
        }
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const msg = parseClientMessage(message);
    if (msg?.type === "resync") {
      const repo = this.repoName();
      if (repo) await this.sendSnapshot(ws, repo);
    } else if (msg?.type === "ping") {
      ws.send(FEED_PONG);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log("warn", "feed socket error", { error: String(error) });
    try {
      ws.close(1011, "error");
    } catch {
      // Already closed.
    }
  }
}

// ---------------------------------------------------------------------------
// Worker-side helpers (stream B mounts these behind its auth)
// ---------------------------------------------------------------------------

export interface CoordinatorEnv {
  COORDINATOR: DurableObjectNamespace<RepoCoordinator>;
}

// Typed RPC facade for one repo's coordinator (repo pre-bound).
export function coordinatorFor(env: CoordinatorEnv, repo: string) {
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(repo));
  return {
    declare: (intent: Intent) => stub.declare(repo, intent),
    sync: (intentId: string) => stub.sync(repo, intentId),
    heartbeat: (intentId: string, agent: string, ttlSeconds?: number) => stub.heartbeat(repo, intentId, agent, ttlSeconds),
    reportPush: (intentId: string, input: ReportPushInput) => stub.reportPush(repo, intentId, input),
    release: (intentId: string) => stub.release(repo, intentId),
    similar: (goalText: string, limit?: number) => stub.similar(repo, goalText, limit),
    snapshot: (opts?: { maxIntents?: number; forFeed?: boolean }) => stub.snapshot(repo, opts),
    whatsHappening: (paths?: string[]) => stub.whatsHappening(repo, paths),
    hydrate: () => stub.hydrate(repo),
  };
}

export type CoordinatorClient = ReturnType<typeof coordinatorFor>;

// GET /v1/forge/feed?repo= upgrade: validates the repo and the Upgrade
// header, then hands the socket to the repo's ForgeFeed DO. The caller
// authenticates and authorizes `repo` first.
export async function handleForgeFeedUpgrade(
  request: Request,
  env: { FORGE_FEED: DurableObjectNamespace<ForgeFeed> },
  repo: string,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response(JSON.stringify({ error: "expected websocket upgrade", code: "upgrade_required" }), {
      status: 426,
      headers: { "Content-Type": "application/json", Upgrade: "websocket" },
    });
  }
  if (!validateRepo(repo)) {
    return new Response(JSON.stringify({ error: "invalid repo", code: "invalid_repo" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const headers = new Headers(request.headers);
  headers.set(REPO_HEADER, repo);
  const stub = env.FORGE_FEED.get(env.FORGE_FEED.idFromName(repo));
  return stub.fetch(new Request(request.url, { method: "GET", headers }));
}
