// Tournament verdicts: the overlap radar (file-level collision foresight
// across attempt diffs) and the cross-attempt review (deterministic
// ranking plus a Workers AI rationale). Inference degrades exactly like
// triage: outage or busy model falls back to the deterministic order
// with a recorded note, never a 500.
import { type Db, getRun, isTerminal, listFailingTests, nowIso } from "./db";
import { appendLedger, getTournament, type TournamentArtifacts } from "./tournaments";
import { buildRunDigest } from "./digest";
import { TRIAGE_MODEL, gatewayOptions, type AiBinding } from "./triage";

export const VERDICT_TIMEOUT_MS = 30 * 60 * 1000;
export const VERDICT_MAX_STORED_CHARS = 4096;
const RADAR_MAX_ENTRIES = 3000;
const RADAR_MAX_DEPTH = 8;
const RADAR_MAX_PATHS = 10;
const RADAR_MAX_COLLISIONS = 20;

export interface Collision {
  agents: [string, string];
  paths: string[];
}

export interface VerdictEvidence {
  attemptId: string;
  agent: string;
  terminal: boolean;
  status: string;
  failingTests: number;
  summary: string;
}

// Walk one tree breadth-first, bounded. Directories recurse by mode;
// anything over the caps truncates (radar degrades to partial, never
// hangs a tick on a huge tree).
export async function collectTreePaths(
  artifacts: TournamentArtifacts,
  repo: string,
  treeHash: string,
): Promise<{ paths: Map<string, string>; truncated: boolean }> {
  const paths = new Map<string, string>();
  let truncated = false;
  let handle = null as Awaited<ReturnType<TournamentArtifacts["get"]>> | null;
  try {
    handle = await artifacts.get(repo);
    const queue: { hash: string; prefix: string; depth: number }[] = [{ hash: treeHash, prefix: "", depth: 0 }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth > RADAR_MAX_DEPTH || paths.size >= RADAR_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const entries = await handle.readTree(cur.hash);
      if (!entries) {
        truncated = true;
        continue;
      }
      for (const e of entries) {
        if (paths.size >= RADAR_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const path = cur.prefix ? `${cur.prefix}/${e.name}` : e.name;
        if (e.mode === "40000") {
          queue.push({ hash: e.hash, prefix: path, depth: cur.depth + 1 });
        } else {
          paths.set(path, e.hash);
        }
      }
    }
  } catch {
    truncated = true;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail the radar.
    }
  }
  return { paths, truncated };
}

async function commitTree(
  artifacts: TournamentArtifacts,
  repo: string,
  commit: string,
): Promise<string | null> {
  let handle = null as Awaited<ReturnType<TournamentArtifacts["get"]>> | null;
  try {
    handle = await artifacts.get(repo);
    const decoded = await handle.readCommit(commit);
    return decoded?.treeHash ?? null;
  } catch {
    return null;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // ignore
    }
  }
}

// Changed paths between two commits, by per-path blob comparison.
// Null when either side cannot be read.
export async function changedFiles(
  artifacts: TournamentArtifacts,
  repo: string,
  baseCommit: string,
  headCommit: string,
): Promise<{ changed: string[]; truncated: boolean } | null> {
  if (!baseCommit || !headCommit || baseCommit === headCommit) return { changed: [], truncated: false };
  const [baseTree, headTree] = await Promise.all([
    commitTree(artifacts, repo, baseCommit),
    commitTree(artifacts, repo, headCommit),
  ]);
  if (!baseTree || !headTree) return null;
  const [base, head] = await Promise.all([
    collectTreePaths(artifacts, repo, baseTree),
    collectTreePaths(artifacts, repo, headTree),
  ]);
  const changed: string[] = [];
  for (const [path, hash] of head.paths) {
    if (base.paths.get(path) !== hash) changed.push(path);
  }
  for (const path of base.paths.keys()) {
    if (!head.paths.has(path)) changed.push(path);
  }
  changed.sort();
  return { changed, truncated: base.truncated || head.truncated };
}

// Pairwise path intersection across attempts. Pure: tested without I/O.
export function detectCollisions(changedByAgent: { agent: string; changed: string[] }[]): Collision[] {
  const out: Collision[] = [];
  for (let i = 0; i < changedByAgent.length && out.length < RADAR_MAX_COLLISIONS; i++) {
    for (let j = i + 1; j < changedByAgent.length && out.length < RADAR_MAX_COLLISIONS; j++) {
      const a = changedByAgent[i];
      const b = changedByAgent[j];
      const inB = new Set(b.changed);
      const paths = a.changed.filter((p) => inB.has(p)).sort().slice(0, RADAR_MAX_PATHS);
      if (paths.length > 0) out.push({ agents: [a.agent, b.agent], paths });
    }
  }
  return out;
}

