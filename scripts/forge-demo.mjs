#!/usr/bin/env node
// Flare Forge demo bootstrap (docs/DEMO.md). One command, idempotent,
// non-interactive:
//
//   npm run forge:demo [-- --repo bookshelf] [--namespace NS] [--lanes 32]
//                      [--declare] [--plan] [--no-seed] [--recreate] [--dry-run] [--json]
//
// 1. Trunk: ensure the Artifacts repo (wrangler; the Forge API has no
//    repo-create route), push examples/forge-demo WITHOUT agents/ seed/
//    scripts/ (agents must not see the reference solutions), pre-create
//    forge/lane-0..N-1 and refs/notes/why with the git CLI (spike S5:
//    new refs pushed from the Worker upload the whole history).
// 2. Goals: the 3 seeded goals via POST /v1/forge/goals (reused when a
//    goal with the same text exists). --declare also declares the 13
//    seeded intents (the director's stage 1).
// 3. Prints the dashboard URLs and the next commands.
//
// Reads FLARE_ACTIONS_URL + RUNNER_TOKEN from the environment or the
// repo .env (like the CLI). Tokens never reach argv or stdout.

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  artifactsRemote,
  buildBootstrapPlan,
  dashboardUrls,
  DEFAULT_LANES,
  DEFAULT_REPO,
  DEMO_DIR,
  demoEnv,
  intFlag,
  laneRefs,
  loadSeed,
  NOTES_REF,
  parseArgs,
  resolveArtifactsTarget,
  ROOT,
  seedIntents,
  trunkPaths,
  validateRepoName,
} from "./forge-demo-lib.mjs";
import {
  artifactsRepoCreate,
  artifactsRepoDelete,
  artifactsRepoGet,
  artifactsToken,
  DEMO_GIT_IDENTITY,
  forgeClient,
  forgeConfig,
  git,
  listAllIntents,
  pickRemote,
  readState,
  TERMINAL,
  writeState,
} from "./forge-demo-ops.mjs";

export const DEMO_FLAGS = {
  values: ["repo", "namespace", "account", "lanes"],
  bools: ["dry-run", "declare", "plan", "no-seed", "recreate", "json", "help"],
};

const USAGE = `usage: npm run forge:demo -- [--repo ${DEFAULT_REPO}] [--namespace NS] [--account ID] [--lanes ${DEFAULT_LANES}]
                            [--declare] [--plan] [--no-seed] [--recreate] [--dry-run] [--json]
  --declare   also declare the 13 seeded intents under their goals (director stage 1)
  --plan      ask the planner (Workers AI) for proposals when recording goals
  --recreate  delete and recreate the trunk repo first (the director's reset uses this)`;

/** Walk a directory into relative POSIX paths (files only). */
function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, base));
    else out.push(relative(base, abs).split("\\").join("/"));
  }
  return out;
}

export function demoOptions(argv, env = demoEnv()) {
  const f = parseArgs(argv, DEMO_FLAGS);
  const repo = validateRepoName(f.values.repo ?? env.FORGE_DEMO_REPO ?? DEFAULT_REPO);
  let wranglerText = null;
  try {
    wranglerText = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  } catch {
    wranglerText = null;
  }
  const target = resolveArtifactsTarget({ flags: f.values, env, wranglerText });
  const seed = loadSeed();
  return {
    help: f.bools.has("help"),
    dryRun: f.bools.has("dry-run"),
    json: f.bools.has("json"),
    repo,
    namespace: target.namespace,
    accountId: target.accountId,
    lanes: intFlag(f.values, "lanes", DEFAULT_LANES, 1, 64),
    declare: f.bools.has("declare"),
    plan: f.bools.has("plan"),
    seed: !f.bools.has("no-seed"),
    recreate: f.bools.has("recreate"),
    files: trunkPaths(listFiles(DEMO_DIR)),
    seedData: seed,
  };
}

// ---------------------------------------------------------------------------
// Trunk
// ---------------------------------------------------------------------------

