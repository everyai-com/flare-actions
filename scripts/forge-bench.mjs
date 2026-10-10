#!/usr/bin/env node
// Forge benchmark driver (docs/FORGE-BENCH.md).
//
// Layer 1, SIMULATED (deterministic, no network):
//   node --experimental-strip-types scripts/forge-bench.mjs \
//     --agents 1000,10000,100000 --seed 7 [--modes baseline,trains,forge] \
//     [--json] [--out docs/bench] [--markdown] [--max-parallel N]
//     [--speculation-depth N] [--trains-speculation-depth N]
//   Prints a table per agent count; --json also writes
//   docs/bench/forge-sim-seed<seed>.json (the GET /v1/forge/bench shape).
//
// Layer 2, MEASURED (drives the apps/sim harness Worker you deployed):
//   SIM_ADMIN_TOKEN=... node scripts/forge-bench.mjs live start \
//     --url https://flare-forge-sim.<sub>.workers.dev --mode coordination-only --agents 100000
//   ... live start --mode full-git --agents 2000 --confirm
//   ... live results --run <id> [--json]     ... live stop|cleanup --run <id>     ... live list
//   The token comes from the environment only (never argv).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(msg, code = 2) {
  process.stderr.write(`forge-bench: ${msg}\n`);
  process.exit(code);
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function simulated(args) {
  const { simulate, MODES } = await import(join(ROOT, "apps/sim/src/sim.ts"));
  const { toBenchDoc, formatTable, formatMarkdown } = await import(join(ROOT, "apps/sim/src/report.ts"));
  const { DEFAULT_CONSTANTS, CONSTANT_SOURCES } = await import(join(ROOT, "apps/sim/src/constants.ts"));
  const agentsList = String(args.agents ?? "1000,10000,100000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (agentsList.length === 0) die("--agents must be a comma list of positive integers");
  if (agentsList.some((n) => n > 1_000_000)) die("--agents above 1,000,000 is not supported");
  const seed = args.seed === undefined ? 7 : Number(args.seed);
  if (!Number.isInteger(seed) || seed < 0) die("--seed must be a non-negative integer");
  const modes = args.modes ? String(args.modes).split(",") : [...MODES];
  for (const m of modes) if (!MODES.includes(m)) die(`unknown mode ${m} (${MODES.join(", ")})`);

  // Sensitivity knobs: lanes per group (policy lanes.max_parallel), Forge
  // speculation depth (policy lanes.speculation_depth), and the depth the
  // trains-only mode runs at (default 1 = the pre-speculation executor).
  const constants = {};
  const knobs = [];
  const lanes = { ...DEFAULT_CONSTANTS.policy.lanes };
  const intKnob = (flag, min, max) => {
    if (args[flag] === undefined) return undefined;
    const v = Number(args[flag]);
    if (!Number.isInteger(v) || v < min || v > max) die(`--${flag} must be ${min}-${max}`);
    knobs.push(`--${flag} ${v}`);
    return v;
  };
  const mp = intKnob("max-parallel", 1, 64);
  if (mp !== undefined) lanes.maxParallel = mp;
  const depth = intKnob("speculation-depth", 1, 8);
  if (depth !== undefined) lanes.speculationDepth = depth;
  const tdepth = intKnob("trains-speculation-depth", 1, 8);
  if (tdepth !== undefined) constants.trainsSpeculationDepth = tdepth;
  if (mp !== undefined || depth !== undefined) constants.policy = { ...DEFAULT_CONSTANTS.policy, lanes };
  const sha = gitSha();
  const date = new Date().toISOString().slice(0, 10);
  const command = `node --experimental-strip-types scripts/forge-bench.mjs --agents ${agentsList.join(",")} --seed ${seed}${args.modes ? ` --modes ${modes.join(",")}` : ""}${knobs.length ? ` ${knobs.join(" ")}` : ""}`;
  const docs = [];
  process.stdout.write("SIMULATED results: outputs of a deterministic model, not measurements of a running system.\n\n");
  for (const n of agentsList) {
    const t0 = Date.now();
    const result = simulate({ agents: n, seed, modes, constants });
    const doc = toBenchDoc(result, { sha, date, command });
    docs.push(doc);
    process.stdout.write(`${args.markdown ? formatMarkdown(doc) : formatTable(doc)}\n`);
    process.stdout.write(`(simulated in ${((Date.now() - t0) / 1000).toFixed(1)} s)\n\n`);
  }
  if (args.json) {
    const outDir = resolve(ROOT, typeof args.out === "string" ? args.out : "docs/bench");
    mkdirSync(outDir, { recursive: true });
    const suffix = [mp !== undefined ? `-mp${mp}` : "", depth !== undefined ? `-d${depth}` : "", tdepth !== undefined ? `-td${tdepth}` : ""].join("");
    const file = join(outDir, `forge-sim-seed${seed}${suffix}.json`);
    const body = {
      kind: "simulated",
      note: "SIMULATED: outputs of apps/sim/src/sim.ts under the constants below; not measurements.",
      generated_at: date,
      sha,
      command,
      seed,
      constants: { ...DEFAULT_CONSTANTS, ...constants },
      constant_sources: CONSTANT_SOURCES,
      runs: docs,
    };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    process.stdout.write(`wrote ${file}\n`);
  }
}

// ---------------------------------------------------------------------------
// live: drive the deployed apps/sim harness Worker
// ---------------------------------------------------------------------------

async function live(args) {
  const [, sub] = args._;
  const url = String(args.url ?? process.env.FORGE_SIM_URL ?? "").replace(/\/+$/, "");
  if (!url) die("live: --url (or FORGE_SIM_URL) is required");
  const token = process.env.SIM_ADMIN_TOKEN;
  if (!token) die("live: set SIM_ADMIN_TOKEN in the environment (never on the command line)");
  const call = async (method, path, body) => {
    const init = { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
    if (method !== "GET") init.body = JSON.stringify(body ?? {});
    const res = await fetch(url + path, init);
    const json = await res.json().catch(() => null);
    if (!res.ok) die(`${method} ${path} -> ${res.status} ${json?.error ?? ""}: ${json?.message ?? ""}`, 1);
    return json;
  };
  const run = typeof args.run === "string" ? args.run : null;
  switch (sub) {
    case "start": {
      const mode = String(args.mode ?? "coordination-only");
      const agents = Number(args.agents ?? 1000);
      const max = Number(process.env.FORGE_SIM_MAX_FULL_GIT ?? 1000);
      if (mode === "full-git" && agents > max && !args.confirm) {
        die(`full-git with ${agents} agents creates ${agents} Artifacts forks. Above ${max}, pass --confirm.`);
      }
      const body = { mode, agents, confirm: Boolean(args.confirm) };
      if (args.repo) body.repo = String(args.repo);
      if (args["run-id"]) body.run_id = String(args["run-id"]);
      if (args.ramp) body.ramp_seconds = Number(args.ramp);
      if (args.heartbeats) body.heartbeats = Number(args.heartbeats);
      if (args.seed) body.seed = Number(args.seed);
      const out = await call("POST", "/runs", body);
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      process.stdout.write(`results: ${url}/runs/${out.run.runId}\n`);
      return;
    }
    case "list":
      process.stdout.write(`${JSON.stringify(await call("GET", "/runs"), null, 2)}\n`);
      return;
    case "results": {
      if (!run) die("live results: --run <id> required");
      const out = await call("GET", `/runs/${encodeURIComponent(run)}/results`);
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ kind: "measured", ...out }, null, 2)}\n`);
        return;
      }
      const s = out.summary;
      process.stdout.write(`MEASURED · run ${run} · ${out.run.mode} · ${s.agents} agents / ${s.pools} pools\n`);
      process.stdout.write(
        `declared ${s.intentsDeclared} (${s.intentsPerSec ?? "-"}/s) · claimed ${s.claimed} · pushed ${s.gitPushed} · ready ${s.ready}` +
          ` · done ${s.done} failed ${s.failed} pending ${s.pending} · rate-limited ${s.rateLimited} · retries ${s.retries}\n`,
      );
      for (const [op, o] of Object.entries(s.ops)) {
        if (o.requests) process.stdout.write(`  ${op.padEnd(16)} ${String(o.requests).padStart(8)} req  ${String(o.errors).padStart(6)} err  p50 ${o.p50Ms ?? "-"} ms  p95 ${o.p95Ms ?? "-"} ms\n`);
      }
      return;
    }
    case "stop":
    case "cleanup": {
      if (!run) die(`live ${sub}: --run <id> required`);
      process.stdout.write(`${JSON.stringify(await call("POST", `/runs/${encodeURIComponent(run)}/${sub}`), null, 2)}\n`);
      return;
    }
    default:
      die("live: subcommand must be start | list | results | stop | cleanup");
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  process.stdout.write(
    "usage: forge-bench.mjs [--agents 1000,10000,100000] [--seed 7] [--modes baseline,trains,forge] [--json] [--markdown]\n" +
      "       forge-bench.mjs live <start|list|results|stop|cleanup> --url <harness> [--mode coordination-only|full-git] [--agents N] [--confirm] [--run ID]\n",
  );
} else if (args._[0] === "live") {
  await live(args);
} else {
  await simulated(args);
}
