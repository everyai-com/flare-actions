// `cli hook install|uninstall`: a git pre-push hook that runs the fast
// checks before every push. An agent that hits a type error locally
// fixes it in seconds instead of waiting minutes for CI, and a hook
// runs every time, where a line in AGENTS.md gets skipped in long
// sessions. Never clobbers a hook it did not write (husky, lefthook):
// those refuse without --force, which keeps a backup that uninstall
// restores.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const HOOK_MARKER = "# flare-forge pre-push hook";
const CLI = "npx flare-forge-cli";

// Profiles a hook should prefer when the pipeline defines one, fastest
// intent first.
const FAST_PROFILES = ["pre-push", "smoke", "fast", "quick"];

export interface HookChoice {
  command: string;
  why: string;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function packageCheckScript(packageJson: string | null): boolean {
  if (!packageJson) return false;
  try {
    const pkg = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.["check"] === "string";
  } catch {
    return false;
  }
}

function fastProfile(flareYml: string | null): string | null {
  if (!flareYml) return null;
  try {
    const doc = parseYaml(flareYml) as { profiles?: Record<string, unknown> } | null;
    const names = doc && typeof doc.profiles === "object" && doc.profiles ? Object.keys(doc.profiles) : [];
    return FAST_PROFILES.find((p) => names.includes(p)) ?? null;
  } catch {
    return null;
  }
}

// Pure: what the hook runs. Explicit wins; then the repo's own fast
// loop (`npm run check`), then a fast flare.yml profile, then the whole
// pipeline locally (correct, maybe slow; the why says how to speed it up).
export function chooseHookCommand(opts: {
  run?: string;
  profile?: string;
  packageJson: string | null;
  flareYml: string | null;
}): HookChoice {
  if (opts.run?.trim()) return { command: opts.run.trim(), why: "--run" };
  if (opts.profile) return { command: `${CLI} local --profile ${opts.profile}`, why: `flare.yml profile "${opts.profile}"` };
  if (packageCheckScript(opts.packageJson)) return { command: "npm run check", why: 'package.json "check" script' };
  const profile = fastProfile(opts.flareYml);
  if (profile) return { command: `${CLI} local --profile ${profile}`, why: `flare.yml profile "${profile}"` };
  return {
    command: `${CLI} local`,
    why: "the whole pipeline (add a fast profile, e.g. profiles: {smoke: {include: [fast]}}, then re-run with --profile smoke)",
  };
}

// Pure: the hook file. A subshell with stdin from /dev/null keeps git's
// ref list away from the checks and makes npx non-interactive.
export function hookScript(command: string): string {
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Runs the fast checks before every push. Installed by `" + CLI + " hook install`,",
    "# removed by `" + CLI + " hook uninstall`. Skip once: git push --no-verify",
    "# (or FLARE_SKIP_HOOK=1 git push).",
    '[ "${FLARE_SKIP_HOOK:-}" = "1" ] && exit 0',
    `( ${command} ) </dev/null`,
    "",
  ].join("\n");
}

// The hook path git will actually run: honors core.hooksPath and
// linked worktrees (hooks live in the common dir).
export function hookPath(cwd: string): string {
  const out = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], { cwd, encoding: "utf8" }).trim();
  return resolve(cwd, out);
}

export interface InstallResult {
  path: string;
  command: string;
  why: string;
  replaced: "none" | "flare" | "backed-up";
  backup?: string;
}

export function installHook(opts: { cwd: string; run?: string; profile?: string; force?: boolean }): InstallResult {
  const path = hookPath(opts.cwd);
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: opts.cwd, encoding: "utf8" }).trim();
  const choice = chooseHookCommand({
    run: opts.run,
    profile: opts.profile,
    packageJson: readOptional(join(top, "package.json")),
    flareYml: readOptional(join(top, "flare.yml")),
  });
  const existing = readOptional(path);
  let replaced: InstallResult["replaced"] = "none";
  let backup: string | undefined;
  if (existing !== null && existing.includes(HOOK_MARKER)) {
    replaced = "flare";
  } else if (existing !== null) {
    if (!opts.force) {
      throw new Error(`${path} already exists and was not written by flare (husky? lefthook?). Add "${choice.command}" to it, or re-run with --force to replace it (a backup is kept).`);
    }
    backup = `${path}.flare-backup`;
    renameSync(path, backup);
    replaced = "backed-up";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, hookScript(choice.command));
  chmodSync(path, 0o755);
  return { path, command: choice.command, why: choice.why, replaced, ...(backup ? { backup } : {}) };
}

export function uninstallHook(cwd: string): { path: string; removed: boolean; restored: boolean } {
  const path = hookPath(cwd);
  const existing = readOptional(path);
  if (existing === null || !existing.includes(HOOK_MARKER)) return { path, removed: false, restored: false };
  rmSync(path);
  const backup = `${path}.flare-backup`;
  if (existsSync(backup)) {
    renameSync(backup, path);
    return { path, removed: true, restored: true };
  }
  return { path, removed: true, restored: false };
}
