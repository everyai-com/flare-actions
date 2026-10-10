// Flare Forge D1 access: goals, intents (with their fork + lease),
// conflicts, trains, the per-intent mailbox and the forge ledger.
//
// Every state change is a conditional write (`WHERE id = ? AND state =
// ?`): a lost race returns false/null, never a double transition. No
// query binds more than a handful of params (D1 caps at 100). Pure
// rules (lifecycle, footprints, risk, policy) live in intents-core.ts;
// contracts are listed in docs/FORGE.md.
import { type Db, nowIso } from "./db";
import type { TournamentArtifacts, TournamentRepoHandle } from "./tournaments";
import {
  canTransition,
  canTransitionConflict,
  canTransitionTrain,
  DEFAULT_POLICY,
  driftPaths,
  intentForkName,
  isIntentState,
  normalizeFootprint,
  protectedMatches,
  scoreRisk,
  validateAccept,
  validateAgent,
  validateGoalText,
  validateMessageBody,
  validateReasoning,
  validateSha,
  validateTitle,
  type Conflict,
  type ConflictState,
  type Footprint,
  type ForgePolicy,
  type Goal,
  type GoalState,
  type Intent,
  type IntentState,
  type RiskTerm,
  type Train,
  type TrainState,
} from "./intents-core";

// Write tokens minted for an intent's fork live one hour (§3.2 inv. 1).
export const FORK_TOKEN_TTL_SECONDS = 3600;
// Default advisory lease; the Coordinator may pass its own TTL.
export const DEFAULT_LEASE_TTL_SECONDS = 300;
const MAX_LIST = 200;
const REPO_RE = /^[\w.\-/]{1,200}$/;

// ---------------------------------------------------------------------------
// Row types (D1 shape) + mappers to the parsed core types
// ---------------------------------------------------------------------------

