// Train executor: cut -> build (merge in MemoryFS) -> push lane refs ->
// dispatch Flare CI on each exact lane SHA -> land the green prefix on
// main (non-force, CAS) or bisect the first red lane -> why notes ->
// revoke fork tokens. docs/COMPETITION-PLAN.md §3-4, docs/FORGE.md.
//
// The Coordinator/Workflow decides *when*; this module does the work.
// Every function here is an idempotent, resumable step over D1 state:
// trains move only through conditional transitions, commits are
// byte-deterministic (timestamps come from the train row), and a retry
// after a crash re-derives the same SHAs. All I/O is injected (git, fs,
// http, artifacts, dispatch, notes), so the whole flow runs in node
// tests against real git repos — no `cloudflare:workers` import here
// (train-workflow.ts holds the runtime wiring).
//
// Invariants (§3.2) enforced here:
//   1. Agents never hold trunk tokens: trunk tokens are minted per push,
//      held in memory for one step, and never returned or stored; fork
//      tokens are revoked once their intent lands.
//   2. main moves only to a lane head whose CI run succeeded *on that
//      exact SHA* (checked against runs.sha), via a non-force push.
//   4. Conflict resolutions re-enter as ready intents and land only
//      through this same train path.
import type { FsClient, HttpClient } from "isomorphic-git";
import type git from "isomorphic-git";
import { type Db, claimWebhookDelivery, getRun, isTerminal, nowIso } from "./db";
import { ARTIFACTS_EVENT, artifactsDeliveryId, loadArtifactsPipeline } from "./artifacts-push";
import {
  pathCovers,
  parsePolicy,
  POLICY_PATH,
  scoreRisk,
  DEFAULT_POLICY,
  type Conflict,
  type ForgePolicy,
  type Intent,
  type LandingRoute,
  type RiskTerm,
  type Train,
  type WhyNote,
} from "./intents-core";
import {
  appendForgeLedger,
  claimConflict,
  createTrain,
  getConflict,
  getGoal,
  getIntent,
  getTrain,
  isForgeError,
  listConflicts,
  listForgeLedger,
  listTrains as listTrainRows,
  openConflict,
  resolveConflict,
  toIntent,
  toTrain,
  transitionIntent,
  transitionTrain,
  validateRepo,
  type ForgeError,
  type IntentRow,
  type TrainRow,
} from "./intents";
import type { TournamentRepoHandle } from "./tournaments";
import { changedFiles } from "./verdict";
import { recordNotesTip, writeWhyNotes, type ProvenanceGit } from "./provenance";
import {
  agentIdentity,
  bisectStep,
  chainBreak,
  cutCapacity,
  decideChain,
  freeSlots,
  landingGate,
  laneRef,
  LANE_REF_PREFIX,
  MAX_LANE_REFS,
  MAX_SPECULATION_DEPTH,
  nextFetchDepth,
  planTrain,
  squashMessage,
  TRAIN_COMMITTER,
  trainTimestamp,
  type LaneOutcome,
  type TrainCandidate,
} from "./train-core";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// The isomorphic-git surface the train uses (the real module in prod).
export type TrainGit = Pick<
  typeof git,
  "init" | "addRemote" | "fetch" | "push" | "merge" | "commit" | "writeRef" | "resolveRef" | "readCommit" | "listServerRefs"
>;

// Artifacts repo handle: the tournament surface plus token management
// (optional so fakes and older bindings degrade to "nothing to revoke").
export interface TrainRepoHandle extends TournamentRepoHandle {
  listTokens?(): Promise<unknown>;
  revokeToken?(tokenOrId: string): Promise<boolean>;
}

export interface TrainArtifacts {
  get(name: string): Promise<TrainRepoHandle>;
}

export interface TrainDispatchInput {
  repo: string;
  sha: string;
  ref: string;
  pipeline: string;
  event: string;
  agent: string;
  priority: number;
}

// Writes why notes on trunk commits (provenance stream). Absent = notes
// are skipped (never retried forever). Returns the shas written and the
// pushed notes tip, which the train records (Artifacts reads notes only
// by tip sha, never by ref name).
export interface NotesWriter {
  write(input: { repo: string; entries: Array<{ sha: string; note: WhyNote }> }): Promise<{ written: string[]; head: string | null }>;
}

export interface TrainDeps {
  db: Db;
  artifacts: TrainArtifacts | null;
  // Artifacts namespace of trunk repos (runs store repo as "ns/name").
  namespace: string;
  remoteFor: (repo: string) => string | null;
  git: TrainGit;
  http: HttpClient;
  fs: () => FsClient;
  dispatch: ((input: TrainDispatchInput) => Promise<{ runId: string }>) | null;
  // Defaults: D1 runs row; flare.yml via the binding; policy file at main.
  runStatus?: (runId: string) => Promise<{ status: string; sha: string } | null>;
  loadPipeline?: (repo: string, sha: string) => Promise<string | null>;
  loadPolicyText?: (repo: string) => Promise<string | null>;
  notes?: NotesWriter | null;
  // Start a durable executor for the repo (Workflow create); absent =
  // the cron tick drives trains.
  launch?: ((repo: string, key: string) => Promise<void>) | null;
  // Called after a merge conflict opens (replay strategies, replay.ts).
  onConflict?: ((conflict: Conflict) => Promise<void>) | null;
}

// Runs dispatched by trains ride the Artifacts event (seats check out
// the Artifacts remote for it) and are tagged with this agent so the
// dashboard and fairness caps can tell them apart.
export const TRAIN_RUN_AGENT = "forge-train";
// Agent verification beats batch work; trains are the trunk's
// bottleneck, so they jump the queue too.
export const TRAIN_RUN_PRIORITY = 8;
const GITDIR = "/train";
const TOKEN_TTL_SECONDS = 600;
// A builder that crashed mid-merge leaves `merging` rows: requeue them
// after this long. A verifying train whose CI never finishes, likewise.
export const STALE_MERGING_MS = 15 * 60 * 1000;
export const STALE_VERIFYING_MS = 3 * 60 * 60 * 1000;

function log(level: "info" | "warn", msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, ...fields }));
}

function redact(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
    .replace(/art_v2_\S+/g, "art_v2_[redacted]")
    .slice(0, 300);
}

function errCode(err: unknown): string {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : "";
}

function dispose(handle: TrainRepoHandle | null): void {
  try {
    handle?.[Symbol.dispose]?.();
  } catch {
    // Disposal never fails a step.
  }
}

// ---------------------------------------------------------------------------
// Small D1 helpers (train-specific stamps not covered by intents.ts)
// ---------------------------------------------------------------------------

async function changed(stmt: { run(): Promise<unknown> }): Promise<boolean> {
  const res = (await stmt.run()) as { meta?: { changes?: number } } | null;
  return (res?.meta?.changes ?? 0) > 0;
}

// Active trains in chain order: group (cut order), then lane slot (slots
// are assigned ascending within a group). Bounded by the lane-ref pool.
export async function activeTrains(db: Db, repo: string): Promise<Train[]> {
  const res = await db
    .prepare(
      `SELECT * FROM trains WHERE repo = ? AND state IN ('forming', 'merging', 'verifying') ORDER BY group_seq ASC, lane ASC, created_at ASC LIMIT ${MAX_LANE_REFS * 2}`,
    )
    .bind(repo)
    .all<TrainRow>();
  return res.results.map(toTrain);
}

// Split chain-ordered trains into their groups (same groupSeq).
export function groupTrains(trains: readonly Train[]): Train[][] {
  const out: Train[][] = [];
  for (const t of trains) {
    const last = out[out.length - 1];
    if (last && last[0].groupSeq === t.groupSeq) last.push(t);
    else out.push([t]);
  }
  return out;
}

async function nextGroupSeq(db: Db, repo: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(group_seq), 0) AS g FROM trains WHERE repo = ?").bind(repo).first<{ g: number }>();
  return (row?.g ?? 0) + 1;
}

async function setTrainIntents(db: Db, id: string, intentIds: string[]): Promise<void> {
  await db.prepare("UPDATE trains SET intents_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(intentIds), nowIso(), id).run();
}

async function setTrainBase(db: Db, id: string, baseSha: string): Promise<void> {
  await db.prepare("UPDATE trains SET base_sha = ?, updated_at = ? WHERE id = ? AND state = 'merging'").bind(baseSha, nowIso(), id).run();
}

async function stampRun(db: Db, id: string, runId: string): Promise<boolean> {
  return changed(
    db
      .prepare("UPDATE trains SET run_id = ?, updated_at = ? WHERE id = ? AND state = 'verifying' AND run_id IS NULL")
      .bind(runId, nowIso(), id),
  );
}

// Targeted EXISTS reads: an intent with a long ledger (many requeues,
// replays) must never hide a land approval or an llm_replay term behind
// a window of its oldest rows.
async function ledgerKinds(db: Db, intentId: string, kinds: readonly string[] = ["llm_replay", "land_approved"]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const k of kinds) if (await hasLedger(db, intentId, k)) out.add(k);
  return out;
}

