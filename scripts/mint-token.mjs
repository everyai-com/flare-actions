#!/usr/bin/env node
// Mint a least-privilege Cloudflare API token for one profile.
// Usage: npm run token:mint -- --profile ci [--account <id>] [--worker <script>...] [--dry-run]
// Needs a parent credential with API Tokens Write: CLOUDFLARE_API_TOKEN
// env, else wrangler's stored OAuth token. Without either (or without
// list permission), prints the exact dashboard checklist instead of
// failing — creating the token by hand takes a minute.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOKEN_PROFILES, buildMintBody, listPermissionGroups, mintToken, profileNames, resolvePermissionIds, resolveWorkerGroupIds } from "./api-tokens.mjs";

const API_BASE = "https://api.cloudflare.com/client/v4";
const DASH_TOKENS = "https://dash.cloudflare.com/profile/api-tokens";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function argAll(flag) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]);
  }
  return out;
}

const profile = arg("--profile") ?? "ci";
const dryRun = process.argv.includes("--dry-run");
const workerScripts = argAll("--worker");
let accountId = arg("--account") ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;

if (!TOKEN_PROFILES[profile]) {
  console.error(`unknown profile "${profile}" (want one of: ${profileNames().join(", ")})`);
  process.exit(1);
}
const spec = TOKEN_PROFILES[profile];
if (workerScripts.length > 0 && !spec.workerScoped) {
  console.error(`--worker scoping needs a workerScoped profile (ci, debug); "${profile}" is account-level by nature`);
  process.exit(1);
}

function printChecklist() {
  console.log(`Least-privilege token checklist (${profile}: ${spec.description}):`);
  console.log(`1. Open ${DASH_TOKENS} -> Create Token -> Custom token`);
  console.log("2. Permissions (account scope):");
  const accountGroups = workerScripts.length > 0 ? spec.groups.filter((g) => g !== spec.workerScoped.replaces) : spec.groups;
  for (const g of accountGroups) console.log(`   - ${g}`);
  if (workerScripts.length > 0) {
    console.log(`   + Individual Workers Scripts (${spec.workerScoped.access}) on Specified Workers: ${workerScripts.join(", ")}`);
    console.log(`   (replaces account-wide "${spec.workerScoped.replaces}")`);
  }
  console.log("3. Account Resources: Include -> the one account (never All accounts)");
  if (accountId) console.log(`   (this deploy's account id: ${accountId})`);
  console.log("4. Create, then store as CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) in CI secrets.");
}

if (dryRun) {
  console.log(`(dry-run) profile "${profile}": ${spec.description}`);
  for (const g of spec.groups) console.log(`  allow: ${g}`);
  if (workerScripts.length > 0) console.log(`  worker-scoped to: ${workerScripts.join(", ")} (${spec.workerScoped.access})`);
  printChecklist();
  process.exit(0);
}

// Parent credential: explicit env token first, else wrangler's login.
let parent = process.env.CLOUDFLARE_API_TOKEN ?? null;
if (!parent) {
  const toml = join(homedir(), ".wrangler", "config", "default.toml");
  if (existsSync(toml)) {
    const m = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(toml, "utf8"));
    if (m) parent = m[1];
  }
}
if (!parent) {
  console.log("No parent Cloudflare credential found (CLOUDFLARE_API_TOKEN or `wrangler login`).\n");
  printChecklist();
  process.exit(0);
}
if (!accountId) {
  // The account id scopes the token; without it we cannot mint safely.
  console.log("Account id needed: pass --account <id> or set CLOUDFLARE_ACCOUNT_ID.\n");
  printChecklist();
  process.exit(0);
}

let groups;
try {
  groups = await listPermissionGroups(API_BASE, parent);
} catch (err) {
  console.log(`Cannot list permission groups (${err instanceof Error ? err.message : String(err)}).`);
  console.log("The parent credential needs API Tokens Write to mint; create by hand instead:\n");
  printChecklist();
  process.exit(0);
}
const accountGroups = workerScripts.length > 0 ? spec.groups.filter((g) => g !== spec.workerScoped.replaces) : spec.groups;
const resolved = resolvePermissionIds(groups, accountGroups);
if ("missing" in resolved) {
  console.error(`Refusing to mint: unknown permission groups: ${resolved.missing.join(", ")}`);
  if (resolved.candidates.length > 0) console.error(`Close matches: ${resolved.candidates.join(", ")}`);
  process.exit(1);
}
let workerGroupIds;
if (workerScripts.length > 0) {
  const wresolved = resolveWorkerGroupIds(groups, spec.workerScoped.access);
  if ("missing" in wresolved) {
    console.error(`Refusing to mint: ${wresolved.missing.join(", ")} not in the live permission list`);
    if (wresolved.candidates.length > 0) console.error(`Individual Workers groups seen: ${wresolved.candidates.join(", ")}`);
    else console.error("No Individual Workers groups seen — the account may predate granular Worker permissions.");
    process.exit(1);
  }
  workerGroupIds = wresolved.ids;
  console.log(`Worker scoping via "${wresolved.group}" on: ${workerScripts.join(", ")}`);
}
const body = buildMintBody(`flare-actions-${profile}`, accountId, resolved.ids, { workerScripts, workerGroupIds });
try {
  const minted = await mintToken(API_BASE, parent, body);
  console.log("Minted least-privilege token (shown once — store it now):");
  console.log(minted.value);
  console.log(`\nProfile: ${profile} (${spec.description}). Set CLOUDFLARE_API_TOKEN to the value above.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
