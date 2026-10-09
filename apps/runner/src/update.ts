import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// BYO fleet auto-update: runners check the fleet version while idle and,
// with --auto-update, pull + reinstall + exit for the service manager
// to restart. Never runs mid-job, never clobbers a dirty tree, never
// throws (every failure degrades to a log line and the next check).

// Exit code when an update landed: service managers with
// Restart=always come back on the new tree; bare terminals print the
// restart hint from the update log line.
export const RUNNER_UPDATE_EXIT_CODE = 42;
export const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const BEHIND_WARN_INTERVAL_MS = 60 * 60 * 1000;

export type UpdateExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function defaultUpdateExec(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const errCode = (error as { code?: unknown }).code;
        resolve({ code: typeof errCode === "number" ? errCode : 1, stdout: String(stdout ?? ""), stderr: String(stderr ?? error.message) });
      } else {
        resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    });
  });
}

// Fleet drift: any mismatch (ahead or behind) counts — the fleet
// version is a pin, not a minimum. Empty/unset means unenforced.
export function needsUpdate(current: string, advertised: string | null | undefined): boolean {
  if (!advertised || !advertised.trim()) return false;
  return current.trim() !== advertised.trim();
}

export type UpdateOutcome =
  | { ok: true }
  | { ok: false; reason: string };

// Pull + reinstall in a git checkout. Refuses dirty trees (tracked
// modifications — untracked files like .env are fine) and non-git
// directories; `git pull --ff-only` additionally refuses divergence.
export async function updateRunner(opts: {
  cwd: string;
  exec?: UpdateExec;
  exists?: (path: string) => boolean;
}): Promise<UpdateOutcome> {
  const exec = opts.exec ?? defaultUpdateExec;
  const exists = opts.exists ?? existsSync;
  if (!exists(`${opts.cwd}/.git`)) return { ok: false, reason: "not a git checkout" };
  const status = await exec("git", ["status", "--porcelain"], { cwd: opts.cwd, timeoutMs: 30000 });
  if (status.code !== 0) return { ok: false, reason: `git status failed: ${status.stderr.slice(0, 200)}` };
  const dirty = status.stdout.split("\n").some((l) => l !== "" && !l.startsWith("??") && !l.startsWith("!!"));
  if (dirty) return { ok: false, reason: "working tree has tracked modifications; refusing to pull" };
  const pull = await exec("git", ["pull", "--ff-only"], { cwd: opts.cwd, timeoutMs: 120000 });
  if (pull.code !== 0) return { ok: false, reason: `git pull failed: ${`${pull.stdout}\n${pull.stderr}`.slice(0, 300)}` };
  const install = await exec("npm", ["install", "--no-audit", "--no-fund"], { cwd: opts.cwd, timeoutMs: 600000 });
  if (install.code !== 0) return { ok: false, reason: `npm install failed: ${install.stderr.slice(0, 300)}` };
  return { ok: true };
}

export interface UpdateCheckState {
  lastCheck: number;
  lastWarn: number;
}

// One idle-loop update check; returns the exit code to die with, or
// null to keep polling. Throttles checks (10 min) and behind-warnings
// (1 h); failures and skips just log.
export async function maybeUpdateRunner(opts: {
  state: UpdateCheckState;
  now?: number;
  current: string;
  autoUpdate: boolean;
  cwd: string;
  getFleetVersion: () => Promise<string | null>;
  update?: (opts: { cwd: string }) => Promise<UpdateOutcome>;
  log?: (obj: Record<string, unknown>) => void;
}): Promise<number | null> {
  const now = opts.now ?? Date.now();
  if (now - opts.state.lastCheck < UPDATE_CHECK_INTERVAL_MS) return null;
  opts.state.lastCheck = now;
  const log = opts.log ?? ((o) => console.log(JSON.stringify(o)));
  let fleet: string | null;
  try {
    fleet = await opts.getFleetVersion();
  } catch (err) {
    log({ msg: "update check failed", error: String(err) });
    return null;
  }
  if (!needsUpdate(opts.current, fleet)) return null;
  if (!opts.autoUpdate) {
    if (now - opts.state.lastWarn >= BEHIND_WARN_INTERVAL_MS) {
      opts.state.lastWarn = now;
      log({ msg: "runner behind fleet version", current: opts.current, fleet, hint: "restart with --auto-update, or git pull && npm install" });
    }
    return null;
  }
  const update = opts.update ?? updateRunner;
  let outcome: UpdateOutcome;
  try {
    outcome = await update({ cwd: opts.cwd });
  } catch (err) {
    log({ msg: "runner update failed", current: opts.current, fleet, error: String(err) });
    return null;
  }
  if (!outcome.ok) {
    log({ msg: "runner update skipped", current: opts.current, fleet, reason: outcome.reason });
    return null;
  }
  log({ msg: "runner updated, exiting for restart", from: opts.current, to: fleet, exitCode: RUNNER_UPDATE_EXIT_CODE });
  return RUNNER_UPDATE_EXIT_CODE;
}
