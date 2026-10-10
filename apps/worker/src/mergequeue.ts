// Agent merge queue: serialize agent PRs against a moving main —
// enqueue, rebase onto the current head, verify with real CI, land on
// green. One verifying entry per repo at a time; entries whose base
// moved mid-verify re-queue for a fresh verification instead of
// landing stale. The collision radar generalizes the tournament radar
// (verdict.detectCollisions) from agents to queued PRs: same pairwise
// file intersection, same bounds.
//
// Runtime-free: GitHub and dispatch ride the injected deps so unit
// tests drive every transition with fakes. Every GitHub op is
// best-effort — failures park visibly in `note`, never throw.
import { getRun, isTerminal, nowIso, type Db } from "./db";

export const MQ_QUEUED = "queued";
export const MQ_VERIFYING = "verifying";
export const MQ_LANDED = "landed";
export const MQ_FAILED = "failed";
export const MQ_CANCELLED = "cancelled";

export const MERGE_QUEUE_EVENT = "merge-queue";

const ACTIVE = [MQ_QUEUED, MQ_VERIFYING];
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{4,64}$/i;
const AGENT_RE = /^[\w.-]{1,64}$/;
const TICK_BATCH = 50;
const MAX_ACTIVE_PER_REPO = 20;
const MAX_COLLISIONS = 20;
const MAX_COLLISION_PATHS = 10;

export interface MergeQueueRow {
  id: string;
  repo: string;
  pr_number: number;
  base_branch: string;
  head_sha: string;
  base_sha: string;
  agent: string;
  status: string;
  run_id: string | null;
  changed_files: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface MergeQueueEntry {
  id: string;
  repo: string;
  pr: number;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  agent: string;
  status: string;
  runId: string | null;
  files: string[];
  note: string;
  createdAt: string;
  updated_at: string;
}

export interface MergeCollision {
  entries: [string, string];
  prs: [number, number];
  paths: string[];
}

export function parseMergeFiles(joined: string): string[] {
  return joined ? joined.split("\n").filter(Boolean) : [];
}

export function serializeMergeFiles(files: string[]): string {
  return files.slice(0, 150).map((f) => f.slice(0, 200)).join("\n").slice(0, 6000);
}

export function toMergeEntry(row: MergeQueueRow): MergeQueueEntry {
  return {
    id: row.id,
    repo: row.repo,
    pr: row.pr_number,
    baseBranch: row.base_branch,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    agent: row.agent,
    status: row.status,
    runId: row.run_id,
    files: parseMergeFiles(row.changed_files),
    note: row.note,
    createdAt: row.created_at,
    updated_at: row.updated_at,
  };
}

export function validateMergeEnqueue(
  body: Record<string, unknown>,
): { repo: string; pr: number; headSha: string; baseBranch: string; agent: string } | { error: string } {
  const { repo, pr, headSha, baseBranch, agent } = body;
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return { error: "repo must be owner/name" };
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1 || pr > 2000000) {
    return { error: "pr must be a pull request number" };
  }
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) return { error: "headSha must be a commit SHA" };
  if (baseBranch !== undefined && (typeof baseBranch !== "string" || !/^[\w./-]{1,128}$/.test(baseBranch))) {
    return { error: "invalid baseBranch" };
  }
  if (agent !== undefined && (typeof agent !== "string" || !AGENT_RE.test(agent))) {
    return { error: "agent must be 1-64 chars: letters, digits, dot, dash, underscore" };
  }
  return { repo, pr, headSha: headSha.toLowerCase(), baseBranch: baseBranch ?? "main", agent: agent ?? "" };
}

export type EnqueueResult = { id: string } | { error: "duplicate" | "queue-full" };

