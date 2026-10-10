#!/usr/bin/env node
// Flare Forge demo swarm (docs/DEMO.md).
//
//   npm run forge:agents -- --mode scripted [--count 6] [--goal g1] [--intents a,b] [--until ready]
//                           [--pace 800] [--drift g2-default-page-size] [--approve] [--no-resolve]
//                           [--wait 600] [--repo bookshelf] [--dry-run]
//   npm run forge:agents -- --mode real --count 3 [--goal g1] [--model M] [--budget 2]
//                           [--repo bookshelf] [--dry-run]
//
// scripted: deterministic agents (no LLM). Each one declares (or reuses)
//   a seeded intent, notes its overlap owners, claims, clones its fork,
//   applies examples/forge-demo/agents/solutions/<intent>.mjs, commits
//   with Flare-* trailers, pushes with `cli forge push`, and marks ready.
//   The designed textual conflict is then replayed by a scripted
//   resolver (g3-log-latency's replay variant on g1-request-id).
// real: N headless Claude Code agents (`claude -p`), each in its own
//   temp dir with an MCP config for <worker>/mcp (token via env, never
//   in the file), the flare-forge skill as system prompt, and a bounded
//   tool allow-list (`--permission-mode dontAsk`).
//
// Logs: /tmp/forge-agents/<run>/ (FORGE_AGENTS_DIR overrides).

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyToDir } from "../examples/forge-demo/agents/apply.mjs";
import { FORGE_AGENT_PROMPT } from "../packages/runner-sdk/src/forge.ts";
import { commitWithTrailers } from "../packages/runner-sdk/src/provenance.ts";
import {
  assignAgents,
  basicHeader,
  claudeArgs,
  DEFAULT_REPO,
  demoEnv,
  intFlag,
  loadSeed,
  mcpConfig,
  normalizeGoalId,
  parseArgs,
  pickIntents,
  realAgentPrompt,
  redact,
  renderTable,
  replayPlanFor,
  resolveArtifactsTarget,
  ROOT,
  untilIndex,
  validateRepoName,
} from "./forge-demo-lib.mjs";
import {
  artifactsRepoGet,
  artifactsToken,
  forgeClient,
  forgeConfig,
  gitAsync,
  listAllIntents,
  pickRemote,
  readState,
  sh,
  shAsync,
  sleep,
  TERMINAL,
  writeState,
} from "./forge-demo-ops.mjs";

export const AGENT_FLAGS = {
  values: ["mode", "count", "goal", "intents", "exclude", "until", "pace", "drift", "wait", "repo", "namespace", "account", "model", "budget", "concurrency", "run", "prefix"],
  bools: ["dry-run", "approve", "no-resolve", "plain", "help"],
};

const USAGE = `usage: npm run forge:agents -- --mode scripted|real [--count N] [--goal g1] [--repo ${DEFAULT_REPO}] [--dry-run]
scripted: [--intents id,id] [--exclude id,id] [--until declared|claimed|pushed|ready] [--pace ms]
          [--drift intentId] [--approve] [--no-resolve] [--wait seconds]
real:     [--model M] [--budget usd-per-agent] [--concurrency N]
common:   [--run name] [--prefix agent] [--plain] (no live redraw)`;

export function agentOptions(argv, env = demoEnv()) {
  const f = parseArgs(argv, AGENT_FLAGS);
  const seed = loadSeed();
  const mode = f.values.mode ?? "scripted";
  if (!["scripted", "real"].includes(mode)) throw new Error("--mode must be scripted or real");
  const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  let wranglerText = null;
  try {
    wranglerText = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  } catch {
    wranglerText = null;
  }
  const target = resolveArtifactsTarget({ flags: f.values, env, wranglerText });
  const until = f.values.until ?? "ready";
  untilIndex(until);
  return {
    help: f.bools.has("help"),
    mode,
    dryRun: f.bools.has("dry-run"),
    repo: validateRepoName(f.values.repo ?? env.FORGE_DEMO_REPO ?? DEFAULT_REPO),
    namespace: target.namespace,
    accountId: target.accountId,
    goal: normalizeGoalId(seed, f.values.goal),
    count: intFlag(f.values, "count", mode === "real" ? 3 : 6, 1, 64),
    concurrency: f.values.concurrency ? intFlag(f.values, "concurrency", 1, 1, 64) : null,
    intents: list(f.values.intents),
    exclude: list(f.values.exclude),
    until,
    pace: intFlag(f.values, "pace", 800, 0, 60000),
    drift: list(f.values.drift),
    approve: f.bools.has("approve"),
    resolve: !f.bools.has("no-resolve"),
    wait: intFlag(f.values, "wait", 900, 0, 7200),
    model: f.values.model ?? null,
    budget: f.values.budget ? Number(f.values.budget) : null,
    run: f.values.run ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
    prefix: f.values.prefix ?? (mode === "real" ? "claude" : "agent"),
    plain: f.bools.has("plain") || !process.stdout.isTTY,
    seed,
  };
}

