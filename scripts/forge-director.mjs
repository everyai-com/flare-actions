#!/usr/bin/env node
// Flare Forge demo director (COMPETITION-PLAN.md §9 video beats, §10
// finals). Moves the deployed demo to a known state per beat by driving
// the real API and the scripted agents — never the database.
//
//   npm run forge:director -- list
//   npm run forge:director -- status [--repo bookshelf]
//   npm run forge:director -- stage <1-6> [--fresh] [--timeout 900] [--pace 1200] [--plan] [--dry-run]
//   npm run forge:director -- reset [--dry-run]
//
// `stage n` advances from the last completed stage (~/.flare/forge-demo/
// <repo>.json); asking for a stage at or behind the current one (or
// --fresh) resets first and replays 1..n. Reset abandons every live
// intent in the repo, deletes its fork repos, and re-bootstraps trunk.
// Writes that need admin (plan approval, abandoning others' intents)
// use FLARE_ADMIN_TOKEN when set.

import { join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  dashboardUrls,
  DEFAULT_REPO,
  demoEnv,
  intFlag,
  parseArgs,
  renderTable,
  STAGE2_DRIFT,
  STAGE2_INTENTS,
  STAGE3_EXTRA,
  stageByN,
  stagePath,
  STAGES,
  validateRepoName,
} from "./forge-demo-lib.mjs";
import { bootstrapTrunk, declareSeeded, demoOptions, seedGoals } from "./forge-demo.mjs";
import { agentOptions, Board, logsDir, resolveDesignedConflicts, runScripted } from "./forge-agents.mjs";
import {
  artifactsRepoDelete,
  artifactsRepoGet,
  artifactsRepoList,
  artifactsToken,
  forgeClient,
  forgeConfig,
  git,
  listAllIntents,
  pickRemote,
  readState,
  sleep,
  TERMINAL,
  writeState,
} from "./forge-demo-ops.mjs";

export const DIRECTOR_FLAGS = {
  values: ["repo", "namespace", "account", "timeout", "pace", "lanes"],
  bools: ["dry-run", "fresh", "plan", "plain", "help"],
};

const USAGE = `usage: npm run forge:director -- list | status | reset | stage <1-${STAGES.length}> [--fresh]
  [--repo ${DEFAULT_REPO}] [--timeout seconds] [--pace ms] [--plan] [--plain] [--dry-run]`;

function log(msg) {
  console.log(`[director] ${msg}`);
}

