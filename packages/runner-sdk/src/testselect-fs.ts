import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { canParsePath, MAX_GRAPH_FILES } from "./testselect.ts";

// Workspace file harvest for BYO runners and `cli local`: a bounded
// repo listing plus source contents for the parseable subset. Seats
// cannot use this (their files live in a container) and harvest via
// `find`/`grep` exec calls instead — see seat.ts.

export const MAX_WORKSPACE_FILES = 5000;
export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".flare", "coverage", ".turbo", ".next"]);

export interface WorkspaceHarvest {
  files: string[];
  contents: Map<string, string>;
  truncated: boolean;
}

export function collectWorkspaceFiles(rootDir: string): WorkspaceHarvest {
  const files: string[] = [];
  const contents = new Map<string, string>();
  let truncated = false;
  const visit = (dir: string): void => {
    if (files.length >= MAX_WORKSPACE_FILES) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (files.length >= MAX_WORKSPACE_FILES) {
        truncated = true;
        return;
      }
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry)) continue;
        visit(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(rootDir, abs).split(sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      files.push(rel);
      if (contents.size < MAX_GRAPH_FILES && canParsePath(rel) && st.size <= MAX_WORKSPACE_FILE_BYTES) {
        try {
          contents.set(rel, readFileSync(abs, "utf8"));
        } catch {
          // Unreadable files stay leaves.
        }
      }
    }
  };
  visit(rootDir);
  return { files, contents, truncated };
}