async function hasLedger(db: Db, intentId: string, kind: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM forge_ledger WHERE subject_kind = 'intent' AND subject_id = ? AND kind = ? LIMIT 1")
    .bind(intentId, kind)
    .first<{ id: string }>();
  return !!row;
}

// The newest ledger body of one kind for an intent (null = none).
async function latestLedgerBody(db: Db, intentId: string, kind: string, bodyPrefix = ""): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT body FROM forge_ledger WHERE subject_kind = 'intent' AND subject_id = ? AND kind = ? AND substr(body, 1, ?) = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(intentId, kind, bodyPrefix.length, bodyPrefix)
    .first<{ body: string }>();
  return row ? row.body : null;
}

// The squashed commit an intent got in a train (ledger "train_commit",
// body "<trainId> <sha>"; latest wins).
async function trainCommitFor(db: Db, intentId: string, trainId: string): Promise<string | null> {
  const body = await latestLedgerBody(db, intentId, "train_commit", `${trainId} `);
  const sha = body ? body.slice(trainId.length + 1).trim() : "";
  return sha || null;
}

// Requeue without blame: in_train -> ready, clearing the train link. The
// intent keeps its place in line: its queue timestamp goes back to when
// it joined the train, so invalidated speculative work is rebuilt ahead
// of everything that became ready since.
async function requeueIntent(db: Db, intentId: string, reason: string): Promise<boolean> {
  const before = await getIntent(db, intentId);
  const ok = await transitionIntent(db, intentId, "in_train", "ready", { trainId: null }, "train");
  if (ok) {
    if (before?.updatedAt) {
      await db.prepare("UPDATE intents SET updated_at = ? WHERE id = ? AND state = 'ready'").bind(before.updatedAt, intentId).run();
    }
    const intent = await getIntent(db, intentId);
    await appendForgeLedger(db, { repo: intent?.repo ?? "", subjectKind: "intent", subjectId: intentId, kind: "requeued", body: reason, actor: "train" });
  }
  return ok;
}

async function abortTrain(db: Db, train: Train, reason: string): Promise<void> {
  const from = (await getTrain(db, train.id))?.state ?? train.state;
  if (from === "forming" || from === "merging" || from === "verifying") {
    await transitionTrain(db, train.id, from, "aborted");
  }
  await appendForgeLedger(db, { repo: train.repo, subjectKind: "train", subjectId: train.id, kind: "abort_reason", body: reason, actor: "train" });
  for (const id of train.intentIds) {
    const intent = await getIntent(db, id);
    if (intent?.state === "in_train" && intent.trainId === train.id) await requeueIntent(db, id, reason);
  }
}

// ---------------------------------------------------------------------------
// Artifacts helpers
// ---------------------------------------------------------------------------

async function mintToken(artifacts: TrainArtifacts | null, repo: string, scope: "read" | "write"): Promise<string> {
  if (!artifacts) return "";
  let handle: TrainRepoHandle | null = null;
  try {
    handle = await artifacts.get(repo);
    const out = await handle.createToken(scope, TOKEN_TTL_SECONDS);
    const plaintext = typeof out === "string" ? out : out.plaintext;
    return typeof plaintext === "string" ? plaintext : "";
  } catch {
    return "";
  } finally {
    dispose(handle);
  }
}

async function readTrunkFile(deps: TrainDeps, repo: string, ref: string, path: string): Promise<string | null> {
  if (!deps.artifacts) return null;
  let handle: TrainRepoHandle | null = null;
  try {
    handle = await deps.artifacts.get(repo);
    const file = await handle.readFile({ ref, path });
    if (!file || file.size > 65536) return null;
    return await file.text();
  } catch {
    return null;
  } finally {
    dispose(handle);
  }
}

export async function loadPolicy(deps: TrainDeps, repo: string): Promise<ForgePolicy> {
  const text = deps.loadPolicyText ? await deps.loadPolicyText(repo).catch(() => null) : await readTrunkFile(deps, repo, "main", POLICY_PATH);
  const parsed = parsePolicy(text);
  // A broken policy file must never loosen protections: fall back to the
  // default policy (which auto-lands nothing above risk 30).
  return parsed.ok ? parsed.value : DEFAULT_POLICY;
}

async function loadPipelineAt(deps: TrainDeps, repo: string, sha: string): Promise<string | null> {
  if (deps.loadPipeline) return deps.loadPipeline(repo, sha).catch(() => null);
  if (!deps.artifacts) return null;
  return loadArtifactsPipeline(deps.artifacts, repo, sha);
}

async function runStatusOf(deps: TrainDeps, runId: string): Promise<{ status: string; sha: string } | null> {
  if (deps.runStatus) return deps.runStatus(runId);
  const run = await getRun(deps.db, runId).catch(() => null);
  return run ? { status: run.status, sha: run.sha } : null;
}

// ---------------------------------------------------------------------------
// Git helpers (one MemoryFS repo per step)
// ---------------------------------------------------------------------------

interface GitCtx {
  deps: TrainDeps;
  fs: FsClient;
  repo: string;
  trunkUrl: string;
  readToken: string;
  // url -> configured remote name (isomorphic-git fetch needs a remote
  // with a refspec; a bare url fetch has none).
  remotes: Map<string, string>;
}

async function remoteFor(ctx: GitCtx, url: string): Promise<string> {
  const known = ctx.remotes.get(url);
  if (known) return known;
  const name = `r${ctx.remotes.size}`;
  await ctx.deps.git.addRemote({ fs: ctx.fs, gitdir: GITDIR, remote: name, url, force: true });
  ctx.remotes.set(url, name);
  return name;
}

async function hasCommit(ctx: GitCtx, oid: string): Promise<boolean> {
  if (!oid) return false;
  try {
    await ctx.deps.git.readCommit({ fs: ctx.fs, gitdir: GITDIR, oid });
    return true;
  } catch {
    return false;
  }
}

async function fetchRef(ctx: GitCtx, url: string, token: string, ref: string, depth: number): Promise<string | null> {
  const out = await ctx.deps.git.fetch({
    fs: ctx.fs,
    http: ctx.deps.http,
    gitdir: GITDIR,
    remote: await remoteFor(ctx, url),
    ref,
    singleBranch: true,
    depth,
    tags: false,
    onAuth: () => ({ username: "x", password: token }),
  });
  return out.fetchHead ?? null;
}

// Fetch `ref` deepening until every `need` commit is present (merge
// bases reachable); bounded by FETCH_DEPTHS.
async function fetchCovering(ctx: GitCtx, url: string, token: string, ref: string, need: string[]): Promise<string | null> {
  let depth = nextFetchDepth(null);
  let head: string | null = null;
  while (depth !== null) {
    head = await fetchRef(ctx, url, token, ref, depth);
    let all = true;
    for (const oid of need) if (!(await hasCommit(ctx, oid))) all = false;
    if (all) return head;
    depth = nextFetchDepth(depth);
  }
  return head;
}

async function openGit(deps: TrainDeps, repo: string): Promise<GitCtx | null> {
  const trunkUrl = deps.remoteFor(repo);
  if (!trunkUrl) return null;
  const readToken = await mintToken(deps.artifacts, repo, "read");
  const fs = deps.fs();
  await deps.git.init({ fs, gitdir: GITDIR, bare: true, defaultBranch: "main" });
  return { deps, fs, repo, trunkUrl, readToken, remotes: new Map() };
}

async function pushRef(ctx: GitCtx, localRef: string, remoteRef: string, force: boolean): Promise<void> {
  // Trunk write token: minted for this push only, never stored/returned.
  const writeToken = await mintToken(ctx.deps.artifacts, ctx.repo, "write");
  const res = await ctx.deps.git.push({
    fs: ctx.fs,
    http: ctx.deps.http,
    gitdir: GITDIR,
    url: ctx.trunkUrl,
    ref: localRef,
    remoteRef,
    force,
    onAuth: () => ({ username: "x", password: writeToken }),
  });
  const r = res.refs?.[remoteRef];
  if (!res.ok || (r && !r.ok)) throw new Error(`push ${remoteRef} rejected: ${r?.error ?? res.error ?? "unknown"}`);
}

async function remoteHead(ctx: GitCtx, ref: string): Promise<string | null> {
  const refs = await ctx.deps.git.listServerRefs({
    http: ctx.deps.http,
    url: ctx.trunkUrl,
    prefix: ref,
    onAuth: () => ({ username: "x", password: ctx.readToken }),
  });
  return refs.find((r) => r.ref === ref)?.oid ?? null;
}