// One active slot per PR: a re-enqueue while queued/verifying is a 409,
// not a second lane. Terminal rows stay as history.
export async function enqueueMergeEntry(
  db: Db,
  input: { repo: string; pr: number; headSha: string; baseBranch: string; agent: string },
): Promise<EnqueueResult> {
  const dup = await db
    .prepare("SELECT id FROM merge_queue WHERE repo = ? AND pr_number = ? AND status IN ('queued', 'verifying')")
    .bind(input.repo, input.pr)
    .first<{ id: string }>();
  if (dup) return { error: "duplicate" };
  const depth = await db
    .prepare("SELECT COUNT(*) AS n FROM merge_queue WHERE repo = ? AND status IN ('queued', 'verifying')")
    .bind(input.repo)
    .first<{ n: number }>();
  if ((depth?.n ?? 0) >= MAX_ACTIVE_PER_REPO) return { error: "queue-full" };
  const id = crypto.randomUUID();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO merge_queue (id, repo, pr_number, base_branch, head_sha, base_sha, agent, status, run_id, changed_files, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, 'queued', NULL, '', '', ?, ?)`,
    )
    .bind(id, input.repo, input.pr, input.baseBranch, input.headSha, input.agent, now, now)
    .run();
  return { id };
}

export async function getMergeEntry(db: Db, id: string): Promise<MergeQueueRow | null> {
  return db.prepare("SELECT * FROM merge_queue WHERE id = ?").bind(id).first<MergeQueueRow>();
}

// Only live entries cancel; terminal history is immutable.
export async function cancelMergeEntry(db: Db, id: string): Promise<boolean> {
  const res = (await db
    .prepare("UPDATE merge_queue SET status = 'cancelled', note = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'verifying')")
    .bind(nowIso(), id)
    .run()) as { meta?: { changes?: number } };
  return (res?.meta?.changes ?? 0) > 0;
}

export async function listMergeQueue(db: Db, repo: string, limit = 50): Promise<MergeQueueRow[]> {
  const res = await db
    .prepare("SELECT * FROM merge_queue WHERE repo = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(repo, Math.min(Math.max(limit, 1), 100))
    .all<MergeQueueRow>();
  return res.results;
}

// Pairwise file intersection across queued entries. Pure: the same
// shape as the tournament radar, generalized from agents to PRs.
export function detectMergeCollisions(entries: { id: string; pr: number; files: string[] }[]): MergeCollision[] {
  const out: MergeCollision[] = [];
  const live = entries.filter((e) => e.files.length > 0);
  for (let i = 0; i < live.length && out.length < MAX_COLLISIONS; i++) {
    for (let j = i + 1; j < live.length && out.length < MAX_COLLISIONS; j++) {
      const a = live[i];
      const b = live[j];
      const inB = new Set(b.files);
      const paths = a.files.filter((p) => inB.has(p)).sort().slice(0, MAX_COLLISION_PATHS);
      if (paths.length > 0) out.push({ entries: [a.id, b.id], prs: [a.pr, b.pr], paths });
    }
  }
  return out;
}

export type BranchUpdate = "updated" | "current" | "failed";

export interface MergeQueueGithub {
  // Current head of the base branch; null when unreadable.
  baseHead(repo: string, branch: string): Promise<string | null>;
  // Fold the current base into the PR (rebase onto head). "updated"
  // = GitHub accepted an update (the PR head will move), "current" =
  // already up to date (no-op), "failed" parks.
  updateBranch(repo: string, pr: number): Promise<BranchUpdate>;
  // The PR's current head SHA; null when unreadable. Read after the
  // update so verification and merge target the exact post-update head.
  prHead(repo: string, pr: number): Promise<string | null>;
  // PR file list for the radar; empty = unknown (verification proceeds).
  prFiles(repo: string, pr: number): Promise<string[]>;
  // Merge the PR, pinned to the verified head SHA (GitHub rejects the
  // merge if the head moved since); detail lands in the note either way.
  mergePr(repo: string, pr: number, headSha: string): Promise<{ merged: boolean; detail: string }>;
}

export interface MergeQueueDeps {
  db: Db;
  dispatch: (input: { repo: string; sha: string; ref: string; agent: string }) => Promise<{ runId: string }>;
  github: MergeQueueGithub;
}

async function stampNote(db: Db, id: string, note: string): Promise<void> {
  await db
    .prepare("UPDATE merge_queue SET note = ?, updated_at = ? WHERE id = ?")
    .bind(note.slice(0, 500), nowIso(), id)
    .run();
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

// One bounded processing pass: finalize verifying entries whose runs
// went terminal (land on green, fail on red, re-queue when the base
// moved), then start the oldest queued entry per repo that has no
// live verification. Per-entry failures park visibly, never throw.
export async function processMergeQueue(deps: MergeQueueDeps): Promise<{
  started: number;
  landed: number;
  failed: number;
  requeued: number;
}> {
  const out = { started: 0, landed: 0, failed: 0, requeued: 0 };
  const rows = await deps.db
    .prepare("SELECT * FROM merge_queue WHERE status IN ('queued', 'verifying') ORDER BY created_at ASC LIMIT ?")
    .bind(TICK_BATCH)
    .all<MergeQueueRow>();
  const byRepo = new Map<string, MergeQueueRow[]>();
  for (const row of rows.results) {
    byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  }
  for (const [, entries] of byRepo) {
    // Finalize first so a freed lane starts its successor this tick.
    for (const entry of entries.filter((e) => e.status === MQ_VERIFYING)) {
      try {
        await finalizeVerifying(deps, entry, out);
      } catch {
        // Next tick retries; the entry keeps its last visible note.
      }
    }
    if (entries.some((e) => e.status === MQ_VERIFYING)) continue;
    const next = entries.find((e) => e.status === MQ_QUEUED);
    if (!next) continue;
    try {
      if (await startVerifying(deps, next)) out.started += 1;
    } catch {
      // Next tick retries.
    }
  }
  return out;
}

async function finalizeVerifying(
  deps: MergeQueueDeps,
  entry: MergeQueueRow,
  out: { landed: number; failed: number; requeued: number },
): Promise<void> {
  const run = entry.run_id ? await getRun(deps.db, entry.run_id).catch(() => null) : null;
  if (!run) {
    await setTerminal(deps.db, entry.id, MQ_FAILED, "verification run missing; re-enqueue to retry");
    out.failed += 1;
    entry.status = MQ_FAILED;
    return;
  }
  if (!isTerminal(run.status)) {
    // Base moved under a live verification: re-queue for a fresh
    // verify-against-head instead of landing stale.
    const head = await deps.github.baseHead(entry.repo, entry.base_branch).catch(() => null);
    if (head && entry.base_sha && head.toLowerCase() !== entry.base_sha.toLowerCase()) {
      await deps.db
        .prepare("UPDATE merge_queue SET status = 'queued', run_id = NULL, note = ?, updated_at = ? WHERE id = ?")
        .bind(`base moved ${short(entry.base_sha)}->${short(head)} mid-verify; re-queued onto the new head`, nowIso(), entry.id)
        .run();
      out.requeued += 1;
      entry.status = MQ_QUEUED;
    }
    return;
  }
  if (run.status !== "success") {
    await setTerminal(deps.db, entry.id, MQ_FAILED, `verification ${run.status} (run ${short(entry.run_id ?? "")}); fix and re-enqueue`);
    out.failed += 1;
    entry.status = MQ_FAILED;
    return;
  }
  // Green run: land only when the verified base is still the head.
  const head = await deps.github.baseHead(entry.repo, entry.base_branch).catch(() => null);
  if (head && entry.base_sha && head.toLowerCase() !== entry.base_sha.toLowerCase()) {
    await deps.db
      .prepare("UPDATE merge_queue SET status = 'queued', run_id = NULL, note = ?, updated_at = ? WHERE id = ?")
      .bind(`verified ${short(entry.base_sha)} went stale (head is ${short(head)}); re-queued`, nowIso(), entry.id)
      .run();
    out.requeued += 1;
    entry.status = MQ_QUEUED;
    return;
  }
  // head_sha is the SHA the green run verified (stamped at start), so
  // the merge is pinned to exactly what CI saw.
  const landed = await deps.github.mergePr(entry.repo, entry.pr_number, entry.head_sha).catch(() => ({
    merged: false as const,
    detail: "merge call failed",
  }));
  if (landed.merged) {
    await setTerminal(deps.db, entry.id, MQ_LANDED, landed.detail || `PR #${entry.pr_number} merged`);
    out.landed += 1;
  } else {
    await setTerminal(deps.db, entry.id, MQ_FAILED, `land failed: ${landed.detail || "merge rejected"}`);
    out.failed += 1;
  }
  entry.status = landed.merged ? MQ_LANDED : MQ_FAILED;
}

