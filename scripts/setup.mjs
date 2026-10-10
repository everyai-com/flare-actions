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
import { applyMigrationsWithReconcile } from "./migrate-reconcile.mjs";
import { permissionHint } from "./api-tokens.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = "wrangler.jsonc";
const dryRun = process.argv.includes("--dry-run");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (dryRun) return { stdout: "", stderr: "", status: 0 };
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function fail(msg) {
  console.error(`setup failed: ${msg}`);
  // Enriched 403s link the missing permission: surface the fix, not
  // just the stack, and steer toward least-privilege tokens.
  const hint = permissionHint(msg);
  if (hint) console.error(`\n${hint}`);
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
for (const q of ["flare-actions-runs", "flare-actions-dlq", "flare-actions-seats", "flare-actions-seats-dlq", "flare-actions-artifacts", "flare-actions-artifacts-dlq"]) {
  const r = run("npx", ["wrangler", "queues", "create", q]);
  const out = r.stdout + r.stderr;
  if (r.status !== 0 && !/already (exists|taken)/i.test(out) && !dryRun) {
    fail(`queue create ${q} failed:\n${out}`);
  }
  if (/already (exists|taken)/i.test(out)) console.log(`queue ${q} already exists, reusing`);
}

// 3b. Artifacts namespace + push-event subscriptions (REST API: wrangler
// has no namespace-create and no artifacts.repo source options; only one
// subscription per repo is allowed). Namespace always ensured when API
// creds exist; subscriptions opt-in via ARTIFACTS_SUBSCRIBE_REPOS
// (comma-separated stable repo names in ARTIFACTS_NAMESPACE). Previews
// cannot attach queue consumers, so subscriptions target the prod queue;
// staging and dynamic tournament forks rely on the worker poller + tick.
{
  const repos = (process.env.ARTIFACTS_SUBSCRIBE_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const namespace = process.env.ARTIFACTS_NAMESPACE ?? "flare-tournaments";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!apiToken || !accountId) {
    console.log("Artifacts: set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to provision the namespace and push subscriptions, or do it by hand:");
    console.log("  namespace: dashboard > Workers > Artifacts, or POST /accounts/:id/artifacts/namespaces;");
    console.log("  subscriptions: queue flare-actions-artifacts > Subscriptions > Subscribe to events > source artifacts.repo > pushed.");
    if (repos.length > 0) console.log(`  pending repos: ${repos.join(", ")} (namespace ${namespace}).`);
  } else if (!/^[a-f0-9]{32}$/.test(accountId)) {
    fail("CLOUDFLARE_ACCOUNT_ID must be the 32-hex account id.");
  } else if (dryRun) {
    console.log(`(dry-run) would ensure namespace ${namespace}${repos.length > 0 ? ` and subscribe flare-actions-artifacts to pushed on ${repos.join(", ")}` : ""}.`);
  } else {
    try {
      const { ensureNamespace, ensurePushSubscriptions } = await import("./artifacts-admin.mjs");
      const ns = await ensureNamespace({ apiToken, accountId, namespace });
      console.log(ns.reused ? `Artifacts: namespace ${namespace} already exists, reusing` : `Artifacts: namespace ${namespace} created`);
      // Previews bind their own namespace (wrangler.jsonc previews block):
      // never production Artifacts repos (Forge trunks, agent forks).
      const previewNs = process.env.ARTIFACTS_PREVIEW_NAMESPACE ?? "flare-forge-preview";
      if (previewNs !== namespace) {
        const pns = await ensureNamespace({ apiToken, accountId, namespace: previewNs });
        console.log(pns.reused ? `Artifacts: preview namespace ${previewNs} already exists, reusing` : `Artifacts: preview namespace ${previewNs} created`);
      }
      if (repos.length === 0) {
        console.log("Artifacts: ARTIFACTS_SUBSCRIBE_REPOS unset — skipping push subscriptions (the worker poller still covers tournament forks).");
      } else {
        for (const r of await ensurePushSubscriptions({ apiToken, accountId, namespace, repos })) {
          console.log(r.reused ? `Artifacts: ${namespace}/${r.repo} already subscribed, reusing` : `Artifacts: subscribed flare-actions-artifacts to pushed on ${namespace}/${r.repo}`);
        }
      }
    } catch (err) {
      fail(String(err instanceof Error ? err.message : err));
    }
  }
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

// 5. Basin stream for long-term CI analytics (optional, paid plan).
// Best-effort: free-plan accounts fail here, which is fine — the
// worker skips Basin emission without a CI_EVENTS binding, and
// Analytics Engine still records everything. The binding itself is
// never patched into the committed wrangler.jsonc (setup leaves no
// dirty tree); the stream id prints below for a one-line add.
let basinStreamId = null;
{
  const r = run("npx", ["wrangler", "pipelines", "streams", "create", "flare-ci-events"]);
  const out = r.stdout + r.stderr;
  if (dryRun) {
    console.log("(dry-run) would create the flare-ci-events Basin stream");
  } else if (r.status !== 0 && !/already (exists|taken)/i.test(out)) {
    console.log("Basin stream not provisioned (optional, paid plan) — continuing without cold analytics.");
    console.log(`(pipelines error, first line: ${(out.trim().split("\n")[0] ?? "").slice(0, 160)})`);
  } else {
    if (/already (exists|taken)/i.test(out)) console.log("Basin stream flare-ci-events already exists, reusing");
    const g = run("npx", ["wrangler", "pipelines", "streams", "get", "flare-ci-events"]);
    const m = /"id"\s*:\s*"([^"]+)"/.exec(g.stdout) ?? /["']id["']:\s*(\S+)/.exec(g.stdout);
    if (m) {
      basinStreamId = m[1];
      console.log(`Basin stream id: ${basinStreamId}`);
    } else {
      console.log("Basin stream ready but the id could not be parsed — run `npx wrangler pipelines streams get flare-ci-events` (see docs/ANALYTICS.md).");
    }
  }
}