// ---------------------------------------------------------------------------
// TrainPort: enqueue + landing approval
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  intentId: string;
  risk: number;
  riskTerms: RiskTerm[];
  route: LandingRoute;
  // Held out of trains until a human approves the landing.
  held: boolean;
  cut: CutResult | null;
}

// Gate a ready intent for the next train: recompute risk with every
// known term, route it (auto / audit / human), and — unless held for a
// human — try to cut a train. Idempotent; safe to call repeatedly.
export async function enqueueReady(
  deps: TrainDeps,
  intentId: string,
  opts: { cut?: boolean } = {},
): Promise<EnqueueResult | ForgeError> {
  const intent = await getIntent(deps.db, intentId);
  if (!intent) return { error: "not-found", message: "intent not found" };
  if (intent.state !== "ready") return { error: "not-ready", message: `intent is ${intent.state}` };
  const policy = await loadPolicy(deps, intent.repo);
  const kinds = await ledgerKinds(deps.db, intent.id);
  const scored = scoreRisk({
    footprint: intent.footprint,
    actualFootprint: intent.actualFootprint,
    policy,
    llmReplay: kinds.has("llm_replay"),
  });
  const gate = landingGate(scored.risk, policy, intent.id, kinds.has("land_approved"));
  await deps.db
    .prepare("UPDATE intents SET risk = ?, risk_terms_json = ?, updated_at = updated_at WHERE id = ? AND state = 'ready'")
    .bind(scored.risk, JSON.stringify(scored.terms), intent.id)
    .run();
  await appendForgeLedger(deps.db, {
    repo: intent.repo,
    subjectKind: "intent",
    subjectId: intent.id,
    kind: gate.held ? "held" : "queued",
    body: `route=${gate.route} risk=${scored.risk}${gate.held ? " (awaiting human landing approval)" : ""}`,
    actor: "train",
  });
  const cut = !gate.held && opts.cut !== false ? await cutTrain(deps, intent.repo) : null;
  return { intentId: intent.id, risk: scored.risk, riskTerms: scored.terms, route: gate.route, held: gate.held, cut };
}

