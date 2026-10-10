// REST surface for Flare Forge: `/v1/forge/*`, one contiguous router
// called from index.ts with a single line. Each route authenticates
// (read for GETs, run for writes; plan approval needs admin), maps
// path/query/body onto the shared operation in forge-service.ts, and
// serializes `{ ...data }` or `{ error, code, hint }`. Route literals and
// regexes follow index.ts conventions so scripts/check-openapi.mjs sees
// them. Runtime-free: tests call handleForgeRequest with fakes.
import { apiError } from "./errors";
import type { WorkerEnv } from "./env";
import type { ForgeArtifacts } from "./intents";
import {
  abandonOp,
  approveLandingOp,
  approvePlanOp,
  claimConflictOp,
  claimOp,
  declareOp,
  forgeServiceDeps,
  forkSessionOp,
  getConflictOp,
  getGoalOp,
  getIntentOp,
  getTrainOp,
  heartbeatOp,
  listConflictsOp,
  listGoalsOp,
  listIntentsOp,
  listTrainsOp,
  markReadyOp,
  planGoal,
  readInboxOp,
  reportPushOp,
  resolveConflictOp,
  sendNoteOp,
  sessionOp,
  snapshotOp,
  storyInboxOp,
  whatsHappeningOp,
  whyOp,
  type ForgeArgs,
  type ForgeOp,
  type ForgeOutcome,
  type ForgePrincipal,
  type ForgeServiceDeps,
} from "./forge-service";
import type { FeedPort, ForgeCoordinatorPort, TrainPort, WhyPort } from "./forge-ports";
import type { GoalPlanner } from "./forge-planner";

export interface ForgeIdentity {
  scope: string; // admin | runner | readonly
  actor: string;
  repos: string[];
}

// Integration seam: stream A/C/D adapters plug in here (unset = D1).
// index.ts passes forgeAdaptersFromEnv(env, { waitUntil }) (forge-adapters.ts).
export interface ForgeAdapters {
  coordinator?: ForgeCoordinatorPort;
  why?: WhyPort;
  trains?: TrainPort;
  feed?: FeedPort | null;
  planner?: GoalPlanner | null;
  // Request context: background coordinator index syncs ride it.
  waitUntil?: ((p: Promise<unknown>) => void) | null;
}

