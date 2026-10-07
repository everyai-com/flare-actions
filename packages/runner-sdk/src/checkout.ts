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

// The token reaches git through environment config
// (GIT_CONFIG_COUNT + http.<url>.extraheader), never argv: process
// arguments are world-readable in process listings, process
// environments are not. The remote URL stays token-free so git errors
// cannot echo a credential.
function gitEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader";
    env["GIT_CONFIG_VALUE_0"] = `Authorization: Basic ${basic}`;
  }
  return env;
}

function git(args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env,
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
    await git(["--version"], process.cwd(), 10000, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
    return true;
  } catch {
    return false;
  }
}

// Shallow-checkout repo@sha into dir. Public repos need no token;
// private repos need a token with repo read (e.g. GITHUB_TOKEN).
// The token never appears in argv, logs, or errors.
export async function checkoutRepo(opts: CheckoutOptions, urlOverride?: string): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`invalid repo: ${opts.repo}`);
  if (!/^[\w.-]+$/.test(opts.sha)) throw new Error(`invalid sha: ${opts.sha}`);
  if (!(await gitAvailable())) throw new Error("git is not installed");
  mkdirSync(opts.dir, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = urlOverride ?? `https://github.com/${opts.repo}.git`;
  const env = gitEnv(opts.token);
  try {
    await git(["init", "-q"], opts.dir, timeoutMs, env);
    await git(["remote", "add", "origin", url], opts.dir, timeoutMs, env);
    await git(["fetch", "-q", "--depth", "1", "origin", opts.sha], opts.dir, timeoutMs, env);
    await git(["checkout", "-q", opts.sha], opts.dir, timeoutMs, env);
  } catch (err) {
    // Belt and braces: scrub the token if a git error ever echoes it.
    const msg = String((err as Error)?.message ?? err);
    // The cause may echo the token; the scrubbed message is the chain.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(opts.token ? msg.split(opts.token).join("[redacted]") : msg);
  }
}
