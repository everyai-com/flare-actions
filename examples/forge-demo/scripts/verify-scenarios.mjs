#!/usr/bin/env node
// Verifies every designed interaction in seed/goals.json, deterministically,
// with plain git in a throwaway repo:
//
//   1. static: declared footprint == files the reference solution touches;
//      footprint overlaps are exactly the designed pairs; only the designed
//      intent matches a protected glob in .flare/policy.yml
//   2. baseline suite is green
//   3. each intent alone (its own branch off main) is green, accept check included
//   4. overlap-clean pair merges cleanly and is green together
//   5. textual-conflict pair conflicts under `git merge`, the stale diff no
//      longer applies, and the replay variant is green on the new trunk
//   6. semantic pair merges cleanly but the combined suite is red
//   7. trains: the designed green and red batches
//
//   node scripts/verify-scenarios.mjs [--keep] [--json]
//
// Exit 0 when every observation matches its expectation. Zero dependencies.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyToDir, editPaths, loadSolution } from "../agents/apply.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const seed = JSON.parse(readFileSync(join(root, "seed/goals.json"), "utf8"));
const intents = seed.goals.flatMap((g) => g.intents.map((i) => ({ ...i, goal: g.id })));
const rows = [];

function record(scenario, expected, observed, ok, ms) {
  rows.push({ scenario, expected, observed, ok, ms });
  if (!args.has("--json")) process.stderr.write(`${ok ? "PASS" : "FAIL"}  ${scenario}\n`);
}

// --- policy -----------------------------------------------------------------

