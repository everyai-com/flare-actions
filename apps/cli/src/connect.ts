import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FlareClient } from "flare-actions-runner-sdk";
import { detectStacks, formatStacks, primaryStack, type DetectedStack } from "./detect.ts";
import { runInit, type InitResult } from "./init.ts";

// `cli connect`: Jog-style one-command adoption — detect the stack,
// scaffold the pipeline (--init), probe the deployment, explain the
// wiring (one-click App install URL, optionally wire the webhook with
// --wire), then dispatch HEAD and report a compact verdict. Exit codes:
// 0 connected/verified, 1 the verification run failed, 2
// usage/environment errors. Non-interactive and idempotent: re-runs
// never duplicate webhooks or overwrite flare.yml.

export type ConnectClient = Pick<FlareClient, "dispatch" | "waitRun" | "getRunDigest">;

export type ConnectPipeline = "flare.yml" | "workflows" | "none";

export interface ConnectOptions {
  cwd: string;
  baseUrl: string;
  repo?: string;
  wire?: boolean;
  /** Scaffold flare.yml via init when no pipeline file exists. */
  init?: boolean;
  dryRun?: boolean;
  client?: ConnectClient | null;
  env?: Record<string, string | undefined>;
  git?: (args: string[]) => string;
  fetchFn?: typeof fetch;
  newSecret?: () => string;
  /** Filesystem scaffold (injectable for tests); defaults to runInit. */
  scaffold?: (cwd: string) => InitResult;
  log?: (line: string) => void;
  err?: (line: string) => void;
  /** How the user invoked the CLI, for the `next` line (default `cli`). */
  cli?: string;
}

export interface ConnectResult {
  exitCode: 0 | 1 | 2;
  repo: string | null;
  stacks: DetectedStack[];
  pipeline: ConnectPipeline;
  scaffolded: boolean;
  /** The one next move for a human ("next: ..."); never printed by runConnect. */
  next: string;
}

interface AdminStatus {
  claimed?: unknown;
  githubConnected?: unknown;
  installUrl?: unknown;
}

