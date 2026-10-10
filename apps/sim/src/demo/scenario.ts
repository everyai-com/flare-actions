// The scripted Bookshelf scenario as data, for the demo loop: the same
// seed goals, intents and reference solutions scripts/forge-agents.mjs
// drives from a laptop (examples/forge-demo), bundled into the Worker.

import seed from "../../../../examples/forge-demo/seed/goals.json";
import { SOLUTIONS, type Solution, type SolutionEdit } from "../../../../examples/forge-demo/agents/solutions-index.mjs";

export type { Solution, SolutionEdit };

export interface SeedIntent {
  id: string;
  goal: string; // seed goal id (g1..g3)
  title: string;
  reasoning: string;
  footprint: string[];
  accept: string;
}

export interface SeedGoal {
  id: string;
  text: string;
}

// Same order as scripts/forge-demo-lib.mjs DESIGNED_ORDER: the overlap
// pairs arrive together, the textual conflict lands g1-request-id first
// so g3-log-latency is the one replayed, the protected intent is last.
export const DESIGNED_ORDER = [
  "g1-metrics",
  "g3-rate-limit",
  "g1-request-id",
  "g3-log-latency",
  "g2-default-page-size",
  "g3-max-page-size",
  "g1-health-version",
  "g2-fuzzy-search",
  "g1-error-codes",
  "g2-author-books",
  "g2-isbn-validation",
  "g3-cors-allowlist",
  "g3-api-key-rotation",
];

// forge-demo-lib STAGE2_DRIFT: this agent also touches README.md
// (undeclared) so spectators see a drift alert.
export const DRIFT_INTENT = "g2-default-page-size";
export const DRIFT_PATH = "README.md";

export function seedGoals(): SeedGoal[] {
  return seed.goals.map((g) => ({ id: g.id, text: g.text }));
}

export function seedIntents(): SeedIntent[] {
  const all: SeedIntent[] = [];
  for (const g of seed.goals) {
    for (const i of g.intents) all.push({ id: i.id, goal: g.id, title: i.title, reasoning: i.reasoning, footprint: [...i.footprint], accept: i.accept });
  }
  const rank = (id: string): number => {
    const n = DESIGNED_ORDER.indexOf(id);
    return n === -1 ? DESIGNED_ORDER.length : n;
  };
  return all.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export function solutionFor(id: string): Solution | null {
  return SOLUTIONS[id] ?? null;
}

// The designed replay for conflict (a landed first, b replayed): only
// textual conflicts the seed declares have a scripted replay.
export function replayEdits(bSeed: string, aSeed: string): SolutionEdit[] | null {
  return solutionFor(bSeed)?.replayOn?.[aSeed] ?? null;
}

/** Apply edits to a file map (port of agents/apply.mjs applyEdits). */
export function applyEdits(files: Record<string, string>, edits: SolutionEdit[]): Record<string, string> {
  const out = { ...files };
  for (const edit of edits) {
    if (edit.op === "create") {
      if (out[edit.path] !== undefined) throw new Error(`create ${edit.path}: file already exists`);
      out[edit.path] = edit.content;
    } else {
      const text = out[edit.path];
      if (text === undefined) throw new Error(`replace ${edit.path}: file missing`);
      const first = text.indexOf(edit.find);
      if (first === -1) throw new Error(`replace ${edit.path}: anchor not found`);
      if (text.indexOf(edit.find, first + 1) !== -1) throw new Error(`replace ${edit.path}: anchor not unique`);
      out[edit.path] = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
    }
  }
  return out;
}

export function editPaths(edits: SolutionEdit[]): string[] {
  return [...new Set(edits.map((e) => e.path))].sort();
}

// Deterministic crew: agent-1..agent-N round-robin over the order, like
// forge-demo-lib assignAgents.
export function agentFor(index: number, crew: number): string {
  return `agent-${(index % Math.max(1, crew)) + 1}`;
}
