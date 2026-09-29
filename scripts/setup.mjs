#!/usr/bin/env node
// One-command provisioner for Flare Actions.
// Creates D1 + queues + R2, applies migrations, generates secrets,
// deploys the main worker (and the managed seats worker when docker is
// available), and writes a gitignored `.env` so runner/CLI work with zero config.
// Usage: npm run setup [-- --dry-run]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
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
for (const q of ["flare-actions-runs", "flare-actions-dlq", "flare-actions-seats"]) {
  const r = run("npx", ["wrangler", "queues", "create", q]);
  const out = r.stdout + r.stderr;
  if (r.status !== 0 && !/already (exists|taken)/i.test(out) && !dryRun) {
    fail(`queue create ${q} failed:\n${out}`);
  }
  if (/already (exists|taken)/i.test(out)) console.log(`queue ${q} already exists, reusing`);
}

// 4. R2 bucket for build cache + artifacts (idempotent)
{
  const r = run("npx", ["wrangler", "r2", "bucket", "create", "flare-actions-cache"]);
  const out = r.stdout + r.stderr;
  if (r.status !== 0 && !/already (exists|taken)/i.test(out) && !dryRun) {
    fail(`r2 bucket create failed:\n${out}`);
  }
  if (/already (exists|taken)/i.test(out)) console.log("R2 flare-actions-cache already exists, reusing");
}

// 5. Migrations
{
  const r = run("npx", ["wrangler", "d1", "migrations", "apply", "flare-actions", "--remote", "--config", config]);
  if (r.status !== 0 && !dryRun) fail(`migrations failed:\n${r.stdout}\n${r.stderr}`);
}

// 6. Secrets (piped via stdin; values never appear in commands)
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

// 7. Deploy
let workerUrl = null;
{
  const r = run("npx", ["wrangler", "deploy", "--config", config]);
  const m = /(https:\/\/[^\s]+\.workers\.dev)/.exec(r.stdout + r.stderr);
  if (m) workerUrl = m[1];
  else if (!dryRun) fail(`deploy failed:\n${r.stdout}\n${r.stderr}`);
}

// 8. Managed seats worker (needs local docker; cleanly skipped otherwise —
// BYO runners cover everything seats do, minus the zero-box experience).
const seatsConfig = "apps/seats/wrangler.jsonc";
let seatsUrl = null;
let seatsToken = null;
{
  const docker = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.status !== 0 && !dryRun) {
    console.log("docker not available — skipping managed seats (see docs/CONTAINERS.md to add later)");
  } else if (dryRun) {
    console.log("(dry-run) would build/push the seat image and deploy the seats worker");
  } else {
    // Content tag: the image rebuilds only when the Dockerfile changes,
    // so re-runs reuse the registry image and just redeploy workers.
    const dockerfile = readFileSync(join(root, "apps/seats/Dockerfile"), "utf8");
    const tag = `flare-actions-seat:${createHash("sha1").update(dockerfile).digest("hex").slice(0, 12)}`;
    let r = run("docker", ["build", "--platform", "linux/amd64", "-t", tag, "apps/seats"]);
    if (r.status !== 0) fail(`seat image build failed:\n${r.stdout}\n${r.stderr}`);
    r = run("npx", ["wrangler", "containers", "push", tag]);
    const pushed = /Pushed image: (\S+)/.exec(r.stdout + r.stderr);
    if (!pushed) fail(`seat image push failed:\n${r.stdout}\n${r.stderr}`);
    const seatsPath = join(root, seatsConfig);
    const seatsCfg = JSON.parse(readFileSync(seatsPath, "utf8"));
    seatsCfg.containers[0].image = pushed[1];
    writeFileSync(seatsPath, JSON.stringify(seatsCfg));
    // Token gates the seats public URL for direct debugging; the main
    // worker needs nothing — wakes travel over the seats queue.
    seatsToken = randomBytes(32).toString("hex");
    const s = run("npx", ["wrangler", "secret", "put", "SEATS_TOKEN", "--config", seatsConfig], { input: seatsToken });
    if (s.status !== 0) fail(`secret put SEATS_TOKEN failed:\n${s.stdout}\n${s.stderr}`);
    const d = run("npx", ["wrangler", "deploy", "--config", seatsConfig]);
    const m = /(https:\/\/[^\s]+\.workers\.dev)/.exec(d.stdout + d.stderr);
    if (!m) fail(`seats deploy failed:\n${d.stdout}\n${d.stderr}`);
    seatsUrl = m[1];
    console.log(`seats live at ${seatsUrl}`);
  }
}

// 9. Write .env (merge, preserve unknown lines)
if (!dryRun) {
  const path = join(root, ".env");
  const wanted = {
    FLARE_ACTIONS_URL: workerUrl,
    RUNNER_TOKEN: runnerToken,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    ADMIN_TOKEN: adminToken,
    ...(seatsToken ? { SEATS_TOKEN: seatsToken } : {}),
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
  console.log(seatsUrl ? `Seats:    ${seatsUrl} (managed executor live)` : "Seats:    skipped (no docker — BYO runners cover execution)");
  console.log("Next: create the GitHub App (see README), then `npm run runner` and `npm run cli -- runs`.");
}