async function setTerminal(db: Db, id: string, status: string, note: string): Promise<void> {
  await db
    .prepare("UPDATE merge_queue SET status = ?, note = ?, updated_at = ? WHERE id = ?")
    .bind(status, note.slice(0, 500), nowIso(), id)
    .run();
}

async function startVerifying(deps: MergeQueueDeps, entry: MergeQueueRow): Promise<boolean> {
  const head = await deps.github.baseHead(entry.repo, entry.base_branch).catch(() => null);
  if (!head) {
    await stampNote(deps.db, entry.id, "base head unreadable; will retry");
    return false;
  }
  const before = await deps.github.prHead(entry.repo, entry.pr_number).catch(() => null);
  const update = await deps.github.updateBranch(entry.repo, entry.pr_number).catch((): BranchUpdate => "failed");
  if (update === "failed") {
    await stampNote(deps.db, entry.id, `rebase onto ${entry.base_branch}@${short(head)} failed; will retry`);
    return false;
  }
  // Verify exactly what will land: the PR head after the update, not
  // the SHA captured at enqueue time.
  const verified = (await deps.github.prHead(entry.repo, entry.pr_number).catch(() => null))?.toLowerCase() ?? null;
  if (!verified || !SHA_RE.test(verified)) {
    await stampNote(deps.db, entry.id, "PR head unreadable after branch update; will retry");
    return false;
  }
  // GitHub applies update-branch asynchronously: an accepted update
  // whose head has not moved yet is still in flight. Retry next tick
  // (the follow-up call answers "already up to date") instead of
  // verifying the pre-update head.
  if (update === "updated" && before && before.toLowerCase() === verified) {
    await stampNote(deps.db, entry.id, `branch update onto ${entry.base_branch}@${short(head)} pending; will retry`);
    return false;
  }
  const files = await deps.github.prFiles(entry.repo, entry.pr_number).catch(() => [] as string[]);
  let runId: string;
  try {
    runId = (await deps.dispatch({ repo: entry.repo, sha: verified, ref: entry.base_branch, agent: entry.agent })).runId;
  } catch (err) {
    await stampNote(deps.db, entry.id, `verification dispatch failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
    return false;
  }
  await deps.db
    .prepare("UPDATE merge_queue SET status = 'verifying', run_id = ?, head_sha = ?, base_sha = ?, changed_files = ?, note = ?, updated_at = ? WHERE id = ?")
    .bind(runId, verified, head.toLowerCase(), serializeMergeFiles(files), `verifying ${short(verified)} against ${entry.base_branch}@${short(head)}`, nowIso(), entry.id)
    .run();
  entry.head_sha = verified;
  entry.status = MQ_VERIFYING;
  return true;
}

export function isMergeActive(status: string): boolean {
  return (ACTIVE as string[]).includes(status);
}