export function logsDir(run, env = process.env) {
  const base = env.FORGE_AGENTS_DIR || "/tmp/forge-agents";
  const dir = join(base, run.replace(/[^\w.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Live table
// ---------------------------------------------------------------------------

export class Board {
  constructor({ plain, title, logDir }) {
    this.rows = new Map();
    this.plain = plain;
    this.title = title;
    this.logDir = logDir;
    this.timer = null;
  }
  set(agent, patch) {
    const prev = this.rows.get(agent) ?? { agent, intent: "", state: "queued", detail: "" };
    const next = { ...prev, ...patch, at: new Date().toISOString().slice(11, 19) };
    this.rows.set(agent, next);
    const line = `${next.at} ${agent} ${next.intent} ${next.state}${next.detail ? ` — ${next.detail}` : ""}`;
    if (this.logDir) appendFileSync(join(this.logDir, `${agent}.log`), redact(line) + "\n");
    if (this.plain && (prev.state !== next.state || prev.detail !== next.detail)) console.log(redact(line));
  }
  render() {
    const rows = [...this.rows.values()];
    const table = renderTable(rows, [
      { key: "agent", label: "AGENT" },
      { key: "intent", label: "INTENT" },
      { key: "state", label: "STATE" },
      { key: "at", label: "AT" },
      { key: "detail", label: "DETAIL" },
    ]);
    process.stdout.write(`\x1b[H\x1b[2J${this.title}\n\n${redact(table)}\n\nlogs: ${this.logDir}\n`);
  }
  start() {
    if (this.plain) return;
    this.timer = setInterval(() => this.render(), 500);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (!this.plain) this.render();
  }
}

// ---------------------------------------------------------------------------
// Scripted agents
// ---------------------------------------------------------------------------

function cliEnv(cfg, agent) {
  return { FLARE_ACTIONS_URL: cfg.url, RUNNER_TOKEN: cfg.token, FLARE_AGENT: agent, GIT_TERMINAL_PROMPT: "0" };
}

// Store fork auth + flare.* keys in the clone's .git/config by writing
// the file (not `git config`, which would put the token in argv).
function storeCloneAuth(dir, token, intentId, repo) {
  const file = join(dir, ".git", "config");
  const kept = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*extraHeader\s*=\s*Authorization: Basic /i.test(l))
    .join("\n")
    .replace(/\n*$/, "\n");
  writeFileSync(file, `${kept}[http]\n\textraHeader = ${basicHeader(token)}\n[flare]\n\tintent = ${intentId}\n\trepo = ${repo}\n`, { mode: 0o600 });
}

async function setIdentity(dir, agent) {
  await gitAsync(["config", "user.name", `flare-agent ${agent}`], { cwd: dir });
  await gitAsync(["config", "user.email", `${agent}@flare.invalid`], { cwd: dir });
}

async function ensureIntent(o, cfg, forge, agent, it, state) {
  let id = state.intents[it.id];
  if (id) {
    try {
      const cur = (await forge.getIntent(id)).intent;
      if (!TERMINAL.has(cur.state)) return { intent: cur, overlaps: [], reused: true };
    } catch {
      /* stale mapping: declare below */
    }
  }
  const live = (await listAllIntents(forge, o.repo)).filter((i) => !TERMINAL.has(i.state) && i.title === it.title);
  if (live[0]) {
    state.intents[it.id] = live[0].id;
    return { intent: live[0], overlaps: [], reused: true };
  }
  const out = await forge.declare({
    repo: o.repo,
    title: it.title,
    footprint: it.footprint,
    reasoning: it.reasoning,
    accept: it.accept,
    goalId: state.goals[it.goal],
    agent,
  });
  state.intents[it.id] = out.intent.id;
  return { intent: out.intent, overlaps: out.overlaps, reused: false };
}

export async function runScriptedIntent(ctx, agent, it) {
  const { o, cfg, board, state, dir } = ctx;
  const forge = forgeClient(cfg, agent);
  const stopAt = untilIndex(o.until);
  const pace = () => sleep(o.pace);
  board.set(agent, { intent: it.id, state: "declaring", detail: it.footprint.join(", ") });
  const d = await ensureIntent(o, cfg, forge, agent, it, state);
  const id = d.intent.id;
  writeState(o.repo, state);
  const ov = d.overlaps.filter((x) => !TERMINAL.has(x.state));
  board.set(agent, {
    state: d.intent.state === "awaiting_plan" ? "awaiting_plan" : "declared",
    detail: ov.length ? `OVERLAP ${ov.map((x) => `${x.intentId} (${x.agent || "unclaimed"}) on ${x.paths.map((p) => p[0]).join(",")}`).join("; ")}` : d.reused ? `reused ${id}` : id,
  });
  for (const x of ov) {
    const files = [...new Set(x.paths.map((p) => p[0]))].join(", ");
    await forge
      .sendNote(x.intentId, `${agent} on "${it.title}" also touches ${files}: ${it.reasoning.split(". ")[0]}. I will keep to my own region; ping me if you change its shape.`, { fromIntent: id, agent })
      .catch(() => undefined);
  }
  await pace();
  if (d.intent.state === "awaiting_plan") {
    if (!o.approve) {
      board.set(agent, { state: "awaiting_plan", detail: "protected path: approve in #/inbox (or re-run with --approve + FLARE_ADMIN_TOKEN)" });
      return { id, state: "awaiting_plan" };
    }
    await forgeClient(cfg, agent, { admin: true }).approvePlan(id);
    board.set(agent, { state: "declared", detail: "plan approved" });
  }
  if (stopAt === 0) return { id, state: "declared" };

  const claim = await forge.claim(id, { agent, leaseTtlSeconds: 3600 });
  const work = join(dir, agent, it.id);
  await gitAsync(["clone", "-q", claim.forkRemote, work], { token: claim.token });
  storeCloneAuth(work, claim.token, id, o.repo);
  await setIdentity(work, agent);
  board.set(agent, { state: "claimed", detail: `fork ${claim.forkRepo}` });
  await pace();
  if (stopAt === 1) return { id, state: "claimed" };

  board.set(agent, { state: "working", detail: "applying reference solution" });
  const touched = await applyToDir(it.id, work);
  if (o.drift.includes(it.id)) {
    appendFileSync(join(work, "README.md"), `\n<!-- ${it.id}: page-size note for the mobile client -->\n`);
    touched.push("README.md");
  }
  await gitAsync(["add", "-A"], { cwd: work });
  const { sha } = await commitWithTrailers({
    cwd: work,
    message: `${it.title}\n\n${it.reasoning}`,
    trailers: { goal: claim.intent.goalId ?? "", intent: id, agent, session: claim.forkRepo },
  });
  await forge.heartbeat(id, { agent }).catch(() => undefined);
  await pace();

  board.set(agent, { state: "pushing", detail: `${sha.slice(0, 12)} (${touched.join(", ")})` });
  const pushed = await shAsync(process.execPath, ["--experimental-strip-types", join(ROOT, "apps", "cli", "src", "index.ts"), "forge", "push", id, "--json"], {
    cwd: work,
    env: cliEnv(cfg, agent),
  });
  if (pushed.status !== 0) throw new Error(`cli forge push failed: ${redact(pushed.stderr.trim().split("\n").slice(-2).join(" | "), [claim.token, cfg.token])}`);
  let pushData = null;
  try {
    pushData = JSON.parse(pushed.stdout).data;
  } catch {
    pushData = null;
  }
  const drift = pushData?.drift ?? [];
  board.set(agent, { state: "pushed", detail: `${sha.slice(0, 12)} risk ${pushData?.risk?.score ?? "?"}${drift.length ? ` DRIFT ${drift.join(",")}` : ""}` });
  await pace();
  if (stopAt === 2) return { id, state: "pushed", sha };

  const ready = await forge.markReady(id, { agent });
  board.set(agent, { state: "ready", detail: `route ${ready.route}, risk ${ready.risk.score} — ${ready.train.note}` });
  return { id, state: "ready", sha };
}

/** Run seeded intents through a pool of `count` scripted agents. */
export async function runScripted(o, cfg, board, dir) {
  const state = readState(o.repo);
  const intents = pickIntents(o.seed, { goal: o.goal, only: o.intents, exclude: o.exclude });
  const crew = assignAgents(intents, o.count, o.prefix);
  for (const c of crew) board.set(c.agent, { intent: c.intents.map((i) => i.id).join(","), state: "queued", detail: "" });
  const ctx = { o, cfg, board, state, dir };
  const results = [];
  await Promise.all(
    crew.map(async (c, n) => {
      await sleep(n * Math.min(o.pace, 400)); // stagger so declares arrive in order
      for (const it of c.intents) {
        try {
          results.push({ agent: c.agent, seedId: it.id, ...(await runScriptedIntent(ctx, c.agent, it)) });
        } catch (e) {
          board.set(c.agent, { intent: it.id, state: "error", detail: e instanceof Error ? e.message : String(e) });
          results.push({ agent: c.agent, seedId: it.id, state: "error" });
        }
      }
    }),
  );
  writeState(o.repo, state);
  return results;
}

// ---------------------------------------------------------------------------
// Scripted conflict resolver (the designed replay)
// ---------------------------------------------------------------------------

export async function resolveDesignedConflicts(o, cfg, board, dir, { waitSeconds = o.wait, agent = "resolver" } = {}) {
  const forge = forgeClient(cfg, agent);
  const state = readState(o.repo);
  const seedOf = new Map(Object.entries(state.intents).map(([seedId, sid]) => [sid, seedId]));
  const deadline = Date.now() + waitSeconds * 1000;
  board.set(agent, { intent: "-", state: "watching", detail: "waiting for a conflict (trains merge lanes)" });
  const done = [];
  while (Date.now() <= deadline) {
    const open = (await forge.listConflicts(o.repo, "open")).conflicts;
    for (const c of open) {
      const bSeed = seedOf.get(String(c.intentB));
      const aSeed = seedOf.get(String(c.intentA));
      const plan = bSeed ? replayPlanFor(o.seed, bSeed, aSeed) : null;
      if (!plan) continue;
      board.set(agent, { intent: bSeed, state: "claiming", detail: `conflict ${String(c.id)} on ${(c.files ?? []).join(", ")}` });
      const claimed = await forge.claimConflict(String(c.id), { agent });
      const r = claimed.replay;
      if (!r?.token || !r.forkRemote) throw new Error("claim_conflict returned no replay remote/token");
      const work = join(dir, agent, String(c.id));
      await gitAsync(["clone", "-q", r.forkRemote, work], { token: r.token });
      await setIdentity(work, agent);
      // Re-derive on the CURRENT trunk: fetch main with a read token.
      const info = artifactsRepoGet(o.namespace, o.repo);
      const trunkRemote = pickRemote(info) || r.forkRemote.replace(/\/[^/]+\.git$/, `/${o.repo}.git`);
      const readToken = artifactsToken(o.namespace, o.repo, "read", 600);
      await gitAsync(["fetch", "-q", trunkRemote, "refs/heads/main"], { cwd: work, token: readToken });
      await gitAsync(["reset", "-q", "--hard", "FETCH_HEAD"], { cwd: work });
      board.set(agent, { state: "replaying", detail: `${plan.intent} on ${plan.on} (with ${plan.on}'s reasoning in context)` });
      await applyToDir(plan.intent, work, plan.on);
      await gitAsync(["add", "-A"], { cwd: work });
      const it = o.seed.goals.flatMap((g) => g.intents).find((x) => x.id === plan.intent);
      const { sha } = await commitWithTrailers({
        cwd: work,
        message: `${it?.title ?? plan.intent} (replayed on ${plan.on})\n\n${it?.reasoning ?? ""}\nReplayed on the new trunk: keeps ${plan.on}'s requestId and adds durationMs.`,
        trailers: { goal: state.goals[it?.id?.split("-")[0] ?? ""] ?? "", intent: r.intentId, agent, session: r.forkRepo },
      });
      await gitAsync(["push", "-q", r.forkRemote, "+HEAD:refs/heads/main"], { cwd: work, token: r.token });
      const res = await forge.resolveConflict(String(c.id), sha, { agent });
      board.set(agent, { state: "resolved", detail: `${sha.slice(0, 12)}; ${res.nextSteps?.[0]?.why ?? "rides the next train"}` });
      done.push({ conflict: String(c.id), sha });
    }
    if (done.length) return done;
    await sleep(3000);
  }
  board.set(agent, { state: "idle", detail: "no designed conflict opened before --wait ran out" });
  return done;
}

// ---------------------------------------------------------------------------
// Real agents (headless Claude Code)
// ---------------------------------------------------------------------------

function claudeAvailable() {
  const r = sh("claude", ["--version"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function writeCliShim(binDir) {
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "flare");
  const cli = join(ROOT, "apps", "cli", "src", "index.ts");
  writeFileSync(shim, `#!/bin/sh\nexec node --experimental-strip-types "${cli.replace(/"/g, '\\"')}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function toolLabel(evt) {
  const blocks = evt?.message?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b?.type !== "tool_use") continue;
    const name = String(b.name ?? "").replace(/^mcp__flare-forge__/, "");
    if (name === "Bash") return `$ ${String(b.input?.command ?? "").slice(0, 60)}`;
    return name;
  }
  return null;
}

export function realPlan(o, cfg) {
  const goals = o.goal ? o.seed.goals.filter((g) => g.id === o.goal) : o.seed.goals;
  const intents = pickIntents(o.seed, { goal: o.goal, only: o.intents, exclude: o.exclude });
  const targets = Array.from({ length: o.count }, (_, i) => (intents.length ? intents[i % intents.length] : null));
  const goalIds = readState(o.repo).goals;
  return targets.map((target, i) => {
    const agent = `${o.prefix}-${i + 1}`;
    const g = target ? o.seed.goals.find((x) => x.id === target.goal) : goals[i % goals.length];
    const others = [...new Set(targets.filter((t, j) => t && j !== i && t.id !== target?.id).map((t) => t.title))];
    const prompt = realAgentPrompt({ repo: o.repo, agent, goal: g.text, goalId: goalIds[g.id] ?? g.id, target, others, cliHint: "flare" });
    return { agent, target: target?.id ?? null, prompt, mcp: mcpConfig(cfg.url || "https://<worker>.workers.dev", agent) };
  });
}

export async function runReal(o, cfg, board, dir) {
  const version = claudeAvailable();
  if (!version) throw new Error("`claude` (Claude Code CLI) is not on PATH: install it, or use --mode scripted");
  const skill = readFileSync(join(ROOT, "skills", "flare-forge", "SKILL.md"), "utf8");
  const system = `${FORGE_AGENT_PROMPT}\n\n${skill}`;
  const plan = realPlan(o, cfg);
  const binDir = join(dir, "bin");
  writeCliShim(binDir);
  const forge = forgeClient(cfg, "forge-agents");
  let stopPoll = false;
  const poll = (async () => {
    while (!stopPoll) {
      try {
        const intents = await listAllIntents(forge, o.repo);
        for (const p of plan) {
          const mine = intents.filter((i) => i.agent === p.agent).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          if (mine) board.set(p.agent, { intent: mine.title.slice(0, 40), state: mine.state });
        }
      } catch {
        /* transient: next tick */
      }
      await sleep(3000);
    }
  })();
  const limit = o.concurrency ?? o.count;
  const queue = [...plan];
  const runOne = async (p) => {
    const home = join(dir, p.agent);
    mkdirSync(home, { recursive: true });
    const mcpPath = join(home, "mcp.json");
    writeFileSync(mcpPath, JSON.stringify(p.mcp, null, 2) + "\n");
    const args = claudeArgs({ prompt: p.prompt, mcpConfigPath: mcpPath, systemPrompt: system, model: o.model, maxBudgetUsd: o.budget, workDir: home });
    board.set(p.agent, { intent: p.target ?? "(agent picks)", state: "starting", detail: version });
    const out = createWriteStream(join(home, "stream.jsonl"));
    const err = createWriteStream(join(home, "stderr.log"));
    await new Promise((done) => {
      const child = spawn("claude", args, {
        cwd: home,
        env: {
          ...process.env,
          ...cliEnv(cfg, p.agent),
          FLARE_TOKEN: cfg.token,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buf = "";
      child.stdout.on("data", (chunk) => {
        out.write(chunk);
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const evt = JSON.parse(line);
            const label = toolLabel(evt);
            if (label) board.set(p.agent, { detail: label });
            if (evt.type === "result") board.set(p.agent, { detail: `done: ${evt.subtype ?? ""} ${evt.total_cost_usd ? `$${Number(evt.total_cost_usd).toFixed(2)}` : ""}`.trim() });
          } catch {
            /* partial or non-JSON line */
          }
        }
      });
      child.stderr.pipe(err);
      child.on("error", (e) => {
        board.set(p.agent, { state: "error", detail: e.message });
        done();
      });
      child.on("close", (code) => {
        if (code !== 0) board.set(p.agent, { detail: `claude exited ${code} (see ${join(home, "stderr.log")})` });
        out.end();
        err.end();
        done();
      });
    });
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await runOne(p);
    }),
  );
  stopPoll = true;
  await poll;
}

// ---------------------------------------------------------------------------

export async function main(argv) {
  const o = agentOptions(argv);
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const cfg = forgeConfig();
  if (o.dryRun) {
    if (o.mode === "real") {
      const plan = realPlan(o, cfg);
      console.log(`forge:agents (dry run) — ${o.count} real Claude Code agent(s) on ${o.repo}${o.goal ? ` goal ${o.goal}` : ""}`);
      for (const p of plan) console.log(`  ${p.agent.padEnd(10)} -> ${p.target ?? "(picks from the goal)"}`);
      const sample = claudeArgs({ prompt: "<prompt>", mcpConfigPath: "<logs>/<agent>/mcp.json", systemPrompt: "<FORGE_AGENT_PROMPT + skills/flare-forge/SKILL.md>", model: o.model, maxBudgetUsd: o.budget, workDir: "<logs>/<agent>" });
      console.log(`\n  claude ${sample.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
      console.log(`\n  mcp.json: ${JSON.stringify(plan[0]?.mcp)}`);
      console.log(`\n  prompt (${plan[0]?.agent}):\n    ${plan[0]?.prompt.replace(/\n/g, "\n    ")}`);
    } else {
      const intents = pickIntents(o.seed, { goal: o.goal, only: o.intents, exclude: o.exclude });
      console.log(`forge:agents (dry run) — ${o.count} scripted agent(s) on ${o.repo}, until ${o.until}, pace ${o.pace} ms`);
      for (const c of assignAgents(intents, o.count, o.prefix)) console.log(`  ${c.agent.padEnd(10)} -> ${c.intents.map((i) => i.id).join(", ")}`);
      const pair = intents.some((i) => i.id === "g1-request-id") && intents.some((i) => i.id === "g3-log-latency");
      console.log(`  resolver   -> ${o.resolve && pair && o.until === "ready" ? `watch ${o.wait}s for the logging.ts conflict, replay g3-log-latency on g1-request-id` : "off"}`);
      if (o.drift.length) console.log(`  drift      -> ${o.drift.join(", ")} also touch README.md (undeclared)`);
    }
    return 0;
  }
  if (!cfg.url || !cfg.token) {
    console.error("forge:agents needs FLARE_ACTIONS_URL and RUNNER_TOKEN (run `npm run setup` and `npm run forge:demo` first)");
    return 2;
  }
  const dir = logsDir(o.run);
  const board = new Board({ plain: o.plain, title: `forge:agents ${o.mode} — ${o.repo} — run ${o.run}`, logDir: dir });
  board.start();
  try {
    if (o.mode === "real") await runReal(o, cfg, board, dir);
    else {
      const results = await runScripted(o, cfg, board, dir);
      const ids = results.filter((r) => r.state === "ready").map((r) => r.seedId);
      if (o.resolve && ids.includes("g1-request-id") && ids.includes("g3-log-latency")) await resolveDesignedConflicts(o, cfg, board, dir);
    }
  } finally {
    board.stop();
  }
  console.log(`\nlogs: ${dir}`);
  return [...board.rows.values()].some((r) => r.state === "error") ? 1 : 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`forge:agents failed: ${redact(err instanceof Error ? err.message : String(err))}`);
      process.exit(1);
    },
  );
}