// owner/name out of an origin URL (https, ssh, git@ forms); null when the
// remote is missing or not a GitHub repo URL.
export function parseRepoFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`;
}

export function isRepoSlug(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

// 32 random bytes as 64 hex chars (16-512 chars, per the settings
// validator). Manual hex: randomBytes types as Uint8Array here.
export function randomHex(bytes = 32): string {
  return [...randomBytes(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultGit(cwd: string): (args: string[]) => string {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function runConnect(opts: ConnectOptions): Promise<ConnectResult> {
  const log = opts.log ?? console.log;
  const err = opts.err ?? console.error;
  const env = opts.env ?? process.env;
  const git = opts.git ?? defaultGit(opts.cwd);
  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  // Filesystem-only detection up front: dry-run reports it without
  // touching the network, and every exit path carries it for --json.
  const stacks = detectStacks(opts.cwd);
  const primary = primaryStack(stacks)?.stack ?? "generic";
  const hasFlareYml = existsSync(join(opts.cwd, "flare.yml"));
  const workflowsDir = join(opts.cwd, ".github", "workflows");
  const workflows = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((n) => /\.ya?ml$/i.test(n)).sort()
    : [];
  const pipeline: ConnectPipeline = hasFlareYml ? "flare.yml" : workflows.length > 0 ? "workflows" : "none";
  const cli = opts.cli ?? "cli";
  // `next` is either a CLI command (prefixed) or plain text.
  const cmd = (c: string, why?: string): string => `next: ${cli} ${c}${why ? `   (${why})` : ""}`;
  const done = (exitCode: 0 | 1 | 2, repoOut: string | null, scaffolded: boolean, next: string): ConnectResult =>
    ({ exitCode, repo: repoOut, stacks, pipeline: scaffolded ? "flare.yml" : pipeline, scaffolded, next });

  let repo = opts.repo?.trim() || null;
  if (!repo) {
    try {
      repo = parseRepoFromRemote(git(["remote", "get-url", "origin"]));
    } catch {
      repo = null;
    }
  } else if (!isRepoSlug(repo)) {
    err(`"${repo}" is not a project name. Use owner/name, like octo/app.`);
    return done(2, null, false, cmd("connect owner/name"));
  }
  if (!repo) {
    err("Could not find the project's owner/name: there is no GitHub origin remote here.");
    return done(2, null, false, cmd("connect owner/name", "name the project yourself"));
  }

  if (opts.dryRun) {
    log(`plan for ${repo} against ${baseUrl}:`);
    log(`  1. stack: ${formatStacks(stacks)} — pipeline ${pipeline === "none" ? "missing" : pipeline}`);
    if (pipeline !== "flare.yml" && opts.init) log(`  2. --init: scaffold flare.yml (${pipeline === "workflows" ? "converted from .github/workflows" : `${primary} starter`})`);
    else log("  2. detect flare.yml / .github/workflows in this directory (scaffold with --init)");
    log("  3. probe GET /v1/admin/status (deployment + GitHub App state)");
    if (opts.wire) log("  4. --wire: set the webhook secret, then create/reuse the repo webhook");
    else log("  4. print the wiring recipe (one-click App install URL or repo webhook)");
    log("  5. dispatch HEAD and report the compact verdict (one bounded wait)");
    return done(0, repo, false, cmd(`connect${opts.repo ? ` ${repo}` : ""}${opts.init ? " --init" : ""}${opts.wire ? " --wire" : ""}`, "do it for real"));
  }

  let status: AdminStatus;
  try {
    const res = await fetchFn(`${baseUrl}/v1/admin/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = (await res.json()) as AdminStatus;
  } catch (e) {
    err(`The deployment is not reachable at ${baseUrl} (${e instanceof Error ? e.message : String(e)}).`);
    return done(2, repo, false, cmd("doctor", "checks the URL and token"));
  }
  const claimed = status.claimed === true;
  const appConnected = status.githubConnected === true;
  const installUrl = typeof status.installUrl === "string" ? status.installUrl : null;
  log(`deployment: ${baseUrl} (${claimed ? "claimed" : "unclaimed — open /dashboard to claim admin"})`);
  log(`github app: ${appConnected ? "connected" : "not connected"}`);
  log(`stack: ${formatStacks(stacks)}`);

  let scaffolded = false;
  if (hasFlareYml) log("pipeline: flare.yml runs as-is (native format wins when present)");
  else if (workflows.length > 0) {
    log(`pipeline: ${workflows.length} workflow${workflows.length === 1 ? "" : "s"} run unchanged — zero-line change (${workflows.slice(0, 3).join(", ")}${workflows.length > 3 ? "…" : ""})`);
    log("suggestion: `cli init` converts them to a native flare.yml (optional — workflows run unchanged)");
  } else {
    log(`pipeline: none found — \`cli init\` scaffolds a ${primary} starter${opts.init ? "" : " (or pass --init to scaffold now)"}, or add .github/workflows (they run unchanged)`);
  }
  if (opts.init && !hasFlareYml) {
    const scaffold = opts.scaffold ?? ((cwd: string) => runInit({ cwd }));
    const res = scaffold(opts.cwd);
    if (res.error) {
      log(`scaffold: skipped (${res.error})`);
    } else {
      scaffolded = true;
      const what = res.pipelineSource === "converted" ? `converted from .github/workflows/${res.convertedFrom}` : `${res.starterStack} starter`;
      log(`scaffold: wrote ${res.pipelinePath} (${what}) + AGENTS.md snippet`);
    }
  }

  const webhookUrl = `${baseUrl}/webhooks/github`;
  if (appConnected) {
    log(installUrl ? `wiring: installed repos trigger automatically — install the app here: ${installUrl}` : "wiring: app connected — install it on this repo from the dashboard");
  } else {
    log(`wiring: no app connected. recommended: open ${baseUrl}/dashboard → Connect GitHub (guided).`);
    log(`  public-repo alternative: repo Settings → Webhooks → Add webhook: ${webhookUrl} (secret from dashboard Settings).`);
  }

  if (opts.wire) {
    const githubToken = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
    const adminToken = env["FLARE_ADMIN_TOKEN"];
    if (!githubToken || !adminToken) {
      err("--wire needs GITHUB_TOKEN (or GH_TOKEN) plus FLARE_ADMIN_TOKEN (admin API token from the dashboard)");
      return done(2, repo, scaffolded, `next: export GITHUB_TOKEN and FLARE_ADMIN_TOKEN, then ${cli} connect --wire`);
    }
    const secret = (opts.newSecret ?? randomHex)();
    const setRes = await fetchFn(`${baseUrl}/v1/admin/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ webhookSecret: secret }),
    });
    if (!setRes.ok) {
      const detail = await setRes.text().catch(() => "");
      err(`could not set the webhook secret: HTTP ${setRes.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
      return done(2, repo, scaffolded, "next: check FLARE_ADMIN_TOKEN is an admin token (dashboard Settings → API tokens), then retry");
    }
    const ghHeaders = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" };
    const hooksRes = await fetchFn(`https://api.github.com/repos/${repo}/hooks`, { headers: ghHeaders });
    if (!hooksRes.ok) {
      err(`could not list repo webhooks: HTTP ${hooksRes.status} (check the repo slug and token scopes)`);
      return done(2, repo, scaffolded, "next: give GITHUB_TOKEN the admin:repo_hook scope, then retry");
    }
    const hooks = (await hooksRes.json()) as { id?: unknown; config?: { url?: unknown } }[];
    const existing = Array.isArray(hooks) ? hooks.find((h) => h.config?.url === webhookUrl) : undefined;
    if (existing) {
      log(`wiring: webhook already points at ${webhookUrl} (id ${String(existing.id)}) — secret rotated`);
    } else {
      const createRes = await fetchFn(`https://api.github.com/repos/${repo}/hooks`, {
        method: "POST",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["push", "pull_request"],
          config: { url: webhookUrl, content_type: "json", secret },
        }),
      });
      if (!createRes.ok) {
        err(`could not create the repo webhook: HTTP ${createRes.status} (check token scopes: admin:repo_hook)`);
        return done(2, repo, scaffolded, "next: give GITHUB_TOKEN the admin:repo_hook scope, then retry");
      }
      log(`wiring: webhook created → ${webhookUrl} (push + pull_request)`);
    }
  }

  if (!opts.client) {
    log("verify: set RUNNER_TOKEN to dispatch a verification run — skipping (wiring above is complete)");
    return done(0, repo, scaffolded, cmd("login", "get a token so connect can run the first check"));
  }
  let head: string;
  try {
    head = git(["rev-parse", "HEAD"]);
  } catch {
    err(`could not resolve HEAD — commit first, or verify a pushed sha with \`${cli} run <repo> <sha>\``);
    return done(2, repo, scaffolded, cmd(`run ${repo} --source`, "checks your files without a commit"));
  }
  let dirty = false;
  try {
    dirty = git(["status", "--porcelain"]).trim().length > 0;
  } catch {
    // Status check failed (odd git state) — assume clean, HEAD still verifies.
  }
  if (dirty) log("note: working tree is dirty — HEAD is verified, uncommitted changes are not (commit, or use `cli run --source`)");

  const dispatched = await opts.client.dispatch(repo, head);
  log(`run ${dispatched.runId} dispatched for ${head.slice(0, 7)} — waiting (one bounded wait)…`);
  const waited = await opts.client.waitRun(dispatched.runId, 60);
  if (waited.timedOut) {
    log("still queued/running after 60s — no executor may be listening: start one with `npm run runner` (from your Flare checkout) or enable managed seats.");
    return done(0, repo, scaffolded, cmd(`watch ${dispatched.runId}`, "waits for the result"));
  }
  const digest = await opts.client.getRunDigest(dispatched.runId);
  const failed = digest.jobs.filter((j) => j.status !== "success" && j.status !== "skipped");
  log(`${digest.status}  ${digest.repo}@${digest.sha.slice(0, 7)} (${digest.branch || "-"}, ${digest.failedJobs}/${digest.totalJobs} failed)`);
  for (const j of failed.slice(0, 10)) log(`  FAIL ${j.name} (${j.status})`);
  return digest.status === "success"
    ? done(0, repo, scaffolded, cmd("runs", "connected; every push now shows up here"))
    : done(1, repo, scaffolded, cmd(`explain ${dispatched.runId}`, "what broke and how to fix it"));
}
