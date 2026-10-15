// Types for solutions-index.mjs (agents/apply.mjs documents the format).
export type SolutionEdit =
  | { op: "create"; path: string; content: string }
  | { op: "replace"; path: string; find: string; replace: string };

export interface Solution {
  id: string;
  edits: SolutionEdit[];
  // Replay variants keyed by the intent already on trunk.
  replayOn?: Record<string, SolutionEdit[]>;
}

export declare const SOLUTIONS: Record<string, Solution>;
