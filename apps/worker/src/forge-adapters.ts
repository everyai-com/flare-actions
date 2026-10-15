// Flare Forge integration adapters: the real implementations behind the
// forge-ports.ts interfaces, wired by `forgeDepsFromEnv` whenever the
// bindings exist.
//
// - `doCoordinatorPort`: the per-repo RepoCoordinator DO over RPC
//   (`coordinatorFor`). Any missing binding, RPC throw or coordinator
//   error degrades that one call to the D1 fallback with a structured
//   log line; D1 stays the source of truth either way.
// - `whyPort`: exact provenance via why.ts (blame + notes), degrading to
//   the D1 footprint answer when the line cannot be traced.
// - `feedPort`: the hibernating ForgeFeed WebSocket.
// - `trainPort`: train.ts (enqueue/route/cut, detail, landing approval,
//   conflict claim/resolve through the replay stream).
// - `forgePlanner`: the Workers AI goal planner (forge-planner.ts).
//
// `forgeAdaptersFromEnv` assembles all of them for index.ts (REST + MCP).
//
// The `*Over` constructors take injected clients so vitest drives the
// mapping without a runtime (the `cloudflare:workers` import in
// coordinator.ts / train-workflow.ts is aliased to a stub there).
import { coordinatorFor, handleForgeFeedUpgrade } from "./coordinator";
import type { CoordinatorError, CoordinatorSnapshot, DeclareResult, HappeningResult, OverlapView, ReportPushResult, SimilarView } from "./coordinator-core";
import { getSetting, type Db } from "./db";
import type { WorkerEnv } from "./env";
import {
  buildSnapshot,
  d1Coordinator,
  d1Why,
  d1Trains,
  type ConflictClaimOutcome,
  type ConflictResolveOutcome,
  type FeedPort,
  type ForgeCoordinatorPort,
  type LiveIntent,
  type OverlapHit,
  type SimilarHit,
  type TrainPort,
  type WhyAnswer,
  type WhyLink,
  type WhyPort,
} from "./forge-ports";
import { aiGoalPlanner, type GoalPlanner } from "./forge-planner";
import { getIntent, getTrain as getTrainD1 } from "./intents";
import { driftPaths, type Intent, type RiskTerm } from "./intents-core";
import { forkTrunk, replayForkName, type ReplayDeps } from "./replay";
import { approveLanding, claimConflictFor, enqueueReady, getTrainDetail, isForgeError, listTrains, resolveConflictFor } from "./train";
import { trainDepsFromEnv } from "./train-workflow";
import { SETTING_KEYS } from "./settings";
import { why as whyChain, type WhyChain, type WhyDeps } from "./why";

function log(level: "info" | "warn", msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 200);
}

export type WaitUntil = (p: Promise<unknown>) => void;

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

// The RPC surface the adapter uses (a subset of `coordinatorFor`).
export interface CoordinatorRpc {
  declare(intent: Intent): Promise<DeclareResult | CoordinatorError>;
  sync(intentId: string): Promise<string | null>;
  indexPush(intent: Intent, input: { drift: string[]; risk: number; riskTerms: RiskTerm[] }): Promise<ReportPushResult | CoordinatorError>;
  release(intentId: string): Promise<boolean>;
  snapshot(opts?: { maxIntents?: number; forFeed?: boolean }): Promise<CoordinatorSnapshot>;
  whatsHappening(paths?: string[]): Promise<HappeningResult>;
}