function protectedGlobs() {
  const text = readFileSync(join(root, ".flare/policy.yml"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith("protected:"));
  if (line === undefined) return [];
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// --- git + test helpers -------------------------------------------------------

const work = mkdtempSync(join(process.env.FORGE_DEMO_TMP ?? tmpdir(), "forge-demo-"));

function git(gitArgs, allowFail = false) {
  const r = spawnSync("git", ["-c", "user.name=Forge Demo", "-c", "user.email=forge-demo@example.invalid", ...gitArgs], {
    cwd: work,
    encoding: "utf8",
  });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${gitArgs.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

/** Run the suite (or one file) with the TAP reporter; collect failing test names. */
function runTests(files) {
  const testArgs = seed.test.slice(1);
  const runArgs = ["--test", "--test-reporter=tap", ...(files ?? testArgs.filter((a) => a !== "--test"))];
  const started = performance.now();
  const r = spawnSync(process.execPath, runArgs, { cwd: work, encoding: "utf8" });
  const ms = Math.round(performance.now() - started);
  const failing = [
    ...new Set(
      [...(r.stdout ?? "").matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((n) => !/\.(ts|mjs|js)$/.test(n)),
    ),
  ];
  return { ok: r.status === 0, failing, ms, output: r.stdout + r.stderr };
}

function acceptFiles(intent) {
  return intent.accept.split(/\s+/).filter((a) => a.endsWith(".ts"));
}

/** Merge intent branches onto a fresh train branch off main, in order. */
function mergeTrain(name, ids) {
  git(["checkout", "-q", "-B", `train/${name}`, "main"]);
  for (const id of ids) {
    const r = git(["merge", "--no-ff", "-q", "-m", `train ${name}: ${id}`, `intent/${id}`], true);
    if (r.status !== 0) {
      const files = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
      git(["merge", "--abort"], true);
      return { clean: false, conflictAt: id, files };
    }
  }
  return { clean: true };
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
}

// --- run --------------------------------------------------------------------

try {
  // 1. static checks
  const solutions = new Map();
  for (const intent of intents) solutions.set(intent.id, await loadSolution(intent.id));

  const drift = intents.filter((i) => !sameSet(i.footprint, editPaths(solutions.get(i.id).edits))).map((i) => i.id);
  record("static: declared footprint == solution edits", "0 drifting intents", `${drift.length} drifting${drift.length ? ` (${drift.join(", ")})` : ""}`, drift.length === 0);

  const overlaps = [];
  for (let a = 0; a < intents.length; a++) {
    for (let b = a + 1; b < intents.length; b++) {
      const shared = intents[a].footprint.filter((p) => intents[b].footprint.includes(p));
      if (shared.length > 0) overlaps.push({ pair: [intents[a].id, intents[b].id], shared });
    }
  }
  const designedOverlaps = seed.interactions.filter((x) => x.expect.declareOverlap === true);
  const overlapOk =
    overlaps.length === designedOverlaps.length &&
    designedOverlaps.every((d) => overlaps.some((o) => sameSet(o.pair, d.intents) && sameSet(o.shared, d.files)));
  const label = (pair, files) => `${pair.join("+")}@${files.map((f) => basename(f)).join(",")}`;
  record(
    "static: footprint overlaps == designed pairs",
    `${designedOverlaps.length} pairs`,
    `${overlaps.length} pairs: ${overlaps.map((o) => label(o.pair, o.shared)).join("; ")}`,
    overlapOk,
  );

  const globs = protectedGlobs().map((g) => ({ g, re: globToRegExp(g) }));
  const protectedHits = intents.filter((i) => i.footprint.some((p) => globs.some(({ re }) => re.test(p)))).map((i) => i.id);
  const designedProtected = seed.interactions.filter((x) => x.kind === "plan_approval").flatMap((x) => x.intents);
  record("static: protected-path intents (awaiting_plan)", designedProtected.join(", "), protectedHits.join(", ") || "(none)", sameSet(protectedHits, designedProtected));

  // 2. baseline
  cpSync(root, work, {
    recursive: true,
    filter: (src) => !["node_modules", ".git", ".wrangler"].includes(basename(src)),
  });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline: Bookshelf API"]);
  const base = runTests();
  record("baseline: full suite", "pass", base.ok ? "pass" : `fail (${base.failing.join("; ")})`, base.ok, base.ms);

  // 3. each intent alone
  for (const intent of intents) {
    git(["checkout", "-q", "-b", `intent/${intent.id}`, "main"]);
    await applyToDir(intent.id, work);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", `${intent.title}\n\nFlare-Goal: ${intent.goal}\nFlare-Intent: ${intent.id}\nFlare-Agent: reference`]);
    const accept = runTests(acceptFiles(intent));
    const full = runTests();
    const ok = accept.ok && full.ok;
    record(
      `alone: ${intent.id}`,
      "accept + full suite pass",
      ok ? "pass" : `fail (${[...accept.failing, ...full.failing].join("; ") || "see output"})`,
      ok,
      accept.ms + full.ms,
    );
    git(["checkout", "-q", "main"]);
  }

  // 4-6. designed interactions
  for (const x of seed.interactions) {
    if (x.kind === "overlap_clean") {
      // Both merge orders: the outcome must not depend on which lands first.
      for (const order of [x.intents, [...x.intents].reverse()]) {
        const m = mergeTrain(x.id, order);
        const t = m.clean ? runTests() : null;
        const ok = m.clean && t.ok;
        record(`${x.id}: ${order.join(" then ")}`, "merge clean, suite pass", m.clean ? `merge clean, suite ${t.ok ? "pass" : "fail"}` : `conflict in ${m.files.join(", ")}`, ok, t?.ms);
      }
    } else if (x.kind === "textual_conflict") {
      for (const order of [x.intents, [...x.intents].reverse()]) {
        const m = mergeTrain(x.id, order);
        const conflictOk = !m.clean && sameSet(m.files, x.expect.conflictFiles);
        record(`${x.id}: ${order.join(" then ")}`, `git conflict in ${x.expect.conflictFiles.join(", ")}`, m.clean ? "merge clean" : `conflict in ${m.files.join(", ")}`, conflictOk);
      }

      const { intent: replayId, on } = x.expect.replay;
      git(["checkout", "-q", "-B", `replay/${replayId}`, `intent/${on}`]);
      let staleApplies = true;
      try {
        await applyToDir(replayId, work);
      } catch {
        staleApplies = false;
      }
      git(["checkout", "-q", "-f", `replay/${replayId}`]);
      git(["clean", "-qfd"]);
      await applyToDir(replayId, work, on);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", `replay ${replayId} on ${on}\n\nFlare-Intent: ${replayId}\nFlare-Agent: reference-replay`]);
      const t = runTests();
      record(
        `${x.id}: replay ${replayId} on ${on}`,
        "stale diff rejected, replay suite pass",
        `stale diff ${staleApplies ? "applied" : "rejected"}, replay suite ${t.ok ? "pass" : `fail (${t.failing.join("; ")})`}`,
        !staleApplies && t.ok,
        t.ms,
      );
      git(["checkout", "-q", "main"]);
    } else if (x.kind === "semantic_conflict") {
      const m = mergeTrain(x.id, x.intents);
      const t = m.clean ? runTests() : null;
      const missing = t ? x.expect.failingTests.filter((n) => !t.failing.includes(n)) : x.expect.failingTests;
      const ok = m.clean && t !== null && !t.ok && missing.length === 0;
      record(
        `${x.id}: ${x.intents.join(" + ")}`,
        `merge clean, suite FAIL (${x.expect.failingTests.length} tests)`,
        m.clean ? `merge clean, suite ${t.ok ? "pass" : `FAIL (${t.failing.length} tests)`}` : `conflict in ${m.files.join(", ")}`,
        ok,
        t?.ms,
      );
      if (t !== null && !args.has("--json")) for (const n of t.failing) process.stderr.write(`        red: ${n}\n`);
    }
  }

  // 7. trains
  for (const train of seed.trains) {
    const ids = intents.map((i) => i.id).filter((id) => !train.exclude.includes(id));
    const m = mergeTrain(train.id, ids);
    const t = m.clean ? runTests() : null;
    const observed = m.clean ? (t.ok ? "pass" : "fail") : "conflict";
    record(`train ${train.id} (${ids.length} intents)`, `merge clean, suite ${train.expect}`, m.clean ? `merge clean, suite ${observed}` : `conflict at ${m.conflictAt}`, observed === train.expect, t?.ms);
  }
} catch (err) {
  record("harness", "no errors", err instanceof Error ? err.message : String(err), false);
} finally {
  if (args.has("--keep")) process.stderr.write(`kept ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}

// --- report -------------------------------------------------------------------

const failed = rows.filter((r) => !r.ok).length;
if (args.has("--json")) {
  console.log(JSON.stringify({ version: 1, ok: failed === 0, rows }, null, 2));
} else {
  const headers = ["#", "scenario", "expected", "observed", "ms", "result"];
  const table = rows.map((r, i) => [String(i + 1), r.scenario, r.expected, r.observed, r.ms === undefined ? "" : String(r.ms), r.ok ? "PASS" : "FAIL"]);
  const widths = headers.map((h, c) => Math.min(90, Math.max(h.length, ...table.map((row) => row[c].length))));
  const fmt = (cells) => cells.map((cell, c) => (cell.length > widths[c] ? `${cell.slice(0, widths[c] - 1)}~` : cell.padEnd(widths[c]))).join(" | ");
  console.log("");
  console.log(fmt(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of table) console.log(fmt(row));
  console.log("");
  console.log(`${rows.length - failed}/${rows.length} scenarios behave as designed`);
}
process.exit(failed === 0 ? 0 : 1);
