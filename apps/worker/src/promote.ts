// Promotion: resolving the winner to the blessed outcome. 7a banks a
// blessed pointer (winner run + sha, tournament decided) — always
// available. 7b upgrades to a real fast-forward push of the source
// branch via isomorphic-git; any failure falls back to the pointer
// with a ledger row, never half-pushing.
import type { FsClient, HttpClient } from "isomorphic-git";
import { type Db, nowIso } from "./db";
import { appendLedger, getTournament, type TournamentArtifacts } from "./tournaments";

export type ResolveOutcome =
  | { status: "resolved"; winnerRunId: string; resolvedSha: string }
  | { status: "skipped"; reason: "not-ready" | "already" | "no-winner" };

export async function resolveTournament(db: Db, tournamentId: string): Promise<ResolveOutcome> {
  const tournament = await getTournament(db, tournamentId);
  if (!tournament || tournament.state === "decided") return { status: "skipped", reason: "already" };
  if (tournament.state !== "verifying") return { status: "skipped", reason: "not-ready" };
  const verdict = await db
    .prepare("SELECT tournament_id FROM verdicts WHERE tournament_id = ?")
    .bind(tournamentId)
    .first<{ tournament_id: string }>();
  if (!verdict) return { status: "skipped", reason: "not-ready" };
  const winner = await db
    .prepare("SELECT run_id, last_seen_sha FROM attempts WHERE tournament_id = ? AND verdict_rank = 1")
    .bind(tournamentId)
    .first<{ run_id: string | null; last_seen_sha: string }>();
  if (!winner?.run_id || !winner.last_seen_sha) return { status: "skipped", reason: "no-winner" };
  const now = nowIso();
  await db
    .prepare("UPDATE tournaments SET winner_run_id = ?, resolved_sha = ?, state = 'decided', updated_at = ? WHERE id = ?")
    .bind(winner.run_id, winner.last_seen_sha, now, tournamentId)
    .run();
  await appendLedger(db, tournamentId, "resolved", `winner run ${winner.run_id} @ ${winner.last_seen_sha.slice(0, 12)}`);
  return { status: "resolved", winnerRunId: winner.run_id, resolvedSha: winner.last_seen_sha };
}

export async function resolvePass(db: Db): Promise<{ resolved: number }> {
  let resolved = 0;
  const rows = await db
    .prepare(
      `SELECT t.id FROM tournaments t JOIN verdicts v ON v.tournament_id = t.id
       WHERE t.state = 'verifying' ORDER BY t.updated_at ASC LIMIT 10`,
    )
    .bind()
    .all<{ id: string }>();
  for (const row of rows.results) {
    try {
      const out = await resolveTournament(db, row.id);
      if (out.status === "resolved") resolved += 1;
    } catch {
      // Next tick retries.
    }
  }
  return { resolved };
}

// Strict remote builder for promotion pushes. The account id comes from
// configuration (workers cannot see it in the binding); anything
// malformed yields null and the pointer stands.
export function artifactsRemoteFor(accountId: string, namespace: string, repo: string): string | null {
  if (!/^[a-f0-9]{32}$/.test(accountId)) return null;
  if (!/^[\w.-]{1,100}$/.test(namespace) || !/^[\w.-]{1,100}$/.test(repo)) return null;
  return `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`;
}

// --- 7b: fast-forward push (droppable upgrade) ---

// Minimal git surface for the promotion (isomorphic-git in prod, fakes
// in tests). dir-scoped: one MemoryFS repo per promotion.
export interface PromoteGit {
  init(opts: { fs: FsClient; dir: string; defaultBranch: string }): Promise<unknown>;
  addRemote(opts: { fs: FsClient; dir: string; remote: string; url: string }): Promise<unknown>;
  fetch(opts: {
    fs: FsClient;
    http: HttpClient;
    dir: string;
    remote: string;
    ref: string;
    singleBranch?: boolean;
    depth?: number;
  }): Promise<unknown>;
  branch(opts: { fs: FsClient; dir: string; ref: string; object?: string; checkout?: boolean }): Promise<unknown>;
  push(opts: {
    fs: FsClient;
    http: HttpClient;
    dir: string;
    remote: string;
    ref: string;
    onAuth: () => { username: string; password: string };
  }): Promise<unknown>;
}

export interface FastForwardDeps {
  db: Db;
  artifacts: TournamentArtifacts | null;
  // Built by the caller (strict shape); empty = 7b unavailable.
  remoteFor: (repo: string) => string | null;
  git: PromoteGit | null;
  http: HttpClient;
  fs: () => FsClient;
}

