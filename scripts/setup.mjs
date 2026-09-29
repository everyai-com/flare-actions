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

// 2. D1 database (idempotent; deploys also auto-provision by name)
{
  const r = run("npx", ["wrangler", "d1", "create", "flare-actions"]);
  const out = r.stdout + r.stderr;
  if (r.status !== 0 && !/already (exists|taken)/i.test(out) && !dryRun) {
    fail(`d1 create failed:\n${out}`);
  }
  if (/already (exists|taken)/i.test(out)) console.log("D1 flare-actions already exists, reusing");
}

// 3. Queues (idempotent)
for (const q of ["flare-actions-runs", "flare-actions-dlq"]) {
  const r = run("npx", ["wrangler", "queues", "create", q]);
  const out = r.stdout + r.stderr;
  if (r.status !== 0 && !/already (exists|taken)/i.test(out) && !dryRun) {
    fail(`queue create ${q} failed:\n${out}`);
  }
  if (/already (exists|taken)/i.test(out)) console.log(`queue ${q} already exists, reusing`);
}

// 4. Migrations
{
  const r = run("npx", ["wrangler", "d1", "migrations", "apply", "flare-actions", "--remote", "--config", config]);
  if (r.status !== 0 && !dryRun) fail(`migrations failed:\n${r.stdout}\n${r.stderr}`);
}

// 5. Secrets (piped via stdin; values never appear in commands)
const webhookSecret = randomBytes(32).toString("hex");
const runnerToken = randomBytes(32).toString("hex");
const adminToken = randomBytes(32).toString("hex");
for (const [name, value] of [
  ["GITHUB_WEBHOOK_SECRET", webhookSecret],
  ["RUNNER_TOKEN", runnerToken],
  ["ADMIN_TOKEN", adminToken],
]) {
  const r = run("npx", ["wrangler", "secret", "put", name, "--config", config], { input: value });
  if (r.status !== 0 && !dryRun) fail(`secret put ${name} failed:\n${r.stdout}\n${r.stderr}`);
}

// 6. Deploy
let workerUrl = null;
{
  const r = run("npx", ["wrangler", "deploy", "--config", config]);
  const m = /(https:\/\/[^\s]+\.workers\.dev)/.exec(r.stdout + r.stderr);
  if (m) workerUrl = m[1];
  else if (!dryRun) fail(`deploy failed:\n${r.stdout}\n${r.stderr}`);
}

// 7. Write .env (merge, preserve unknown lines)
if (!dryRun) {
  const path = join(root, ".env");
  const wanted = {
    FLARE_ACTIONS_URL: workerUrl,
    RUNNER_TOKEN: runnerToken,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    ADMIN_TOKEN: adminToken,
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
  console.log(`Dashboard: ${workerUrl}/dashboard (password = ADMIN_TOKEN in .env)`);
  console.log("Next: create the GitHub App (see README), then `npm run runner` and `npm run cli -- runs`.");
}
