// Dashboard-facing view fields for the Forge REST responses. The
// dashboard client (dashboard-forge-js.ts) was built against fixture
// JSON (forge-fixtures.ts, docs/FORGE-UX.md §10-11); these pure helpers
// add those fields to the canonical responses (additive: every
// canonical field stays) so the signed-in dashboard renders real data
// with no fixture fallback. Snake_case names here mirror the fixtures
// on purpose. Runtime-free.
import type { Db } from "./db";
import type { Intent, Train } from "./intents-core";

export interface RunBrief {
  id: string;
  status: string;
  sha: string;
  createdAt: string | null;
  updatedAt: string | null;
}

// runs rows for a bounded id list (≤ 50; unknown ids are skipped).
export async function runBriefs(db: Db, ids: readonly (string | null)[]): Promise<Map<string, RunBrief>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 50);
  const out = new Map<string, RunBrief>();
  if (!want.length) return out;
  try {
    const res = await db
      .prepare(`SELECT id, status, sha, created_at, updated_at FROM runs WHERE id IN (${want.map(() => "?").join(", ")})`)
      .bind(...want)
      .all<{ id: string; status: string; sha: string; created_at: string | null; updated_at: string | null }>();
    for (const r of res.results) out.set(r.id, { id: r.id, status: r.status, sha: r.sha, createdAt: r.created_at, updatedAt: r.updated_at });
  } catch {
    // Evidence is decoration: a failed read renders as "no CI evidence".
  }
  return out;
}

const RUN_TERMINAL = new Set(["success", "failure", "error", "cancelled", "skipped"]);

// Client evidence row: { run_id, sha, status, duration_s }.
export function evidenceOf(run: RunBrief | null | undefined, sha = ""): Record<string, unknown> | null {
  if (!run) return null;
  const started = run.createdAt ? Date.parse(run.createdAt) : NaN;
  const ended = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  const duration = Number.isFinite(started) && Number.isFinite(ended) && RUN_TERMINAL.has(run.status) ? Math.max(0, Math.round((ended - started) / 1000)) : 0;
  return { run_id: run.id, sha: run.sha || sha, status: run.status === "queued" || run.status === "blocked" ? "pending" : run.status, duration_s: duration };
}

// Two-letter monogram for an agent id ("claude-1" -> "C1").
export function agentLabel(id: string): string {
  const parts = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1].slice(-1)).toUpperCase();
}

export function agentClient(id: string): string {
  const m = /^(claude|codex|cursor|gemini|copilot|aider|flare)/i.exec(id);
  return m ? m[1].toLowerCase() : "agent";
}

const TRAIN_TERMINAL = new Set(["landed", "failed", "bisected", "aborted"]);

function ciStage(t: Train, run: RunBrief | undefined): Record<string, unknown> {
  const status = run ? (run.status === "queued" || run.status === "blocked" ? "pending" : run.status) : t.state === "landed" ? "success" : "pending";
  return { status, run: t.runId, sha: t.headSha || null, duration_s: 0 };
}

// One train row as a lane (D1 trains are one lane each; lanes of one
// cut share createdAt).
export function laneView(t: Train, run: RunBrief | undefined, paths: string[] = []): Record<string, unknown> {
  const merged = t.state !== "forming";
  const pushed = t.state === "verifying" || TRAIN_TERMINAL.has(t.state);
  return {
    n: t.lane,
    train: t.id,
    paths,
    intents: t.intentIds,
    stages: {
      merge: merged ? "done" : "running",
      push: pushed ? "done" : merged ? "running" : "pending",
      ci: ciStage(t, run),
      cas: t.state === "landed" ? "done" : t.state === "failed" || t.state === "bisected" || t.state === "aborted" ? "failed" : "pending",
    },
  };
}

export function trainView(t: Train, run: RunBrief | undefined, paths: string[] = []): Record<string, unknown> {
  const start = Date.parse(t.createdAt);
  const end = Date.parse(t.updatedAt);
  return {
    ...t,
    base_sha: t.baseSha,
    head_sha: t.headSha,
    started_at: t.createdAt,
    duration_s: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : 0,
    lanes: [laneView(t, run, paths)],
    total: t.intentIds.length,
    result: t.state === "landed" ? { landed: t.intentIds.length, sha: t.headSha, run: t.runId, requeued: 0 } : undefined,
  };
}

// The Live track: in-flight trains grouped as lanes of one "current".
export function trackView(trains: readonly Train[], runs: Map<string, RunBrief>): { current: Record<string, unknown> | null; recent: Record<string, unknown>[] } {
  const sorted = [...trains].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.lane - b.lane);
  const live = sorted.filter((t) => !TRAIN_TERMINAL.has(t.state));
  const recent = sorted.filter((t) => TRAIN_TERMINAL.has(t.state)).slice(0, 5);
  const first = live[0];
  const current = first
    ? {
        id: first.id,
        lane: first.lane,
        state: first.state,
        intents: live.flatMap((t) => t.intentIds),
        headSha: first.headSha,
        runId: first.runId,
        updatedAt: first.updatedAt,
        lanes: live.slice(0, 8).map((t) => laneView(t, t.runId ? runs.get(t.runId) : undefined)),
      }
    : null;
  return {
    current,
    recent: recent.map((t) => ({
      id: t.id,
      lane: t.lane,
      state: t.state,
      intents: t.intentIds,
      headSha: t.headSha,
      runId: t.runId,
      updatedAt: t.updatedAt,
      total: t.intentIds.length,
      result: { landed: t.state === "landed" ? t.intentIds.length : 0, requeued: 0 },
    })),
  };
}

// Bisect subtree (getTrainDetail children) as the client's node shape.
export interface DetailNode {
  train: Train;
  intents: Array<{ id: string; state: string }>;
  run: { id: string; status: string; sha: string } | null;
  children: DetailNode[];
}

export function bisectView(node: DetailNode): Record<string, unknown> {
  const failedLeaf = node.intents.length === 1 && node.intents[0].state === "failed";
  return {
    count: node.train.intentIds.length,
    status: node.run?.status ?? (node.train.state === "landed" ? "success" : node.train.state === "failed" ? "failure" : "running"),
    sha: node.run?.sha ?? node.train.headSha,
    intents: node.train.intentIds,
    culprit: failedLeaf,
    lane: node.train.lane,
    children: node.children.map(bisectView),
  };
}

// One side of a conflict for the A/B panel.
export function conflictSide(i: Intent | null, goalText: string | null): Record<string, unknown> | null {
  if (!i) return null;
  return {
    intent: i.id,
    agent: i.agent,
    title: i.title,
    goal: i.goalId,
    goal_text: goalText ?? "",
    why: i.reasoning,
    footprint: [...new Set([...i.footprint.paths, ...(i.actualFootprint?.paths ?? [])])],
    hunk: [],
    landed: i.state === "landed",
    state: i.state,
  };
}

const WHY_TITLES: Record<string, string> = {
  line: "Line",
  commit: "Commit",
  intent: "Intent",
  goal: "Goal",
  reason: "Reason",
  rejected: "Rejected",
  evidence: "Evidence",
  session: "Session",
};

export function whyTitle(kind: string): string {
  return WHY_TITLES[kind] ?? kind;
}
