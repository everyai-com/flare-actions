import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FlareClient } from "flare-actions-runner-sdk";

// `cli connect`: Jog-style one-command adoption — probe the deployment,
// explain the wiring, optionally wire the webhook (--wire), then dispatch
// HEAD and report a compact verdict. Exit codes: 0 connected/verified,
// 1 the verification run failed, 2 usage/environment errors.

export type ConnectClient = Pick<FlareClient, "dispatch" | "waitRun" | "getRunDigest">;

export interface ConnectOptions {
  cwd: string;
  baseUrl: string;
  repo?: string;
  wire?: boolean;
  dryRun?: boolean;
  client?: ConnectClient | null;
  env?: Record<string, string | undefined>;
  git?: (args: string[]) => string;
  fetchFn?: typeof fetch;
  newSecret?: () => string;
  log?: (line: string) => void;
  err?: (line: string) => void;
}

export interface ConnectResult {
  exitCode: 0 | 1 | 2;
  repo: string | null;
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

  let repo = opts.repo?.trim() || null;
  if (!repo) {
    try {
      repo = parseRepoFromRemote(git(["remote", "get-url", "origin"]));
    } catch {
      repo = null;
    }
  } else if (!isRepoSlug(repo)) {
    err(`invalid repo "${repo}" — want owner/name`);
    return { exitCode: 2, repo: null };
  }
  if (!repo) {
    err("could not resolve owner/name — pass it explicitly or set a github origin remote");
    return { exitCode: 2, repo: null };
  }

  if (opts.dryRun) {
    log(`plan for ${repo} against ${baseUrl}:`);
    log("  1. probe GET /v1/admin/status (deployment + GitHub App state)");
    log("  2. detect flare.yml / .github/workflows in this directory");
    if (opts.wire) log("  3. --wire: set the webhook secret, then create/reuse the repo webhook");
    else log("  3. print the wiring recipe (dashboard Connect or repo webhook)");
    log("  4. dispatch HEAD and report the compact verdict (one bounded wait)");
    return { exitCode: 0, repo };
  }

  let status: AdminStatus;
  try {
    const res = await fetchFn(`${baseUrl}/v1/admin/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = (await res.json()) as AdminStatus;
  } catch (e) {
    err(`deployment not reachable at ${baseUrl} (${e instanceof Error ? e.message : String(e)})`);
    return { exitCode: 2, repo };
  }
  const claimed = status.claimed === true;
  const appConnected = status.githubConnected === true;
  const installUrl = typeof status.installUrl === "string" ? status.installUrl : null;
  log(`deployment: ${baseUrl} (${claimed ? "claimed" : "unclaimed — open /dashboard to claim admin"})`);
  log(`github app: ${appConnected ? "connected" : "not connected"}`);

  const hasFlareYml = existsSync(join(opts.cwd, "flare.yml"));
  const workflowsDir = join(opts.cwd, ".github", "workflows");
  const workflows = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((n) => /\.ya?ml$/i.test(n)).sort()
    : [];
  if (hasFlareYml) log("pipeline: flare.yml runs as-is (native format wins when present)");
  else if (workflows.length > 0) {
    log(`pipeline: ${workflows.length} workflow${workflows.length === 1 ? "" : "s"} run unchanged — zero-line change (${workflows.slice(0, 3).join(", ")}${workflows.length > 3 ? "…" : ""})`);
  } else {
    log("pipeline: none found — `cli init` scaffolds a starter, or add .github/workflows (they run unchanged)");
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
      return { exitCode: 2, repo };
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
      return { exitCode: 2, repo };
    }
    const ghHeaders = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" };
    const hooksRes = await fetchFn(`https://api.github.com/repos/${repo}/hooks`, { headers: ghHeaders });
    if (!hooksRes.ok) {
      err(`could not list repo webhooks: HTTP ${hooksRes.status} (check the repo slug and token scopes)`);
      return { exitCode: 2, repo };
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
        return { exitCode: 2, repo };
      }
      log(`wiring: webhook created → ${webhookUrl} (push + pull_request)`);
    }
  }

  if (!opts.client) {
    log("verify: set RUNNER_TOKEN to dispatch a verification run — skipping (wiring above is complete)");
    return { exitCode: 0, repo };
  }
  let head: string;
  try {
    head = git(["rev-parse", "HEAD"]);
  } catch {
    err("could not resolve HEAD — commit first, or verify a pushed sha with `cli run <repo> <sha>`");
    return { exitCode: 2, repo };
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
    log(`check back with \`cli watch ${dispatched.runId}\``);
    return { exitCode: 0, repo };
  }
  const digest = await opts.client.getRunDigest(dispatched.runId);
  const failed = digest.jobs.filter((j) => j.status !== "success" && j.status !== "skipped");
  log(`${digest.status}  ${digest.repo}@${digest.sha.slice(0, 7)} (${digest.branch || "-"}, ${digest.failedJobs}/${digest.totalJobs} failed)`);
  for (const j of failed.slice(0, 10)) log(`  FAIL ${j.name} (${j.status})`);
  return { exitCode: digest.status === "success" ? 0 : 1, repo };
}