// Human approval for a 'human'-routed intent: it may ride trains from
// now on (still CI-gated). Ledger-backed; idempotent.
export async function approveLanding(deps: TrainDeps, intentId: string, approvedBy: string): Promise<boolean> {
  const by = approvedBy.trim().slice(0, 100);
  if (!by) return false;
  const intent = await getIntent(deps.db, intentId);
  if (!intent || intent.state !== "ready") return false;
  if (!(await hasLedger(deps.db, intentId, "land_approved"))) {
    await appendForgeLedger(deps.db, { repo: intent.repo, subjectKind: "intent", subjectId: intentId, kind: "land_approved", body: by, actor: by });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cut
// ---------------------------------------------------------------------------

export type CutResult =
  | {
      status: "cut";
      trainIds: string[];
      lanes: string[][];
      baseSha: string;
      deferred: string[];
      // Stacked on an in-flight group (built on its speculative head).
      speculative: boolean;
      groupSeq: number;
      slots: number[];
    }
  | { status: "busy"; trainIds: string[] }
  | { status: "idle" | "unavailable" | "no-pipeline" | "invalid-repo" };

export async function trunkMainSha(deps: TrainDeps, repo: string): Promise<string | null> {
  if (!deps.artifacts) return null;
  let handle: TrainRepoHandle | null = null;
  try {
    handle = await deps.artifacts.get(repo);
    const commits = await handle.log({ ref: "main", limit: 1 });
    const hash = commits[0]?.hash ?? "";
    return /^[0-9a-f]{40}$/i.test(hash) ? hash.toLowerCase() : null;
  } catch {
    return null;
  } finally {
    dispose(handle);
  }
}

// Cut one train group for a repo from its ready queue. Up to
// lanes.speculation_depth groups may be in flight: a group cut while
// others are active is speculative — it is built on the chain head (the
// last in-flight lane's head), assuming everything ahead passes, so
// ready intents that overlap in-flight work stack on it instead of
// waiting for it to land. Each group takes free lane-ref slots; landings
// stay serialized through one CAS on main (checkTrains).
export async function cutTrain(deps: TrainDeps, repo: string): Promise<CutResult> {
  if (!validateRepo(repo)) return { status: "invalid-repo" };
  const active = await activeTrains(deps.db, repo);
  const policy = await loadPolicy(deps, repo);
  const cap = cutCapacity(policy, groupTrains(active).length, active.map((t) => t.lane));
  if (!cap.slots.length) return { status: "busy", trainIds: active.map((t) => t.id) };
  const rows = await deps.db
    .prepare("SELECT * FROM intents WHERE repo = ? AND state = 'ready' ORDER BY updated_at ASC, id ASC LIMIT 500")
    .bind(repo)
    .all<IntentRow>();
  if (!rows.results.length) return { status: "idle" };
  const approvedRows = await deps.db
    .prepare("SELECT DISTINCT subject_id FROM forge_ledger WHERE repo = ? AND subject_kind = 'intent' AND kind = 'land_approved'")
    .bind(repo)
    .all<{ subject_id: string }>();
  const approved = new Set(approvedRows.results.map((r) => r.subject_id));
  const candidates: Array<TrainCandidate & { intent: Intent }> = [];
  for (const row of rows.results) {
    const intent = toIntent(row);
    if (!intent.headSha || !intent.forkRepo) continue;
    if (landingGate(intent.risk, policy, intent.id, approved.has(intent.id)).held) continue;
    candidates.push({ id: intent.id, footprint: intent.footprint, readyAt: intent.updatedAt, intent });
  }
  if (!candidates.length) return { status: "idle" };
  const baseSha = await trunkMainSha(deps, repo);
  if (!baseSha) return { status: "unavailable" };
  // CI is the gate: without a pipeline at trunk there is nothing to
  // verify, so nothing may land (invariant 2).
  if (!(await loadPipelineAt(deps, repo, baseSha))) return { status: "no-pipeline" };
  const plan = planTrain(candidates, policy, { maxLanes: cap.slots.length });
  const groupSeq = await nextGroupSeq(deps.db, repo);
  const trainIds: string[] = [];
  const lanes: string[][] = [];
  const slots: number[] = [];
  for (let i = 0; i < plan.lanes.length; i++) {
    const lane = plan.lanes[i];
    // base_sha is provisional (main at cut); the builder stamps the real
    // base (main, or the speculative head the lane is stacked on).
    const train = await createTrain(deps.db, { repo, lane: cap.slots[i], baseSha, intentIds: lane.map((c) => c.id), groupSeq });
    const joined: string[] = [];
    for (const c of lane) {
      if (await transitionIntent(deps.db, c.id, "ready", "in_train", { trainId: train.id }, "train")) joined.push(c.id);
    }
    if (!joined.length) {
      await transitionTrain(deps.db, train.id, "forming", "aborted");
      continue;
    }
    if (joined.length !== lane.length) await setTrainIntents(deps.db, train.id, joined);
    trainIds.push(train.id);
    lanes.push(joined);
    slots.push(cap.slots[i]);
  }
  if (!trainIds.length) return { status: "idle" };
  // Only the cut that starts a chain launches an executor; a speculative
  // group is picked up by the executor already driving the repo.
  if (deps.launch && !active.length) {
    try {
      await deps.launch(repo, trainIds[0]);
    } catch (err) {
      // The cron tick drives the train when the Workflow cannot start.
      log("warn", "train launch failed", { repo, error: redact(err) });
    }
  }
  return {
    status: "cut",
    trainIds,
    lanes,
    baseSha,
    deferred: plan.deferred.map((c) => c.id),
    speculative: cap.speculative,
    groupSeq,
    slots,
  };
}

// ---------------------------------------------------------------------------
// Build: merge each lane's intents as squashed commits, stack the lanes,
// push lane refs, dispatch CI.
// ---------------------------------------------------------------------------

export interface BuiltLane {
  trainId: string;
  lane: number;
  head: string | null;
  merged: string[];
  conflicts: string[];
  requeued: string[];
  mergeMs: number;
}

export type BuildResult =
  | { status: "built"; baseSha: string; lanes: BuiltLane[]; dispatched: number }
  | { status: "none" | "busy" | "unavailable" | "failed"; detail?: string };

interface MergeOk {
  ok: true;
  commit: string;
  noop: boolean;
}
interface MergeConflictOut {
  ok: false;
  files: string[];
  reason: string;
}

async function squashOnto(
  ctx: GitCtx,
  head: string,
  theirs: string,
  message: string,
  author: { name: string; email: string },
  timestamp: number,
): Promise<MergeOk | MergeConflictOut> {
  const g = ctx.deps.git;
  await g.writeRef({ fs: ctx.fs, gitdir: GITDIR, ref: "refs/heads/train", value: head, force: true });
  let tree: string | undefined;
  try {
    const res = await g.merge({
      fs: ctx.fs,
      gitdir: GITDIR,
      ours: "refs/heads/train",
      theirs,
      fastForward: false,
      noUpdateBranch: true,
      abortOnConflict: true,
      message: "train merge",
      author: { ...TRAIN_COMMITTER, timestamp, timezoneOffset: 0 },
    });
    if (res.alreadyMerged) return { ok: true, commit: head, noop: true };
    tree = res.tree;
  } catch (err) {
    if (errCode(err) === "MergeConflictError") {
      const data = (err as { data?: { filepaths?: unknown } }).data;
      const files = Array.isArray(data?.filepaths) ? data.filepaths.filter((f): f is string => typeof f === "string") : [];
      return { ok: false, files, reason: "textual conflict" };
    }
    if (errCode(err) === "MergeNotSupportedError") return { ok: false, files: [], reason: "multiple merge bases" };
    throw err;
  }
  if (!tree) return { ok: false, files: [], reason: "merge produced no tree" };
  const commit = await g.commit({
    fs: ctx.fs,
    gitdir: GITDIR,
    ref: "refs/heads/train",
    tree,
    parent: [head],
    message,
    author: { ...author, timestamp, timezoneOffset: 0 },
    committer: { ...TRAIN_COMMITTER, timestamp, timezoneOffset: 0 },
  });
  return { ok: true, commit, noop: false };
}

// The other side of a conflict: an earlier intent in this group whose
// footprint covers a conflicting file, else the latest landed intent that
// does, else the trunk itself.
async function otherSide(db: Db, repo: string, earlier: Intent[], files: string[], self: string): Promise<string> {
  const covers = (i: Intent): boolean => {
    const fp = i.actualFootprint && i.actualFootprint.paths.length ? i.actualFootprint : i.footprint;
    return files.some((f) => fp.paths.some((p) => pathCovers(p, f)));
  };
  for (let k = earlier.length - 1; k >= 0; k--) if (earlier[k].id !== self && covers(earlier[k])) return earlier[k].id;
  const landed = await db
    .prepare("SELECT * FROM intents WHERE repo = ? AND state = 'landed' ORDER BY updated_at DESC LIMIT 50")
    .bind(repo)
    .all<IntentRow>();
  for (const row of landed.results) {
    const i = toIntent(row);
    if (i.id !== self && covers(i)) return i.id;
  }
  return "trunk";
}

// Build every forming group of the repo, in chain order, each as one
// stacked group on the chain head, then dispatch CI for the new lane
// heads. Retry-safe: commits are deterministic, so a re-run reproduces
// the same heads.
export async function buildTrains(deps: TrainDeps, repo: string): Promise<BuildResult> {
  let first: BuildResult | null = null;
  const lanes: BuiltLane[] = [];
  for (let k = 0; k <= MAX_SPECULATION_DEPTH; k++) {
    const out = await buildGroup(deps, repo);
    if (!first) first = out;
    if (out.status !== "built") break;
    lanes.push(...out.lanes);
  }
  // Only the builder that built dispatches (checkTrains covers misses).
  if (!first || first.status !== "built") return first ?? { status: "none" };
  const dispatched = await dispatchTrains(deps, repo);
  return { status: "built", baseSha: first.baseSha, lanes, dispatched };
}

// Build the first forming group of the chain. Every group ahead of it
// must be built (verifying); the group's first lane is stacked on the
// last of their heads — the speculative head — or on main when nothing
// is ahead (the chain root).
async function buildGroup(deps: TrainDeps, repo: string): Promise<BuildResult> {
  const groups = groupTrains(await activeTrains(deps.db, repo));
  const gi = groups.findIndex((g) => g.some((t) => t.state === "forming"));
  if (gi < 0) return { status: "none" };
  const ahead = groups.slice(0, gi).flat();
  if (ahead.some((t) => t.state !== "verifying")) return { status: "busy" };
  const forming = groups[gi];
  if (forming.some((t) => t.state !== "forming")) return { status: "busy" };
  const parent = ahead.length ? ahead[ahead.length - 1] : null;
  // Lane 0's conditional claim is the group lock: only one builder wins.
  if (!(await transitionTrain(deps.db, forming[0].id, "forming", "merging"))) return { status: "busy" };
  for (const t of forming.slice(1)) await transitionTrain(deps.db, t.id, "forming", "merging");
  const group = forming.map((t) => ({ ...t, state: "merging" as const }));

  const ctx = await openGit(deps, repo).catch(() => null);
  if (!ctx) {
    for (const t of group) await abortTrain(deps.db, t, "trunk remote unavailable");
    return { status: "unavailable" };
  }
  const intentsByTrain = new Map<string, Intent[]>();
  const allBases: string[] = [];
  for (const t of group) {
    const list: Intent[] = [];
    for (const id of t.intentIds) {
      const i = await getIntent(deps.db, id);
      if (i && i.state === "in_train" && i.trainId === t.id) {
        list.push(i);
        if (i.baseSha) allBases.push(i.baseSha);
      }
    }
    intentsByTrain.set(t.id, list);
  }

  let baseSha: string;
  try {
    const mainHead = await fetchCovering(ctx, ctx.trunkUrl, ctx.readToken, "main", allBases);
    if (!mainHead) throw new Error("trunk main not found");
    if (parent) {
      // Speculative: stack on the in-flight chain head (its lane ref
      // carries the whole chain down to main).
      await fetchCovering(ctx, ctx.trunkUrl, ctx.readToken, `refs/heads/${laneRef(parent.lane)}`, [parent.headSha]);
      if (!(await hasCommit(ctx, parent.headSha))) throw new Error(`speculative base ${parent.headSha.slice(0, 12)} not fetchable`);
      baseSha = parent.headSha;
    } else {
      baseSha = mainHead;
    }
  } catch (err) {
    for (const t of group) await abortTrain(deps.db, t, `fetch trunk failed: ${redact(err)}`);
    return { status: "failed", detail: redact(err) };
  }
  // The pool is pre-created at bootstrap; the Worker never creates a
  // ref (spike S5). Unknown = the listing failed: push and let a missing
  // ref surface as a push error instead.
  let laneRefs: Set<string> | null = null;
  try {
    const refs = await deps.git.listServerRefs({
      http: deps.http,
      url: ctx.trunkUrl,
      prefix: `refs/heads/${LANE_REF_PREFIX}`,
      onAuth: () => ({ username: "x", password: ctx.readToken }),
    });
    laneRefs = new Set(refs.map((r) => r.ref));
  } catch {
    laneRefs = null;
  }

  let head = baseSha;
  const lanes: BuiltLane[] = [];
  const mergedSoFar: Intent[] = [];
  let broken: string | null = null;
  for (const t of group) {
    const ref = `refs/heads/${laneRef(t.lane)}`;
    if (!broken && laneRefs && !laneRefs.has(ref)) {
      broken = `lane ref ${laneRef(t.lane)} missing: bootstrap the lane-ref pool (scripts/artifacts-mirror.mjs lanes)`;
      log("warn", "lane ref missing", { repo, ref });
    }
    if (broken) {
      await abortTrain(deps.db, t, broken);
      lanes.push({ trainId: t.id, lane: t.lane, head: null, merged: [], conflicts: [], requeued: t.intentIds, mergeMs: 0 });
      continue;
    }
    await setTrainBase(deps.db, t.id, head);
    const started = Date.now();
    const timestamp = trainTimestamp(t.createdAt);
    const built: BuiltLane = { trainId: t.id, lane: t.lane, head: null, merged: [], conflicts: [], requeued: [], mergeMs: 0 };
    for (const intent of intentsByTrain.get(t.id) ?? []) {
      const forkUrl = intent.forkRepo ? deps.remoteFor(intent.forkRepo) : null;
      let theirs: string | null = null;
      if (forkUrl && intent.forkRepo) {
        try {
          const forkToken = await mintToken(deps.artifacts, intent.forkRepo, "read");
          const need = [intent.headSha, ...(intent.baseSha ? [intent.baseSha] : [])];
          await fetchCovering(ctx, forkUrl, forkToken, "main", need);
          if (!(await hasCommit(ctx, intent.headSha))) await fetchRef(ctx, forkUrl, forkToken, intent.headSha, 50).catch(() => null);
          if (await hasCommit(ctx, intent.headSha)) theirs = intent.headSha;
        } catch (err) {
          log("warn", "train fork fetch failed", { repo, intent: intent.id, error: redact(err) });
        }
      }
      if (!theirs) {
        await requeueIntent(deps.db, intent.id, "fork head unreachable; requeued");
        built.requeued.push(intent.id);
        continue;
      }
      const message = squashMessage({
        intentId: intent.id,
        title: intent.title,
        reasoning: intent.reasoning,
        agent: intent.agent,
        goalId: intent.goalId,
        session: intent.forkRepo ?? "",
      });
      let out: MergeOk | MergeConflictOut;
      try {
        out = await squashOnto(ctx, head, theirs, message, agentIdentity(intent.agent), timestamp);
      } catch (err) {
        // Shallow history cut the merge-base walk: treat as unmergeable
        // here (replay re-derives on the new trunk).
        out = { ok: false, files: [], reason: `merge failed: ${redact(err)}` };
      }
      if (!out.ok) {
        const other = await otherSide(deps.db, repo, mergedSoFar, out.files, intent.id);
        const conflict = await openConflict(deps.db, { repo, intentA: intent.id, intentB: other, files: out.files });
        await transitionIntent(deps.db, intent.id, "in_train", "conflicted", { trainId: null }, "train");
        await appendForgeLedger(deps.db, {
          repo,
          subjectKind: "conflict",
          subjectId: conflict.id,
          kind: "detected",
          body: `${out.reason} at trunk ${baseSha.slice(0, 12)} on ${out.files.slice(0, 20).join(", ") || "(unknown files)"}`,
          actor: "train",
        });
        built.conflicts.push(conflict.id);
        if (deps.onConflict) {
          try {
            await deps.onConflict(conflict);
          } catch (err) {
            log("warn", "conflict hook failed", { repo, conflict: conflict.id, error: redact(err) });
          }
        }
        continue;
      }
      head = out.commit;
      built.merged.push(intent.id);
      mergedSoFar.push(intent);
      await appendForgeLedger(deps.db, { repo, subjectKind: "intent", subjectId: intent.id, kind: "train_commit", body: `${t.id} ${out.commit}`, actor: "train" });
    }
    built.mergeMs = Date.now() - started;
    if (!built.merged.length) {
      await transitionTrain(deps.db, t.id, "merging", "aborted");
      await appendForgeLedger(deps.db, { repo, subjectKind: "train", subjectId: t.id, kind: "abort_reason", body: "every intent dropped (conflict or unreachable)", actor: "train" });
      lanes.push(built);
      continue;
    }
    if (built.merged.length !== t.intentIds.length) await setTrainIntents(deps.db, t.id, built.merged);
    try {
      // Claim the (repo, sha) delivery first so the push trigger does not
      // dispatch a duplicate run for the lane push.
      await claimWebhookDelivery(deps.db, artifactsDeliveryId(deps.namespace, repo, head));
      await deps.git.writeRef({ fs: ctx.fs, gitdir: GITDIR, ref: "refs/heads/lane", value: head, force: true });
      await pushRef(ctx, "refs/heads/lane", ref, true);
    } catch (err) {
      broken = `lane push failed: ${redact(err)}`;
      await abortTrain(deps.db, { ...t, intentIds: built.merged }, broken);
      built.requeued.push(...built.merged);
      built.merged = [];
      lanes.push(built);
      continue;
    }
    await transitionTrain(deps.db, t.id, "merging", "verifying", { headSha: head });
    built.head = head;
    lanes.push(built);
  }
  return { status: "built", baseSha, lanes, dispatched: 0 };
}

// Dispatch CI for verifying lanes that have no run yet (idempotent: the
// run id is stamped conditionally). A lane that cannot dispatch is
// aborted with every lane stacked on it.
export async function dispatchTrains(deps: TrainDeps, repo: string): Promise<number> {
  const trains = (await activeTrains(deps.db, repo)).filter((t) => t.state === "verifying");
  let dispatched = 0;
  let broken: string | null = null;
  // The pipeline comes from TRUNK (the chain root's base = main when the
  // chain was built), never from the lane head: a lane head carries the
  // intents' changes, and an intent that rewrote flare.yml to `echo ok`
  // must not get to choose the CI that verifies it.
  const trunkSha = trains.length ? trains[0].baseSha : "";
  let pipeline: string | null | undefined;
  for (const t of trains) {
    if (broken) {
      await abortTrain(deps.db, t, broken);
      continue;
    }
    if (t.runId) continue;
    if (pipeline === undefined) pipeline = await loadPipelineAt(deps, repo, trunkSha);
    if (!pipeline || !deps.dispatch) {
      broken = pipeline ? "no dispatcher" : "no pipeline on trunk";
      await abortTrain(deps.db, t, broken);
      continue;
    }
    try {
      const out = await deps.dispatch({
        repo: `${deps.namespace}/${repo}`,
        sha: t.headSha,
        ref: `refs/heads/${laneRef(t.lane)}`,
        pipeline,
        event: ARTIFACTS_EVENT,
        agent: TRAIN_RUN_AGENT,
        priority: TRAIN_RUN_PRIORITY,
      });
      if (await stampRun(deps.db, t.id, out.runId)) dispatched += 1;
    } catch (err) {
      broken = `dispatch failed: ${redact(err)}`;
      await abortTrain(deps.db, t, broken);
    }
  }
  return dispatched;
}

// ---------------------------------------------------------------------------
// Check: observe CI, land the green prefix, bisect the first red lane.
// ---------------------------------------------------------------------------

export type CheckResult =
  | { status: "idle" | "building" | "waiting" }
  | { status: "retry"; detail: string }
  | { status: "rebuild"; detail: string; requeued: string[] }
  // A green prefix of the chain landed; lanes behind it still verifying.
  | { status: "progress"; mainSha: string; landed: string[]; requeued: string[] }
  | {
      status: "decided";
      mainSha: string;
      landed: string[];
      failed: string[];
      requeued: string[];
      bisected: string[];
    };

async function laneOutcome(deps: TrainDeps, t: Train): Promise<LaneOutcome> {
  if (!t.runId) return "pending";
  const run = await runStatusOf(deps, t.runId);
  if (!run || !isTerminal(run.status)) return "pending";
  if (run.sha.toLowerCase() !== t.headSha.toLowerCase()) {
    // A run for some other SHA proves nothing about this head.
    await appendForgeLedger(deps.db, { repo: t.repo, subjectKind: "train", subjectId: t.id, kind: "sha_mismatch", body: `run ${t.runId} ran ${run.sha.slice(0, 12)}, lane head ${t.headSha.slice(0, 12)}`, actor: "train" });
    return "red";
  }
  return run.status === "success" ? "green" : "red";
}

type LandOutcome = { status: "landed"; mainSha: string } | { status: "moved"; mainSha: string | null } | { status: "retry"; detail: string };

// Fast-forward main to exactly `target` (non-force). The remote main
// must still equal `expected` (CAS); otherwise main moved and the train
// rebuilds. A retry after a crash that already pushed sees main == target.
async function fastForwardMain(deps: TrainDeps, repo: string, expected: string, target: string, lane: number): Promise<LandOutcome> {
  const ctx = await openGit(deps, repo).catch(() => null);
  if (!ctx) return { status: "retry", detail: "trunk remote unavailable" };
  try {
    const current = await remoteHead(ctx, "refs/heads/main");
    if (current === target) return { status: "landed", mainSha: target };
    if (current !== expected) return { status: "moved", mainSha: current };
    await fetchCovering(ctx, ctx.trunkUrl, ctx.readToken, `refs/heads/${laneRef(lane)}`, [target, expected]);
    if (!(await hasCommit(ctx, target))) return { status: "retry", detail: "lane head not fetchable" };
    await deps.git.writeRef({ fs: ctx.fs, gitdir: GITDIR, ref: "refs/heads/main", value: target, force: true });
    await pushRef(ctx, "refs/heads/main", "refs/heads/main", false);
    return { status: "landed", mainSha: target };
  } catch (err) {
    const now = await remoteHead(ctx, "refs/heads/main").catch(() => null);
    if (now === target) return { status: "landed", mainSha: target };
    if (now && now !== expected) return { status: "moved", mainSha: now };
    return { status: "retry", detail: redact(err) };
  }
}

// The landing gate as of now (risk re-scored with every known term).
async function gateFor(deps: TrainDeps, policy: ForgePolicy, intent: Intent): Promise<{ scored: ReturnType<typeof scoreRisk>; gate: ReturnType<typeof landingGate>; kinds: Set<string> }> {
  const kinds = await ledgerKinds(deps.db, intent.id);
  const scored = scoreRisk({
    footprint: intent.footprint,
    actualFootprint: intent.actualFootprint,
    policy,
    llmReplay: kinds.has("llm_replay"),
  });
  return { scored, gate: landingGate(scored.risk, policy, intent.id, kinds.has("land_approved")), kinds };
}

// First lane at or before `through` holding an intent the gate now holds
// for a human (-1 = none). Checked BEFORE main moves: once a commit is on
// main it has landed, so a held intent must never reach the push.
async function firstGatedLane(deps: TrainDeps, policy: ForgePolicy, lanes: readonly Train[], through: number): Promise<number> {
  for (let i = 0; i <= through && i < lanes.length; i++) {
    for (const id of lanes[i].intentIds) {
      const intent = await getIntent(deps.db, id);
      if (intent && (await gateFor(deps, policy, intent)).gate.held) return i;
    }
  }
  return -1;
}

async function landIntent(deps: TrainDeps, policy: ForgePolicy, train: Train, intentId: string, runId: string): Promise<boolean> {
  const intent = await getIntent(deps.db, intentId);
  if (!intent || intent.state !== "in_train" || intent.trainId !== train.id) return false;
  const { scored, gate, kinds } = await gateFor(deps, policy, intent);
  const commit = (await trainCommitFor(deps.db, intent.id, train.id)) ?? train.headSha;
  // The policy line goes in *before* the landed transition so the why
  // chain's review is the routing decision, not the state change.
  const approved = kinds.has("land_approved");
  await appendForgeLedger(deps.db, {
    repo: train.repo,
    subjectKind: "intent",
    subjectId: intent.id,
    kind: "routed",
    body: routeLine(scored.risk, policy, gate.route, approved, `run ${runId}, train ${train.id.slice(0, 8)}, sha ${commit.slice(0, 12)}`),
    actor: "train",
  });
  return transitionIntent(
    deps.db,
    intent.id,
    "in_train",
    "landed",
    { landedSha: commit, risk: scored.risk, riskTerms: scored.terms },
    "train",
  );
}

// "risk 12 <= 30 -> auto (...)": the policy line the why chain shows.
export function routeLine(risk: number, policy: ForgePolicy, route: LandingRoute, approved: boolean, detail = ""): string {
  const cmp = risk > policy.autoLandMaxRisk ? ">" : "<=";
  const decision = approved ? "approved" : route;
  return `risk ${risk} ${cmp} ${policy.autoLandMaxRisk} → ${decision}${detail ? ` (${detail})` : ""}`;
}

// Observe the speculative chain (every active lane, chain order): land
// its longest contiguous green prefix with one CAS push of main, bisect
// the first red lane and invalidate every lane behind it (any group).
// Lanes not yet built count as pending. Idempotent: a retry after a
// crash sees main already at the target and finishes the transitions.
export async function checkTrains(deps: TrainDeps, repo: string): Promise<CheckResult> {
  let active = await activeTrains(deps.db, repo);
  if (!active.length) return { status: "idle" };
  if (active.some((t) => t.state === "verifying" && !t.runId)) {
    await dispatchTrains(deps, repo);
    active = await activeTrains(deps.db, repo);
    if (!active.length) return { status: "idle" };
  }
  // Built lanes form the chain's prefix (groups build in order).
  let builtCount = active.findIndex((t) => t.state !== "verifying");
  if (builtCount < 0) builtCount = active.length;
  if (builtCount === 0) return { status: "building" };
  // Contiguity: a lane not stacked on the lane before it (that lane was
  // aborted by a sweep or failed dispatch) would land unverified commits;
  // invalidate it and everything behind it.
  const brk = chainBreak(active.slice(0, builtCount));
  if (brk !== null) {
    const requeued: string[] = [];
    for (const t of active.slice(brk)) {
      await abortTrain(deps.db, t, "chain broken: the lane it was stacked on left the chain; rebuild");
      requeued.push(...t.intentIds);
    }
    return { status: "rebuild", detail: "chain broken", requeued };
  }
  const outcomes: LaneOutcome[] = [];
  for (let i = 0; i < active.length; i++) outcomes.push(i < builtCount ? await laneOutcome(deps, active[i]) : "pending");
  const d = decideChain(outcomes);
  if (d.waiting && d.landThrough < 0) return { status: "waiting" };
  const expected = active[0].baseSha;
  let mainSha = expected;
  const out = { landed: [] as string[], failed: [] as string[], requeued: [] as string[], bisected: [] as string[] };
  const policy = await loadPolicy(deps, repo);
  // Landing gate, re-evaluated now (policy or risk may have changed since
  // the cut): a lane holding an intent that needs a human landing
  // approval does not land; it and every lane behind it are requeued.
  const gated = await firstGatedLane(deps, policy, active, d.landThrough);
  const landThrough = gated >= 0 ? gated - 1 : d.landThrough;

  if (landThrough >= 0) {
    const top = active[landThrough];
    const landed = await fastForwardMain(deps, repo, expected, top.headSha, top.lane);
    if (landed.status === "retry") return { status: "retry", detail: landed.detail };
    if (landed.status === "moved") {
      // Someone moved main under a green train: its SHA was never
      // verified on the new main, so rebuild from scratch (bounded by
      // the caller's round budget).
      const requeued: string[] = [];
      for (const t of active) {
        await abortTrain(deps.db, t, `main moved to ${String(landed.mainSha).slice(0, 12)}; rebuild`);
        requeued.push(...t.intentIds);
      }
      for (const id of requeued) {
        await appendForgeLedger(deps.db, { repo, subjectKind: "intent", subjectId: id, kind: "rebuild", body: "main moved under a green train", actor: "train" });
      }
      return { status: "rebuild", detail: "main moved", requeued };
    }
    mainSha = landed.mainSha;
    for (let i = 0; i <= landThrough; i++) {
      const t = active[i];
      if (await transitionTrain(deps.db, t.id, "verifying", "landed")) {
        for (const id of t.intentIds) if (await landIntent(deps, policy, t, id, t.runId ?? "")) out.landed.push(id);
      }
    }
  }
  if (gated >= 0) {
    for (const t of active.slice(gated)) {
      await abortTrain(deps.db, t, `landing gate: lane ${gated} holds an intent that needs human landing approval`);
      out.requeued.push(...t.intentIds);
    }
    return { status: "decided", mainSha, ...out };
  }
  if (d.waiting) return { status: "progress", mainSha, landed: out.landed, requeued: [] };
  // Invalidate every lane behind the red one, in any descendant group:
  // its head contains the red lane's changes. Requeued without blame.
  const redId = d.redLane === null ? "" : active[d.redLane].id.slice(0, 8);
  for (const j of d.requeueLanes) {
    const t = active[j];
    await abortTrain(deps.db, t, `stacked on red lane ${d.redLane} (train ${redId}); rebuild`);
    out.requeued.push(...t.intentIds);
  }
  if (d.redLane !== null) {
    const red = active[d.redLane];
    const step = bisectStep(red.intentIds);
    const evidence = `run ${red.runId ?? "?"} red on ${red.headSha.slice(0, 12)}`;
    // Every transition is checked: when two executors decide the same red
    // lane, only the one that wins the train transition acts on it.
    if ("culprit" in step) {
      if (!(await transitionTrain(deps.db, red.id, "verifying", "failed"))) return { status: "decided", mainSha, ...out };
      if (await transitionIntent(deps.db, step.culprit, "in_train", "failed", { trainId: null }, "train")) {
        await appendForgeLedger(deps.db, { repo, subjectKind: "intent", subjectId: step.culprit, kind: "culprit", body: `${evidence} (train ${red.id})`, actor: "train" });
        out.failed.push(step.culprit);
      }
    } else if ("halves" in step) {
      if (!(await transitionTrain(deps.db, red.id, "verifying", "bisected"))) return { status: "decided", mainSha, ...out };
      const halves = step.halves;
      // Children form a new group at the chain head (everything behind
      // the red lane was just invalidated), on the new main.
      const groupSeq = await nextGroupSeq(deps.db, repo);
      const used = (await activeTrains(deps.db, repo)).map((t) => t.lane);
      const childSlots = freeSlots(used, MAX_LANE_REFS, halves.length);
      for (let h = 0; h < halves.length && h < childSlots.length; h++) {
        const ids: string[] = [];
        for (const id of halves[h]) {
          if (await transitionIntent(deps.db, id, "in_train", "bisected", { trainId: null }, "train")) ids.push(id);
        }
        if (!ids.length) continue;
        const child = await createTrain(deps.db, { repo, lane: childSlots[h], baseSha: mainSha, intentIds: ids, parentTrainId: red.id, groupSeq });
        const joined: string[] = [];
        for (const id of ids) {
          if (
            (await transitionIntent(deps.db, id, "bisected", "ready", {}, "train")) &&
            (await transitionIntent(deps.db, id, "ready", "in_train", { trainId: child.id }, "train"))
          ) {
            joined.push(id);
          }
        }
        if (joined.length !== ids.length) await setTrainIntents(deps.db, child.id, joined);
        if (!joined.length) await transitionTrain(deps.db, child.id, "forming", "aborted");
        else out.bisected.push(child.id);
      }
      await appendForgeLedger(deps.db, { repo, subjectKind: "train", subjectId: red.id, kind: "bisect", body: `${evidence}; children ${out.bisected.join(", ")}`, actor: "train" });
    }
  }
  return { status: "decided", mainSha, ...out };
}

// ---------------------------------------------------------------------------
// After landing: why notes + fork token revocation (invariant 1)
// ---------------------------------------------------------------------------

async function landedWithout(db: Db, repo: string, kind: string, limit = 50): Promise<Intent[]> {
  const res = await db
    .prepare(
      `SELECT i.* FROM intents i WHERE i.repo = ? AND i.state = 'landed'
       AND NOT EXISTS (SELECT 1 FROM forge_ledger l WHERE l.subject_kind = 'intent' AND l.subject_id = i.id AND l.kind = ?)
       ORDER BY i.updated_at ASC LIMIT ?`,
    )
    .bind(repo, kind, limit)
    .all<IntentRow>();
  return res.results.map(toIntent);
}

export async function buildWhyNote(db: Db, intent: Intent): Promise<WhyNote | null> {
  if (!intent.landedSha || !intent.trainId) return null;
  const train = await getTrain(db, intent.trainId);
  const goal = intent.goalId ? await getGoal(db, intent.goalId) : null;
  const routedBody = await latestLedgerBody(db, intent.id, "routed");
  const routed = routedBody === null ? undefined : { body: routedBody };
  const decisionWord = /→ (\w+)/.exec(routed?.body ?? "")?.[1] ?? "auto";
  const decision: WhyNote["review"]["decision"] =
    decisionWord === "approved" || decisionWord === "audit" || decisionWord === "human" ? decisionWord : "auto";
  const conflicts = await db
    .prepare("SELECT id, intent_a, intent_b, state FROM conflicts WHERE (intent_a = ? OR intent_b = ?) ORDER BY created_at ASC LIMIT 20")
    .bind(intent.id, intent.id)
    .all<{ id: string; intent_a: string; intent_b: string; state: string }>();
  return {
    v: 1,
    goal: goal ? { id: goal.id, text: goal.text } : null,
    intent: { id: intent.id, title: intent.title, reasoning: intent.reasoning, accept: intent.accept },
    agent: intent.agent,
    session_repo: intent.forkRepo ?? "",
    alternatives_rejected: [],
    evidence: { run_id: train?.runId ?? "", sha: train?.headSha ?? intent.landedSha, status: "success" },
    conflict_decisions: conflicts.results.map((c) => ({
      conflict_id: c.id,
      with_intent: c.intent_a === intent.id ? c.intent_b : c.intent_a,
      decision: c.state === "resolved" ? "replayed on new trunk" : c.state,
    })),
    review: { decision, by: decision === "approved" ? "human" : "policy", policy: routed?.body ?? `risk ${intent.risk}` },
    train_id: intent.trainId,
  };
}

// Write a why note for each landed intent's squashed commit in one
// notes push, then record the pushed tip on the train (readers address
// the notes tree by that sha). Without a writer this is a no-op.
export async function writeNotes(deps: TrainDeps, repo: string): Promise<{ written: number; head: string | null }> {
  if (!deps.notes) return { written: 0, head: null };
  const pending = await landedWithout(deps.db, repo, "noted");
  const entries: Array<{ sha: string; note: WhyNote; intent: Intent }> = [];
  for (const intent of pending) {
    const note = await buildWhyNote(deps.db, intent);
    if (note && intent.landedSha) entries.push({ sha: intent.landedSha, note, intent });
  }
  if (!entries.length) return { written: 0, head: null };
  let out: { written: string[]; head: string | null };
  try {
    out = await deps.notes.write({ repo, entries: entries.map((e) => ({ sha: e.sha, note: e.note })) });
  } catch (err) {
    log("warn", "why notes failed", { repo, error: redact(err) });
    return { written: 0, head: null };
  }
  const written = new Set(out.written.map((s) => s.toLowerCase()));
  let count = 0;
  let lastTrain: string | null = null;
  for (const e of entries) {
    if (!written.has(e.sha.toLowerCase())) continue;
    await appendForgeLedger(deps.db, { repo, subjectKind: "intent", subjectId: e.intent.id, kind: "noted", body: e.sha, actor: "train" });
    lastTrain = e.intent.trainId ?? lastTrain;
    count += 1;
  }
  if (out.head && lastTrain) await recordNotesTip(deps.db, repo, lastTrain, out.head);
  return { written: count, head: out.head };
}

// The production NotesWriter: provenance.writeWhyNotes into a MemoryFS
// repo, pushed to trunk `refs/notes/why` with a per-push write token
// (server-side only; invariant 1).
export function createWhyNotesWriter(deps: {
  git: ProvenanceGit & Pick<typeof git, "init" | "addRemote">;
  http: HttpClient;
  fs: () => FsClient;
  remoteFor: (repo: string) => string | null;
  artifacts: TrainArtifacts | null;
}): NotesWriter {
  return {
    async write({ repo, entries }) {
      const url = deps.remoteFor(repo);
      if (!url) return { written: [], head: null };
      const fs = deps.fs();
      const dir = "/notes";
      await deps.git.init({ fs, dir, defaultBranch: "main" });
      await deps.git.addRemote({ fs, dir, remote: "trunk", url });
      const token = await mintToken(deps.artifacts, repo, "write");
      const res = await writeWhyNotes(deps.git, fs, dir, entries, {
        strategy: "notes",
        remote: { name: "trunk", http: deps.http, onAuth: () => ({ username: "x", password: token }) },
      });
      return { written: res.pushed ? res.written : [], head: res.pushed ? res.head : null };
    },
  };
}

function tokenIds(list: unknown): string[] {
  const tokens = Array.isArray(list)
    ? list
    : typeof list === "object" && list !== null && Array.isArray((list as { tokens?: unknown }).tokens)
      ? (list as { tokens: unknown[] }).tokens
      : [];
  const out: string[] = [];
  for (const t of tokens) {
    if (typeof t === "string") out.push(t);
    else if (typeof t === "object" && t !== null && typeof (t as { id?: unknown }).id === "string") out.push((t as { id: string }).id);
  }
  return out;
}

// Invariant 1: once an intent lands, every token on its fork is revoked
// (the agent's write token included), so a landed fork is read-only.
export async function revokeLandedTokens(deps: TrainDeps, repo: string): Promise<{ revoked: number }> {
  if (!deps.artifacts) return { revoked: 0 };
  let revoked = 0;
  for (const intent of await landedWithout(deps.db, repo, "tokens_revoked")) {
    if (!intent.forkRepo) continue;
    let handle: TrainRepoHandle | null = null;
    let count = 0;
    let ok = true;
    try {
      handle = await deps.artifacts.get(intent.forkRepo);
      if (handle.listTokens && handle.revokeToken) {
        for (const id of tokenIds(await handle.listTokens())) {
          if (await handle.revokeToken(id)) count += 1;
        }
      }
    } catch (err) {
      ok = false;
      log("warn", "token revoke failed", { repo, intent: intent.id, error: redact(err) });
    } finally {
      dispose(handle);
    }
    if (ok) {
      await appendForgeLedger(deps.db, { repo, subjectKind: "intent", subjectId: intent.id, kind: "tokens_revoked", body: `${count} token(s) on ${intent.forkRepo}`, actor: "train" });
      revoked += count;
    }
  }
  return { revoked };
}

// ---------------------------------------------------------------------------
// Sweeps + one cron-driven advance (fallback when no Workflow binding)
// ---------------------------------------------------------------------------

// Requeue trains whose executor died: merging past STALE_MERGING_MS, or
// verifying past STALE_VERIFYING_MS (CI never finished).
export async function sweepStaleTrains(deps: TrainDeps, repo: string, nowMs = Date.now()): Promise<number> {
  let swept = 0;
  for (const t of await activeTrains(deps.db, repo)) {
    const age = nowMs - Date.parse(t.updatedAt);
    if ((t.state === "merging" && age > STALE_MERGING_MS) || (t.state === "verifying" && age > STALE_VERIFYING_MS)) {
      await abortTrain(deps.db, t, `stale ${t.state} (${Math.round(age / 60000)} min)`);
      swept += 1;
    }
  }
  return swept;
}

// Keep the pipeline full: cut a group (the chain root, or a speculative
// group when a speculation level and lane refs are free) and build every
// forming group. Idempotent; safe to call on every poll.
export async function pumpRepo(deps: TrainDeps, repo: string): Promise<{ cut: CutResult; build: BuildResult | null }> {
  const cut = await cutTrain(deps, repo);
  const forming = (await activeTrains(deps.db, repo)).some((t) => t.state === "forming");
  return { cut, build: forming ? await buildTrains(deps, repo) : null };
}

export interface AdvanceResult {
  cut: CutResult | null;
  build: BuildResult | null;
  check: CheckResult | null;
  notes: number;
  revoked: number;
}

// One non-blocking pass for a repo: sweep, cut if idle, build forming
// trains, check verifying ones, then notes + revocation. The cron tick
// calls this when no Workflow drives the repo.
export async function advanceRepo(deps: TrainDeps, repo: string): Promise<AdvanceResult> {
  const out: AdvanceResult = { cut: null, build: null, check: null, notes: 0, revoked: 0 };
  await sweepStaleTrains(deps, repo);
  const pumped = await pumpRepo(deps, repo);
  out.cut = pumped.cut;
  out.build = pumped.build;
  if ((await activeTrains(deps.db, repo)).some((t) => t.state === "verifying")) out.check = await checkTrains(deps, repo);
  out.notes = (await writeNotes(deps, repo)).written;
  out.revoked = (await revokeLandedTokens(deps, repo)).revoked;
  return out;
}

// ---------------------------------------------------------------------------
// TrainPort reads + conflict wrappers (for the REST/MCP stream)
// ---------------------------------------------------------------------------

export async function listTrains(deps: Pick<TrainDeps, "db">, repo: string, opts: { state?: Train["state"]; limit?: number } = {}): Promise<Train[]> {
  return listTrainRows(deps.db, repo, opts);
}

export interface TrainLaneIntent {
  id: string;
  title: string;
  agent: string;
  state: Intent["state"];
  landedSha: string | null;
  commit: string | null;
}

export interface TrainNode {
  train: Train;
  intents: TrainLaneIntent[];
  run: { id: string; status: string; sha: string } | null;
  children: TrainNode[];
}

export interface TrainDetail extends TrainNode {
  // The root of the bisect tree this train belongs to.
  rootId: string;
  ledger: Array<{ kind: string; body: string; at: string }>;
}

async function trainNode(deps: Pick<TrainDeps, "db" | "runStatus">, train: Train, depth: number): Promise<TrainNode> {
  const intents: TrainLaneIntent[] = [];
  for (const id of train.intentIds.slice(0, 100)) {
    const i = await getIntent(deps.db, id);
    if (!i) continue;
    intents.push({ id: i.id, title: i.title, agent: i.agent, state: i.state, landedSha: i.landedSha, commit: await trainCommitFor(deps.db, i.id, train.id) });
  }
  let run: TrainNode["run"] = null;
  if (train.runId) {
    const r = deps.runStatus ? await deps.runStatus(train.runId) : await getRun(deps.db, train.runId).catch(() => null);
    if (r) run = { id: train.runId, status: r.status, sha: r.sha };
  }
  const children: TrainNode[] = [];
  if (depth < 12) {
    const res = await deps.db
      .prepare("SELECT * FROM trains WHERE parent_train_id = ? ORDER BY lane ASC, created_at ASC LIMIT 4")
      .bind(train.id)
      .all<TrainRow>();
    for (const row of res.results) children.push(await trainNode(deps, toTrain(row), depth + 1));
  }
  return { train, intents, run, children };
}

// One train with its lane intents (and their squashed commits), its CI
// run, and the bisect subtree below it.
export async function getTrainDetail(deps: Pick<TrainDeps, "db" | "runStatus">, id: string): Promise<TrainDetail | null> {
  const train = await getTrain(deps.db, id);
  if (!train) return null;
  let rootId = train.id;
  let cursor: Train | null = train;
  for (let k = 0; k < 16 && cursor?.parentTrainId; k++) {
    cursor = await getTrain(deps.db, cursor.parentTrainId);
    if (cursor) rootId = cursor.id;
  }
  const node = await trainNode(deps, train, 0);
  const ledger = (await listForgeLedger(deps.db, "train", id, 100)).map((r) => ({ kind: r.kind, body: r.body, at: r.created_at }));
  return { ...node, rootId, ledger };
}

// claim_conflict: open -> claimed (attempt-capped by policy), and the
// dropped intent conflicted -> replaying.
export async function claimConflictFor(
  deps: TrainDeps,
  conflictId: string,
  agent: string,
): Promise<{ conflict: Conflict; intent: Intent } | ForgeError> {
  const conflict = await getConflict(deps.db, conflictId);
  if (!conflict) return { error: "not-found", message: "conflict not found" };
  const policy = await loadPolicy(deps, conflict.repo);
  if (!(await claimConflict(deps.db, conflictId, agent, policy.replay.maxAttempts))) {
    return { error: "not-claimable", message: `conflict is ${conflict.state} (attempts ${conflict.attempts}/${policy.replay.maxAttempts})` };
  }
  const intent = await getIntent(deps.db, conflict.intentA);
  if (intent?.state === "conflicted") await transitionIntent(deps.db, intent.id, "conflicted", "replaying", {}, agent);
  const after = await getConflict(deps.db, conflictId);
  const i = await getIntent(deps.db, conflict.intentA);
  if (!after || !i) return { error: "not-found", message: "intent not found" };
  return { conflict: after, intent: i };
}

// resolve_conflict: the resolver pushed a replay of the intent on the new
// trunk. The intent re-enters `ready` with the replay as its head (and,
// when the replay lives on a fresh fork, that fork) and lands only via a
// train (invariant 4). `llmReplay` adds the llm_replay risk term.
export async function resolveConflictFor(
  deps: TrainDeps,
  conflictId: string,
  agent: string,
  sha: string,
  opts: { forkRepo?: string; llmReplay?: boolean } = {},
): Promise<{ conflict: Conflict; enqueue: EnqueueResult | ForgeError } | ForgeError> {
  const conflict = await getConflict(deps.db, conflictId);
  if (!conflict) return { error: "not-found", message: "conflict not found" };
  if (opts.forkRepo !== undefined && !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(opts.forkRepo)) {
    return { error: "invalid-fork", message: "fork repo name is invalid" };
  }
  const pre = await getIntent(deps.db, conflict.intentA);
  if (!pre) return { error: "not-found", message: "intent not found" };
  const base = (await trunkMainSha(deps, conflict.repo)) ?? pre.baseSha;
  // The replay is a new diff: its footprint (what it really touches)
  // replaces the old one, so risk is scored on the replay, not on the
  // change that conflicted (review #6). Fail closed when it can't be read.
  let replayFootprint: string[] | null = null;
  if (deps.artifacts) {
    const fork = opts.forkRepo ?? pre.forkRepo ?? "";
    const diff = fork ? await changedFiles(deps.artifacts, fork, base, sha.toLowerCase()) : null;
    if (!diff) return { error: "footprint-unavailable", message: "could not diff the replay against trunk; retry" };
    replayFootprint = diff.changed.slice(0, 500);
  }
  if (!(await resolveConflict(deps.db, conflictId, agent, sha))) {
    return { error: "not-resolvable", message: `conflict is ${conflict.state} or claimed by another agent` };
  }
  const intent = (await getIntent(deps.db, conflict.intentA)) ?? pre;
  if (replayFootprint) {
    await deps.db
      .prepare("UPDATE intents SET actual_footprint_json = ? WHERE id = ? AND state = 'replaying'")
      .bind(JSON.stringify({ paths: replayFootprint }), intent.id)
      .run();
  }
  if (opts.forkRepo) {
    await deps.db.prepare("UPDATE intents SET fork_repo = ?, updated_at = ? WHERE id = ? AND state = 'replaying'").bind(opts.forkRepo, nowIso(), intent.id).run();
  }
  if (opts.llmReplay) {
    await appendForgeLedger(deps.db, { repo: conflict.repo, subjectKind: "intent", subjectId: intent.id, kind: "llm_replay", body: `conflict ${conflictId}`, actor: agent });
  }
  await appendForgeLedger(deps.db, {
    repo: conflict.repo,
    subjectKind: "intent",
    subjectId: intent.id,
    kind: "decision",
    body: `replayed on trunk ${base.slice(0, 12)} after conflict ${conflictId.slice(0, 8)} with ${conflict.intentB === "trunk" ? "trunk" : `intent ${conflict.intentB.slice(0, 8)}`} on ${conflict.files.slice(0, 5).join(", ") || "(unknown files)"}`,
    actor: agent,
  });
  const moved = await transitionIntent(deps.db, intent.id, "replaying", "ready", { headSha: sha.toLowerCase(), baseSha: base }, agent);
  if (!moved) return { error: "conflict", message: `intent is ${intent.state}, expected replaying` };
  await appendForgeLedger(deps.db, { repo: conflict.repo, subjectKind: "conflict", subjectId: conflictId, kind: "resolved", body: `${agent} replayed at ${sha.slice(0, 12)} on trunk ${base.slice(0, 12)}`, actor: agent });
  const after = (await getConflict(deps.db, conflictId)) ?? conflict;
  const enqueue = await enqueueReady(deps, intent.id);
  return { conflict: after, enqueue };
}

export { isForgeError, listConflicts };
