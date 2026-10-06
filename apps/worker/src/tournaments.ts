// Agent tournaments: one task races N agents in isolated Artifacts
// forks. Claims are atomic (one fork per agent slot); a poller watches
// fork heads and dispatches verification runs on every new push.
//
// Push subscriptions are repo-scoped and not CLI-provisionable, so
// dynamic forks poll instead of subscribing: the same dispatch core as
// artifacts-push.ts, driven by head changes rather than events.
import { type Db, getRun, isTerminal, nowIso } from "./db";
import {
  ARTIFACTS_EVENT,
  loadArtifactsPipeline,
  type ArtifactsDispatchInput,
  type ArtifactsRepoHandle,
} from "./artifacts-push";

export const TOURNAMENT_OPEN = "open";
export const TOURNAMENT_VERIFYING = "verifying";
export const TOURNAMENT_DECIDED = "decided";

export const ATTEMPT_CLAIMED = "claimed";
export const ATTEMPT_PUSHING = "pushing";
export const ATTEMPT_VERIFYING = "verifying";
export const ATTEMPT_TERMINAL = "terminal";

const AGENT_RE = /^[\w.-]{1,40}$/;
const SHA40_RE = /^[0-9a-f]{40}$/i;
const POLL_BATCH = 50;

export interface TournamentRow {
  id: string;
  intent: string;
  source_repo: string;
  base_ref: string;
  base_sha: string;
  state: string;
  winner_run_id: string | null;
  resolved_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  tournament_id: string;
  agent: string;
  fork_repo: string;
  state: string;
  last_seen_sha: string;
  run_id: string | null;
  verdict_rank: number | null;
  created_at: string;
  updated_at: string;
}

export interface VerdictRow {
  tournament_id: string;
  ranking: string;
  rationale: string;
  model: string;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  tournament_id: string;
  kind: string;
  body: string;
  created_at: string;
}

// Binding surface for tournaments: pipeline reads (shared with the push
// trigger) plus fork, head, and tree reads.
export interface TournamentCommit {
  hash: string;
}

export interface TournamentTreeEntry {
  name: string;
  mode: string;
  hash: string;
}

export interface TournamentRepoHandle extends ArtifactsRepoHandle {
  fork(name: string, opts?: { defaultBranchOnly?: boolean }): Promise<{ name: string; remote: string; defaultBranch: string }>;
  log(opts?: { ref?: string; limit?: number }): Promise<TournamentCommit[]>;
  readTree(hash: string): Promise<TournamentTreeEntry[] | null>;
  readCommit(hash: string): Promise<{ treeHash: string } | null>;
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<{ plaintext: string } | string>;
}

export interface TournamentArtifacts {
  get(name: string): Promise<TournamentRepoHandle>;
}

export interface TournamentPollDeps {
  db: Db;
  artifacts: TournamentArtifacts | null;
  namespace: string;
  dispatch: (input: ArtifactsDispatchInput) => Promise<{ runId: string }>;
}