// 6. Migrations (reconciles databases the worker already self-healed)
{
  try {
    applyMigrationsWithReconcile({
      run,
      dbName: "flare-actions",
      config,
      migrationsDir: join(root, "apps/worker/migrations"),
    });
  } catch (err) {
    if (!dryRun) fail(err instanceof Error ? err.message : String(err));
  }
}

// 7. Secrets (piped via stdin; values never appear in commands). Only the
// runner token: the admin password is created on first dashboard open
// (normal login, no token paste), and Connect GitHub manages the
// webhook secret + App credentials in D1 — env values would block it.
const runnerToken = randomBytes(32).toString("hex");
for (const [name, value] of [["RUNNER_TOKEN", runnerToken]]) {
  const r = run("npx", ["wrangler", "secret", "put", name, "--config", config], { input: value });
  if (r.status !== 0 && !dryRun) fail(`secret put ${name} failed:\n${r.stdout}\n${r.stderr}`);
}

// 8. Deploy
let workerUrl = null;
{
  const r = run("npx", ["wrangler", "deploy", "--config", config]);
  const m = /(https:\/\/[^\s]+\.workers\.dev)/.exec(r.stdout + r.stderr);
  if (m) workerUrl = m[1];
  else if (!dryRun) fail(`deploy failed:\n${r.stdout}\n${r.stderr}`);
}

// 9. Managed seats worker (needs local docker; cleanly skipped otherwise —
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
    // Content tag: the image rebuilds when the Dockerfile or the egress
    // shim source changes (the .so compiles in-image, so egress.c is part
    // of the content) — re-runs otherwise reuse the registry image and
    // just redeploy workers. Tags are immutable, never overwritten.
    const dockerfile = readFileSync(join(root, "apps/seats/Dockerfile"), "utf8");
    const shimSrc = readFileSync(join(root, "apps/seats/egress.c"), "utf8");
    const tag = `flare-actions-seat:${createHash("sha1").update(dockerfile).update(shimSrc).digest("hex").slice(0, 12)}`;
    let r = run("docker", ["build", "--platform", "linux/amd64", "-t", tag, "apps/seats"]);
    if (r.status !== 0) fail(`seat image build failed:\n${r.stdout}\n${r.stderr}`);
    r = run("npx", ["wrangler", "containers", "push", tag]);
    const pushed = /Pushed image: (\S+)/.exec(r.stdout + r.stderr);
    if (!pushed) fail(`seat image push failed:\n${r.stdout}\n${r.stderr}`);
    // Generate the seats config from its template: the committed example
    // never carries anyone's account id, and the generated file is
    // gitignored so setup leaves no dirty tree.
    const examplePath = join(root, "apps/seats/wrangler.jsonc.example");
    const seatsCfg = JSON.parse(readFileSync(examplePath, "utf8"));
    seatsCfg.containers[0].image = pushed[1];
    if (basinStreamId) {
      seatsCfg.pipelines = [{ binding: "CI_EVENTS", stream: basinStreamId }];
      console.log("bound the Basin stream on the generated seats config");
    }
    writeFileSync(join(root, seatsConfig), JSON.stringify(seatsCfg));
    console.log("generated apps/seats/wrangler.jsonc (gitignored) with the pushed image");
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

// 10. Write .env (merge, preserve unknown lines)
if (!dryRun) {
  const path = join(root, ".env");
  const wanted = {
    FLARE_ACTIONS_URL: workerUrl,
    RUNNER_TOKEN: runnerToken,
    ...(seatsToken ? { SEATS_TOKEN: seatsToken } : {}),
    // Remote dev boxes (`cli devbox --remote`) talk to the seats worker.
    ...(typeof seatsUrl === "string" && seatsUrl ? { SEATS_URL: seatsUrl } : {}),
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
  console.log(`Dashboard: ${workerUrl}/dashboard (create your admin password on first open)`);
  console.log(seatsUrl ? `Seats:    ${seatsUrl} (managed executor live)` : "Seats:    skipped (no docker — BYO runners cover execution)");
  if (basinStreamId) {
    console.log(`Basin:    stream ${basinStreamId} — add {"pipelines":[{"binding":"CI_EVENTS","stream":"${basinStreamId}"}]} to wrangler.jsonc and redeploy (see docs/ANALYTICS.md).`);
  } else {
    console.log("Basin:    skipped (optional, paid plan — Analytics Engine still records everything).");
  }
  console.log("Next: Connect GitHub in the dashboard Settings tab, then `npm run runner` and `npm run cli -- runs`.");
  console.log("Note: the CLI uses the runner token above; issue readonly/runner/admin tokens for other machines in the Access tab.");
}
