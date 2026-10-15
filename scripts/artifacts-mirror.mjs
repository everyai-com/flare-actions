#!/usr/bin/env node
// Artifacts mirror provisioning: create mirror repos, sync shas from
// GitHub, and rotate the shared read token. Mirrors inside the seats
// ARTIFACTS binding namespace need no stored token at all (seats mint
// per-job tokens, B2); the shared token path is for cross-namespace
// (single-repo) mirrors.
//
// Usage:
//   node scripts/artifacts-mirror.mjs provision owner/repo [--namespace ns]
//   node scripts/artifacts-mirror.mjs sync owner/repo <sha> [--namespace ns]
//   node scripts/artifacts-mirror.mjs rotate <mirror-repo> (--seats-config <path> | --worker-name <name>) [--namespace ns]
//   node scripts/artifacts-mirror.mjs lanes <artifacts-repo> [--namespace ns]
// (--worker-name addresses the seats worker without its generated
// config file, for the scheduled rotation workflow.)
//
// Forge lane-ref pool: trains force-update the fixed refs
// refs/heads/forge/lane-0..31 (speculation_depth x max_parallel; spike
// S5: the Worker must never push a NEW ref — isomorphic-git would upload
// the whole history). `sync` creates any missing pool ref at the synced
// sha; `lanes` does it for an existing Artifacts repo (e.g. a Forge
// trunk) at its current main. Existing refs are never touched.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const YEAR_TTL = 31536000;
// Keep in sync with MAX_LANE_REFS in apps/worker/src/train-core.ts.
export const LANE_REF_POOL = 32;

export function laneRefPool(n = LANE_REF_POOL) {
  return Array.from({ length: n }, (_, i) => `refs/heads/forge/lane-${i}`);
}

// Refspecs that create the missing pool refs at `sha` (pure).
export function missingLaneRefspecs(existingRefs, sha) {
  const have = new Set(existingRefs);
  return laneRefPool()
    .filter((r) => !have.has(r))
    .map((r) => `${sha}:${r}`);
}

// Create missing lane refs on `authedRemote` from a local git dir holding
// `sha`. One push; never echoes the remote (it embeds a token).
function ensureLaneRefs(gitDir, authedRemote, sha, label) {
  const ls = sh("git", ["ls-remote", "--heads", authedRemote, "refs/heads/forge/lane-*"]);
  if (ls.status !== 0) {
    console.error(`lane refs: ls-remote failed for ${label}`);
    return false;
  }
  const existing = ls.out
    .split("\n")
    .map((l) => l.split("\t")[1])
    .filter(Boolean);
  const specs = missingLaneRefspecs(existing, sha);
  if (!specs.length) {
    console.log(`lane refs: ${label} already has all ${LANE_REF_POOL}`);
    return true;
  }
  const r = sh("git", ["--git-dir", gitDir, "push", "-q", authedRemote, ...specs]);
  if (r.status !== 0) {
    console.error(`lane refs: push failed for ${label} (exit ${r.status})`);
    return false;
  }
  console.log(`lane refs: created ${specs.length} on ${label} at ${sha.slice(0, 12)}`);
  return true;
}

function flag(name, def = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function mirrorName(githubRepo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    console.error(`not owner/repo: ${githubRepo}`);
    process.exit(1);
  }
  return githubRepo.replace("/", "-");
}

function provision(githubRepo, namespace) {
  const name = mirrorName(githubRepo);
  const r = sh("npx", ["wrangler", "artifacts", "repos", "create", name, "--namespace", namespace]);
  if (r.status !== 0 && !/already exists/i.test(r.out)) {
    console.error(`provision failed:\n${r.out.slice(0, 600)}`);
    process.exit(1);
  }
  console.log(/already exists/i.test(r.out) ? `mirror ${name} already exists, reusing` : `mirror ${name} created in ${namespace}`);
}

function issueToken(mirrorRepo, namespace, scope, ttl) {
  const r = sh("npx", ["wrangler", "artifacts", "repos", "issue-token", mirrorRepo, "--namespace", namespace, "--scope", scope, "--ttl", String(ttl)]);
  const token = r.out.match(/art_v2_\S+/)?.[0];
  if (r.status !== 0 || !token) {
    console.error(`issue-token failed:\n${r.out.slice(0, 600)}`);
    process.exit(1);
  }
  return token;
}