export function forkNameFor(tournamentId: string, agent: string): string {
  const slug = `${tournamentId.slice(0, 8)}-${agent}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `t-${slug || "agent"}`;
}

export async function createTournament(
  db: Db,
  input: { intent: string; sourceRepo: string; baseRef?: string; baseSha?: string },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO tournaments (id, intent, source_repo, base_ref, base_sha, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
    )
    .bind(id, input.intent.slice(0, 2000), input.sourceRepo.slice(0, 200), input.baseRef ?? "main", input.baseSha ?? "", now, now)
    .run();
  await appendLedger(db, id, "opened", input.intent.slice(0, 500));
  return { id };
}

export async function getTournament(db: Db, id: string): Promise<TournamentRow | null> {
  return db.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first<TournamentRow>();
}

export async function appendLedger(db: Db, tournamentId: string, kind: string, body: string): Promise<void> {
  await db
    .prepare("INSERT INTO ledger (id, tournament_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), tournamentId, kind.slice(0, 40), body.slice(0, 2000), nowIso())
    .run();
}

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ALREADY_EXISTS"
  );
}

export type ClaimResult =
  | { attemptId: string; forkRepo: string; remote: string }
  | { error: "invalid-agent" | "tournament-not-open" | "already-claimed" | "fork-failed" };

// Atomic claim: the UNIQUE(tournament_id, agent) row wins first, then the
// fork. A lost race never forks; a failed fork deletes its row (an
// ALREADY_EXISTS fork from a retried claim is reused).
export async function claimAttempt(
  db: Db,
  artifacts: TournamentArtifacts,
  tournamentId: string,
  agent: string,
): Promise<ClaimResult> {
  if (!AGENT_RE.test(agent)) return { error: "invalid-agent" };
  const tournament = await getTournament(db, tournamentId);
  if (!tournament || tournament.state !== TOURNAMENT_OPEN) return { error: "tournament-not-open" };
  const existing = await db
    .prepare("SELECT id FROM attempts WHERE tournament_id = ? AND agent = ?")
    .bind(tournamentId, agent)
    .first<{ id: string }>();
  if (existing) return { error: "already-claimed" };
  const attemptId = crypto.randomUUID();
  const forkRepo = forkNameFor(tournamentId, agent);
  const now = nowIso();
  try {
    await db
      .prepare(
        "INSERT INTO attempts (id, tournament_id, agent, fork_repo, state, last_seen_sha, created_at, updated_at) VALUES (?, ?, ?, ?, 'claimed', '', ?, ?)",
      )
      .bind(attemptId, tournamentId, agent, forkRepo, now, now)
      .run();
  } catch {
    // Lost a same-slot race between the SELECT and the INSERT.
    return { error: "already-claimed" };
  }
  let remote: string;
  let handle = null as TournamentRepoHandle | null;
  try {
    handle = await artifacts.get(tournament.source_repo);
    try {
      const forked = await handle.fork(forkRepo, { defaultBranchOnly: true });
      remote = forked.remote;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      remote = "";
    }
  } catch {
    await db.prepare("DELETE FROM attempts WHERE id = ?").bind(attemptId).run().catch(() => undefined);
    return { error: "fork-failed" };
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail the claim.
    }
  }
  await appendLedger(db, tournamentId, "claimed", `${agent} -> ${forkRepo}`);
  return { attemptId, forkRepo, remote };
}

export async function forkHead(artifacts: TournamentArtifacts, repo: string): Promise<string | null> {
  let handle: TournamentRepoHandle | null = null;
  try {
    handle = await artifacts.get(repo);
    const commits = await handle.log({ limit: 1 });
    const hash = commits[0]?.hash ?? "";
    return SHA40_RE.test(hash) ? hash.toLowerCase() : null;
  } catch {
    return null;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail the poll.
    }
  }
}

async function markTournamentVerifying(db: Db, tournamentId: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare("UPDATE tournaments SET state = 'verifying', updated_at = ? WHERE id = ? AND state = 'open'")
    .bind(now, tournamentId)
    .run();
}

// Head-watch poll: new heads dispatch verification runs; linked runs
// reaching terminal flip their attempts. Attempts may iterate: a fresh
// push after terminal dispatches again. Never throws per-attempt — one
// bad fork must not stall the tournament.
export async function pollTournamentAttempts(deps: TournamentPollDeps): Promise<{
  checked: number;
  dispatched: number;
  terminal: number;
}> {
  const out = { checked: 0, dispatched: 0, terminal: 0 };
  if (!deps.artifacts || !deps.namespace) return out;
  const rows = await deps.db
    .prepare(
      `SELECT a.*, t.base_ref AS base_ref FROM attempts a
       JOIN tournaments t ON t.id = a.tournament_id
       WHERE a.state IN ('claimed', 'pushing', 'verifying', 'terminal') AND t.state != 'decided'
       ORDER BY a.updated_at ASC LIMIT ?`,
    )
    .bind(POLL_BATCH)
    .all<AttemptRow & { base_ref: string }>();
  for (const attempt of rows.results) {
    let head: string | null = null;
    try {
      head = await forkHead(deps.artifacts, attempt.fork_repo);
    } catch {
      head = null;
    }
    if (!head) continue;
    out.checked += 1;
    const now = nowIso();
    try {
      // Terminalize the linked run first, then look for fresher work.
      if (attempt.state === ATTEMPT_VERIFYING && attempt.run_id) {
        const run = await getRun(deps.db, attempt.run_id);
        if (run && isTerminal(run.status)) {
          await deps.db
            .prepare("UPDATE attempts SET state = 'terminal', updated_at = ? WHERE id = ?")
            .bind(now, attempt.id)
            .run();
          await appendLedger(deps.db, attempt.tournament_id, "terminal", `${attempt.agent} run ${run.status}`);
          attempt.state = ATTEMPT_TERMINAL;
          out.terminal += 1;
        }
      }
      if (attempt.state === ATTEMPT_TERMINAL && head === attempt.last_seen_sha) continue;
      if (head === attempt.last_seen_sha && attempt.state !== ATTEMPT_CLAIMED) continue;
      // New head (or first sight): stamp it, then verify when a pipeline
      // exists. Stamping without a pipeline avoids re-reading every tick;
      // any later push moves the head again.
      await deps.db
        .prepare("UPDATE attempts SET last_seen_sha = ?, updated_at = ? WHERE id = ?")
        .bind(head, now, attempt.id)
        .run();
      const pipeline = await loadArtifactsPipeline(deps.artifacts, attempt.fork_repo, head);
      if (!pipeline) {
        if (attempt.state === ATTEMPT_CLAIMED) {
          await deps.db
            .prepare("UPDATE attempts SET state = 'pushing', updated_at = ? WHERE id = ?")
            .bind(now, attempt.id)
            .run();
        }
        continue;
      }
      const dispatched = await deps.dispatch({
        repo: `${deps.namespace}/${attempt.fork_repo}`,
        sha: head,
        ref: `refs/heads/${attempt.base_ref || "main"}`,
        pipeline,
        event: ARTIFACTS_EVENT,
      });
      await deps.db
        .prepare("UPDATE attempts SET state = 'verifying', run_id = ?, updated_at = ? WHERE id = ?")
        .bind(dispatched.runId, now, attempt.id)
        .run();
      await markTournamentVerifying(deps.db, attempt.tournament_id);
      await appendLedger(deps.db, attempt.tournament_id, "pushed", `${attempt.agent}@${head.slice(0, 7)} -> ${dispatched.runId}`);
      out.dispatched += 1;
    } catch {
      // Per-attempt failure: counted as checked, retried next tick.
    }
  }
  return out;
}

export interface TournamentBoard {
  tournament: TournamentRow;
  attempts: AttemptRow[];
  verdict: VerdictRow | null;
  ledger: LedgerRow[];
}

export async function listTournaments(db: Db, limit = 20): Promise<TournamentRow[]> {
  const res = await db
    .prepare("SELECT * FROM tournaments ORDER BY created_at DESC LIMIT ?")
    .bind(Math.min(Math.max(limit, 1), 100))
    .all<TournamentRow>();
  return res.results;
}

export function validateTournamentCreate(
  body: Record<string, unknown>,
): { intent: string; sourceRepo: string; baseRef: string; baseSha: string } | { error: string } {
  const { intent, sourceRepo, baseRef, baseSha } = body;
  if (typeof intent !== "string" || !intent.trim() || intent.length > 2000) {
    return { error: "intent is required (1-2000 chars)" };
  }
  if (typeof sourceRepo !== "string" || !/^[\w.-]{1,100}$/.test(sourceRepo)) {
    return { error: "sourceRepo must be a repo name in the bound namespace (1-100 chars)" };
  }
  if (baseRef !== undefined && (typeof baseRef !== "string" || !baseRef.trim() || baseRef.length > 128)) {
    return { error: "invalid baseRef" };
  }
  if (baseSha !== undefined && (typeof baseSha !== "string" || baseSha.length > 64)) {
    return { error: "invalid baseSha" };
  }
  return { intent: intent.trim(), sourceRepo, baseRef: baseRef ?? "main", baseSha: baseSha ?? "" };
}

export function validateTournamentClaim(body: Record<string, unknown>): { agent: string } | { error: string } {
  const { agent } = body;
  if (typeof agent !== "string" || !AGENT_RE.test(agent)) {
    return { error: "agent must match [\\w.-]{1,40}" };
  }
  return { agent };
}

export async function getTournamentBoard(db: Db, id: string): Promise<TournamentBoard | null> {
  const tournament = await getTournament(db, id);
  if (!tournament) return null;
  const attempts = await db
    .prepare("SELECT * FROM attempts WHERE tournament_id = ? ORDER BY created_at ASC")
    .bind(id)
    .all<AttemptRow>();
  const verdict = await db
    .prepare("SELECT * FROM verdicts WHERE tournament_id = ?")
    .bind(id)
    .first<VerdictRow>();
  const ledger = await db
    .prepare("SELECT * FROM ledger WHERE tournament_id = ? ORDER BY created_at ASC LIMIT 100")
    .bind(id)
    .all<LedgerRow>();
  return { tournament, attempts: attempts.results, verdict, ledger: ledger.results };
}