function isCoordinatorError(v: unknown): v is CoordinatorError {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

export function overlapHit(v: OverlapView): OverlapHit {
  return {
    intentId: v.intentId,
    title: v.title,
    agent: v.agent,
    state: v.state,
    reasoning: v.reasoning,
    paths: v.pairs.map((p) => [p.mine, p.theirs] as [string, string]),
    leaseExpiresAt: null,
  };
}

export function similarHit(v: SimilarView): SimilarHit {
  return { intentId: v.intentId, title: v.title, state: v.state, score: Math.round(v.score * 100) / 100 };
}

function liveFromItem(item: HappeningResult["items"][number]): LiveIntent {
  return {
    intentId: item.intentId,
    goalId: item.goalId ?? null,
    title: item.title,
    agent: item.agent,
    state: item.state,
    reasoning: item.reasoning,
    footprint: item.paths,
    actualFootprint: item.actual,
    headSha: item.headSha,
    risk: item.risk,
    leaseExpiresAt: item.leaseExpiresAt,
    updatedAt: item.updatedAt ?? "",
    matchedPaths: [...new Set(item.matched.map((m) => m.mine))],
  };
}

// A hot-index row as the minimal Intent the Live-map builder reads.
function intentFromLive(repo: string, l: CoordinatorSnapshot["intents"][number]): Intent {
  return {
    id: l.id,
    goalId: l.goalId,
    repo,
    agent: l.agent,
    title: l.title,
    reasoning: "",
    accept: "",
    footprint: { paths: l.paths },
    actualFootprint: l.actual ? { paths: l.actual } : null,
    forkRepo: l.forkRepo,
    state: l.state,
    risk: l.risk,
    riskTerms: [],
    baseSha: "",
    headSha: l.headSha,
    trainId: null,
    landedSha: null,
    planApprovedBy: null,
    leaseExpiresAt: l.leaseExpiresAt,
    createdAt: "",
    updatedAt: "",
  };
}

async function count(db: Db, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return typeof row?.n === "number" ? row.n : 0;
}

export function coordinatorPortOver(input: {
  db: Db;
  client: ((repo: string) => CoordinatorRpc) | null;
  fallback?: ForgeCoordinatorPort;
  waitUntil?: WaitUntil;
}): ForgeCoordinatorPort {
  const fallback = input.fallback ?? d1Coordinator(input.db);
  const clientFor = input.client;
  if (!clientFor) return fallback;
  // One call through the DO; any throw or coordinator error degrades
  // this call (only) to D1.
  async function via<T>(op: string, repo: string, run: (c: CoordinatorRpc) => Promise<T | null>, degrade: () => Promise<T>): Promise<T> {
    try {
      const out = await run(clientFor!(repo));
      if (out !== null) return out;
    } catch (err) {
      log("warn", "forge coordinator degraded to d1", { op, repo, error: errText(err) });
    }
    return degrade();
  }
  const sync = async (repo: string, intentId: string): Promise<void> => {
    try {
      await clientFor(repo).sync(intentId);
    } catch (err) {
      log("warn", "forge coordinator sync failed", { repo, intent: intentId, error: errText(err) });
    }
  };
  return {
    kind: "coordinator",
    declare: (repo, intent) =>
      via(
        "declare",
        repo,
        async (c) => {
          const out = await c.declare(intent);
          if (isCoordinatorError(out)) {
            log("warn", "forge coordinator declare error", { repo, intent: intent.id, error: out.error });
            return null;
          }
          return { overlaps: out.overlaps.map(overlapHit), similar: out.similar.map(similarHit) };
        },
        () => fallback.declare(repo, intent),
      ),
    // Leases are D1 conditional writes (the DO's own heartbeat drains the
    // inbox, which the service delivers itself); mirror into the index.
    async heartbeat(repo, intentId, agent, ttlSeconds) {
      const lease = await fallback.heartbeat(repo, intentId, agent, ttlSeconds);
      if (lease) {
        if (input.waitUntil) input.waitUntil(sync(repo, intentId));
        else await sync(repo, intentId);
      }
      return lease;
    },
    reportPush: (repo, intent) =>
      via(
        "reportPush",
        repo,
        async (c) => {
          const drift = intent.actualFootprint ? driftPaths(intent.footprint, intent.actualFootprint) : [];
          const out = await c.indexPush(intent, { drift, risk: intent.risk, riskTerms: intent.riskTerms });
          if (isCoordinatorError(out)) {
            log("warn", "forge coordinator push error", { repo, intent: intent.id, error: out.error });
            return null;
          }
          return { overlaps: out.overlaps.map(overlapHit) };
        },
        () => fallback.reportPush(repo, intent),
      ),
    whatsHappening: (repo, opts) =>
      via(
        "whatsHappening",
        repo,
        async (c) => {
          const out = await c.whatsHappening(opts.paths && opts.paths.length ? opts.paths : undefined);
          const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
          return out.items.filter((x) => x.intentId !== opts.excludeIntent).slice(0, limit).map(liveFromItem);
        },
        () => fallback.whatsHappening(repo, opts),
      ),
    snapshot: (repo, opts) =>
      via(
        "snapshot",
        repo,
        async (c) => {
          const snap = await c.snapshot();
          const now = new Date().toISOString();
          const today = `${now.slice(0, 10)}T00:00:00.000Z`;
          const [conflictsOpen, landedToday] = await Promise.all([
            count(input.db, "SELECT COUNT(*) AS n FROM conflicts WHERE repo = ? AND state IN ('open', 'claimed')", repo),
            count(input.db, "SELECT COUNT(*) AS n FROM intents WHERE repo = ? AND state = 'landed' AND updated_at >= ?", repo, today),
          ]);
          return buildSnapshot({
            repo,
            intents: snap.intents.map((l) => intentFromLive(repo, l)),
            policy: opts.policy,
            trains: opts.trains,
            head: opts.head,
            conflictsOpen,
            landedToday,
            overlapsCaught: snap.counters.overlapsCaught,
            source: "coordinator",
            now,
            edges: snap.edges.map((e) => ({ id: e.id, a: e.a, b: e.b, pairs: e.pairs, origin: e.origin })),
            ver: snap.ver,
          });
        },
        () => fallback.snapshot(repo, opts),
      ),
    async release(repo, intentId) {
      try {
        await clientFor(repo).release(intentId);
      } catch (err) {
        log("warn", "forge coordinator release failed", { repo, intent: intentId, error: errText(err) });
      }
    },
    sync,
  };
}

export function doCoordinatorPort(env: WorkerEnv, opts: { waitUntil?: WaitUntil } = {}): ForgeCoordinatorPort {
  const ns = env.COORDINATOR ?? null;
  return coordinatorPortOver({
    db: env.DB,
    client: ns ? (repo) => coordinatorFor({ COORDINATOR: ns }, repo) : null,
    waitUntil: opts.waitUntil,
  });
}

// ---------------------------------------------------------------------------
// Why
// ---------------------------------------------------------------------------

export function whyLinks(c: WhyChain): WhyLink[] {
  const links: WhyLink[] = [{ kind: "line", id: `${c.path}:${c.line}`, text: c.commit?.lineText ?? c.path, links: {} }];
  if (c.commit) {
    links.push({
      kind: "commit",
      id: c.commit.sha,
      text: c.commit.subject,
      links: c.commit.landedVia ? { landedVia: c.commit.landedVia } : {},
    });
  }
  if (c.intent) links.push({ kind: "intent", id: c.intent.id, text: c.intent.title, links: { self: `/v1/forge/intents/${c.intent.id}` } });
  if (c.goal) links.push({ kind: "goal", id: c.goal.id, text: c.goal.text.slice(0, 500), links: { self: `/v1/forge/goals/${c.goal.id}` } });
  if (c.intent?.reasoning) links.push({ kind: "reason", id: c.intent.id, text: c.intent.reasoning.slice(0, 1000), links: {} });
  for (const d of c.decisions.slice(0, 5)) links.push({ kind: "reason", id: d.kind, text: d.body.slice(0, 500), links: {} });
  for (const a of c.alternatives.slice(0, 5)) links.push({ kind: "rejected", id: a.source, text: a.text.slice(0, 500), links: {} });
  if (c.evidence) {
    links.push({ kind: "evidence", id: c.evidence.runId, text: `run ${c.evidence.status} on ${c.evidence.sha.slice(0, 12)}`, links: { self: `/v1/runs/${c.evidence.runId}` } });
  }
  if (c.train) links.push({ kind: "evidence", id: c.train.id, text: `train ${c.train.state} (lane ${c.train.lane})`, links: { self: `/v1/forge/trains/${c.train.id}` } });
  if (c.session) links.push({ kind: "session", id: c.session.repo, text: `${c.session.repo} (${c.session.branch})`, links: {} });
  return links;
}

export function whyPortOver(input: {
  db: Db;
  chain: ((repo: string, path: string, line: number) => Promise<WhyChain>) | null;
  fallback?: WhyPort;
}): WhyPort {
  const fallback = input.fallback ?? d1Why(input.db);
  const chainFor = input.chain;
  if (!chainFor) return fallback;
  return {
    kind: "notes",
    async why(repo, path, line): Promise<WhyAnswer> {
      if (line === null) return fallback.why(repo, path, line);
      let chain: WhyChain;
      try {
        chain = await chainFor(repo, path, line);
      } catch (err) {
        log("warn", "forge why degraded to d1", { repo, error: errText(err) });
        return fallback.why(repo, path, line);
      }
      // No exact answer (ref/path not found, binary, out of range,
      // Artifacts down): the footprint fallback, with the reason.
      if (chain.error) {
        const out = await fallback.why(repo, path, line);
        return { ...out, warnings: [`blame: ${chain.error.code}: ${chain.error.message}`] };
      }
      return {
        repo,
        path,
        line,
        exact: true,
        source: chain.noteSource,
        chain: whyLinks(chain),
        narrative: chain.narrative,
        origin: chain.origin,
        warnings: chain.warnings,
      };
    },
  };
}

export function whyPort(env: WorkerEnv): WhyPort {
  const artifacts = env.ARTIFACTS ?? null;
  const deps: WhyDeps | null = artifacts ? { db: env.DB, artifacts } : null;
  return whyPortOver({ db: env.DB, chain: deps ? (repo, path, line) => whyChain(deps, { repo, path, line }) : null });
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export function feedPort(env: WorkerEnv): FeedPort | null {
  const ns = env.FORGE_FEED ?? null;
  if (!ns) return null;
  return { upgrade: (request, repo) => handleForgeFeedUpgrade(request, { FORGE_FEED: ns }, repo) };
}

// ---------------------------------------------------------------------------
// Trains
// ---------------------------------------------------------------------------

export function trainPortOver(deps: ReplayDeps): TrainPort {
  const d1 = d1Trains(deps.db);
  return {
    kind: "trains",
    async markReady(repo, intent, policy) {
      const res = await enqueueReady(deps, intent.id);
      if (isForgeError(res)) {
        log("warn", "forge enqueue failed", { repo, intent: intent.id, error: res.error });
        return d1.markReady(repo, intent, policy);
      }
      const cut = res.cut;
      let trainId: string | null = null;
      if (cut?.status === "cut") {
        const lane = cut.lanes.findIndex((l) => l.includes(intent.id));
        trainId = lane >= 0 ? (cut.trainIds[lane] ?? null) : null;
      }
      const note = res.held
        ? `held: route human (risk ${res.risk} > ${policy.autoLandMaxRisk}); a human approves the landing (POST /v1/forge/intents/${intent.id}/approve-landing), then it rides the next train`
        : trainId
          ? `cut into train ${trainId}; lands when CI verifies the lane's exact SHA`
          : `queued for the next train (${cut?.status ?? "cut deferred"})`;
      return { queued: !res.held, route: res.route, trainId, position: null, note, held: res.held };
    },
    listTrains: (repo, opts) => listTrains(deps, repo, opts),
    getTrain: (id) => getTrainD1(deps.db, id),
    async getTrainDetail(id) {
      const detail = await getTrainDetail(deps, id);
      return detail ? { ...detail } : null;
    },
    async approveLanding(intentId, approvedBy) {
      const ok = await approveLanding(deps, intentId, approvedBy);
      // Approved intents ride from now on: try to cut right away.
      if (ok) await enqueueReady(deps, intentId).catch(() => null);
      return ok;
    },
    async claimConflict(conflictId, agent): Promise<ConflictClaimOutcome | { error: string; message: string }> {
      const res = await claimConflictFor(deps, conflictId, agent);
      if (isForgeError(res)) return res;
      const name = replayForkName(conflictId, res.conflict.attempts);
      const forked = await forkTrunk(deps, res.conflict.repo, name).catch(() => false);
      return { conflict: res.conflict, intent: res.intent, replayFork: forked ? name : null };
    },
    async resolveConflict(conflictId, agent, sha, opts): Promise<ConflictResolveOutcome | { error: string; message: string }> {
      const res = await resolveConflictFor(deps, conflictId, agent, sha, { forkRepo: opts.forkRepo });
      if (isForgeError(res)) return res;
      const enq = res.enqueue;
      const enqueue = isForgeError(enq)
        ? null
        : { route: enq.route, held: enq.held, risk: enq.risk, trainIds: enq.cut && (enq.cut.status === "cut" || enq.cut.status === "busy") ? enq.cut.trainIds : [] };
      const intent = await getIntent(deps.db, res.conflict.intentA);
      return {
        conflict: res.conflict,
        intent,
        enqueue,
        note: isForgeError(enq) ? `replay recorded; enqueue failed (${enq.message})` : "the replay re-entered ready and lands only through a CI-verified train (invariant 4)",
      };
    },
  };
}

export function trainPort(env: WorkerEnv): TrainPort {
  return trainPortOver(trainDepsFromEnv(env));
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function forgePlanner(env: WorkerEnv): GoalPlanner | null {
  return aiGoalPlanner({
    ai: env.AI ?? null,
    artifacts: env.ARTIFACTS ?? null,
    gatewayId: async () => env.AI_GATEWAY_ID ?? (await getSetting(env.DB, SETTING_KEYS.aiGatewayId)) ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface ForgeAdapterSet {
  coordinator: ForgeCoordinatorPort;
  why: WhyPort;
  trains?: TrainPort;
  feed: FeedPort | null;
  planner: GoalPlanner | null;
  waitUntil: WaitUntil | null;
}

// Every adapter whose binding exists; the rest stay on the D1 fallbacks
// forgeServiceDeps fills in. Trains need Artifacts (forks, replay), so a
// deployment without it keeps the D1 train queue.
export function forgeAdaptersFromEnv(env: WorkerEnv, opts: { waitUntil?: WaitUntil } = {}): ForgeAdapterSet {
  return {
    coordinator: doCoordinatorPort(env, opts),
    why: whyPort(env),
    ...(env.ARTIFACTS ? { trains: trainPort(env) } : {}),
    feed: feedPort(env),
    planner: forgePlanner(env),
    waitUntil: opts.waitUntil ?? null,
  };
}