export type FastForwardOutcome =
  | { status: "pushed"; sha: string }
  | { status: "skipped"; reason: "not-ready" | "already" | "unavailable" | "failed" };

async function mintWriteToken(artifacts: TournamentArtifacts, repo: string): Promise<string | null> {
  let handle = null as Awaited<ReturnType<TournamentArtifacts["get"]>> | null;
  try {
    handle = await artifacts.get(repo);
    const out = await handle.createToken("write", 600);
    const plaintext = typeof out === "string" ? out : (out as { plaintext?: unknown }).plaintext;
    return typeof plaintext === "string" && plaintext ? plaintext : null;
  } catch {
    return null;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail the promotion.
    }
  }
}

// Fast-forward the source branch to the winner's tree: fetch the winner
// commit from the fork, point a local branch at it, push to the source.
// Non-fast-forward (source moved) fails closed — the pointer stands.
export async function fastForwardWinner(
  deps: FastForwardDeps,
  tournamentId: string,
): Promise<FastForwardOutcome> {
  const tournament = await getTournament(deps.db, tournamentId);
  if (!tournament || tournament.state !== "decided" || !tournament.resolved_sha) {
    return { status: "skipped", reason: "not-ready" };
  }
  const promoted = await deps.db
    .prepare("SELECT id FROM ledger WHERE tournament_id = ? AND kind = 'promoted' LIMIT 1")
    .bind(tournamentId)
    .first<{ id: string }>();
  if (promoted) return { status: "skipped", reason: "already" };
  if (!deps.artifacts || !deps.git || !deps.http) return { status: "skipped", reason: "unavailable" };
  const winner = await deps.db
    .prepare("SELECT fork_repo FROM attempts WHERE tournament_id = ? AND verdict_rank = 1")
    .bind(tournamentId)
    .first<{ fork_repo: string }>();
  if (!winner) return { status: "skipped", reason: "not-ready" };
  const winnerRemote = deps.remoteFor(winner.fork_repo);
  const sourceRemote = deps.remoteFor(tournament.source_repo);
  if (!winnerRemote || !sourceRemote) return { status: "skipped", reason: "unavailable" };
  const token = await mintWriteToken(deps.artifacts, tournament.source_repo);
  if (!token) return { status: "skipped", reason: "failed" };
  const secret = token.split("?expires=")[0];
  const fs = deps.fs();
  const dir = "/promote";
  const base = tournament.base_ref || "main";
  try {
    await deps.git.init({ fs, dir, defaultBranch: base });
    await deps.git.addRemote({ fs, dir, remote: "winner", url: winnerRemote });
    await deps.git.addRemote({ fs, dir, remote: "source", url: sourceRemote });
    await deps.git.fetch({ fs, http: deps.http, dir, remote: "winner", ref: tournament.resolved_sha, singleBranch: true, depth: 50 });
    await deps.git.branch({ fs, dir, ref: base, object: tournament.resolved_sha, checkout: false });
    await deps.git.push({
      fs,
      http: deps.http,
      dir,
      remote: "source",
      ref: base,
      onAuth: () => ({ username: "x", password: secret }),
    });
  } catch {
    await appendLedger(deps.db, tournamentId, "promote-failed", "fast-forward rejected; blessed pointer stands").catch(
      () => undefined,
    );
    return { status: "skipped", reason: "failed" };
  }
  await appendLedger(deps.db, tournamentId, "promoted", `${base} -> ${tournament.resolved_sha.slice(0, 12)}`);
  return { status: "pushed", sha: tournament.resolved_sha };
}

export async function fastForwardPass(deps: FastForwardDeps): Promise<{ pushed: number }> {
  let pushed = 0;
  const rows = await deps.db
    .prepare(
      `SELECT t.id FROM tournaments t
       WHERE t.state = 'decided'
       AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.tournament_id = t.id AND l.kind IN ('promoted', 'promote-failed'))
       ORDER BY t.updated_at ASC LIMIT 5`,
    )
    .bind()
    .all<{ id: string }>();
  for (const row of rows.results) {
    try {
      const out = await fastForwardWinner(deps, row.id);
      if (out.status === "pushed") pushed += 1;
    } catch {
      // Next tick retries (promote-failed rows stop repeat attempts only
      // after a recorded failure; throws retry).
    }
  }
  return { pushed };
}