export function bootstrapTrunk(o, log = console.log) {
  if (o.recreate) {
    log(`  deleting ${o.namespace}/${o.repo} (reset)`);
    artifactsRepoDelete(o.namespace, o.repo);
  }
  let info = o.recreate ? null : artifactsRepoGet(o.namespace, o.repo);
  let created = false;
  if (!info) {
    info = artifactsRepoCreate(o.namespace, o.repo);
    created = true;
  }
  const remote = pickRemote(info) || artifactsRemote(o.accountId, o.namespace, o.repo);
  if (!remote) throw new Error("could not learn the repo's git remote: pass --account <32-hex account id> or set CLOUDFLARE_ACCOUNT_ID");
  log(`  repo ${o.namespace}/${o.repo} ${created ? "created" : "exists"} (${remote})`);

  const token = artifactsToken(o.namespace, o.repo, "write", 3600);
  return { remote, created, ...pushTrunk(o, remote, token, created, log) };
}

/** Push main (if absent), lane refs and the notes ref to `remote` with the git CLI. */
export function pushTrunk(o, remote, token, created, log = console.log) {
  const work = mkdtempSync(join(tmpdir(), "forge-demo-trunk-"));
  try {
    const heads = git(["ls-remote", remote], { token, allowFail: true });
    const refs = new Map(
      heads.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha, ref] = l.split("\t");
          return [ref, sha];
        }),
    );
    let mainSha = refs.get("refs/heads/main") ?? "";
    git(["init", "-q", "-b", "main", work]);
    if (!mainSha) {
      for (const p of o.files) cpSync(join(DEMO_DIR, p), join(work, p), { recursive: true });
      git(["add", "-A"], { cwd: work });
      git(["commit", "-q", "-m", "Bookshelf trunk\n\nImported from examples/forge-demo (agents/, seed/ and scripts/ left out)."], { cwd: work, env: DEMO_GIT_IDENTITY });
      git(["push", "-q", remote, "HEAD:refs/heads/main"], { cwd: work, token });
      mainSha = git(["rev-parse", "HEAD"], { cwd: work }).stdout.trim();
      log(`  pushed main ${mainSha.slice(0, 12)} (${o.files.length} files)`);
    } else {
      git(["fetch", "-q", "--depth", "1", remote, "refs/heads/main"], { cwd: work, token });
      log(`  main already at ${mainSha.slice(0, 12)}`);
    }

    const missing = laneRefs(o.lanes).filter((r) => !refs.has(r));
    if (missing.length) {
      git(["push", "-q", remote, ...missing.map((r) => `${mainSha}:${r}`)], { cwd: work, token });
      log(`  created ${missing.length} lane ref(s) (forge/lane-0..${o.lanes - 1})`);
    } else log(`  lane refs forge/lane-0..${o.lanes - 1} exist`);

    if (!refs.has(NOTES_REF)) {
      // The root commit: main has a single commit on a fresh trunk; on an
      // existing trunk fetch full history first to find it.
      if (refs.has("refs/heads/main") && !created) git(["fetch", "-q", "--unshallow", remote, "refs/heads/main"], { cwd: work, token, allowFail: true });
      const root = git(["rev-list", "--max-parents=0", mainSha], { cwd: work }).stdout.trim().split("\n")[0];
      git(["notes", `--ref=${NOTES_REF}`, "add", "--allow-empty", "-m", "", root], { cwd: work, env: DEMO_GIT_IDENTITY });
      git(["push", "-q", remote, `${NOTES_REF}:${NOTES_REF}`], { cwd: work, token });
      log(`  created ${NOTES_REF} (empty note on ${root.slice(0, 12)})`);
    } else log(`  ${NOTES_REF} exists`);
    return { mainSha };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Goals + intents (idempotent: reuse by exact text / title)
// ---------------------------------------------------------------------------

export async function seedGoals(o, cfg, log = console.log) {
  const forge = forgeClient(cfg, "forge-demo");
  const state = readState(o.repo);
  const existing = (await forge.listGoals(o.repo, { limit: 200 })).goals;
  for (const g of o.seedData.goals) {
    const hit = existing.find((x) => x.text === g.text && x.state === "open");
    if (hit) {
      state.goals[g.id] = hit.id;
      log(`  goal ${g.id} -> ${hit.id} (reused)`);
      continue;
    }
    const out = await forge.planGoal(o.repo, g.text, { plan: o.plan });
    state.goals[g.id] = out.goal.id;
    const planned = out.planner ? (out.planner.used ? `, ${out.proposals.length} proposal(s) from ${String(out.planner.model)}` : "") : "";
    log(`  goal ${g.id} -> ${out.goal.id} (created${planned})`);
  }
  writeState(o.repo, state);
  return state;
}

