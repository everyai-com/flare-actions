#!/usr/bin/env node
// One check after each change: fast lint on what changed, a type check,
// and only the tests affected by the change. Built for agent loops —
// several sessions can run at once across worktrees of this clone; a
// slot semaphore (shared through the git common dir) keeps the heavy
// steps from stacking up and thrashing memory.
//
// Usage: node scripts/check.mjs [--full] [--no-slots]
//   --full      run the whole suite (eslint stays a CI gate; oxlint is
//               the local fast lint and always runs scoped/full)
//   --no-slots  bypass the cross-worktree slot semaphore
// Env: FLARE_CHECK_SLOTS (default 3), FLARE_CHECK_NO_SLOTS=1, FLARE_CHECK_TSC=tsc|tsgo
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const useSlots = !args.has("--no-slots") && process.env.FLARE_CHECK_NO_SLOTS !== "1";
const bin = (name) => join(repoRoot, "node_modules", ".bin", name);

function run(cmd, argv) {
  const started = process.hrtime.bigint();
  const res = spawnSync(cmd, argv, { cwd: repoRoot, stdio: "inherit" });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ok: res.status === 0, ms, status: res.status ?? 1 };
}

function git(argv) {
  const res = spawnSync("git", ["-C", repoRoot, ...argv], { encoding: "utf8" });
  return res.status === 0 ? res.stdout : "";
}

// ---- cross-worktree slots -------------------------------------------------
// Locks live in the git common dir so every worktree of this clone shares
// them. Stale locks (owner gone, older than 15 min) are stolen; a slot
// whose owner died mid-run cannot wedge the fleet.
function acquireSlot() {
  const commonDir = git(["rev-parse", "--git-common-dir"]).trim();
  const locksDir = join(repoRoot, commonDir || ".git", "flare-check-slots");
  const slots = Math.max(1, Number(process.env.FLARE_CHECK_SLOTS ?? "3") || 3);
  mkdirSync(locksDir, { recursive: true });
  let announced = false;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const dir = join(locksDir, `slot-${i}`);
      try {
        mkdirSync(dir);
        writeFileSync(join(dir, "owner"), `${process.pid}\n`);
        return () => rmSync(dir, { recursive: true, force: true });
      } catch {
        try {
          const owner = join(dir, "owner");
          const age = Date.now() - statSync(lstatSync(owner).isFile() ? owner : dir).mtimeMs;
          if (age > 15 * 60 * 1000) rmSync(dir, { recursive: true, force: true });
        } catch {
          // Owner file missing or raced away; retry next pass.
        }
      }
    }
    if (!announced) {
      console.log(`waiting for a check slot (${slots} max, ${readdirSync(locksDir).length} busy)…`);
      announced = true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

// ---- changed files --------------------------------------------------------
function changedFiles() {
  const tracked = git(["diff", "--name-only", "HEAD"]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  const files = new Set();
  for (const name of [...tracked, ...untracked]) {
    const file = name.trim();
    if (file) files.add(file);
  }
  return [...files].filter((file) => existsSync(join(repoRoot, file)));
}

async function main() {
  if (!existsSync(join(repoRoot, "node_modules"))) {
    console.error("node_modules missing — run `npm install` first (NODE_ENV=development npm install).");
    process.exit(1);
  }
  const release = useSlots ? acquireSlot() : () => {};
  const changed = full ? [] : changedFiles();
  const lintTargets = changed.filter((f) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(f));
  const timings = [];
  try {
    // 1. Fast lint. oxlint is a correctness-speed pass, not the CI gate:
    // type-aware eslint still runs in CI.
    if (full) {
      console.log("--- oxlint (full) ---");
      timings.push(["lint", run(bin("oxlint"), ["."])]);
    } else if (lintTargets.length > 0) {
      console.log(`--- oxlint (${lintTargets.length} changed file${lintTargets.length === 1 ? "" : "s"}) ---`);
      timings.push(["lint", run(bin("oxlint"), lintTargets)]);
    } else {
      console.log("--- oxlint: no changed lint targets ---");
    }
    // 2. Type check. tsgo (TypeScript native) is ~2x faster and half the
    // memory; tsc stays the CI gate (FLARE_CHECK_TSC=tsc forces it).
    const typechecker = process.env.FLARE_CHECK_TSC ?? (existsSync(bin("tsgo")) ? "tsgo" : "tsc");
    console.log(`--- ${typechecker} --noEmit ---`);
    timings.push(["types", run(bin(typechecker), ["--noEmit"])]);
    // 3. Tests for the change (vitest --changed resolves the affected
    // module graph against HEAD); --passWithNoTests keeps clean trees green.
    const testArgv = full ? ["run"] : ["run", "--changed", "HEAD", "--passWithNoTests"];
    console.log(`--- vitest ${full ? "(full)" : "--changed HEAD"} ---`);
    timings.push(["tests", run(bin("vitest"), testArgv)]);
    const failed = timings.filter(([, result]) => !result.ok);
    console.log("");
    for (const [name, result] of timings) {
      console.log(`${result.ok ? "ok  " : "FAIL"} ${name.padEnd(6)} ${(result.ms / 1000).toFixed(2)}s`);
    }
    process.exitCode = failed.length > 0 ? 1 : 0;
  } finally {
    release();
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