function sync(githubRepo, sha, namespace) {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
    console.error(`not a sha: ${sha}`);
    process.exit(1);
  }
  const name = mirrorName(githubRepo);
  const info = sh("npx", ["wrangler", "artifacts", "repos", "get", name, "--namespace", namespace]);
  const remote = info.out.match(/remote:\s+(https:\/\/\S+\.git)/)?.[1];
  if (info.status !== 0 || !remote) {
    console.error(`mirror repo not found (provision first): ${name}`);
    process.exit(1);
  }
  const writeToken = issueToken(name, namespace, "write", 3600);
  const dir = mkdtempSync(join(tmpdir(), "flare-mirror-"));
  try {
    execFileSync("git", ["clone", "-q", "--bare", `https://github.com/${githubRepo}.git`, dir + "/src"], { stdio: "pipe" });
    execFileSync("git", ["--git-dir", dir + "/src", "cat-file", "-t", sha], { stdio: "pipe" });
    const authed = `https://x-access-token:${encodeURIComponent(writeToken)}@${remote.slice("https://".length)}`;
    const r = sh("git", ["--git-dir", dir + "/src", "push", "-q", authed, `${sha}:refs/heads/main`]);
    // Never echo the remote: it embeds the token.
    if (r.status !== 0) {
      console.error(`sync push failed for ${name} (exit ${r.status})`);
      process.exit(1);
    }
    console.log(`mirror ${name}: ${sha.slice(0, 12)} synced`);
    if (!ensureLaneRefs(dir + "/src", authed, sha, name)) process.exit(1);
  } catch (err) {
    console.error(`sync failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rotate(mirrorRepo, namespace, seatsConfig, workerName) {
  if (!/^[\w.-]{1,100}$/.test(mirrorRepo)) {
    console.error(`bad mirror repo: ${mirrorRepo}`);
    process.exit(1);
  }
  if (!seatsConfig && !workerName) {
    console.error("rotate needs --seats-config <path to seats wrangler config> or --worker-name <seats worker name>");
    process.exit(1);
  }
  const token = issueToken(mirrorRepo, namespace, "read", YEAR_TTL);
  // Secret via stdin pipe, never argv (repo rule).
  const putArgs = seatsConfig
    ? ["wrangler", "secret", "put", "ARTIFACTS_MIRROR_TOKEN", "--config", seatsConfig]
    : ["wrangler", "secret", "put", "ARTIFACTS_MIRROR_TOKEN", "--name", workerName];
  const r = spawnSync("npx", putArgs, {
    input: token,
    encoding: "utf8",
  });
  if ((r.status ?? 1) !== 0) {
    console.error(`secret put failed:\n${((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`ARTIFACTS_MIRROR_TOKEN rotated for ${namespace}/${mirrorRepo} (old token expires on its own TTL)`);
}

// Bootstrap the lane-ref pool on an Artifacts repo at its current main.
function lanes(repo, namespace) {
  if (!/^[\w.-]{1,100}$/.test(repo)) {
    console.error(`bad repo: ${repo}`);
    process.exit(1);
  }
  const info = sh("npx", ["wrangler", "artifacts", "repos", "get", repo, "--namespace", namespace]);
  const remote = info.out.match(/remote:\s+(https:\/\/\S+\.git)/)?.[1];
  if (info.status !== 0 || !remote) {
    console.error(`repo not found: ${repo}`);
    process.exit(1);
  }
  const token = issueToken(repo, namespace, "write", 3600);
  const authed = `https://x-access-token:${encodeURIComponent(token)}@${remote.slice("https://".length)}`;
  const dir = mkdtempSync(join(tmpdir(), "flare-lanes-"));
  try {
    execFileSync("git", ["init", "-q", "--bare", dir + "/src"], { stdio: "pipe" });
    const f = sh("git", ["--git-dir", dir + "/src", "fetch", "-q", "--depth", "1", authed, "refs/heads/main"]);
    if (f.status !== 0) {
      console.error(`fetch main failed for ${repo} (exit ${f.status})`);
      process.exit(1);
    }
    const sha = execFileSync("git", ["--git-dir", dir + "/src", "rev-parse", "FETCH_HEAD"], { encoding: "utf8" }).trim();
    if (!ensureLaneRefs(dir + "/src", authed, sha, repo)) process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2);
  const namespace = flag("namespace", "flare-mirrors");
  if (cmd === "provision" && a) provision(a, namespace);
  else if (cmd === "sync" && a && b) sync(a, b, namespace);
  else if (cmd === "rotate" && a) rotate(a, namespace, flag("seats-config"), flag("worker-name"));
  else if (cmd === "lanes" && a) lanes(a, namespace);
  else {
    console.error("usage: artifacts-mirror.mjs (provision owner/repo | sync owner/repo <sha> | rotate <mirror-repo> (--seats-config <path> | --worker-name <name>) | lanes <artifacts-repo>) [--namespace ns]");
    process.exit(1);
  }
}
