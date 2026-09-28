#!/usr/bin/env node
// One-command provisioner for Flare Actions.
// Creates D1 + queues, applies migrations, generates secrets, deploys,
// and writes a gitignored `.env` so runner/CLI work with zero config.
// Usage: npm run setup [-- --dry-run]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = "apps/worker/wrangler.jsonc";
const dryRun = process.argv.includes("--dry-run");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (dryRun) return { stdout: "", stderr: "", status: 0 };
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function fail(msg) {
  console.error(`setup failed: ${msg}`);
  process.exit(1);
}

// 1. Auth check
{
  const r = run("npx", ["wrangler", "whoami"]);
  if (r.status !== 0) fail("wrangler is not logged in. Run `npx wrangler login` first.");
}

// 2. D1 database (idempotent)
let databaseId = null;
{
  const r = run("npx", ["wrangler", "d1", "create", "flare-actions"]);
  const m = /"database_id"\s*:\s*"([^"]+)"/.exec(r.stdout + r.stderr);
  if (m) {
    databaseId = m[1];
  } else if (/already exists/i.test(r.stdout + r.stderr)) {
    const cfg = readFileSync(join(root, config), "utf8");
    const existing = /"database_id"\s*:\s*"([^"]+)"/.exec(cfg);
    if (!existing) fail("D1 exists but no database_id in wrangler.jsonc");
    databaseId = existing[1];
    console.log(`reusing database_id ${databaseId}`);
  } else if (!dryRun) {
    fail(`d1 create failed:\n${r.stdout}\n${r.stderr}`);
  }
}

// 3. Patch database_id into wrangler.jsonc
if (!dryRun && databaseId) {
  const path = join(root, config);
  let cfg = readFileSync(path, "utf8");
  if (/"database_id"\s*:/.test(cfg)) {
    cfg = cfg.replace(/("database_id"\s*:\s*")[^"]+"/, `$1${databaseId}"`);
  } else {
    cfg = cfg.replace(
      /("database_name"\s*:\s*"flare-actions")/,
      `$1,"database_id": "${databaseId}"`,
    );
  }
  writeFileSync(path, cfg);
  console.log("wrangler.jsonc database_id set");
}

// 4. Queues (idempotent)
for (const q of ["flare-actions-runs", "flare-actions-dlq"]) {
  const r = run("npx", ["wrangler", "queues", "create", q]);
  const out = r.stdout + r.stderr;
  if (r.status !== 0 && !/already exists/i.test(out) && !dryRun) fail(`queue create ${q} failed:\n${out}`);
}

// 5. Migrations
{
  const r = run("npx", ["wrangler", "d1", "migrations", "apply", "flare-actions", "--remote", "--config", config]);
  if (r.status !== 0 && !dryRun) fail(`migrations failed:\n${r.stdout}\n${r.stderr}`);
}

// 6. Secrets (piped via stdin; values never appear in commands)
const webhookSecret = randomBytes(32).toString("hex");
const runnerToken = randomBytes(32).toString("hex");
for (const [name, value] of [
  ["GITHUB_WEBHOOK_SECRET", webhookSecret],
  ["RUNNER_TOKEN", runnerToken],
]) {
  const r = run("npx", ["wrangler", "secret", "put", name, "--config", config], { input: value });
  if (r.status !== 0 && !dryRun) fail(`secret put ${name} failed:\n${r.stdout}\n${r.stderr}`);
}

// 7. Deploy
let workerUrl = null;
{
  const r = run("npx", ["wrangler", "deploy", "--config", config]);
  const m = /(https:\/\/[^\s]+\.workers\.dev)/.exec(r.stdout + r.stderr);
  if (m) workerUrl = m[1];
  else if (!dryRun) fail(`deploy failed:\n${r.stdout}\n${r.stderr}`);
}

// 8. Write .env (merge, preserve unknown lines)
if (!dryRun) {
  const path = join(root, ".env");
  const wanted = {
    FLARE_ACTIONS_URL: workerUrl,
    RUNNER_TOKEN: runnerToken,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
  };
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = line.split("=")[0].trim();
    if (key in wanted) {
      out.push(`${key}=${wanted[key]}`);
      seen.add(key);
    } else if (line.trim()) {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(wanted)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(path, out.join("\n") + "\n", { mode: 0o600 });
  console.log("wrote .env (gitignored)");
}

console.log("\nDone.");
if (!dryRun) {
  console.log(`Worker:  ${workerUrl}`);
  console.log(`Webhook: ${workerUrl}/webhooks/github`);
  console.log(`Webhook secret (paste once into your GitHub App): ${webhookSecret}`);
  console.log("Next: create the GitHub App (see README), then `npm run runner` and `npm run cli -- runs`.");
}