// Deterministic order: terminal first, success before failure, fewer
// failing tests first, agent name last (stable, no coin flips).
export function rankEvidence(items: VerdictEvidence[]): VerdictEvidence[] {
  const statusOrder = (status: string): number =>
    status === "success" ? 0 : status === "failure" ? 1 : 2;
  return items.slice().sort(
    (a, b) =>
      Number(b.terminal) - Number(a.terminal) ||
      statusOrder(a.status) - statusOrder(b.status) ||
      a.failingTests - b.failingTests ||
      a.agent.localeCompare(b.agent),
  );
}

function evidenceSummary(
  agent: string,
  status: string,
  failingTests: number,
  digest: Awaited<ReturnType<typeof buildRunDigest>>,
): string {
  const failing = (digest?.jobs ?? [])
    .filter((j) => j.failing)
    .slice(0, 3)
    .map((j) => `${j.name}: ${j.failing!.command.slice(0, 120)} (exit ${j.failing!.exitCode})`);
  const triage = (digest?.jobs ?? []).map((j) => j.triage).find((t) => t?.trim())?.slice(0, 500) ?? "";
  return [
    `${agent}: ${status}, failing tests ${failingTests}`,
    ...failing.map((f) => `  FAIL ${f}`),
    ...(triage ? [`  triage: ${triage}`] : []),
  ].join("\n");
}

async function gatherEvidence(
  db: Db,
  attempts: { id: string; agent: string; run_id: string | null }[],
): Promise<VerdictEvidence[]> {
  const out: VerdictEvidence[] = [];
  for (const a of attempts) {
    if (!a.run_id) {
      out.push({ attemptId: a.id, agent: a.agent, terminal: false, status: "no-run", failingTests: 0, summary: `${a.agent}: no verification run` });
      continue;
    }
    const run = await getRun(db, a.run_id);
    const terminal = !!run && isTerminal(run.status);
    const status = run?.status ?? "missing";
    const failingTests = (await listFailingTests(db, a.run_id, 200).catch(() => [])).length;
    const digest = terminal ? await buildRunDigest(db, a.run_id).catch(() => null) : null;
    out.push({ attemptId: a.id, agent: a.agent, terminal, status, failingTests, summary: evidenceSummary(a.agent, status, failingTests, digest) });
  }
  return out;
}

function buildVerdictPrompt(intent: string, ranked: VerdictEvidence[]): { system: string; user: string } {
  const winner = ranked[0]?.agent ?? "unknown";
  return {
    system:
      `The tournament is already decided: ${winner} won (final — never name a different winner, never write a Winner line). ` +
      "Reply in ≤150 words justifying the decision: two sentences citing verification evidence (status, failing tests, failure output). Note any attempt that looks partially correct. Never invent results; every claim must trace to the evidence.",
    user: `Task: ${intent.slice(0, 500)}\n\nAttempts in verification order:\n${ranked.map((r) => r.summary).join("\n\n").slice(0, 6000)}`,
  };
}

async function aiRationale(
  ai: AiBinding | null | undefined,
  gatewayId: string | undefined,
  model: string | undefined,
  intent: string,
  ranked: VerdictEvidence[],
): Promise<{ rationale: string; model: string }> {
  const fallback =
    `Ranked by verification (deterministic; AI review unavailable): ` +
    ranked.map((r, i) => `${i + 1}. ${r.agent} (${r.status}, ${r.failingTests} failing tests)`).join("; ");
  if (!ai) return { rationale: fallback.slice(0, VERDICT_MAX_STORED_CHARS), model: "deterministic" };
  try {
    const prompt = buildVerdictPrompt(intent, ranked);
    const out = (await ai.run(
      model?.trim() || TRIAGE_MODEL,
      { messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], max_tokens: 512 },
      gatewayOptions(gatewayId),
    )) as { response?: unknown };
    if (typeof out?.response !== "string" || !out.response.trim()) throw new Error("empty verdict");
    // Deterministic header first: the stored rationale can never contradict
    // the ranking even if the model names another agent in its prose.
    const headed = `Winner: ${ranked[0]?.agent ?? "unknown"}. ${out.response.trim()}`;
    return { rationale: headed.slice(0, VERDICT_MAX_STORED_CHARS), model: model?.trim() || TRIAGE_MODEL };
  } catch {
    return { rationale: fallback.slice(0, VERDICT_MAX_STORED_CHARS), model: "deterministic" };
  }
}

export type VerdictOutcome =
  | { status: "decided"; winnerAttemptId: string; ranking: string[]; rationale: string; model: string }
  | { status: "skipped"; reason: "not-ready" | "already" | "no-attempts" };

