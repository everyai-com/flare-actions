// Side-effecting helpers for the Forge demo scripts: child processes
// (git, wrangler), the Forge SDK client, and the per-repo state file.
// Secrets never reach argv or stdout: git auth rides GIT_CONFIG_* env,
// wrangler tokens are parsed from --json stdout and held in memory.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FlareForge } from "../packages/runner-sdk/src/forge.ts";
import { demoEnv, gitAuthEnv, parseCliJson, pickRemote, pickRepoNames, pickToken, redact, ROOT, stateFile } from "./forge-demo-lib.mjs";

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
}

export function shAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on("error", (e) => resolve({ status: 1, stdout, stderr: stderr + String(e.message) }));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

/** git with optional token auth via env. Throws with a redacted message. */
export function git(args, { cwd, token, env = {}, allowFail = false } = {}) {
  const r = sh("git", args, { cwd, env: { ...(token ? gitAuthEnv(token) : { GIT_TERMINAL_PROMPT: "0" }), ...env } });
  if (r.status !== 0 && !allowFail) {
    const tail = redact(r.stderr.trim().split("\n").slice(-3).join(" | "), [token]);
    throw new Error(`git ${args[0]} failed: ${tail}`);
  }
  return r;
}

export async function gitAsync(args, { cwd, token, env = {}, allowFail = false } = {}) {
  const r = await shAsync("git", args, { cwd, env: { ...(token ? gitAuthEnv(token) : { GIT_TERMINAL_PROMPT: "0" }), ...env } });
  if (r.status !== 0 && !allowFail) {
    const tail = redact(r.stderr.trim().split("\n").slice(-3).join(" | "), [token]);
    throw new Error(`git ${args[0]} failed: ${tail}`);
  }
  return r;
}

/** Fixed bot identity for demo-tool commits (never the user's). */
export const DEMO_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Flare Forge demo",
  GIT_AUTHOR_EMAIL: "demo@flare.invalid",
  GIT_COMMITTER_NAME: "Flare Forge demo",
  GIT_COMMITTER_EMAIL: "demo@flare.invalid",
};

// ---------------------------------------------------------------------------
// wrangler artifacts (the Forge API has no repo-create route; the operator's
// wrangler login is the trunk-admin credential, agents never see it)
// ---------------------------------------------------------------------------

function wranglerBin() {
  const local = join(ROOT, "node_modules", ".bin", "wrangler");
  return existsSync(local) ? { cmd: local, pre: [] } : { cmd: "npx", pre: ["wrangler"] };
}

export function wrangler(args, { allowFail = false } = {}) {
  const w = wranglerBin();
  const r = sh(w.cmd, [...w.pre, ...args]);
  if (r.status !== 0 && !allowFail) {
    const msg = redact((r.stderr || r.stdout).trim().split("\n").filter(Boolean).slice(-3).join(" | "));
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${msg}`);
  }
  return r;
}

export function artifactsRepoGet(namespace, repo) {
  const r = wrangler(["artifacts", "repos", "get", repo, "--namespace", namespace, "--json"], { allowFail: true });
  if (r.status !== 0) return null;
  try {
    return parseCliJson(r.stdout);
  } catch {
    return {};
  }
}

export function artifactsRepoCreate(namespace, repo) {
  const r = wrangler(["artifacts", "repos", "create", repo, "--namespace", namespace, "--default-branch", "main", "--json"]);
  try {
    return parseCliJson(r.stdout);
  } catch {
    return {};
  }
}

export function artifactsRepoDelete(namespace, repo) {
  const r = wrangler(["artifacts", "repos", "delete", repo, "--namespace", namespace, "--force", "--json"], { allowFail: true });
  return r.status === 0;
}

export function artifactsRepoList(namespace) {
  const r = wrangler(["artifacts", "repos", "list", "--namespace", namespace, "--json"], { allowFail: true });
  if (r.status !== 0) return [];
  try {
    return pickRepoNames(parseCliJson(r.stdout));
  } catch {
    return [];
  }
}

export function artifactsToken(namespace, repo, scope = "write", ttl = 3600) {
  const r = wrangler(["artifacts", "repos", "issue-token", repo, "--namespace", namespace, "--scope", scope, "--ttl", String(ttl), "--json"]);
  const token = pickToken(parseCliJson(r.stdout));
  if (!token) throw new Error(`issue-token for ${repo} returned no token (wrangler output shape changed?)`);
  return token;
}

export { pickRemote };

// ---------------------------------------------------------------------------
// Forge API
// ---------------------------------------------------------------------------

export function forgeConfig(env = demoEnv()) {
  const url = (env.FLARE_ACTIONS_URL ?? "").replace(/\/+$/, "");
  const token = env.RUNNER_TOKEN || env.FLARE_TOKEN || "";
  const adminToken = env.FLARE_ADMIN_TOKEN || env.ADMIN_TOKEN || "";
  return { url, token, adminToken, env };
}

export function forgeClient(cfg, agent, { admin = false } = {}) {
  const token = admin ? cfg.adminToken || cfg.token : cfg.token;
  if (!cfg.url || !token) throw new Error("FLARE_ACTIONS_URL and RUNNER_TOKEN are required (run `npm run setup`, or set them in .env)");
  return new FlareForge(cfg.url, token, { agent, timeoutMs: 45000 });
}

/** Every intent of a repo (keyset pages of 200). */
export async function listAllIntents(forge, repo, opts = {}) {
  const out = [];
  let before;
  for (let page = 0; page < 50; page++) {
    const r = await forge.listIntents(repo, { ...opts, limit: 200, before });
    out.push(...r.intents);
    if (!r.nextBefore || r.intents.length === 0) break;
    before = r.nextBefore;
  }
  return out;
}

export const TERMINAL = new Set(["landed", "failed", "abandoned"]);

// ---------------------------------------------------------------------------
// State file (~/.flare/forge-demo/<repo>.json): seed id -> server id maps
// plus the director's last completed stage. Not secret.
// ---------------------------------------------------------------------------

export function readState(repo) {
  const f = stateFile(repo);
  if (!existsSync(f)) return { repo, goals: {}, intents: {}, stage: 0 };
  try {
    return { goals: {}, intents: {}, stage: 0, ...JSON.parse(readFileSync(f, "utf8")) };
  } catch {
    return { repo, goals: {}, intents: {}, stage: 0 };
  }
}

export function writeState(repo, state) {
  const f = stateFile(repo);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ ...state, repo, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