export async function declareSeeded(o, cfg, ids = null, log = console.log) {
  const forge = forgeClient(cfg, "planner");
  const state = readState(o.repo);
  const live = (await listAllIntents(forge, o.repo)).filter((i) => !TERMINAL.has(i.state));
  for (const it of seedIntents(o.seedData)) {
    if (ids && !ids.includes(it.id)) continue;
    const hit = live.find((x) => x.title === it.title);
    if (hit) {
      state.intents[it.id] = hit.id;
      log(`  intent ${it.id} -> ${hit.id} (${hit.state}, reused)`);
      continue;
    }
    const out = await forge.declare({
      repo: o.repo,
      title: it.title,
      footprint: it.footprint,
      reasoning: it.reasoning,
      accept: it.accept,
      goalId: state.goals[it.goal],
      agent: "planner",
    });
    state.intents[it.id] = out.intent.id;
    const extra = [out.protectedHits.length ? `protected ${out.protectedHits.join(",")}` : "", out.overlaps.length ? `${out.overlaps.length} overlap(s)` : ""].filter(Boolean).join(", ");
    log(`  intent ${it.id} -> ${out.intent.id} (${out.intent.state}${extra ? `, ${extra}` : ""})`);
  }
  writeState(o.repo, state);
  return state;
}

export function nextCommands(o, url) {
  const u = dashboardUrls(url, o.repo);
  return [
    `dashboard (live map): ${u.live}`,
    `dashboard (inbox):    ${u.inbox}`,
    "",
    "next:",
    `  npm run forge:agents -- --mode scripted --count 6 --repo ${o.repo}      # deterministic swarm (designed overlaps, conflict, semantic pair)`,
    `  npm run forge:agents -- --mode real --count 3 --goal g1 --repo ${o.repo} # headless Claude Code agents`,
    `  npm run forge:director -- stage 2 --repo ${o.repo}                       # jump to a video beat (list: forge:director -- list)`,
    `  npm run cli -- forge connect-agent --client claude                     # bring your own agent`,
  ];
}

export async function main(argv) {
  const o = demoOptions(argv);
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const cfg = forgeConfig();
  const plan = buildBootstrapPlan({
    url: cfg.url,
    repo: o.repo,
    namespace: o.namespace,
    lanes: o.lanes,
    files: o.files,
    seed: o.seed,
    declare: o.declare,
    plan: o.plan,
    recreate: o.recreate,
    goalCount: o.seedData.goals.length,
    intentCount: seedIntents(o.seedData).length,
  });
  if (o.dryRun) {
    if (o.json) {
      console.log(JSON.stringify({ version: 1, command: "forge:demo", data: { dryRun: true, repo: o.repo, namespace: o.namespace, accountId: o.accountId || null, url: cfg.url || null, files: o.files, plan } }, null, 2));
      return 0;
    }
    console.log(`forge:demo (dry run) — repo ${o.namespace}/${o.repo}, worker ${cfg.url || "<FLARE_ACTIONS_URL unset>"}, token ${cfg.token ? "set" : "MISSING"}`);
    plan.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. [${s.id}] ${s.what}`));
    console.log(`\ntrunk files (${o.files.length}):\n  ${o.files.join("\n  ")}`);
    console.log("");
    for (const l of nextCommands(o, cfg.url || "https://<worker>.workers.dev")) console.log(l);
    return 0;
  }
  if (!cfg.url || !cfg.token) {
    console.error("forge:demo needs FLARE_ACTIONS_URL and RUNNER_TOKEN (run `npm run setup` first; it writes .env)");
    return 2;
  }
  console.log(`[1/3] forge API at ${cfg.url}`);
  const forge = forgeClient(cfg, "forge-demo");
  try {
    await forge.listGoals(o.repo, { limit: 1 });
  } catch (e) {
    console.error(`  forge API check failed: ${e instanceof Error ? e.message : String(e)} — is this deploy on a Forge build?`);
    return 1;
  }
  console.log(`[2/3] trunk ${o.namespace}/${o.repo}`);
  bootstrapTrunk(o);
  if (o.seed) {
    console.log("[3/3] goals" + (o.declare ? " + intents" : ""));
    await seedGoals(o, cfg);
    if (o.declare) await declareSeeded(o, cfg);
  } else console.log("[3/3] seeding skipped (--no-seed)");
  console.log("");
  for (const l of nextCommands(o, cfg.url)) console.log(l);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`forge:demo failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