export function forgeDepsFromEnv(env: WorkerEnv, adapters: ForgeAdapters = {}): ForgeServiceDeps {
  const artifacts: ForgeArtifacts | null = env.ARTIFACTS ?? null;
  return forgeServiceDeps({
    db: env.DB,
    artifacts,
    namespace: env.ARTIFACTS_NAMESPACE ?? "",
    accountId: env.ARTIFACTS_ACCOUNT_ID ?? "",
    ...adapters,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function respond(out: ForgeOutcome): Response {
  return out.ok ? json(out.data, out.status) : json(out.body, out.status);
}

function principalOf(ident: ForgeIdentity, request: Request): ForgePrincipal {
  return {
    actor: ident.actor,
    repos: ident.repos,
    isAdmin: ident.scope === "admin",
    canWrite: ident.scope === "admin" || ident.scope === "runner",
    agent: request.headers.get("X-Flare-Agent") ?? undefined,
  };
}

function queryArgs(url: URL): ForgeArgs {
  const out: ForgeArgs = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

async function bodyArgs(request: Request): Promise<ForgeArgs> {
  const body: unknown = await request.json().catch(() => ({}));
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as ForgeArgs) : {};
}

const UNAUTHORIZED_HINT = "pass a token: Authorization: Bearer <token> (readonly reads the forge; runner/admin also writes)";

// Returns null for paths outside /v1/forge so index.ts falls through.
export async function handleForgeRequest(
  request: Request,
  url: URL,
  deps: ForgeServiceDeps,
  auth: () => Promise<ForgeIdentity | null>,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/forge/")) return null;
  const method = request.method;
  const ident = await auth();
  if (!ident) return json(apiError("unauthorized", "unauthorized", UNAUTHORIZED_HINT), 401);
  const p = principalOf(ident, request);
  const read = (op: ForgeOp, extra: ForgeArgs = {}): Promise<Response> => op(deps, p, { ...queryArgs(url), ...extra }).then(respond);
  const write = async (op: ForgeOp, extra: ForgeArgs = {}): Promise<Response> =>
    respond(await op(deps, p, { ...(await bodyArgs(request)), ...extra }));

  // --- goals ---------------------------------------------------------------
  if (method === "POST" && url.pathname === "/v1/forge/goals") {
    // `?plan=1` (or body `plan: true`) asks for the AI planner's split.
    const plan = url.searchParams.get("plan");
    return write(planGoal, plan !== null ? { plan } : {});
  }
  if (method === "GET" && url.pathname === "/v1/forge/goals") return read(listGoalsOp);
  const goalMatch = /^\/v1\/forge\/goals\/([^/]+)$/.exec(url.pathname);
  if (goalMatch && method === "GET") return read(getGoalOp, { goalId: goalMatch[1] });

  // --- intents -------------------------------------------------------------
  if (method === "POST" && url.pathname === "/v1/forge/intents") return write(declareOp);
  if (method === "GET" && url.pathname === "/v1/forge/intents") return read(listIntentsOp);
  const intentMatch = /^\/v1\/forge\/intents\/([^/]+)$/.exec(url.pathname);
  if (intentMatch && method === "GET") return read(getIntentOp, { intentId: intentMatch[1] });
  const claimMatch = /^\/v1\/forge\/intents\/([^/]+)\/claim$/.exec(url.pathname);
  if (claimMatch && method === "POST") return write(claimOp, { intentId: claimMatch[1] });
  const heartbeatMatch = /^\/v1\/forge\/intents\/([^/]+)\/heartbeat$/.exec(url.pathname);
  if (heartbeatMatch && method === "POST") return write(heartbeatOp, { intentId: heartbeatMatch[1] });
  const pushMatch = /^\/v1\/forge\/intents\/([^/]+)\/push$/.exec(url.pathname);
  if (pushMatch && method === "POST") return write(reportPushOp, { intentId: pushMatch[1] });
  const readyMatch = /^\/v1\/forge\/intents\/([^/]+)\/ready$/.exec(url.pathname);
  if (readyMatch && method === "POST") return write(markReadyOp, { intentId: readyMatch[1] });
  const approveMatch = /^\/v1\/forge\/intents\/([^/]+)\/approve-plan$/.exec(url.pathname);
  if (approveMatch && method === "POST") return write(approvePlanOp, { intentId: approveMatch[1] });
  const approveLandingMatch = /^\/v1\/forge\/intents\/([^/]+)\/approve-landing$/.exec(url.pathname);
  if (approveLandingMatch && method === "POST") return write(approveLandingOp, { intentId: approveLandingMatch[1] });
  const sessionMatch = /^\/v1\/forge\/intents\/([^/]+)\/session$/.exec(url.pathname);
  if (sessionMatch && method === "GET") return read(sessionOp, { intentId: sessionMatch[1] });
  const abandonMatch = /^\/v1\/forge\/intents\/([^/]+)\/abandon$/.exec(url.pathname);
  if (abandonMatch && method === "POST") return write(abandonOp, { intentId: abandonMatch[1] });
  const forkMatch = /^\/v1\/forge\/intents\/([^/]+)\/fork-session$/.exec(url.pathname);
  if (forkMatch && method === "POST") return write(forkSessionOp, { intentId: forkMatch[1] });
  const messagesMatch = /^\/v1\/forge\/intents\/([^/]+)\/messages$/.exec(url.pathname);
  if (messagesMatch && method === "POST") return write(sendNoteOp, { toIntent: messagesMatch[1] });
  if (messagesMatch && method === "GET") return read(readInboxOp, { intentId: messagesMatch[1] });

  // --- coordination reads ---------------------------------------------------
  if (method === "GET" && url.pathname === "/v1/forge/whats-happening") return read(whatsHappeningOp);
  if (method === "GET" && url.pathname === "/v1/forge/inbox") return read(storyInboxOp);
  if (method === "GET" && url.pathname === "/v1/forge/snapshot") return read(snapshotOp);
  // FORGE-UX §10 names the Live map endpoint `live`; same payload.
  if (method === "GET" && url.pathname === "/v1/forge/live") return read(snapshotOp);
  if (method === "GET" && url.pathname === "/v1/forge/why") return read(whyOp);

  // --- conflicts -------------------------------------------------------------
  if (method === "GET" && url.pathname === "/v1/forge/conflicts") return read(listConflictsOp);
  const conflictMatch = /^\/v1\/forge\/conflicts\/([^/]+)$/.exec(url.pathname);
  if (conflictMatch && method === "GET") return read(getConflictOp, { conflictId: conflictMatch[1] });
  const conflictClaimMatch = /^\/v1\/forge\/conflicts\/([^/]+)\/claim$/.exec(url.pathname);
  if (conflictClaimMatch && method === "POST") return write(claimConflictOp, { conflictId: conflictClaimMatch[1] });
  const conflictResolveMatch = /^\/v1\/forge\/conflicts\/([^/]+)\/resolve$/.exec(url.pathname);
  if (conflictResolveMatch && method === "POST") return write(resolveConflictOp, { conflictId: conflictResolveMatch[1] });

  // --- trains ------------------------------------------------------------------
  if (method === "GET" && url.pathname === "/v1/forge/trains") return read(listTrainsOp);
  const trainMatch = /^\/v1\/forge\/trains\/([^/]+)$/.exec(url.pathname);
  if (trainMatch && method === "GET") return read(getTrainOp, { trainId: trainMatch[1] });

  // --- live feed (WebSocket; Coordinator stream) -----------------------------
  if (method === "GET" && url.pathname === "/v1/forge/feed") {
    const repo = url.searchParams.get("repo") ?? "";
    // Scope check via the snapshot op's repo validation (no data read).
    const scoped = await listGoalsOp(deps, p, { repo, limit: 1 });
    if (!scoped.ok) return respond(scoped);
    if (!deps.feed) {
      return json(
        apiError("not_implemented", "live feed not wired on this deployment", `poll GET /v1/forge/snapshot?repo=${encodeURIComponent(repo)} every 2s (same payload)`),
        501,
      );
    }
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json(apiError("invalid_request", "expected a WebSocket upgrade", "connect with Upgrade: websocket, or poll GET /v1/forge/snapshot"), 426);
    }
    return deps.feed.upgrade(request, repo);
  }

  return json(apiError("forge_not_found", `no forge route ${method} ${url.pathname}`, "see GET /openapi.yaml (tag Forge) or /llms.txt for the forge endpoints"), 404);
}
