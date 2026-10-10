#!/usr/bin/env node
// Deterministic "reference agent": applies an intent's scripted solution
// to a checkout, no LLM involved. Used by the synthetic simulator, the
// fallback demo, and scripts/verify-scenarios.mjs.
//
//   node agents/apply.mjs <intent-id> [repoDir]            # the intent on baseline
//   node agents/apply.mjs <intent-id> [repoDir] --replay-on <other-intent>
//                                                         # the replay variant, re-derived
//                                                         # on a trunk that already has <other>
//
// Solutions live in agents/solutions/<intent-id>.mjs and export
// `{ id, edits, replayOn? }`. Edits are pure data so a Worker can apply them
// to an in-memory tree too (see applyEdits):
//   { op: "create",  path, content }         new file (fails if it exists)
//   { op: "replace", path, find, replace }   `find` must occur exactly once

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Apply edits to an in-memory file map ({ [path]: text }). Returns a new
 * map; throws with a precise message when an edit does not apply (the
 * caller treats that as "this solution needs a replay").
 */
export function applyEdits(files, edits) {
  const out = { ...files };
  for (const edit of edits) {
    if (edit.op === "create") {
      if (out[edit.path] !== undefined) throw new Error(`create ${edit.path}: file already exists`);
      out[edit.path] = edit.content;
    } else if (edit.op === "replace") {
      const text = out[edit.path];
      if (text === undefined) throw new Error(`replace ${edit.path}: file missing`);
      const first = text.indexOf(edit.find);
      if (first === -1) throw new Error(`replace ${edit.path}: anchor not found`);
      if (text.indexOf(edit.find, first + 1) !== -1) throw new Error(`replace ${edit.path}: anchor not unique`);
      out[edit.path] = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
    } else {
      throw new Error(`unknown edit op ${String(edit.op)}`);
    }
  }
  return out;
}

/** Paths an edit list touches: the intent's actual footprint. */
export function editPaths(edits) {
  return [...new Set(edits.map((e) => e.path))].sort();
}

export async function loadSolution(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad intent id ${id}`);
  const mod = await import(pathToFileURL(join(here, "solutions", `${id}.mjs`)).href);
  return mod.default;
}

/** Apply a solution to a directory on disk. */
export async function applyToDir(id, repoDir, replayOn) {
  const solution = await loadSolution(id);
  let edits = solution.edits;
  if (replayOn !== undefined) {
    edits = solution.replayOn?.[replayOn];
    if (edits === undefined) throw new Error(`${id} has no replay variant on ${replayOn}`);
  }
  const files = {};
  for (const path of editPaths(edits)) {
    const abs = join(repoDir, path);
    if (existsSync(abs)) files[path] = readFileSync(abs, "utf8");
  }
  const next = applyEdits(files, edits);
  for (const path of editPaths(edits)) {
    const abs = join(repoDir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, next[path]);
  }
  return editPaths(edits);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const replayIdx = args.indexOf("--replay-on");
  const replayOn = replayIdx === -1 ? undefined : args[replayIdx + 1];
  const positional = replayIdx === -1 ? args : args.filter((_, i) => i !== replayIdx && i !== replayIdx + 1);
  const [id, dir = process.cwd()] = positional;
  if (id === undefined) {
    console.error("usage: node agents/apply.mjs <intent-id> [repoDir] [--replay-on <intent-id>]");
    process.exit(2);
  }
  try {
    const touched = await applyToDir(id, resolve(dir), replayOn);
    console.log(JSON.stringify({ intent: id, replayOn: replayOn ?? null, touched }));
  } catch (err) {
    console.error(`apply ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