export interface GoalRow {
  id: string;
  repo: string;
  text: string;
  created_by: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface IntentRow {
  id: string;
  goal_id: string | null;
  repo: string;
  agent: string;
  title: string;
  reasoning: string;
  accept_check: string;
  footprint_json: string;
  actual_footprint_json: string | null;
  fork_repo: string | null;
  state: string;
  risk: number;
  risk_terms_json: string;
  base_sha: string;
  head_sha: string;
  train_id: string | null;
  landed_sha: string | null;
  plan_approved_by: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConflictRow {
  id: string;
  repo: string;
  intent_a: string;
  intent_b: string;
  files_json: string;
  state: string;
  resolver_agent: string | null;
  resolution_sha: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface TrainRow {
  id: string;
  repo: string;
  lane: number;
  base_sha: string;
  head_sha: string;
  intents_json: string;
  run_id: string | null;
  state: string;
  parent_train_id: string | null;
  group_seq: number | null;
  created_at: string;
  updated_at: string;
}

export interface IntentMessageRow {
  id: string;
  repo: string;
  to_intent: string;
  from_intent: string | null;
  from_agent: string;
  body: string;
  created_at: string;
  delivered_at: string | null;
}

export type ForgeSubjectKind = "goal" | "intent" | "conflict" | "train";

export interface ForgeLedgerRow {
  id: string;
  repo: string;
  subject_kind: ForgeSubjectKind;
  subject_id: string;
  kind: string;
  body: string;
  actor: string;
  created_at: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseFootprint(text: string | null): Footprint | null {
  if (text === null) return null;
  const r = normalizeFootprint(parseJson<unknown>(text, { paths: [] }));
  return r.ok ? r.value : { paths: [] };
}

function stringArray(text: string): string[] {
  const v = parseJson<unknown>(text, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    repo: row.repo,
    text: row.text,
    createdBy: row.created_by,
    state: row.state as GoalState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toIntent(row: IntentRow): Intent {
  return {
    id: row.id,
    goalId: row.goal_id,
    repo: row.repo,
    agent: row.agent,
    title: row.title,
    reasoning: row.reasoning,
    accept: row.accept_check,
    footprint: parseFootprint(row.footprint_json) ?? { paths: [] },
    actualFootprint: parseFootprint(row.actual_footprint_json),
    forkRepo: row.fork_repo,
    state: isIntentState(row.state) ? row.state : "failed",
    risk: row.risk,
    riskTerms: parseJson<RiskTerm[]>(row.risk_terms_json, []),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    trainId: row.train_id,
    landedSha: row.landed_sha,
    planApprovedBy: row.plan_approved_by,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toConflict(row: ConflictRow): Conflict {
  return {
    id: row.id,
    repo: row.repo,
    intentA: row.intent_a,
    intentB: row.intent_b,
    files: stringArray(row.files_json),
    state: row.state as ConflictState,
    resolverAgent: row.resolver_agent,
    resolutionSha: row.resolution_sha,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTrain(row: TrainRow): Train {
  return {
    id: row.id,
    repo: row.repo,
    lane: row.lane,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    intentIds: stringArray(row.intents_json),
    runId: row.run_id,
    state: row.state as TrainState,
    parentTrainId: row.parent_train_id,
    groupSeq: row.group_seq ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function changed(stmt: { run(): Promise<unknown> }): Promise<boolean> {
  const res = (await stmt.run()) as { meta?: { changes?: number } } | null;
  return (res?.meta?.changes ?? 0) > 0;
}

function clampLimit(limit: number | undefined, dflt = 50): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return dflt;
  return Math.max(1, Math.min(MAX_LIST, Math.floor(limit)));
}

function isoPlus(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1000).toISOString();
}

export function validateRepo(repo: unknown): repo is string {
  return typeof repo === "string" && REPO_RE.test(repo) && !repo.includes("..");
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export async function appendForgeLedger(
  db: Db,
  entry: { repo: string; subjectKind: ForgeSubjectKind; subjectId: string; kind: string; body?: string; actor?: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO forge_ledger (id, repo, subject_kind, subject_id, kind, body, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      entry.repo.slice(0, 200),
      entry.subjectKind,
      entry.subjectId.slice(0, 64),
      entry.kind.slice(0, 40),
      (entry.body ?? "").slice(0, 2000),
      (entry.actor ?? "").slice(0, 100),
      nowIso(),
    )
    .run();
}

export async function listForgeLedger(
  db: Db,
  subjectKind: ForgeSubjectKind,
  subjectId: string,
  limit?: number,
): Promise<ForgeLedgerRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM forge_ledger WHERE subject_kind = ? AND subject_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
    )
    .bind(subjectKind, subjectId, clampLimit(limit, 100))
    .all<ForgeLedgerRow>();
  return res.results;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export type ForgeError = { error: string; message: string };

export async function createGoal(
  db: Db,
  input: { repo: string; text: string; createdBy?: string },
): Promise<Goal | ForgeError> {
  if (!validateRepo(input.repo)) return { error: "invalid-repo", message: "repo must be an Artifacts repo name" };
  const text = validateGoalText(input.text);
  if (!text.ok) return { error: "invalid-goal", message: text.error };
  const now = nowIso();
  const row: GoalRow = {
    id: crypto.randomUUID(),
    repo: input.repo,
    text: text.value,
    created_by: (input.createdBy ?? "").slice(0, 100),
    state: "open",
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare("INSERT INTO goals (id, repo, text, created_by, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.repo, row.text, row.created_by, row.state, now, now)
    .run();
  await appendForgeLedger(db, { repo: row.repo, subjectKind: "goal", subjectId: row.id, kind: "opened", body: row.text.slice(0, 500), actor: row.created_by });
  return toGoal(row);
}

export async function getGoal(db: Db, id: string): Promise<Goal | null> {
  const row = await db.prepare("SELECT * FROM goals WHERE id = ?").bind(id).first<GoalRow>();
  return row ? toGoal(row) : null;
}

export async function listGoals(db: Db, repo: string, opts: { state?: GoalState; limit?: number } = {}): Promise<Goal[]> {
  const limit = clampLimit(opts.limit);
  const res = opts.state
    ? await db
        .prepare("SELECT * FROM goals WHERE repo = ? AND state = ? ORDER BY created_at DESC LIMIT ?")
        .bind(repo, opts.state, limit)
        .all<GoalRow>()
    : await db.prepare("SELECT * FROM goals WHERE repo = ? ORDER BY created_at DESC LIMIT ?").bind(repo, limit).all<GoalRow>();
  return res.results.map(toGoal);
}

export async function setGoalState(db: Db, id: string, from: GoalState, to: GoalState): Promise<boolean> {
  return changed(
    db.prepare("UPDATE goals SET state = ?, updated_at = ? WHERE id = ? AND state = ?").bind(to, nowIso(), id, from),
  );
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export interface DeclareIntentInput {
  repo: string;
  goalId?: string | null;
  agent?: string;
  title: unknown;
  reasoning?: unknown;
  accept?: unknown;
  footprint: unknown;
  baseSha?: string;
  policy?: ForgePolicy;
}

// Insert a new intent. Protected footprints (policy) start at
// `awaiting_plan`; everything else at `draft` (claimable). The initial
// risk covers the declare-time terms (protected path + size).
export async function declareIntent(
  db: Db,
  input: DeclareIntentInput,
): Promise<{ intent: Intent; protectedHits: string[] } | ForgeError> {
  if (!validateRepo(input.repo)) return { error: "invalid-repo", message: "repo must be an Artifacts repo name" };
  const title = validateTitle(input.title);
  if (!title.ok) return { error: "invalid-intent", message: title.error };
  const reasoning = validateReasoning(input.reasoning);
  if (!reasoning.ok) return { error: "invalid-intent", message: reasoning.error };
  const accept = validateAccept(input.accept);
  if (!accept.ok) return { error: "invalid-intent", message: accept.error };
  const footprint = normalizeFootprint(input.footprint);
  if (!footprint.ok) return { error: "invalid-footprint", message: footprint.error };
  let agent = "";
  if (input.agent !== undefined && input.agent !== "") {
    const a = validateAgent(input.agent);
    if (!a.ok) return { error: "invalid-agent", message: a.error };
    agent = a.value;
  }
  let baseSha = "";
  if (input.baseSha) {
    const s = validateSha(input.baseSha);
    if (!s.ok) return { error: "invalid-sha", message: s.error };
    baseSha = s.value;
  }
  const goalId = input.goalId ?? null;
  if (goalId) {
    const goal = await getGoal(db, goalId);
    if (!goal || goal.repo !== input.repo) return { error: "goal-not-found", message: "goal not found in this repo" };
    if (goal.state !== "open") return { error: "goal-closed", message: `goal is ${goal.state}` };
  }
  const policy = input.policy ?? DEFAULT_POLICY;
  const protectedHits = protectedMatches(footprint.value, policy);
  const { risk, terms } = scoreRisk({ footprint: footprint.value, policy });
  const now = nowIso();
  const row: IntentRow = {
    id: crypto.randomUUID(),
    goal_id: goalId,
    repo: input.repo,
    agent,
    title: title.value,
    reasoning: reasoning.value,
    accept_check: accept.value,
    footprint_json: JSON.stringify(footprint.value),
    actual_footprint_json: null,
    fork_repo: null,
    state: protectedHits.length ? "awaiting_plan" : "draft",
    risk,
    risk_terms_json: JSON.stringify(terms),
    base_sha: baseSha,
    head_sha: "",
    train_id: null,
    landed_sha: null,
    plan_approved_by: null,
    lease_expires_at: null,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO intents (id, goal_id, repo, agent, title, reasoning, accept_check, footprint_json, state, risk,
        risk_terms_json, base_sha, head_sha, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
    )
    .bind(
      row.id,
      row.goal_id,
      row.repo,
      row.agent,
      row.title,
      row.reasoning,
      row.accept_check,
      row.footprint_json,
      row.state,
      row.risk,
      row.risk_terms_json,
      row.base_sha,
      now,
      now,
    )
    .run();
  await appendForgeLedger(db, {
    repo: row.repo,
    subjectKind: "intent",
    subjectId: row.id,
    kind: "declared",
    body: protectedHits.length ? `${row.title} (awaiting plan: ${protectedHits.join(", ")})` : row.title,
    actor: agent,
  });
  return { intent: toIntent(row), protectedHits };
}

export async function getIntent(db: Db, id: string): Promise<Intent | null> {
  const row = await db.prepare("SELECT * FROM intents WHERE id = ?").bind(id).first<IntentRow>();
  return row ? toIntent(row) : null;
}

export async function getIntentByFork(db: Db, forkRepo: string): Promise<Intent | null> {
  const row = await db.prepare("SELECT * FROM intents WHERE fork_repo = ?").bind(forkRepo).first<IntentRow>();
  return row ? toIntent(row) : null;
}

export interface ListIntentsFilter {
  state?: IntentState;
  goalId?: string;
  agent?: string;
  limit?: number;
  // Keyset cursor: return rows created strictly before this ISO time.
  before?: string;
}

// Newest first. One optional equality filter per column; bound params
// stay tiny regardless of filters.
export async function listIntents(db: Db, repo: string, filter: ListIntentsFilter = {}): Promise<Intent[]> {
  const where = ["repo = ?"];
  const binds: unknown[] = [repo];
  if (filter.state) {
    where.push("state = ?");
    binds.push(filter.state);
  }
  if (filter.goalId) {
    where.push("goal_id = ?");
    binds.push(filter.goalId);
  }
  if (filter.agent) {
    where.push("agent = ?");
    binds.push(filter.agent);
  }
  if (filter.before) {
    where.push("created_at < ?");
    binds.push(filter.before);
  }
  binds.push(clampLimit(filter.limit));
  const res = await db
    .prepare(`SELECT * FROM intents WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...binds)
    .all<IntentRow>();
  return res.results.map(toIntent);
}

// Whitelisted columns a transition may stamp alongside the state.
export interface IntentPatch {
  trainId?: string | null;
  landedSha?: string | null;
  headSha?: string;
  baseSha?: string;
  risk?: number;
  riskTerms?: RiskTerm[];
  leaseExpiresAt?: string | null;
}

function patchSql(patch: IntentPatch): { sets: string[]; binds: unknown[] } {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.trainId !== undefined) {
    sets.push("train_id = ?");
    binds.push(patch.trainId);
  }
  if (patch.landedSha !== undefined) {
    sets.push("landed_sha = ?");
    binds.push(patch.landedSha);
  }
  if (patch.headSha !== undefined) {
    sets.push("head_sha = ?");
    binds.push(patch.headSha);
  }
  if (patch.baseSha !== undefined) {
    sets.push("base_sha = ?");
    binds.push(patch.baseSha);
  }
  if (patch.risk !== undefined) {
    sets.push("risk = ?");
    binds.push(Math.max(0, Math.min(100, Math.round(patch.risk))));
  }
  if (patch.riskTerms !== undefined) {
    sets.push("risk_terms_json = ?");
    binds.push(JSON.stringify(patch.riskTerms));
  }
  if (patch.leaseExpiresAt !== undefined) {
    sets.push("lease_expires_at = ?");
    binds.push(patch.leaseExpiresAt);
  }
  return { sets, binds };
}

// Conditional state change: applies only when the row is still in
// `from` and the lifecycle allows `from -> to`. Returns false on an
// illegal edge or a lost race (someone else moved it first).
export async function transitionIntent(
  db: Db,
  id: string,
  from: IntentState,
  to: IntentState,
  patch: IntentPatch = {},
  actor = "",
): Promise<boolean> {
  if (!canTransition(from, to)) return false;
  const { sets, binds } = patchSql(patch);
  const ok = await changed(
    db
      .prepare(`UPDATE intents SET state = ?, ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ? AND state = ?`)
      .bind(to, ...binds, nowIso(), id, from),
  );
  if (ok) {
    const row = await db.prepare("SELECT repo FROM intents WHERE id = ?").bind(id).first<{ repo: string }>();
    await appendForgeLedger(db, { repo: row?.repo ?? "", subjectKind: "intent", subjectId: id, kind: to, body: `${from} -> ${to}`, actor });
  }
  return ok;
}

// Human plan approval: awaiting_plan -> draft (claimable), stamping the
// approver. Rejection is transitionIntent(id, "awaiting_plan", "abandoned").
export async function approvePlan(db: Db, id: string, approvedBy: string): Promise<boolean> {
  const by = approvedBy.trim().slice(0, 100);
  if (!by) return false;
  const ok = await changed(
    db
      .prepare(
        "UPDATE intents SET state = 'draft', plan_approved_by = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_plan'",
      )
      .bind(by, nowIso(), id),
  );
  if (ok) {
    const row = await db.prepare("SELECT repo FROM intents WHERE id = ?").bind(id).first<{ repo: string }>();
    await appendForgeLedger(db, { repo: row?.repo ?? "", subjectKind: "intent", subjectId: id, kind: "plan_approved", body: by, actor: by });
  }
  return ok;
}

// The Artifacts surface a claim needs: trunk fork + fork-scoped token.
// Same binding shape as tournaments (TournamentArtifacts).
export type ForgeArtifacts = TournamentArtifacts;

export type ClaimIntentResult =
  | { intent: Intent; forkRepo: string; remote: string; token: string; tokenExpiresAt: string }
  | { error: "invalid-agent" | "not-found" | "not-claimable" | "fork-failed" | "token-failed"; message: string };

function isAlreadyExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ALREADY_EXISTS";
}

function dispose(handle: TournamentRepoHandle | null): void {
  try {
    handle?.[Symbol.dispose]?.();
  } catch {
    // Disposal must never fail the claim.
  }
}

// Revoke every active token on a fork (the Artifacts handle's token
// API). Null = could not revoke (API missing or a call failed); the
// caller fails closed. Revoked/expired entries are skipped.
async function revokeForkTokens(handle: TournamentRepoHandle): Promise<number | null> {
  const h = handle as TournamentRepoHandle & {
    listTokens?: () => Promise<unknown>;
    revokeToken?: (tokenOrId: string) => Promise<boolean>;
  };
  if (typeof h.listTokens !== "function" || typeof h.revokeToken !== "function") return null;
  try {
    const list = await h.listTokens();
    const tokens: unknown[] = Array.isArray(list)
      ? list
      : typeof list === "object" && list !== null && Array.isArray((list as { tokens?: unknown }).tokens)
        ? (list as { tokens: unknown[] }).tokens
        : [];
    let count = 0;
    for (const t of tokens) {
      if (typeof t !== "object" || t === null) continue;
      const { id, state } = t as { id?: unknown; state?: unknown };
      if (typeof id !== "string" || !id || state === "revoked" || state === "expired") continue;
      if (await h.revokeToken(id)) count += 1;
    }
    return count;
  } catch {
    return null;
  }
}

// Claim: draft|expired -> claimed (conditional; the row wins first so a
// lost race never forks), then fork trunk to `i-<shortid>` (an existing
// fork from a prior claim is reused, with every token on it revoked
// first) and mint a fork-scoped write token (1 h). A fork/token failure releases the claim back to its prior
// state. The agent never receives a trunk token (§3.2 invariant 1).
export async function claimIntent(
  db: Db,
  artifacts: ForgeArtifacts,
  input: { id: string; agent: string; leaseTtlSeconds?: number },
): Promise<ClaimIntentResult> {
  const a = validateAgent(input.agent);
  if (!a.ok) return { error: "invalid-agent", message: a.error };
  const current = await getIntent(db, input.id);
  if (!current) return { error: "not-found", message: "intent not found" };
  if (current.state !== "draft" && current.state !== "expired") {
    return { error: "not-claimable", message: `intent is ${current.state}` };
  }
  const from = current.state;
  const forkRepo = intentForkName(current.id);
  const now = nowIso();
  const lease = isoPlus(now, input.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS);
  const won = await changed(
    db
      .prepare(
        "UPDATE intents SET state = 'claimed', agent = ?, fork_repo = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = ?",
      )
      .bind(a.value, forkRepo, lease, now, current.id, from),
  );
  if (!won) return { error: "not-claimable", message: "intent was claimed concurrently" };

  const release = async (): Promise<void> => {
    await db
      .prepare("UPDATE intents SET state = ?, updated_at = ? WHERE id = ? AND state = 'claimed' AND agent = ?")
      .bind(from, nowIso(), current.id, a.value)
      .run()
      .catch(() => undefined);
  };

  let remote = "";
  let reused = from === "expired";
  let trunk: TournamentRepoHandle | null = null;
  try {
    trunk = await artifacts.get(current.repo);
    try {
      const forked = await trunk.fork(forkRepo, { defaultBranchOnly: true });
      remote = forked.remote;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      reused = true;
    }
  } catch {
    await release();
    return { error: "fork-failed", message: "could not fork trunk" };
  } finally {
    dispose(trunk);
  }

  let token = "";
  let revoked = 0;
  let fork: TournamentRepoHandle | null = null;
  try {
    fork = await artifacts.get(forkRepo);
    if (reused) {
      // Re-claim of a fork a previous holder wrote to: its token may
      // still be live (1 h TTL outlives a lapsed lease). Revoke every
      // token on the fork BEFORE minting the new holder's, so exactly
      // one agent can push. Fails closed: no revoke, no claim.
      const count = await revokeForkTokens(fork);
      if (count === null) {
        await release();
        return { error: "token-failed", message: "could not revoke the previous holder's fork tokens" };
      }
      revoked = count;
    }
    const out = await fork.createToken("write", FORK_TOKEN_TTL_SECONDS);
    const plaintext = typeof out === "string" ? out : out.plaintext;
    token = typeof plaintext === "string" ? plaintext : "";
    if (!remote) {
      // Reused fork: the handle may expose its remote URL.
      const r: unknown = "remote" in fork ? fork.remote : undefined;
      if (typeof r === "string") remote = r;
    }
  } catch {
    token = "";
  } finally {
    dispose(fork);
  }
  if (!token) {
    await release();
    return { error: "token-failed", message: "could not mint a fork write token" };
  }
  await appendForgeLedger(db, {
    repo: current.repo,
    subjectKind: "intent",
    subjectId: current.id,
    kind: "claimed",
    body: `${a.value} -> ${forkRepo}${reused ? ` (re-claim; revoked ${revoked} prior token(s))` : ""}`,
    actor: a.value,
  });
  const intent = await getIntent(db, current.id);
  return {
    intent: intent ?? { ...current, state: "claimed", agent: a.value, forkRepo, leaseExpiresAt: lease },
    forkRepo,
    remote,
    token,
    tokenExpiresAt: isoPlus(now, FORK_TOKEN_TTL_SECONDS),
  };
}

// Renew the lease of a live intent owned by `agent`. False when the
// intent is not leased by that agent (expired, moved on, re-claimed).
export async function heartbeatIntent(
  db: Db,
  id: string,
  agent: string,
  ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
): Promise<string | null> {
  const now = nowIso();
  const lease = isoPlus(now, ttlSeconds);
  const ok = await changed(
    db
      .prepare(
        "UPDATE intents SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND agent = ? AND state IN ('claimed', 'working', 'ready', 'replaying')",
      )
      .bind(lease, now, id, agent),
  );
  return ok ? lease : null;
}

// Move claimed/working intents whose lease lapsed to `expired` (open for
// re-claim). Bounded per call; returns the expired ids.
export async function expireLeases(db: Db, now = nowIso(), limit = 100): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT id, repo, state FROM intents WHERE state IN ('claimed', 'working') AND lease_expires_at IS NOT NULL AND lease_expires_at < ? ORDER BY lease_expires_at ASC LIMIT ?",
    )
    .bind(now, clampLimit(limit, 100))
    .all<{ id: string; repo: string; state: string }>();
  const out: string[] = [];
  for (const row of rows.results) {
    const ok = await changed(
      db
        .prepare(
          "UPDATE intents SET state = 'expired', updated_at = ? WHERE id = ? AND state = ? AND lease_expires_at < ?",
        )
        .bind(nowIso(), row.id, row.state, now),
    );
    if (ok) {
      out.push(row.id);
      await appendForgeLedger(db, { repo: row.repo, subjectKind: "intent", subjectId: row.id, kind: "expired", body: `${row.state} -> expired` });
    }
  }
  return out;
}

export interface RecordPushResult {
  intent: Intent;
  drift: string[];
  risk: number;
  riskTerms: RiskTerm[];
}

// report_push: stamp the head SHA + actual footprint (concrete files),
// recompute risk (drift etc.), and move claimed|ready -> working.
// Conditional on the pushing agent still owning a pushable state.
export async function recordPush(
  db: Db,
  input: { id: string; agent: string; headSha: string; actualFootprint: unknown; policy?: ForgePolicy },
): Promise<RecordPushResult | ForgeError> {
  const sha = validateSha(input.headSha);
  if (!sha.ok) return { error: "invalid-sha", message: sha.error };
  const actual = normalizeFootprint(input.actualFootprint);
  if (!actual.ok) return { error: "invalid-footprint", message: actual.error };
  const current = await getIntent(db, input.id);
  if (!current) return { error: "not-found", message: "intent not found" };
  if (current.agent !== input.agent) return { error: "not-owner", message: "intent is owned by another agent" };
  const from = current.state;
  if (from !== "claimed" && from !== "working" && from !== "ready" && from !== "replaying") {
    return { error: "not-pushable", message: `intent is ${from}` };
  }
  // replaying stays replaying (a resolution push); everything else works.
  const to: IntentState = from === "replaying" ? "replaying" : "working";
  const policy = input.policy ?? DEFAULT_POLICY;
  const scored = scoreRisk({ footprint: current.footprint, actualFootprint: actual.value, policy });
  const ok = await changed(
    db
      .prepare(
        "UPDATE intents SET state = ?, head_sha = ?, actual_footprint_json = ?, risk = ?, risk_terms_json = ?, updated_at = ? WHERE id = ? AND state = ? AND agent = ?",
      )
      .bind(to, sha.value, JSON.stringify(actual.value), scored.risk, JSON.stringify(scored.terms), nowIso(), current.id, from, input.agent),
  );
  if (!ok) return { error: "conflict", message: "intent changed concurrently; retry" };
  const drift = driftPaths(current.footprint, actual.value);
  await appendForgeLedger(db, {
    repo: current.repo,
    subjectKind: "intent",
    subjectId: current.id,
    kind: "pushed",
    body: `${sha.value}${drift.length ? ` drift: ${drift.slice(0, 10).join(", ")}` : ""}`,
    actor: input.agent,
  });
  const intent = (await getIntent(db, current.id)) ?? current;
  return { intent, drift, risk: scored.risk, riskTerms: scored.terms };
}

// mark_ready: working -> ready for the owning agent (requires a push).
export async function markReady(db: Db, id: string, agent: string): Promise<Intent | ForgeError> {
  const current = await getIntent(db, id);
  if (!current) return { error: "not-found", message: "intent not found" };
  if (current.agent !== agent) return { error: "not-owner", message: "intent is owned by another agent" };
  if (current.state !== "working" || !current.headSha) {
    return { error: "not-ready", message: current.state === "claimed" ? "push first (report_push)" : `intent is ${current.state}` };
  }
  const ok = await transitionIntent(db, id, "working", "ready", {}, agent);
  if (!ok) return { error: "conflict", message: "intent changed concurrently; retry" };
  return (await getIntent(db, id)) ?? { ...current, state: "ready" };
}

// ---------------------------------------------------------------------------
// Mailbox (§3.2 invariant 5: bodies are untrusted peer data)
// ---------------------------------------------------------------------------

export async function sendMessage(
  db: Db,
  input: { toIntent: string; fromIntent?: string | null; fromAgent: string; body: unknown },
): Promise<IntentMessageRow | ForgeError> {
  const body = validateMessageBody(input.body);
  if (!body.ok) return { error: "invalid-message", message: body.error };
  const target = await db.prepare("SELECT repo, state FROM intents WHERE id = ?").bind(input.toIntent).first<{ repo: string; state: string }>();
  if (!target) return { error: "not-found", message: "recipient intent not found" };
  const row: IntentMessageRow = {
    id: crypto.randomUUID(),
    repo: target.repo,
    to_intent: input.toIntent,
    from_intent: input.fromIntent ?? null,
    from_agent: input.fromAgent.slice(0, 40),
    body: body.value,
    created_at: nowIso(),
    delivered_at: null,
  };
  await db
    .prepare(
      "INSERT INTO intent_messages (id, repo, to_intent, from_intent, from_agent, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(row.id, row.repo, row.to_intent, row.from_intent, row.from_agent, row.body, row.created_at)
    .run();
  return row;
}

// Deliver undelivered messages oldest-first, marking each conditionally
// so two concurrent drains never hand the same message out twice.
export async function drainInbox(db: Db, toIntent: string, limit = 20): Promise<IntentMessageRow[]> {
  const rows = await db
    .prepare(
      "SELECT * FROM intent_messages WHERE to_intent = ? AND delivered_at IS NULL ORDER BY created_at ASC, rowid ASC LIMIT ?",
    )
    .bind(toIntent, clampLimit(limit, 20))
    .all<IntentMessageRow>();
  const out: IntentMessageRow[] = [];
  const now = nowIso();
  for (const row of rows.results) {
    const ok = await changed(
      db.prepare("UPDATE intent_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL").bind(now, row.id),
    );
    if (ok) out.push({ ...row, delivered_at: now });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export async function openConflict(
  db: Db,
  input: { repo: string; intentA: string; intentB: string; files: string[] },
): Promise<Conflict> {
  const now = nowIso();
  const row: ConflictRow = {
    id: crypto.randomUUID(),
    repo: input.repo,
    intent_a: input.intentA,
    intent_b: input.intentB,
    files_json: JSON.stringify(input.files.slice(0, 200)),
    state: "open",
    resolver_agent: null,
    resolution_sha: null,
    attempts: 0,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      "INSERT INTO conflicts (id, repo, intent_a, intent_b, files_json, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?)",
    )
    .bind(row.id, row.repo, row.intent_a, row.intent_b, row.files_json, now, now)
    .run();
  await appendForgeLedger(db, { repo: row.repo, subjectKind: "conflict", subjectId: row.id, kind: "opened", body: `${row.intent_a} x ${row.intent_b}` });
  return toConflict(row);
}

export async function getConflict(db: Db, id: string): Promise<Conflict | null> {
  const row = await db.prepare("SELECT * FROM conflicts WHERE id = ?").bind(id).first<ConflictRow>();
  return row ? toConflict(row) : null;
}

export async function listConflicts(db: Db, repo: string, opts: { state?: ConflictState; limit?: number } = {}): Promise<Conflict[]> {
  const limit = clampLimit(opts.limit);
  const res = opts.state
    ? await db
        .prepare("SELECT * FROM conflicts WHERE repo = ? AND state = ? ORDER BY created_at DESC LIMIT ?")
        .bind(repo, opts.state, limit)
        .all<ConflictRow>()
    : await db.prepare("SELECT * FROM conflicts WHERE repo = ? ORDER BY created_at DESC LIMIT ?").bind(repo, limit).all<ConflictRow>();
  return res.results.map(toConflict);
}

// open -> claimed by `agent`, bumping attempts; bounded by maxAttempts.
export async function claimConflict(db: Db, id: string, agent: string, maxAttempts = DEFAULT_POLICY.replay.maxAttempts): Promise<boolean> {
  return changed(
    db
      .prepare(
        "UPDATE conflicts SET state = 'claimed', resolver_agent = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'open' AND attempts < ?",
      )
      .bind(agent, nowIso(), id, Math.max(1, maxAttempts)),
  );
}

// claimed -> resolved by the claiming agent, recording the replay SHA.
// The resolution still lands only through a train (§3.2 invariant 4).
export async function resolveConflict(db: Db, id: string, agent: string, sha: string): Promise<boolean> {
  const s = validateSha(sha);
  if (!s.ok) return false;
  return changed(
    db
      .prepare(
        "UPDATE conflicts SET state = 'resolved', resolution_sha = ?, updated_at = ? WHERE id = ? AND state = 'claimed' AND resolver_agent = ?",
      )
      .bind(s.value, nowIso(), id, agent),
  );
}

export async function transitionConflict(db: Db, id: string, from: ConflictState, to: ConflictState): Promise<boolean> {
  if (!canTransitionConflict(from, to)) return false;
  return changed(
    db.prepare("UPDATE conflicts SET state = ?, updated_at = ? WHERE id = ? AND state = ?").bind(to, nowIso(), id, from),
  );
}

// ---------------------------------------------------------------------------
// Trains
// ---------------------------------------------------------------------------

export async function createTrain(
  db: Db,
  input: { repo: string; lane: number; baseSha: string; intentIds: string[]; parentTrainId?: string | null; groupSeq?: number },
): Promise<Train> {
  const now = nowIso();
  const row: TrainRow = {
    id: crypto.randomUUID(),
    repo: input.repo,
    // -1 = no lane-ref slot yet (a bisect probe waiting for one).
    lane: Math.max(-1, Math.floor(input.lane)),
    base_sha: input.baseSha,
    head_sha: "",
    intents_json: JSON.stringify(input.intentIds.slice(0, 500)),
    run_id: null,
    state: "forming",
    parent_train_id: input.parentTrainId ?? null,
    group_seq: Math.max(0, Math.floor(input.groupSeq ?? 0)),
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      "INSERT INTO trains (id, repo, lane, base_sha, head_sha, intents_json, state, parent_train_id, group_seq, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 'forming', ?, ?, ?, ?)",
    )
    .bind(row.id, row.repo, row.lane, row.base_sha, row.intents_json, row.parent_train_id, row.group_seq, now, now)
    .run();
  await appendForgeLedger(db, { repo: row.repo, subjectKind: "train", subjectId: row.id, kind: "forming", body: `${input.intentIds.length} intents, lane ${row.lane}` });
  return toTrain(row);
}

export async function getTrain(db: Db, id: string): Promise<Train | null> {
  const row = await db.prepare("SELECT * FROM trains WHERE id = ?").bind(id).first<TrainRow>();
  return row ? toTrain(row) : null;
}

export async function listTrains(db: Db, repo: string, opts: { state?: TrainState; limit?: number } = {}): Promise<Train[]> {
  const limit = clampLimit(opts.limit);
  const res = opts.state
    ? await db
        .prepare("SELECT * FROM trains WHERE repo = ? AND state = ? ORDER BY created_at DESC LIMIT ?")
        .bind(repo, opts.state, limit)
        .all<TrainRow>()
    : await db.prepare("SELECT * FROM trains WHERE repo = ? ORDER BY created_at DESC LIMIT ?").bind(repo, limit).all<TrainRow>();
  return res.results.map(toTrain);
}

// Conditional train state change, optionally stamping head SHA / run id.
export async function transitionTrain(
  db: Db,
  id: string,
  from: TrainState,
  to: TrainState,
  patch: { headSha?: string; runId?: string } = {},
): Promise<boolean> {
  if (!canTransitionTrain(from, to)) return false;
  const sets = ["state = ?"];
  const binds: unknown[] = [to];
  if (patch.headSha !== undefined) {
    sets.push("head_sha = ?");
    binds.push(patch.headSha);
  }
  if (patch.runId !== undefined) {
    sets.push("run_id = ?");
    binds.push(patch.runId);
  }
  sets.push("updated_at = ?");
  binds.push(nowIso());
  const ok = await changed(
    db.prepare(`UPDATE trains SET ${sets.join(", ")} WHERE id = ? AND state = ?`).bind(...binds, id, from),
  );
  if (ok) {
    const row = await db.prepare("SELECT repo FROM trains WHERE id = ?").bind(id).first<{ repo: string }>();
    await appendForgeLedger(db, { repo: row?.repo ?? "", subjectKind: "train", subjectId: id, kind: to, body: `${from} -> ${to}` });
  }
  return ok;
}

export async function getTrainByRun(db: Db, runId: string): Promise<Train | null> {
  const row = await db.prepare("SELECT * FROM trains WHERE run_id = ?").bind(runId).first<TrainRow>();
  return row ? toTrain(row) : null;
}

export function isForgeError(v: unknown): v is ForgeError {
  return typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string";
}