async function waitFor(label, timeoutSec, fn, everyMs = 4000) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() <= deadline) {
    last = await fn();
    if (last && last.done) return last;
    if (last?.note) process.stdout.write(`\r[director] ${label}: ${last.note}`.padEnd(100));
    await sleep(everyMs);
  }
  process.stdout.write("\n");
  log(`${label}: timed out after ${timeoutSec}s (continuing; the dashboard shows where it got to)`);
  return last;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export async function reset(ctx) {
  const { demo, cfg } = ctx;
  const runner = forgeClient(cfg, "director");
  const admin = cfg.adminToken ? forgeClient(cfg, "director", { admin: true }) : null;
  const intents = await listAllIntents(runner, demo.repo);
  const live = intents.filter((i) => !TERMINAL.has(i.state));
  log(`abandoning ${live.length} live intent(s) in ${demo.repo}`);
  let failed = 0;
  for (const i of live) {
    try {
      await (admin ?? runner).abandon(i.id, { agent: i.agent || undefined });
    } catch {
      try {
        await forgeClient(cfg, i.agent || "director").abandon(i.id, { agent: i.agent || undefined });
      } catch (e) {
        failed++;
        log(`  could not abandon ${i.id} (${i.state}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (failed) log(`  ${failed} intent(s) left live — set FLARE_ADMIN_TOKEN so the director can abandon other agents' intents`);

  // Fork repos: every intent's fork, plus replay (r-<conflict>) and
  // session (s-<intent>) forks that name one of this repo's ids.
  const conflicts = (await runner.listConflicts(demo.repo).catch(() => ({ conflicts: [] }))).conflicts;
  const short = (id) => String(id).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  const forks = new Set(intents.map((i) => i.forkRepo).filter(Boolean));
  const prefixes = [...conflicts.map((c) => `r-${short(c.id)}-`), ...intents.map((i) => `s-${short(i.id)}`)];
  for (const name of artifactsRepoList(demo.namespace)) {
    if (name === demo.repo) continue;
    if (prefixes.some((p) => name.startsWith(p))) forks.add(name);
  }
  log(`deleting ${forks.size} fork repo(s)`);
  for (const f of forks) if (f !== demo.repo) artifactsRepoDelete(demo.namespace, f);

  log(`re-bootstrapping trunk ${demo.namespace}/${demo.repo}`);
  bootstrapTrunk({ ...demo, recreate: true }, (l) => log(l.trim()));
  const prev = readState(demo.repo);
  writeState(demo.repo, { goals: prev.goals, intents: {}, stage: 0 });
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function scriptedOpts(ctx, extra) {
  const base = agentOptions(["--mode", "scripted", "--repo", ctx.demo.repo, "--namespace", ctx.demo.namespace, "--pace", String(ctx.pace), ...(ctx.plain ? ["--plain"] : [])]);
  return { ...base, ...extra, run: `director-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}` };
}

async function runSwarm(ctx, extra) {
  const o = scriptedOpts(ctx, extra);
  const dir = logsDir(o.run);
  const board = new Board({ plain: o.plain, title: `director stage — ${o.repo}`, logDir: dir });
  board.start();
  try {
    return await runScripted(o, ctx.cfg, board, dir);
  } finally {
    board.stop();
  }
}

const STAGE_RUNNERS = {
  // Goal -> plan: 3 goals, the 7 intents the stage-2 agents will NOT
  // declare themselves (so stage 2 shows declare-time overlaps live).
  1: async (ctx) => {
    await seedGoals({ ...ctx.demo, plan: ctx.plan }, ctx.cfg, (l) => log(l.trim()));
    const rest = ctx.demo.seedData.goals.flatMap((g) => g.intents.map((i) => i.id)).filter((id) => !STAGE2_INTENTS.includes(id));
    await declareSeeded(ctx.demo, ctx.cfg, rest, (l) => log(l.trim()));
  },
  // Q1 awareness: 6 agents declare (overlaps come back + notes), claim,
  // push; one drifts. Nobody is ready yet.
  2: async (ctx) => {
    await runSwarm(ctx, { intents: STAGE2_INTENTS, count: 6, until: "pushed", drift: [STAGE2_DRIFT] });
  },
  // Q2 trains: mark the six ready, then six more green intents run to
  // ready. The train cuts lanes; the semantic pair turns one red -> bisect.
  3: async (ctx) => {
    const forge = forgeClient(ctx.cfg, "director");
    const state = readState(ctx.demo.repo);
    for (const seedId of STAGE2_INTENTS) {
      const id = state.intents[seedId];
      if (!id) continue;
      const cur = (await forge.getIntent(id)).intent;
      if (cur.state !== "working" && cur.state !== "claimed") continue;
      const r = await forgeClient(ctx.cfg, cur.agent || "director").markReady(id, { agent: cur.agent || undefined });
      log(`ready ${seedId} (${cur.agent}) route ${r.route} — ${r.train.note}`);
    }
    await runSwarm(ctx, { intents: STAGE3_EXTRA, count: 6, until: "ready", prefix: "agent", drift: [] });
    await waitFor("train", ctx.timeout, async () => {
      const trains = (await forge.listTrains(ctx.demo.repo)).trains;
      const bisecting = trains.some((t) => t.parentTrainId || t.parent_train_id);
      const states = trains.map((t) => String(t.state)).join(",");
      return { done: bisecting, note: `${trains.length} train(s) [${states}]${bisecting ? " — bisect in flight" : ""}` };
    });
  },
  // Q2 conflicts: the scripted resolver replays g3-log-latency.
  4: async (ctx) => {
    const o = scriptedOpts(ctx, { wait: ctx.timeout });
    const dir = logsDir(o.run);
    const board = new Board({ plain: o.plain, title: `director stage 4 — ${o.repo}`, logDir: dir });
    board.start();
    try {
      await resolveDesignedConflicts(o, ctx.cfg, board, dir, { waitSeconds: ctx.timeout });
    } finally {
      board.stop();
    }
  },
  // Q3 review: trains settle; the protected intent gets its plan
  // approved and lands in the inbox as the one item that needs a human.
  5: async (ctx) => {
    const forge = forgeClient(ctx.cfg, "director");
    const busy = new Set(["ready", "in_train", "replaying", "bisected"]);
    await waitFor("trains settle", ctx.timeout, async () => {
      const live = (await listAllIntents(forge, ctx.demo.repo)).filter((i) => !TERMINAL.has(i.state));
      const moving = live.filter((i) => busy.has(i.state));
      const landed = (await listAllIntents(forge, ctx.demo.repo, { state: "landed" })).length;
      return { done: moving.length === 0, note: `${landed} landed, ${moving.length} still moving` };
    });
    if (!ctx.cfg.adminToken) log("FLARE_ADMIN_TOKEN unset: approve g3-api-key-rotation's plan in #/inbox by hand, then re-run stage 5");
    else await runSwarm(ctx, { intents: ["g3-api-key-rotation"], count: 1, until: "ready", approve: true, prefix: "agent-7", drift: [] });
    const inbox = await forge.inbox(ctx.demo.repo);
    const m = inbox.metrics;
    log(`inbox: needs you ${String(m.needs_you)} · audit sample ${String(m.sample)} · auto ${String(m.auto)} · ${inbox.groups.length} stor${inbox.groups.length === 1 ? "y" : "ies"}`);
  },
  // Q4 why: a landed line in logging.ts -> goal -> intent -> reasoning.
  6: async (ctx) => {
    const forge = forgeClient(ctx.cfg, "director");
    const path = "src/middleware/logging.ts";
    const info = artifactsRepoGet(ctx.demo.namespace, ctx.demo.repo);
    const remote = pickRemote(info);
    let line = 1;
    if (remote) {
      const token = artifactsToken(ctx.demo.namespace, ctx.demo.repo, "read", 600);
      const work = mkdtempSync(join(tmpdir(), "forge-why-"));
      try {
        git(["clone", "-q", "--depth", "1", remote, work], { token });
        const lines = readFileSync(join(work, path), "utf8").split("\n");
        const hit = lines.findIndex((l) => /requestId/.test(l) && /durationMs/.test(l));
        const any = hit === -1 ? lines.findIndex((l) => /requestId/.test(l)) : hit;
        line = any === -1 ? 1 : any + 1;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    const why = await forge.why(ctx.demo.repo, path, line);
    log(`why ${path}:${line}${why.exact ? "" : " (best effort: no exact note yet)"}`);
    for (const link of why.chain) log(`  ${link.kind.padEnd(8)} ${link.id}  ${link.text.split("\n")[0].slice(0, 110)}`);
    log(`open: ${ctx.cfg.url}/#/why?repo=${encodeURIComponent(ctx.demo.repo)}&path=${encodeURIComponent(path)}&line=${line}`);
  },
};

// ---------------------------------------------------------------------------

export function directorOptions(argv, env = demoEnv()) {
  const f = parseArgs(argv, DIRECTOR_FLAGS);
  const [cmd = "list", arg] = f.pos;
  if (!["list", "status", "reset", "stage"].includes(cmd)) throw new Error(`unknown command ${cmd}\n${USAGE}`);
  const passthrough = ["repo", "namespace", "account", "lanes"].flatMap((k) => (f.values[k] ? [`--${k}`, f.values[k]] : []));
  const demo = demoOptions(passthrough, env);
  return {
    cmd,
    stage: cmd === "stage" ? stageByN(arg).n : null,
    fresh: f.bools.has("fresh"),
    dryRun: f.bools.has("dry-run"),
    help: f.bools.has("help"),
    timeout: intFlag(f.values, "timeout", 900, 10, 7200),
    pace: intFlag(f.values, "pace", 1200, 0, 60000),
    plan: f.bools.has("plan"),
    plain: f.bools.has("plain"),
    demo: { ...demo, repo: validateRepoName(demo.repo) },
  };
}

export async function main(argv) {
  const o = directorOptions(argv);
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  if (o.cmd === "list") {
    console.log(renderTable(STAGES.map((s) => ({ ...s, n: String(s.n) })), [
      { key: "n", label: "STAGE" },
      { key: "beat", label: "VIDEO BEAT" },
      { key: "title", label: "STATE" },
      { key: "shows", label: "ON SCREEN" },
    ]));
    return 0;
  }
  const cfg = forgeConfig();
  const state = readState(o.demo.repo);
  const urls = dashboardUrls(cfg.url || "https://<worker>.workers.dev", o.demo.repo);
  if (o.cmd === "status") {
    log(`${o.demo.repo}: last completed stage ${state.stage} (${state.stage ? stageByN(state.stage).title : "fresh"}), ${Object.keys(state.intents).length} mapped intent(s)`);
    log(`live map ${urls.live}`);
    return 0;
  }
  const path = o.cmd === "reset" ? { reset: true, run: [] } : stagePath(o.fresh ? -1 : state.stage, o.stage);
  if (o.dryRun) {
    log(`plan for ${o.cmd}${o.stage ? ` ${o.stage}` : ""} on ${o.demo.namespace}/${o.demo.repo} (current stage ${state.stage}):`);
    if (path.reset) log("  reset: abandon live intents, delete fork repos (i-/r-/s-), recreate trunk + lanes + notes");
    for (const n of path.run) log(`  stage ${n} [${stageByN(n).beat}] ${stageByN(n).title}: ${stageByN(n).shows}`);
    log(`then open ${urls.live}`);
    return 0;
  }
  if (!cfg.url || !cfg.token) {
    console.error("forge:director needs FLARE_ACTIONS_URL and RUNNER_TOKEN (npm run setup), plus wrangler login for trunk resets");
    return 2;
  }
  const ctx = { demo: o.demo, cfg, timeout: o.timeout, pace: o.pace, plan: o.plan, plain: o.plain };
  const t0 = Date.now();
  if (path.reset) await reset(ctx);
  for (const n of path.run) {
    const s = stageByN(n);
    log(`stage ${n} — ${s.title} (${s.beat})`);
    await STAGE_RUNNERS[n](ctx);
    writeState(o.demo.repo, { ...readState(o.demo.repo), stage: n });
  }
  log(`done in ${Math.round((Date.now() - t0) / 1000)}s. live ${urls.live}  inbox ${urls.inbox}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`forge:director failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