// Pure read: collisions are computed here but written only by the
// caller that wins the verdict INSERT, so concurrent or retried ticks
// cannot duplicate collision ledger rows.
async function runRadar(
  artifacts: TournamentArtifacts | null,
  baseSha: string,
  attempts: { id: string; agent: string; fork_repo: string; last_seen_sha: string }[],
): Promise<string[]> {
  if (!artifacts || !baseSha || attempts.length < 2) return [];
  const changedByAgent: { agent: string; changed: string[] }[] = [];
  for (const a of attempts) {
    if (!a.last_seen_sha) continue;
    try {
      const diff = await changedFiles(artifacts, a.fork_repo, baseSha, a.last_seen_sha);
      if (diff) changedByAgent.push({ agent: a.agent, changed: diff.changed });
    } catch {
      // One unreadable fork must not stall the radar.
    }
  }
  return detectCollisions(changedByAgent).map((c) => `${c.agents[0]} x ${c.agents[1]}: ${c.paths.join(", ").slice(0, 500)}`);
}

// Eligible when every attempt is terminal, or the oldest activity is
// past the timeout with at least one terminal run (a stuck attempt
// must not veto the tournament — the expiry is recorded).
export async function composeVerdict(
  db: Db,
  deps: { artifacts: TournamentArtifacts | null; ai?: AiBinding | null; gatewayId?: string; model?: string },
  tournamentId: string,
  nowMs = Date.now(),
): Promise<VerdictOutcome> {
  const tournament = await getTournament(db, tournamentId);
  if (!tournament || tournament.state !== "verifying") return { status: "skipped", reason: "not-ready" };
  const existing = await db
    .prepare("SELECT tournament_id FROM verdicts WHERE tournament_id = ?")
    .bind(tournamentId)
    .first<{ tournament_id: string }>();
  if (existing) return { status: "skipped", reason: "already" };
  const attempts = await db
    .prepare("SELECT * FROM attempts WHERE tournament_id = ? ORDER BY created_at ASC")
    .bind(tournamentId)
    .all<{ id: string; agent: string; fork_repo: string; state: string; last_seen_sha: string; run_id: string | null; updated_at: string }>();
  if (attempts.results.length === 0) return { status: "skipped", reason: "no-attempts" };
  const evidence = await gatherEvidence(db, attempts.results);
  const allTerminal = evidence.every((e) => e.terminal);
  const oldestActive = Math.min(...attempts.results.map((a) => Date.parse(a.updated_at) || nowMs));
  const expired = nowMs - oldestActive > VERDICT_TIMEOUT_MS && evidence.some((e) => e.terminal);
  if (!allTerminal && !expired) return { status: "skipped", reason: "not-ready" };
  const collisions = await runRadar(deps.artifacts, tournament.base_sha, attempts.results);
  const ranked = rankEvidence(evidence);
  const { rationale, model } = await aiRationale(deps.ai, deps.gatewayId, deps.model, tournament.intent, ranked);
  const ranking = ranked.map((r) => r.attemptId);
  const finalRationale = expired && !allTerminal ? `[decided on timeout] ${rationale}` : rationale;
  try {
    await db
      .prepare("INSERT INTO verdicts (tournament_id, ranking, rationale, model, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(tournamentId, JSON.stringify(ranking).slice(0, 4000), finalRationale, model.slice(0, 200), nowIso())
      .run();
  } catch {
    return { status: "skipped", reason: "already" };
  }
  // Only the tick that won the verdict row records the radar.
  for (const body of collisions) await appendLedger(db, tournamentId, "collision", body);
  for (let i = 0; i < ranking.length; i++) {
    await db.prepare("UPDATE attempts SET verdict_rank = ? WHERE id = ?").bind(i + 1, ranking[i]).run();
  }
  await appendLedger(db, tournamentId, "verdict", `winner ${ranked[0].agent}: ${finalRationale.slice(0, 500)}`);
  return { status: "decided", winnerAttemptId: ranking[0], ranking, rationale: finalRationale, model };
}

// One verdict pass over verifying tournaments (bounded; per-tournament
// failures never stall the tick).
export async function verdictPass(
  db: Db,
  deps: { artifacts: TournamentArtifacts | null; ai?: AiBinding | null; gatewayId?: string; model?: string },
): Promise<{ decided: number }> {
  let decided = 0;
  const rows = await db
    .prepare("SELECT id FROM tournaments WHERE state = 'verifying' ORDER BY updated_at ASC LIMIT 10")
    .bind()
    .all<{ id: string }>();
  for (const row of rows.results) {
    try {
      const out = await composeVerdict(db, deps, row.id);
      if (out.status === "decided") decided += 1;
    } catch {
      // Next tick retries.
    }
  }
  return { decided };
}
