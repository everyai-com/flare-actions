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
//   node scripts/artifacts-mirror.mjs rotate <mirror-repo> --seats-config <path> [--namespace ns]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const YEAR_TTL = 31536000;

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
  } catch (err) {
    console.error(`sync failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rotate(mirrorRepo, namespace, seatsConfig) {
  if (!/^[\w.-]{1,100}$/.test(mirrorRepo)) {
    console.error(`bad mirror repo: ${mirrorRepo}`);
    process.exit(1);
  }
  if (!seatsConfig) {
    console.error("rotate needs --seats-config <path to seats wrangler config>");
    process.exit(1);
  }
  const token = issueToken(mirrorRepo, namespace, "read", YEAR_TTL);
  // Secret via stdin pipe, never argv (repo rule).
  const r = spawnSync("npx", ["wrangler", "secret", "put", "ARTIFACTS_MIRROR_TOKEN", "--config", seatsConfig], {
    input: token,
    encoding: "utf8",
  });
  if ((r.status ?? 1) !== 0) {
    console.error(`secret put failed:\n${((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`ARTIFACTS_MIRROR_TOKEN rotated for ${namespace}/${mirrorRepo} (old token expires on its own TTL)`);
}

const [cmd, a, b] = process.argv.slice(2);
const namespace = flag("namespace", "flare-mirrors");
if (cmd === "provision" && a) provision(a, namespace);
else if (cmd === "sync" && a && b) sync(a, b, namespace);
else if (cmd === "rotate" && a) rotate(a, namespace, flag("seats-config"));
else {
  console.error("usage: artifacts-mirror.mjs (provision owner/repo | sync owner/repo <sha> | rotate <mirror-repo> --seats-config <path>) [--namespace ns]");
  process.exit(1);
}
