import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";

export interface CheckoutOptions {
  repo: string;
  sha: string;
  dir: string;
  token?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180000;

function git(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).slice(0, 500)}`));
          return;
        }
        resolve();
      },
    );
  });
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await git(["--version"], process.cwd(), 10000);
    return true;
  } catch {
    return false;
  }
}

// Shallow-checkout repo@sha into dir. Public repos need no token;
// private repos need a token with repo read (e.g. GITHUB_TOKEN).
// The token never appears in logs or errors.
export async function checkoutRepo(opts: CheckoutOptions, urlOverride?: string): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`invalid repo: ${opts.repo}`);
  if (!/^[\w.-]+$/.test(opts.sha)) throw new Error(`invalid sha: ${opts.sha}`);
  if (!(await gitAvailable())) throw new Error("git is not installed");
  mkdirSync(opts.dir, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = urlOverride ?? (opts.token
    ? `https://x-access-token:${opts.token}@github.com/${opts.repo}.git`
    : `https://github.com/${opts.repo}.git`);
  try {
    await git(["init", "-q"], opts.dir, timeoutMs);
    await git(["remote", "add", "origin", url], opts.dir, timeoutMs);
    await git(["fetch", "-q", "--depth", "1", "origin", opts.sha], opts.dir, timeoutMs);
    await git(["checkout", "-q", opts.sha], opts.dir, timeoutMs);
  } catch (err) {
    // git errors can echo the remote URL — scrub the token before throwing.
    const msg = String((err as Error)?.message ?? err);
    throw new Error(opts.token ? msg.split(opts.token).join("[redacted]") : msg);
  }
}
