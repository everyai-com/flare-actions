import { readFileSync } from "node:fs";
import {
  convertActionsWorkflow,
  FlareApiError,
  FlareClient,
  isImportSuccess,
  loadEnv,
  type FlareRunDigest,
} from "flare-actions-runner-sdk";
import { formatParityReport, runLocal, runLocalParity } from "./local.ts";
import { dispatchSource, readLocalPipeline } from "./source.ts";
import { formatPlan } from "./dryrun.ts";
import { runInit } from "./init.ts";
import { runConnect } from "./connect.ts";
import { runLogin } from "./login.ts";
import { BoxManager } from "./devbox.ts";
import { RemoteBoxManager } from "./devbox-remote.ts";
import { runDevboxMcpServer } from "./mcp-serve.ts";
import { simulateDrain } from "../../worker/src/fairness.ts";
import { ACTIONS_LIST_USD_PER_MIN } from "../../worker/src/cost.ts";
import { hasJsonFlag, printJson, splitPassthrough, stripJsonFlag } from "./json.ts";
import { explainDigest } from "./explain.ts";
import { formatCacheStats, parseCacheStats } from "./cache.ts";
import { forgeCliDeps, ForgeConfigError, runForge } from "./forge.ts";
import {
  applyTokenAlias,
  cliInvocation,
  missingConfigMessage,
  missingConfigVars,
  nextAfterError,
  nextAfterRun,
  nextLine,
  nextText,
  suggestCommand,
  type EnvLocation,
} from "./hints.ts";
import { formatDoctor, repoFromRemote, runDoctor } from "./doctor.ts";
import { loginMissingArgs } from "./login.ts";
import { spawnSync } from "node:child_process";

// npm runs scripts from the package root (`npm run cli` from any repo
// subdirectory, `npm start` in apps/cli) and keeps the caller's directory
// in INIT_CWD. Restore it so `import`, `local`, `init`, and `connect` act
// on the directory the user ran the command in. Gated on one of this
// repo's own scripts (root package flare-actions, CLI package flare-forge),
// so a user's project script that `cd`s before calling `flare` is left
// alone. Runs before loadEnv(), which walks up from cwd, so the repo-root
// .env is still found from any subdirectory up to 6 levels deep.
const initCwd = process.env["INIT_CWD"];
const ownScript = process.env["npm_package_name"] === "flare-actions" || process.env["npm_package_name"] === "flare-forge";
if (initCwd && ownScript && initCwd !== process.cwd()) {
  process.chdir(initCwd);
}

// FLARE_TOKEN (what the README exports) aliases RUNNER_TOKEN. Applied
// before loadEnv so an exported FLARE_TOKEN beats a .env RUNNER_TOKEN
// (explicit env wins), and again after for a FLARE_TOKEN only in .env.
const aliasedBeforeLoad = applyTokenAlias(process.env);
const ENV_LOCATION: EnvLocation = loadEnv();
const TOKEN_FROM_ALIAS = applyTokenAlias(process.env) || aliasedBeforeLoad;

// --json anywhere before a `--` separator (including before the command
// itself) switches the command to its versioned envelope; args past `--`
// (devbox exec) pass through verbatim.
const { head: argHead, tail } = splitPassthrough(process.argv.slice(2));
const JSON_MODE = hasJsonFlag(argHead);
const [cmd, ...head] = stripJsonFlag(argHead);
const rest = [...head, ...tail];

// How the user ran us (`npm run cli --`, `npx flare-forge`, `flare`), so
// every "next:" line can be pasted back as-is.
const CLI = cliInvocation(process.argv, process.env);

// The one next move after a human-facing outcome. It goes to stderr so
// piped stdout (tab-separated lists, yaml, JSON configs) stays clean,
// and never prints in --json mode (the envelope stays pure).
function next(command: string, why?: string): void {
  if (!JSON_MODE) console.error(nextLine(CLI, command, why));
}
function nextPlain(text: string): void {
  if (!JSON_MODE) console.error(nextText(text));
}

// owner/name of this working tree's origin, for next lines that need a
// repo (`run <repo> --source`). null outside a GitHub clone.
function gitRepo(): string | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  return r.status === 0 ? repoFromRemote(r.stdout.trim() || null) : null;
}

// A wrong value for a flag or argument: one plain sentence, then a
// copy-pasteable example, exit 2.
function badValue(message: string, example: string): never {
  console.error(message);
  console.error(nextLine(CLI, example));
  process.exit(2);
}

const USAGE_LINES = [
  "Start here: Flare runs your project's checks (CI) on your own Cloudflare account,",
  "and lets many coding agents work on one repo without clashing.",
  `  first run: ${CLI} doctor   (checks your setup and names the one next step)`,
  "",
  "  cli doctor                                  check setup and tell you what to fix next (alias: whoami)",
  "  cli login [--url U] [--code C]              pair this machine (writes .env, 0600)",
  "  cli connect [repo] [--init] [--wire] [--dry-run]  detect stack, scaffold, wire, verify in one command",
  "  cli init [--force] [--stack <id>] [--template <id>]  scaffold flare.yml (auto-detected stack) + AGENTS.md snippet",
  "  cli run <repo> <sha|branch|tag> [ref]      dispatch, wait, print the compact digest (exit 1 on failure)",
  "  cli run <repo> --source [ref]              upload the working tree and run it (no commit needed)",
  "  run/dispatch accept --agent <tag>          tag the run for per-agent caps + attribution",
  "  run/dispatch accept --profile <name>      run one CI profile from flare.yml (else the event default, else all jobs)",
  "  append --dry-run to run/dispatch           plan the fan-out (queued/blocked/budget) without creating a run",
  "  cli watch <runId>                          wait for a run and print the compact digest",
  "  cli explain <runId>                        one narrative: verdict, failures, next command",
  "  cli local [job] [--file flare.yml]         run the pipeline in this directory (no server, warm cache)",
  "  cli local --parity [--file] [job]          report local-vs-cloud divergences (image, cache, env) without running",
  "",
  "Runs:",
  "  cli runs [agent]                          list recent runs, optionally one agent's",
  "  cli logs <runId>                           show run jobs, steps, triage, logs",
  "  cli cancel <runId>                         cancel queued/blocked jobs of a run",
  "  cli dispatch <repo> <sha|branch|tag> [ref]  trigger a run without waiting",
  "  cli rerun <runId> <jobId>                   reset a finished job to queued",
  "  cli tests <runId>                           per-test results and failing tests",
  "  cli selection <runId>                       smart test selection: what was skipped and why",
  "  cli attestation <receiptId>                 verify a reused-verdict receipt",
  "  cli artifacts <runId>                       list a run's artifacts",
  "  cli egress <runId>                          per-job egress (uploads/downloads by host)",
  "  cli search <query...>                       search all job logs (branch:main level:error ...)",
  "  cli flaky <repo> [days]                     per-job failure rates, worst first",
  "  cli bottlenecks <repo> [days]               slowest checks: p50/p95 run time + queue wait",
  "  cli quarantine list <repo>                  quarantined (flaky) tests for a repo",
  "  cli quarantine add <repo> <test>            move a test out of the blocking gate",
  "  cli quarantine remove <repo> <test>         reinstate a quarantined test",
  "  cli mergequeue enqueue <repo> <pr> <sha>   queue a PR for verify-then-land (--base, --agent)",
  "  cli mergequeue status <repo>                queue entries + file-collision radar",
  "  cli mergequeue cancel <entryId>             cancel a queued/verifying entry",
  "  cli github-jobs [repo]                    ephemeral runner-mode jobs (status, duration, list price)",
  "  cli github-jobs --logs <jobId> [repo]    print one lane job's log digest",
  "  cli badge <repo> [branch]                   print badge markdown + url",
  "  cli import <workflow.yml>                   convert a GitHub Actions workflow to flare.yml",
  "",
  "Agents & Forge:",
  "  cli forge <verb> ...                        Flare Forge: goal|declare|claim|push|ready|inbox|status|why|conflicts|trains|snapshot|connect-agent|init (cli forge --help)",
  "  cli races [raceId]                          list agent races, or one race board",
  "  cli claim <raceId> <agent>                  claim a race lane (forks a workspace)",
  "  cli verdict <raceId>                        winner ranking + why-it-won rationale",
  "  cli repos [name] [path] [--ref R]           list forge repos, or browse one",
  "  cli mcp-config                              print MCP client config for this server",
  "",
  "Admin:",
  "  cli queue [labels]                        live queue + projected claim order (admin)",
  "  cli cache list [prefix]                     list cache entries (admin)",
  "  cli cache purge [prefix]                    delete cache entries (admin)",
  "  cli cache stats                             shared warm-cache hit rate (7d)",
  "  cli paused                                  repos auto-paused for runaway spend (admin)",
  "  cli resume <repo>                           resume a paused repo (admin)",
  "",
  "Dev boxes:",
  "  cli devbox create <name> [--image img]      create a persistent warm dev box (local docker)",
  "  cli devbox exec <name> -- <cmd...>           run a command in the box (/work)",
  "  cli devbox sync <name> [--dir D] [paths..]  tar local paths into the box workdir",
  "  cli devbox fetch <name> <path> [dir]        copy a workdir-relative path out of the box",
  "  cli devbox snapshot <name> [tag]            commit the box filesystem to a local image tag",
  "  cli devbox restore <name> <tag>             recreate the box from a snapshot tag",
  "  cli devbox list                             list dev boxes",
  "  cli devbox destroy <name>                   remove the box (snapshot images kept)",
  "  append --remote to devbox/mcp-serve        run boxes on the seats worker (SEATS_URL + SEATS_TOKEN)",
  "  cli mcp-serve                               stdio MCP server for dev boxes (local agents)",
  "",
  "Billing:",
  "  cli usage [days] [repo]                     runs, jobs, compute-minutes for billing",
  "  cli usage --merged-pr <repo> [weeks]       cost-per-merged-PR trend (needs the GitHub App)",
  "  cli credits [limit]                       prepaid balance + ledger (hosted; self-hosted is free)",
  "  cli signup [--agent <tag>]                 onboard this deployment (tokenless probe + next steps)",
  "",
  "invoke as: npm run cli -- <command>   (or: flare-forge <command> once installed)",
  "run/dispatch accept --priority N (0-10): higher jumps queued batch work.",
  "every command accepts --json: stdout becomes one versioned envelope",
  "  { version: 1, command, data } (mcp-config stays paste-ready, mcp-serve ignores it).",
  "cli local reads FLARE_SECRET_<NAME> for ${{ secrets.NAME }} placeholders.",
  "env: FLARE_ACTIONS_URL + RUNNER_TOKEN (FLARE_TOKEN also works; from `cli login`, `npm run setup`, or the dashboard).",
  "Reads accept readonly tokens; dispatch/rerun need runner scope.",
];

// Every top-level command, for "did you mean" and for telling a known
// command with missing args (show its usage) from a typo.
const COMMANDS: readonly string[] = [
  ...new Set([
    ...USAGE_LINES.map((l) => /^\s*cli ([a-z][\w-]*)/.exec(l)?.[1]).filter((c): c is string => !!c),
    "doctor",
    "whoami",
    "help",
    "version",
  ]),
];
// Forge verbs typed at top level (`cli status`) suggest `forge <verb>`.
const FORGE_VERBS = ["goal", "declare", "push", "ready", "inbox", "status", "why", "conflicts", "trains", "snapshot", "connect-agent", "done", "heartbeat", "claim", "note", "fork", "init"];

// Exit 0 (explicit help) prints to stdout; any non-zero exit prints to
// stderr so a --json caller's stdout stays empty on failure.
function usage(code = 2): never {
  const text = ["usage:", ...USAGE_LINES, "", nextLine(CLI, "doctor")].join("\n");
  if (code === 0) console.log(text);
  else console.error(text);
  process.exit(code);
}

function commandUsageLines(name: string): string[] {
  return USAGE_LINES.filter((l) => l.trimStart().startsWith(`cli ${name} `) || l.trim() === `cli ${name}`);
}

// The current command's args are wrong: its usage lines only, exit 2.
function badArgs(): never {
  const lines = commandUsageLines(cmd ?? "");
  if (lines.length === 0) usage();
  // The first usage line's signature is the example to copy.
  const sig = lines[0].trim().replace(/^cli /, "").split(/\s{2,}/)[0];
  console.error([`Missing or wrong arguments for \`${cmd}\`.`, "usage:", ...lines, nextLine(CLI, sig)].join("\n"));
  process.exit(2);
}

// Typo or unknown command: one short hint, never the full usage dump.
function unknownCommand(name: string): never {
  console.error(`unknown command "${name}"`);
  const top = suggestCommand(name, COMMANDS.filter((c) => c !== "help" && c !== "version"));
  const forge = top ? null : suggestCommand(name, FORGE_VERBS);
  if (top) console.error(`did you mean: ${top}?`);
  else if (forge) console.error(`did you mean: forge ${forge}?`);
  console.error("run with --help for all commands");
  console.error(nextLine(CLI, top ?? (forge ? `forge ${forge}` : "--help")));
  process.exit(2);
}

function requireConfig(): { baseUrl: string; token: string } {
  const missing = missingConfigVars(process.env);
  const baseUrl = process.env["FLARE_ACTIONS_URL"];
  const token = process.env["RUNNER_TOKEN"];
  if (missing.length > 0 || !baseUrl || !token) {
    console.error(missingConfigMessage(missing, ENV_LOCATION, CLI));
    process.exit(1);
  }
  return { baseUrl, token };
}

// `<cmd> --help` / `-h`: print that command's usage lines (exit 0) instead
// of treating the flag as an argument (e.g. `import --help` opening a file
// named --help). Commands with their own help (forge) handle it themselves.
function commandHelp(name: string): never {
  const lines = commandUsageLines(name);
  if (lines.length === 0) usage(0);
  console.log(["usage:", ...lines].join("\n"));
  process.exit(0);
}

function client(): FlareClient {
  const { baseUrl, token } = requireConfig();
  return new FlareClient(baseUrl, token);
}

// --priority N anywhere in the args; returns the remaining positionals.
function takePriority(args: string[]): { args: string[]; priority?: number } {
  const out = args.slice();
  const i = out.indexOf("--priority");
  if (i === -1) return { args: out };
  const value = Number(out[i + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 10) badValue("--priority must be a whole number from 0 to 10.", "run owner/repo HEAD --priority 5");
  out.splice(i, 2);
  return { args: out, priority: value };
}

function takeAgent(args: string[]): { args: string[]; agent?: string } {
  const out = args.slice();
  const i = out.indexOf("--agent");
  if (i === -1) return { args: out };
  const value = out[i + 1] ?? "";
  if (!/^[\w.-]{1,64}$/.test(value)) {
    badValue("--agent must be 1-64 chars: letters, digits, dot, dash, underscore.", "run owner/repo HEAD --agent claude");
  }
  out.splice(i, 2);
  return { args: out, agent: value };
}

function takeProfile(args: string[]): { args: string[]; profile?: string } {
  const out = args.slice();
  const i = out.indexOf("--profile");
  if (i === -1) return { args: out };
  const value = out[i + 1] ?? "";
  if (!/^[\w.-]{1,64}$/.test(value)) {
    badValue("--profile must be 1-64 chars: letters, digits, dot, dash, underscore.", "run owner/repo HEAD --profile quick");
  }
  out.splice(i, 2);
  return { args: out, profile: value };
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

function topR2Bucket(buckets: { bucket: string; ingressBytes: number; egressBytes: number }[] | undefined): string {
  if (!buckets || buckets.length === 0) return "";
  const top = buckets[0];
  return ` (top: ${top.bucket} ${formatBytes(top.ingressBytes + top.egressBytes)})`;
}

function printDigest(d: FlareRunDigest): void {
  const secs = d.durationMs === null ? "?" : `${Math.round(d.durationMs / 1000)}s`;
  console.log(`${d.status}  ${d.repo}@${d.sha.slice(0, 7)} (${d.branch || "-"}, ${secs})  ${d.failedJobs}/${d.totalJobs} failed`);
  for (const j of d.jobs) {
    const mark = j.status === "success" ? "ok" : j.status === "skipped" ? "--" : "FAIL";
    console.log(`  [${mark}] ${j.name} (${j.durationMs === null ? "?" : `${j.durationMs}ms`})`);
    if (j.failing) {
      console.log(`        $ ${j.failing.command} (exit ${j.failing.exitCode})`);
      const tail = j.failing.outputTail.trim();
      if (tail) console.log(tail.split("\n").map((l) => `        | ${l}`).join("\n"));
    }
    if (j.triage) console.log(`        triage: ${j.triage.replace(/\n/g, "\n        ")}`);
  }
}

// Wait loop via the blocking endpoint: one request per check, no client
// sleep loop. Bounded at 15 minutes, then a non-zero exit.
async function waitAndDigest(c: FlareClient, runId: string): Promise<FlareRunDigest> {
  const started = Date.now();
  for (;;) {
    const waited = await c.waitRun(runId, 60);
    if (!waited.timedOut) break;
    if (Date.now() - started > 15 * 60000) {
      console.error(`Still not finished after 15 minutes (run ${runId}).`);
      console.error(nextLine(CLI, `watch ${runId}`, "keep waiting"));
      process.exit(2);
    }
    console.error(`still running (${Math.round((Date.now() - started) / 1000)}s)…`);
  }
  const digest = await c.getRunDigest(runId);
  if (!JSON_MODE) {
    printDigest(digest);
    console.error(nextAfterRun(CLI, digest));
  }
  return digest;
}

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(process.env["FLARE_CLI_VERSION"] ?? "dev");
  process.exit(0);
}
const HELP_FLAGS = new Set(["--help", "-h"]);
if (!cmd || cmd === "help" || HELP_FLAGS.has(cmd)) usage(cmd ? 0 : 2);
if (!COMMANDS.includes(cmd)) unknownCommand(cmd);
if (cmd !== "forge" && head.some((a) => HELP_FLAGS.has(a))) commandHelp(cmd === "whoami" ? "doctor" : cmd);

try {
  if (cmd === "runs") {
    const runs = await client().listRuns(rest[0]);
    if (JSON_MODE) printJson("runs", { runs, agent: rest[0] ?? null });
    else {
      for (const r of runs) console.log(`${r.status}\t${r.id}\t${r.repo}@${r.sha.slice(0, 7)}\t${r.event}${r.agent ? `\t@${r.agent}` : ""}`);
      const failed = runs.find((r) => r.status === "failure" || r.status === "error");
      if (runs.length === 0) {
        console.log(rest[0] ? `No checks yet for agent ${rest[0]}.` : "No checks yet.");
        next("connect", "wire this project and run its first check");
      } else if (failed) next(`explain ${failed.id}`, "the newest failed check");
      else next(`logs ${runs[0].id}`, "the newest check in detail");
    }
  } else if (cmd === "logs" && rest[0]) {
    const { run, jobs } = await client().getRun(rest[0]);
    if (JSON_MODE) {
      printJson("logs", { run, jobs });
    } else {
      console.log(`run ${run.id} ${run.status} ${run.repo}@${run.sha}`);
      for (const j of jobs) {
        const label = j.name ? `${j.name} ${j.id.slice(0, 8)}` : j.id;
        console.log(`--- job ${label} ${j.status} ---`);
        try {
          const parsed = JSON.parse(j.result || "") as {
            steps?: { command?: string; exitCode?: number; durationMs?: number }[];
          };
          if (parsed && Array.isArray(parsed.steps)) {
            for (const s of parsed.steps) {
              const mark = s.exitCode === 0 ? "ok" : "FAIL";
              console.log(`  [${mark}] ${s.command} (exit ${s.exitCode}, ${s.durationMs}ms)`);
            }
          }
        } catch {
          // legacy jobs without structured results
        }
        if (j.triage) console.log(`AI triage:\n${j.triage}`);
        console.log(j.log);
      }
      console.error(nextAfterRun(CLI, { runId: run.id, status: run.status, repo: run.repo }));
    }
  } else if (cmd === "explain" && rest[0]) {
    const digest = await client().getRunDigest(rest[0]);
    const out = explainDigest(digest, CLI);
    if (JSON_MODE) printJson("explain", out);
    else console.log(out.narrative);
  } else if (cmd === "local") {
    let file: string | undefined;
    const positional: string[] = [];
    let parity = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--file") {
        file = rest[++i];
      } else if (rest[i] === "--parity") {
        parity = true;
      } else {
        positional.push(rest[i]);
      }
    }
    if (parity) {
      const report = runLocalParity({ cwd: process.cwd(), file, job: positional[0], quiet: true });
      if (JSON_MODE) printJson("local", report);
      else {
        console.log(formatParityReport(report));
        next(`local${positional[0] ? ` ${positional[0]}` : ""}${file ? ` --file ${file}` : ""}`, "run it here");
      }
    } else {
      const result = await runLocal({
        cwd: process.cwd(),
        file,
        job: positional[0],
        ...(JSON_MODE ? { quiet: true } : {}),
      });
      if (JSON_MODE) printJson("local", result);
      else if (result.ok) next(`run ${gitRepo() ?? "owner/repo"} --source`, "passed here; now check it on the server, no commit needed");
      else nextPlain(`fix the failing step above, then ${CLI} local${positional[0] ? ` ${positional[0]}` : ""}`);
      process.exitCode = result.ok ? 0 : 1;
    }
  } else if (cmd === "run" && rest[0]) {
    const { args: noPriority, priority } = takePriority(rest);
    const { args: noAgent, agent } = takeAgent(noPriority);
    const { args, profile } = takeProfile(noAgent);
    const sourceMode = args.includes("--source");
    const dryRun = args.includes("--dry-run");
    const positional = args.filter((a) => a !== "--source" && a !== "--dry-run");
    const repo = positional[0];
    if (!repo || (!sourceMode && !positional[1])) badArgs();
    if (dryRun) {
      // Source dry-runs plan from the local flare.yml without uploading;
      // the placeholder source id never leaves this branch.
      const plan = sourceMode
        ? await client().dryRunDispatch(repo, "", {
            ref: positional[1],
            pipeline: readLocalPipeline(process.cwd()),
            source: "dry-run",
            ...(profile !== undefined ? { profile } : {}),
          })
        : await client().dryRunDispatch(repo, positional[1] as string, {
            ...(positional[2] ? { ref: positional[2] } : {}),
            ...(profile !== undefined ? { profile } : {}),
          });
      if (JSON_MODE) printJson("run", plan);
      else {
        console.log(formatPlan(plan));
        next(`run ${rest.filter((a) => a !== "--dry-run").join(" ")}`, "start it for real");
      }
    } else if (sourceMode) {
      const out = await dispatchSource(client(), {
        repo,
        ref: positional[1],
        cwd: process.cwd(),
        ...(priority !== undefined ? { priority } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      if (!JSON_MODE) console.error(`source run ${out.runId} dispatched (upload ${out.sourceId.slice(0, 8)}…) — waiting for the digest…`);
      const digest = await waitAndDigest(client(), out.runId);
      if (JSON_MODE) printJson("run", { runId: out.runId, sourceId: out.sourceId, digest });
      process.exitCode = digest.status === "success" ? 0 : 1;
    } else {
      const out = await client().dispatch(repo, positional[1] as string, {
        ...(positional[2] ? { ref: positional[2] } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      if (!JSON_MODE) console.error(`run ${out.runId} dispatched — waiting for the digest…`);
      const digest = await waitAndDigest(client(), out.runId);
      if (JSON_MODE) printJson("run", { runId: out.runId, digest });
      process.exitCode = digest.status === "success" ? 0 : 1;
    }
  } else if (cmd === "watch" && rest[0]) {
    const digest = await waitAndDigest(client(), rest[0]);
    if (JSON_MODE) printJson("watch", { runId: rest[0], digest });
    process.exitCode = digest.status === "success" ? 0 : 1;
  } else if (cmd === "cancel" && rest[0]) {
    const cancelled = await client().cancelRun(rest[0]);
    if (JSON_MODE) printJson("cancel", { ok: true, cancelled });
    else {
      console.log(cancelled > 0 ? `Stopped ${cancelled} waiting job${cancelled === 1 ? "" : "s"} in run ${rest[0]}.` : `Nothing to stop: run ${rest[0]} has no waiting jobs.`);
      next(`logs ${rest[0]}`, "see where it stopped");
    }
  } else if (cmd === "dispatch" && rest[0] && rest[1]) {
    const { args: noPriority, priority } = takePriority(rest);
    const { args: noAgent, agent } = takeAgent(noPriority);
    const { args, profile } = takeProfile(noAgent);
    const positional = args.filter((a) => a !== "--dry-run");
    if (!positional[0] || !positional[1]) badArgs();
    if (args.includes("--dry-run")) {
      const plan = await client().dryRunDispatch(positional[0], positional[1], {
        ...(positional[2] ? { ref: positional[2] } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      if (JSON_MODE) printJson("dispatch", plan);
      else {
        console.log(formatPlan(plan));
        next(`dispatch ${rest.filter((a) => a !== "--dry-run").join(" ")}`, "start it for real");
      }
    } else {
      const out = await client().dispatch(positional[0], positional[1], {
        ...(positional[2] ? { ref: positional[2] } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      if (JSON_MODE) printJson("dispatch", out);
      else {
        console.log(`Started run ${out.runId} (${out.jobIds.length} job${out.jobIds.length === 1 ? "" : "s"}).`);
        next(`watch ${out.runId}`, "wait for the result");
      }
    }
  } else if (cmd === "rerun" && rest[0] && rest[1]) {
    await client().rerun(rest[0], rest[1]);
    if (JSON_MODE) printJson("rerun", { ok: true, runId: rest[0], jobId: rest[1] });
    else {
      console.log(`Job ${rest[1]} is queued again.`);
      next(`watch ${rest[0]}`, "wait for the result");
    }
  } else if (cmd === "flaky" && rest[0]) {
    const days = rest[1] === undefined ? 30 : Number(rest[1]);
    if (!Number.isInteger(days) || days < 1 || days > 365) badValue("days must be a whole number from 1 to 365.", `flaky ${rest[0]} 30`);
    const { stats, candidates } = await client().getFlaky(rest[0], days);
    if (JSON_MODE) printJson("flaky", { repo: rest[0], days, stats, candidates });
    else {
      for (const s of stats) {
        console.log(`${(s.rate * 100).toFixed(1)}%\t${s.failures}/${s.runs}\t${s.job}`);
      }
      for (const c of candidates) {
        console.log(`suggest\t${c.sparkline || "-"}\t${c.name}\t${c.reason}`);
      }
      if (candidates[0]) next(`quarantine add ${rest[0]} ${candidates[0].name}`, "stop this flaky test from blocking");
      else if (stats.length === 0) {
        console.log(`No failures in the last ${days} days.`);
        next(`bottlenecks ${rest[0]}`, "see the slowest checks instead");
      } else next(`quarantine list ${rest[0]}`, "tests already kept out of the gate");
    }
  } else if (cmd === "bottlenecks" && rest[0]) {
    const days = rest[1] === undefined ? 14 : Number(rest[1]);
    if (!Number.isInteger(days) || days < 1 || days > 90) badValue("days must be a whole number from 1 to 90.", `bottlenecks ${rest[0]} 14`);
    const checks = await client().getBottlenecks(rest[0], days);
    if (JSON_MODE) printJson("bottlenecks", { repo: rest[0], days, checks });
    else {
      console.log("check\tp50\tp95\tqueue p50\tjobs\tfailed");
      for (const c of checks) {
        const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
        console.log(`${c.check}\t${secs(c.p50Ms)}\t${secs(c.p95Ms)}\t${secs(c.queueP50Ms)}\t${c.jobs}\t${c.failures}`);
      }
      if (checks.length === 0) {
        console.log("(no finished jobs in the window)");
        next(`run ${rest[0]} HEAD`, "run a check first");
      } else next(`flaky ${rest[0]}`, "checks that fail now and then");
    }
  } else if (cmd === "quarantine" && rest[0]) {
    const sub = rest[0];
    if (sub === "list" && rest[1]) {
      const tests = await client().getQuarantine(rest[1]);
      if (JSON_MODE) printJson("quarantine", { action: "list", repo: rest[1], tests });
      else {
        if (tests.length === 0) console.log("no quarantined tests");
        for (const t of tests) console.log(`${t.status}\t${t.name}\t${t.reason}`);
        next(`flaky ${rest[1]}`, tests.length === 0 ? "find tests worth quarantining" : "see failure rates");
      }
    } else if (sub === "add" && rest[1] && rest[2]) {
      const name = rest.slice(2).join(" ");
      await client().setQuarantine(rest[1], name, "add");
      if (JSON_MODE) printJson("quarantine", { action: "add", repo: rest[1], name, ok: true });
      else {
        console.log(`quarantined: ${name} (it still runs, but no longer blocks)`);
        next(`quarantine list ${rest[1]}`);
      }
    } else if (sub === "remove" && rest[1] && rest[2]) {
      const name = rest.slice(2).join(" ");
      await client().setQuarantine(rest[1], name, "remove");
      if (JSON_MODE) printJson("quarantine", { action: "remove", repo: rest[1], name, ok: true });
      else {
        console.log(`reinstated: ${name} (it blocks again when it fails)`);
        next(`quarantine list ${rest[1]}`);
      }
    } else {
      console.error("usage: cli quarantine <list <repo> | add <repo> <test> | remove <repo> <test>>");
      console.error(nextLine(CLI, "quarantine list owner/repo"));
      process.exit(2);
    }
  } else if (cmd === "init") {
    const stackAt = rest.indexOf("--stack");
    const stack = stackAt === -1 ? undefined : rest[stackAt + 1];
    if (stackAt !== -1 && !stack) {
      badValue("--stack needs a stack id (node, python, go, rust, ruby, java, php, dotnet, elixir, generic).", "init --stack node");
    }
    const templateAt = rest.indexOf("--template");
    const template = templateAt === -1 ? undefined : rest[templateAt + 1];
    if (templateAt !== -1 && !template) {
      badValue("--template needs a template id (see the dashboard gallery or GET /v1/templates).", "init");
    }
    const result = runInit({
      cwd: process.cwd(),
      force: rest.includes("--force"),
      ...(stack ? { stack } : {}),
      ...(template ? { template } : {}),
    });
    if (result.error) {
      console.error(result.error);
      console.error(/exists/i.test(result.error) ? nextLine(CLI, "local", "run the pipeline you already have") : nextLine(CLI, "init --stack generic"));
      process.exit(2);
    }
    if (JSON_MODE) {
      printJson("init", result);
    } else {
      const detected = result.stacks.length > 0
        ? result.stacks.map((s) => `${s.stack} (${s.evidence.join(", ")})`).join(" + ")
        : "none";
      console.log(`detected stack: ${detected}`);
      const origin = result.pipelineSource === "converted"
        ? `from .github/workflows/${result.convertedFrom}`
        : result.pipelineSource === "template"
          ? `from the ${result.templateId} gallery template`
          : `${result.starterStack} starter`;
      console.log(`wrote ${result.pipelinePath} (${origin})`);
      for (const warning of result.warnings.slice(0, 20)) console.log(`  warning: ${warning}`);
      if (result.warnings.length > 20) console.log(`  … ${result.warnings.length - 20} more warnings`);
      console.log(`updated ${result.agentsPath} (idempotent snippet; agents learn the verify loop)`);
      console.log("");
      console.log("after that:");
      console.log(`  ${CLI} mcp-config            # teach your agent the MCP verify loop`);
      console.log("  deploy: https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/flare-actions");
      console.log("  docs: docs/GITHUB-ACTIONS-COMPAT.md · docs/PIPELINES.md · skills/flare-verify");
      console.log(nextLine(CLI, "local", "check it here, no server needed"));
    }
  } else if (cmd === "connect") {
    const baseUrl = process.env["FLARE_ACTIONS_URL"];
    if (!baseUrl) {
      console.error(missingConfigMessage(["FLARE_ACTIONS_URL"], ENV_LOCATION, CLI));
      process.exit(2);
    }
    const token = process.env["RUNNER_TOKEN"];
    const positional = rest.filter((a) => !a.startsWith("--"));
    if (positional.length > 1) badArgs();
    const dryRun = rest.includes("--dry-run");
    const lines: string[] = [];
    const out = await runConnect({
      cwd: process.cwd(),
      baseUrl,
      ...(positional[0] ? { repo: positional[0] } : {}),
      wire: rest.includes("--wire"),
      init: rest.includes("--init"),
      dryRun,
      cli: CLI,
      client: token ? new FlareClient(baseUrl, token) : null,
      ...(JSON_MODE ? { log: (l: string) => lines.push(l), err: () => undefined } : {}),
    });
    if (JSON_MODE) {
      printJson("connect", {
        repo: out.repo,
        exitCode: out.exitCode,
        stacks: out.stacks,
        pipeline: out.pipeline,
        scaffolded: out.scaffolded,
        ...(dryRun ? { plan: lines } : { lines }),
      });
    } else if (out.exitCode === 0) console.log(out.next);
    else console.error(out.next);
    process.exitCode = out.exitCode;
  } else if (cmd === "tests" && rest[0]) {
    const t = await client().getRunTests(rest[0]);
    if (JSON_MODE) {
      printJson("tests", t);
    } else {
      console.log(
        `${t.totals.total} tests: ${t.totals.passed} passed, ${t.totals.failed} failed, ${t.totals.errors} errors, ${t.totals.skipped} skipped`,
      );
      for (const j of t.jobs) {
        console.log(`  ${j.jobName}: ${j.passed}/${j.total} passed${j.truncated ? " (truncated)" : ""}`);
      }
      for (const f of t.failing) {
        console.log(`  FAIL ${f.name}${f.suite ? ` (${f.suite})` : ""} [${f.jobName}]`);
        if (f.message) console.log(`       ${f.message.split("\n")[0]?.slice(0, 200)}`);
      }
      if (t.failing.length > 0) next(`explain ${rest[0]}`, "what broke and how to fix it");
      else next(`selection ${rest[0]}`, "which tests were skipped and why");
    }
  } else if (cmd === "selection" && rest[0]) {
    const s = await client().getRunSelection(rest[0]);
    if (JSON_MODE) {
      printJson("selection", s);
    } else if (s.jobs.length === 0) {
      console.log("no test selection ran for this run (jobs did not opt in)");
      next(`tests ${rest[0]}`, "per-test results");
    } else {
      for (const j of s.jobs) {
        if (j.mode === "select") {
          console.log(`${j.jobName}: selected ${j.selectedCount}, skipped ${j.skippedCount} — ${j.reason}`);
          for (const skip of j.skipped.slice(0, 20)) {
            console.log(`  skip ${skip.file} (${skip.reason})`);
          }
          if (j.skipped.length > 20) console.log(`  …and ${j.skipped.length - 20} more skipped`);
        } else {
          console.log(`${j.jobName}: full suite — ${j.reason}`);
        }
      }
      next(`tests ${rest[0]}`, "per-test results");
    }
  } else if (cmd === "attestation" && rest[0]) {
    const a = await client().getAttestation(rest[0]);
    if (JSON_MODE) {
      printJson("attestation", a);
    } else {
      const stamp = a.verified === true ? "verified" : a.verified === false ? "MISMATCH" : "unverifiable";
      console.log(`${a.id} ${a.verdict} (${stamp}: ${a.verifyReason})`);
      console.log(`  ${a.repo}@${a.sha.slice(0, 12)}${a.profile ? ` profile ${a.profile}` : ""} — ${a.jobCount} jobs from run ${a.runId}`);
      console.log(`  hash ${a.hash}`);
      for (const j of a.jobs) {
        console.log(`  ${j.status} ${j.name}`);
      }
      next(`explain ${a.runId}`, "the run this receipt came from");
    }
  } else if (cmd === "mergequeue" && rest[0]) {
    const sub = rest[0];
    if (sub === "enqueue" && rest[1] && rest[2] && rest[3]) {
      const pr = Number(rest[2]);
      if (!Number.isInteger(pr) || pr < 1) badValue("pr must be a pull request number.", `mergequeue enqueue ${rest[1]} 42 <sha>`);
      const takeFlag = (flag: string): string | undefined => {
        const i = rest.indexOf(flag);
        return i === -1 ? undefined : rest[i + 1];
      };
      const baseBranch = takeFlag("--base");
      const agent = takeFlag("--agent");
      const out = await client().enqueueMerge(rest[1], pr, rest[3], {
        ...(baseBranch ? { baseBranch } : {}),
        ...(agent ? { agent } : {}),
      });
      if (JSON_MODE) printJson("mergequeue", { action: "enqueue", repo: rest[1], pr, ...out });
      else {
        console.log(`enqueued ${rest[1]}#${pr} as ${out.id}`);
        next(`mergequeue status ${rest[1]}`, "watch it verify and land");
      }
    } else if (sub === "status" && rest[1]) {
      const q = await client().getMergeQueue(rest[1]);
      if (JSON_MODE) {
        printJson("mergequeue", { action: "status", ...q });
      } else if (q.entries.length === 0) {
        console.log(`merge queue for ${rest[1]} is empty`);
        next(`mergequeue enqueue ${rest[1]} <pr> <sha>`, "queue a pull request");
      } else {
        for (const e of q.entries) {
          console.log(`${e.status}\t#${e.pr}\t${e.headSha.slice(0, 7)}${e.agent ? `\t@${e.agent}` : ""}\t${e.note || "-"}\t${e.id.slice(0, 8)}`);
        }
        for (const c of q.collisions) {
          console.log(`collision: #${c.prs[0]} x #${c.prs[1]}: ${c.paths.join(", ")}`);
        }
        next(`mergequeue status ${rest[1]}`, "check again later");
      }
    } else if (sub === "cancel" && rest[1]) {
      const out = await client().cancelMerge(rest[1]);
      if (JSON_MODE) printJson("mergequeue", { action: "cancel", entryId: rest[1], ...out });
      else {
        console.log(out.cancelled ? `cancelled ${rest[1]}` : `${rest[1]} was already finished`);
        next("runs");
      }
    } else {
      console.error("usage: cli mergequeue <enqueue <repo> <pr> <sha> [--base b] [--agent a] | status <repo> | cancel <entryId>>");
      console.error(nextLine(CLI, "mergequeue status owner/repo"));
      process.exit(2);
    }
  } else if (cmd === "login") {
    const takeFlag = (flag: string): string | undefined => {
      const i = rest.indexOf(flag);
      return i === -1 ? undefined : rest[i + 1];
    };
    const loginOpts = { baseUrl: takeFlag("--url"), code: takeFlag("--code"), cwd: process.cwd() };
    // No TTY (piped stdin, CI, agents): never block on a prompt that
    // cannot be answered — name the missing flags and exit as usage.
    const missingFlags = loginMissingArgs(loginOpts, process.env);
    if (!process.stdin.isTTY && missingFlags.length > 0) {
      console.error(`login: no terminal to prompt on; pass ${missingFlags.join(" and ")}`);
      console.error("  (mint a code in dashboard Settings → Pair a runner)");
      console.error(nextLine(CLI, "login --url https://<worker>.workers.dev --code ABCD-1234"));
      process.exit(2);
    }
    const out = await runLogin(loginOpts);
    // Prove the saved credentials work before declaring victory.
    await new FlareClient(out.baseUrl, out.token).listRuns();
    if (JSON_MODE) printJson("login", { envPath: out.envPath, name: out.name });
    else {
      console.log(`logged in as ${out.name} — credentials saved to ${out.envPath}`);
      console.log(nextLine(CLI, "doctor", "checks the rest of your setup"));
    }
  } else if (cmd === "races") {
    if (!rest[0]) {
      const races = await client().listTournaments();
      if (JSON_MODE) printJson("races", { races });
      else if (races.length === 0) {
        console.log("no races yet");
        nextPlain("start one from the dashboard Races tab");
      } else {
        for (const t of races) console.log(`${t.state}\t${t.id}\t${t.source_repo}\t${t.intent.slice(0, 80)}`);
        next(`races ${races[0].id}`, "the newest race board");
      }
    } else {
      const board = await client().getTournament(rest[0]);
      if (JSON_MODE) printJson("races", board);
      else {
        const t = board.tournament;
        console.log(`${t.id} [${t.state}] ${t.source_repo}@${t.base_ref}`);
        console.log(`intent: ${t.intent}`);
        for (const a of board.attempts) {
          const rank = a.verdict_rank === null ? "-" : `#${a.verdict_rank}`;
          console.log(`  ${rank}\t@${a.agent}\t${a.state}\t${a.run_status ?? "no run"}\t${a.fork_repo}`);
        }
        if (board.verdict) {
          console.log(`verdict (${board.verdict.model}): ${board.verdict.rationale.slice(0, 500)}`);
          next(`verdict ${t.id}`, "the full ranking and why");
        } else {
          console.log("verdict: pending");
          next(`claim ${t.id} <agent>`, "join the race");
        }
      }
    }
  } else if (cmd === "repos") {
    if (!rest[0]) {
      const repos = await client().listRepos();
      if (JSON_MODE) printJson("repos", { repos });
      else if (repos.length === 0) {
        console.log("no repos in this namespace yet");
        next("forge init", "wire a repo for your agents");
      } else {
        for (const r of repos) console.log(`${r.name}\t${r.defaultBranch}\t${r.lastPushAt ?? "never pushed"}`);
        next(`repos ${repos[0].name}`, "browse one");
      }
    } else {
      const takeFlag = (flag: string): string | undefined => {
        const i = rest.indexOf(flag);
        return i === -1 ? undefined : rest[i + 1];
      };
      const ref = takeFlag("--ref");
      const positional = rest.filter((a) => a !== "--ref" && a !== ref);
      const name = positional[0];
      const path = positional[1];
      const detail = await client().getRepo(name);
      const [tree, commits] = await Promise.all([
        client().getRepoTree(name, ref, path),
        path ? Promise.resolve([]) : client().getRepoCommits(name, ref, 5),
      ]);
      if (JSON_MODE) printJson("repos", { repo: detail, tree, commits });
      else {
        console.log(`${detail.name} (${detail.defaultBranch})${detail.head ? ` @ ${detail.head.hash.slice(0, 7)} ${detail.head.message.split("\n")[0]}` : " (empty)"}`);
        for (const e of tree.entries) console.log(`  ${e.type === "tree" ? "dir " : "file"} ${e.name}`);
        if (tree.truncated) console.log("  … truncated");
        for (const c of commits) console.log(`  ${c.hash.slice(0, 7)} ${c.message.split("\n")[0]} — ${c.authorName}`);
        next(`forge status ${detail.name}`, "who is working on it now");
      }
    }
  } else if (cmd === "claim" && rest[0] && rest[1]) {
    const out = await client().claimTournament(rest[0], rest[1]);
    if (JSON_MODE) printJson("claim", { raceId: rest[0], agent: rest[1], ...out });
    else {
      console.log(`lane claimed for @${rest[1]}: ${out.forkRepo}`);
      console.log(`  git clone ${out.remote} ${out.forkRepo}`);
      nextPlain(`clone it, push your attempt, then ${CLI} verdict ${rest[0]}`);
    }
  } else if (cmd === "verdict" && rest[0]) {
    const board = await client().getTournament(rest[0]);
    if (JSON_MODE) printJson("verdict", { raceId: rest[0], verdict: board.verdict, winnerRunId: board.tournament.winner_run_id });
    else if (!board.verdict) {
      console.log(`no verdict yet — race is ${board.tournament.state}`);
      next(`races ${rest[0]}`, "see each attempt");
    } else {
      const ordered = board.attempts.slice().sort((a, b) => (a.verdict_rank ?? 99) - (b.verdict_rank ?? 99));
      for (const a of ordered) console.log(`#${a.verdict_rank ?? "-"} @${a.agent} (${a.run_status ?? a.state})`);
      console.log(`\nwhy (model ${board.verdict.model}):\n${board.verdict.rationale}`);
      const winner = board.tournament.winner_run_id;
      if (winner) next(`explain ${winner}`, "the winning run");
      else next(`races ${rest[0]}`);
    }
  } else if (cmd === "egress" && rest[0]) {
    const e = await client().getRunEgress(rest[0]);
    if (JSON_MODE) {
      printJson("egress", e);
    } else {
      console.log(`up ${e.totals.reqBytes}b / down ${e.totals.respBytes}b`);
      for (const j of e.jobs) {
        console.log(`  ${j.jobId} ${j.host}: up ${j.reqBytes}b / down ${j.respBytes}b`);
      }
      next(`explain ${rest[0]}`, "the run's result");
    }
  } else if (cmd === "queue") {
    const q = await client().listQueue();
    const labels = (rest[0] ?? "").split(",").map((l) => l.trim()).filter(Boolean);
    const claims = simulateDrain(
      q.jobs.map((j) => ({ id: j.id, repo: j.repo, priority: j.priority, priorMs: j.priorMs ?? 0, createdAt: j.createdAt, labels: j.labels })),
      [{ id: "you", labels }],
      q.fairSharePerRepo,
    );
    if (JSON_MODE) {
      printJson("queue", { jobs: q.jobs, fairSharePerRepo: q.fairSharePerRepo, fairSharePerAgent: q.fairSharePerAgent, labels, projectedOrder: claims });
    } else {
      const caps = [`repo: ${q.fairSharePerRepo === 0 ? "off" : q.fairSharePerRepo}`, `agent: ${q.fairSharePerAgent === 0 ? "off" : q.fairSharePerAgent}`];
      console.log(`${q.jobs.length} queued (fair-share ${caps.join(", ")})`);
      for (const j of q.jobs) {
        console.log(`  p${j.priority} ${j.repo} ${j.name}${j.agent ? ` @${j.agent}` : ""} [${j.labels || "any"}] ${j.id}`);
      }
      console.log(`projected order for [${labels.join(",") || "unlabeled-only"}]:`);
      for (const c of claims) {
        console.log(`  ${c.jobId} (${c.repo})`);
      }
      if (q.jobs.length === 0) next("runs", "nothing is waiting; see recent checks");
      else next("doctor", "jobs are waiting; make sure a computer is online");
    }
  } else if (cmd === "cache" && rest[0] === "list") {
    const entries = await client().listCache(rest[1] ?? "");
    if (JSON_MODE) printJson("cache", { action: "list", prefix: rest[1] ?? "", entries });
    else {
      for (const e of entries) {
        console.log(`${e.key}\t${e.size}b\t${e.uploaded}`);
      }
      if (entries.length === 0) console.log("no cache entries");
      next("cache stats", "how often the cache helps");
    }
  } else if (cmd === "search") {
    const query = rest.join(" ").trim();
    if (!query) badArgs();
    const hits = await client().searchLogs(query);
    if (JSON_MODE) {
      printJson("search", { query, hits });
    } else {
      for (const h of hits) {
        console.log(`${h.created_at} ${h.repo}@${h.branch || "-"} [${h.level}] (${h.run_id.slice(0, 8)}/${h.job_id.slice(0, 8)})`);
        console.log(`  ${h.line}`);
      }
      if (hits.length === 0) {
        console.log("No matching log lines.");
        next("search level:error", "try a wider search");
      } else next(`explain ${hits[0].run_id}`, "the run behind the first match");
    }
  } else if (cmd === "cache" && rest[0] === "purge") {
    const out = await client().purgeCache(rest[1] ?? "");
    if (JSON_MODE) printJson("cache", { action: "purge", prefix: rest[1] ?? "", ...out });
    else {
      console.log(JSON.stringify(out));
      next("cache stats");
    }
  } else if (cmd === "cache" && rest[0] === "stats") {
    const stats = parseCacheStats(await client().getCacheStats());
    if (!stats) {
      console.error("The server sent cache stats this CLI does not understand (version mismatch?).");
      console.error(nextLine(CLI, "doctor"));
      process.exit(2);
    }
    if (JSON_MODE) printJson("cache", { action: "stats", ...stats });
    else {
      console.log(formatCacheStats(stats));
      next("usage", "compute minutes and cost");
    }
  } else if (cmd === "paused") {
    const paused = await client().listPaused();
    if (JSON_MODE) printJson("paused", { paused });
    else if (paused.length === 0) {
      console.log("no paused repos");
      next("usage", "compute minutes per project");
    } else {
      for (const p of paused) {
        const actors = p.topActors.map((a) => `${a.actor} (${a.dispatches})`).join(", ");
        console.log(`${p.repo} paused ${p.pausedAt} — ${p.usedMinutes}/${p.cap ?? "?"} compute-min${actors ? ` — top: ${actors}` : ""}`);
      }
      next(`resume ${paused[0].repo}`, "after you fix what was using the budget");
    }
  } else if (cmd === "resume" && rest[0]) {
    const resumed = await client().resumeRepo(rest[0]);
    if (JSON_MODE) printJson("resume", { repo: rest[0], resumed });
    else {
      console.log(resumed ? `${rest[0]} resumed` : `${rest[0]} was not paused`);
      next(`run ${rest[0]} HEAD`, "check it runs again");
    }
  } else if (cmd === "usage" && rest.includes("--merged-pr")) {
    const args = rest.filter((a) => a !== "--merged-pr");
    const repo = args[0];
    const weeks = args[1] === undefined ? 8 : Number(args[1]);
    if (!repo || !repo.includes("/")) badValue("usage --merged-pr needs a project as owner/repo.", "usage --merged-pr owner/repo 8");
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) badValue("weeks must be a whole number from 1 to 26.", `usage --merged-pr ${repo} 8`);
    const out = await client().getMergedPrCost(repo, weeks);
    if (JSON_MODE) printJson("usage", { mergedPrCost: out });
    else {
      for (const w of out.weeks) {
        console.log(`${w.week}: ${w.mergedPrs} merged PRs, ${w.computeMinutes} compute-min (${w.costPerPrMinutes}/PR, ~$${w.actionsListUsd} list)`);
      }
      console.log(`total: ${out.totals.mergedPrs} merged PRs, ${out.totals.costPerPrMinutes} compute-min/PR`);
      next(`bottlenecks ${repo}`, "where the minutes go");
    }
  } else if (cmd === "usage") {
    let days = 30;
    let repo: string | undefined;
    if (rest[0] !== undefined) {
      if (rest[0].includes("/")) {
        repo = rest[0];
      } else {
        days = Number(rest[0]);
        repo = rest[1];
      }
    }
    if (!Number.isInteger(days) || days < 1 || days > 365) badValue("days must be a whole number from 1 to 365.", "usage 30");
    const c = client();
    const u = await c.getUsage(days, repo);
    // Real Cloudflare dollars when the caller is admin and billing is
    // configured; readonly tokens and outages print nothing extra.
    const billable = !repo ? await c.getBillableUsage(days).catch(() => null) : null;
    if (JSON_MODE) {
      printJson("usage", { usage: u, billableUsage: billable });
    } else {
      console.log(
        `${u.days}d: ${u.runs} runs, ${u.jobs} finished jobs, ${u.computeMinutes} compute-min (~$${u.actionsListUsd} at Actions list price)`,
      );
      if ((u.githubRunnerJobs ?? 0) > 0) {
        console.log(
          `  runner-mode (flare lane): ${u.githubRunnerJobs} jobs, ${u.githubRunnerMinutes} compute-min (~$${u.githubRunnerListUsd} at Actions list price)`,
        );
      }
      for (const [status, n] of Object.entries(u.runsByStatus)) console.log(`  ${status}: ${n}`);
      for (const r of u.topRepos) console.log(`  ${r.repo}: ${r.jobs} jobs, ${r.computeMinutes} compute-min`);
      if (billable?.configured && typeof billable.totalCost === "number") {
        const fams = (billable.families ?? []).slice(0, 5).map((f) => `${f.family} $${f.cost}`).join(", ");
        const partial = billable.truncated ? ` (partial: ${billable.totalRows ?? "?"} rows, first 2000 kept)` : "";
        console.log(`  Cloudflare billable (${billable.from}..${billable.to}): $${billable.totalCost} ${billable.currency ?? "USD"}${fams ? ` (${fams})` : ""}${partial}`);
        if (billable.r2 && typeof billable.r2.egressBytes === "number") {
          console.log(
            `  R2 bandwidth (${billable.r2.from}..${billable.r2.to}): ${formatBytes(billable.r2.ingressBytes)} in / ${formatBytes(billable.r2.egressBytes)} out${topR2Bucket(billable.r2.buckets)}`,
          );
        }
      }
      const top = repo ?? u.topRepos[0]?.repo;
      if (top) next(`bottlenecks ${top}`, "the slowest checks");
      else next("runs", "no compute used yet; see recent checks");
    }
  } else if (cmd === "credits") {
    const limit = rest[0] === undefined ? 20 : Number(rest[0]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) badValue("limit must be a whole number from 1 to 100.", "credits 20");
    const baseUrl = process.env["FLARE_ACTIONS_URL"];
    if (!baseUrl) {
      console.error(missingConfigMessage(["FLARE_ACTIONS_URL"], ENV_LOCATION, CLI));
      process.exit(2);
    }
    const probe = new FlareClient(baseUrl, process.env["RUNNER_TOKEN"] ?? "");
    const status = await probe.getCloudStatus();
    if (!status.hosted) {
      if (JSON_MODE) printJson("credits", { hosted: false, balanceCents: null, recent: [] });
      else {
        console.log(`self-hosted deploy at ${baseUrl}: no credit ledger — runs are unlimited and free.`);
        next("usage", "compute minutes instead");
      }
    } else {
      const { balanceCents, recent } = await client().getCreditBalance(limit);
      if (JSON_MODE) {
        printJson("credits", { hosted: true, balanceCents, recent });
      } else {
        console.log(`balance: $${(balanceCents / 100).toFixed(2)} (${balanceCents}c)`);
        for (const r of recent) {
          const sign = r.kind === "grant" ? "+" : "-";
          console.log(`  ${r.createdAt.slice(0, 10)}  ${sign}${r.amountCents}c  ${r.memo || r.ref}`);
        }
        next("usage", "what the credits were spent on");
      }
    }
  } else if (cmd === "signup") {
    const { args, agent } = takeAgent(rest);
    if (args.length > 0) badArgs();
    const baseUrl = process.env["FLARE_ACTIONS_URL"];
    if (!baseUrl) {
      console.error(missingConfigMessage(["FLARE_ACTIONS_URL"], ENV_LOCATION, CLI));
      process.exit(2);
    }
    // Tokenless by design: onboarding happens before credentials exist.
    const status = await new FlareClient(baseUrl, "").getCloudStatus();
    const agentLine = agent ? `tag agent runs: cli run --agent ${agent} (per-agent caps + attribution)` : null;
    const steps = status.hosted
      ? [
          `open ${baseUrl} and finish signup in the dashboard`,
          "connect the GitHub App (dashboard Connect walks the manifest)",
          "fund the account: an admin mints a top-up link, or grant credits via the API",
          ...(agentLine ? [agentLine] : ["tag agent runs with --agent <tag> for per-agent caps + attribution"]),
        ]
      : [
          `open ${baseUrl} — first login claims admin`,
          "connect the GitHub App: dashboard Connect (or `cli connect --wire` with GITHUB_TOKEN)",
          "pair a runner: mint a code in dashboard Access, then run the pairing command on the machine",
          "verify without committing: `cli local`, then `cli run owner/repo HEAD`",
          ...(agentLine ? [agentLine] : []),
        ];
    if (JSON_MODE) {
      printJson("signup", { hosted: status.hosted, baseUrl, ...(agent ? { agent } : {}), steps });
    } else {
      console.log(status.hosted ? `Flare Cloud at ${baseUrl}` : `self-hosted Flare at ${baseUrl}`);
      for (const [i, s] of steps.entries()) console.log(`  ${i + 1}. ${s}`);
      next(`login --url ${baseUrl}`, "after step 1, pair this machine");
    }
  } else if (cmd === "github-jobs" && rest.includes("--logs")) {
    const args = rest.filter((a) => a !== "--logs");
    const jobId = args[0];
    const repo = args[1];
    if (!jobId) badValue("github-jobs --logs needs a job id (the first column of `github-jobs`).", "github-jobs --logs <jobId>");
    const jobs = await client().listGithubJobs(repo, 100);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) {
      console.error(`job ${jobId} not found in recent lane jobs${repo ? ` for ${repo}` : ""}`);
      console.error(nextLine(CLI, `github-jobs${repo ? ` ${repo}` : ""}`, "list recent job ids"));
      process.exit(1);
    }
    if (JSON_MODE) printJson("github-jobs", { job });
    else {
      console.log(job.logDigest ?? "(no digest yet — success conclusions and pending fetches have none)");
      next(`github-jobs${repo ? ` ${repo}` : ""}`, "the other jobs");
    }
  } else if (cmd === "github-jobs") {
    const jobs = await client().listGithubJobs(rest[0]);
    if (JSON_MODE) {
      printJson("github-jobs", {
        repo: rest[0] ?? null,
        jobs: jobs.map((j) => {
          const ms = j.startedAt && j.completedAt ? Date.parse(j.completedAt) - Date.parse(j.startedAt) : null;
          const ok = ms !== null && Number.isFinite(ms) && ms >= 0;
          return { ...j, durationMs: ok ? ms : null, listUsd: ok && ms !== null ? Math.round(((ms / 60000) * ACTIONS_LIST_USD_PER_MIN) * 10000) / 10000 : null };
        }),
      });
    } else {
      console.log("status\tconclusion\trepo\tjob\tduration\test. list");
      for (const j of jobs) {
        const ms = j.startedAt && j.completedAt ? Date.parse(j.completedAt) - Date.parse(j.startedAt) : null;
        const dur = ms === null || !Number.isFinite(ms) || ms < 0 ? "-" : `${(ms / 1000).toFixed(0)}s`;
        const usd = ms === null || !Number.isFinite(ms) || ms < 0 ? "-" : `~$${((ms / 60000) * ACTIONS_LIST_USD_PER_MIN).toFixed(4)}`;
        console.log(`${j.status}\t${j.conclusion ?? "-"}\t${j.repo}\t${j.jobName}\t${dur}\t${usd}`);
      }
      const failed = jobs.find((j) => j.conclusion && j.conclusion !== "success" && j.conclusion !== "skipped");
      if (jobs.length === 0) {
        console.log("(no runner-mode jobs)");
        nextPlain("set `runs-on: flare` in a workflow and turn on runner mode in dashboard Settings (docs/GITHUB-RUNNERS.md)");
      } else if (failed) next(`github-jobs --logs ${failed.id}${rest[0] ? ` ${rest[0]}` : ""}`, "why the newest failure failed");
      else next("usage", "minutes saved");
    }
  } else if (cmd === "artifacts" && rest[0]) {
    const artifacts = await client().listArtifacts(rest[0]);
    if (JSON_MODE) printJson("artifacts", { runId: rest[0], artifacts });
    else {
      for (const a of artifacts) {
        console.log(`${a.jobName}\t${a.name}\t${a.size}b\t${a.uploaded}`);
      }
      if (artifacts.length === 0) console.log("no artifacts for this run");
      next(`explain ${rest[0]}`, "the run's result");
    }
  } else if (cmd === "badge" && rest[0]) {
    const baseUrl = process.env["FLARE_ACTIONS_URL"];
    const qs = `repo=${encodeURIComponent(rest[0])}${rest[1] ? `&branch=${encodeURIComponent(rest[1])}` : ""}`;
    const svgUrl = `${baseUrl}/v1/badge.svg?${qs}`;
    if (JSON_MODE) {
      printJson("badge", { repo: rest[0], branch: rest[1] ?? null, svgUrl, markdown: `[![flare](${svgUrl})](${baseUrl}/dashboard)` });
    } else {
      console.log(svgUrl);
      console.log(`[![flare](${svgUrl})](${baseUrl}/dashboard)`);
      nextPlain("paste the markdown line into your README");
    }
  } else if (cmd === "import" && rest[0]) {
    const text = readFileSync(rest[0], "utf8");
    const res = convertActionsWorkflow(text);
    if (!isImportSuccess(res)) {
      console.error(`import failed: ${res.error}`);
      console.error(nextLine(CLI, "local", "run the workflows as they are instead"));
      process.exit(1);
    }
    if (JSON_MODE) {
      printJson("import", { file: rest[0], yaml: res.yaml, warnings: res.warnings });
    } else {
      for (const w of res.warnings) console.error(`warn: ${w}`);
      process.stdout.write(res.yaml);
      nextPlain(`save the output above as flare.yml, then ${CLI} local`);
    }
  } else if (cmd === "devbox") {
    // --remote before the subcommand (or before `--` for exec) runs the
    // same ops against a warm box on the seats worker. Only the args
    // before `--` are searched, so an inner command flag can never
    // flip the mode or lose an argument.
    const sepIdx = rest.indexOf("--");
    const remoteIdx = (sepIdx === -1 ? rest : rest.slice(0, sepIdx)).indexOf("--remote");
    const remote = remoteIdx !== -1;
    const devRest = remote ? [...rest.slice(0, remoteIdx), ...rest.slice(remoteIdx + 1)] : rest;
    const boxes = remote ? RemoteBoxManager.fromEnv() : new BoxManager();
    const [sub, ...dargs] = devRest;
    const takeFlag = (flag: string): string | undefined => {
      const i = dargs.indexOf(flag);
      if (i === -1) return undefined;
      const v = dargs[i + 1];
      if (!v) badValue(`${flag} needs a value.`, `devbox ${sub ?? "create"} <name> ${flag} <value>`);
      dargs.splice(i, 2);
      return v;
    };
    if (sub === "create" && dargs[0]) {
      const image = takeFlag("--image");
      const created = await boxes.create(dargs[0], { image });
      if (JSON_MODE) printJson("devbox", { action: "create", ...created });
      else {
        console.log(`created ${created.name} (${created.container}, ${created.image})`);
        next(`devbox sync ${created.name}${remote ? " --remote" : ""}`, "copy this folder in");
      }
    } else if (sub === "exec" && dargs[0]) {
      const sep = dargs.indexOf("--");
      const command = (sep === -1 ? dargs.slice(1) : dargs.slice(sep + 1)).filter((a) => a !== "--");
      if (command.length === 0) badValue("devbox exec needs a command after `--`.", `devbox exec ${dargs[0]} -- npm test`);
      const res = await boxes.exec(dargs[0], command);
      if (JSON_MODE) printJson("devbox", { action: "exec", box: dargs[0], command, ...res });
      else {
        if (res.stdout) process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`);
        if (res.stderr) process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`);
      }
      process.exitCode = res.exitCode;
    } else if (sub === "sync" && dargs[0]) {
      const dir = takeFlag("--dir") ?? process.cwd();
      const paths = dargs.slice(1);
      const res = await boxes.sync(dargs[0], dir, paths.length > 0 ? paths : ["."]);
      if (JSON_MODE) printJson("devbox", { action: "sync", box: dargs[0], dir, ...res });
      else {
        console.log(`synced ${res.bytes} bytes (${res.paths.join(", ")}) into ${dargs[0]}:/work`);
        next(`devbox exec ${dargs[0]}${remote ? " --remote" : ""} -- npm test`, "run something in it");
      }
    } else if (sub === "fetch" && dargs[0] && dargs[1]) {
      const res = await boxes.fetch(dargs[0], dargs[1], dargs[2] ?? process.cwd());
      if (JSON_MODE) printJson("devbox", { action: "fetch", box: dargs[0], dir: dargs[2] ?? process.cwd(), ...res });
      else {
        console.log(`fetched ${res.path} (${res.bytes} bytes) from ${dargs[0]} into ${dargs[2] ?? process.cwd()}`);
        next(`devbox snapshot ${dargs[0]}${remote ? " --remote" : ""}`, "save the box as it is now");
      }
    } else if (sub === "snapshot" && dargs[0]) {
      const snap = await boxes.snapshot(dargs[0], dargs[1]);
      if (JSON_MODE) printJson("devbox", { action: "snapshot", box: dargs[0], ...snap });
      else {
        console.log(`snapshot ${dargs[0]}:${snap.tag}`);
        next(`devbox restore ${dargs[0]} ${snap.tag}${remote ? " --remote" : ""}`, "go back to it later");
      }
    } else if (sub === "restore" && dargs[0] && dargs[1]) {
      const restored = await boxes.restore(dargs[0], dargs[1]);
      if (JSON_MODE) printJson("devbox", { action: "restore", box: dargs[0], tag: dargs[1], ...restored });
      else {
        console.log(`restored ${dargs[0]} from ${dargs[1]} (${restored.image})`);
        next(`devbox exec ${dargs[0]}${remote ? " --remote" : ""} -- npm test`);
      }
    } else if (sub === "list") {
      const list = await boxes.list();
      if (JSON_MODE) printJson("devbox", { action: "list", boxes: list });
      else {
        if (list.length === 0) console.log("no dev boxes");
        for (const b of list) {
          console.log(`${b.name}\t${b.image}\t${b.workdir}\tsnapshots:${b.snapshots.map((s) => s.tag).join(",") || "-"}\t${b.createdAt}`);
        }
        if (list[0]) next(`devbox exec ${list[0].name}${remote ? " --remote" : ""} -- <cmd>`);
        else next(`devbox create mybox${remote ? " --remote" : ""}`, "make your first one");
      }
    } else if (sub === "destroy" && dargs[0]) {
      const destroyed = await boxes.destroy(dargs[0]);
      if (JSON_MODE) printJson("devbox", { action: "destroy", ...destroyed });
      else {
        console.log(`destroyed ${destroyed.name}`);
        for (const img of destroyed.imagesKept) console.log(remote ? `  kept snapshot ${img}` : `  kept image ${img}`);
        next(`devbox list${remote ? " --remote" : ""}`);
      }
    } else {
      console.error("usage: cli devbox <create|exec|sync|fetch|snapshot|restore|list|destroy> ...");
      console.error(nextLine(CLI, "devbox list"));
      process.exit(2);
    }
  } else if (cmd === "forge") {
    const code = await runForge(rest, forgeCliDeps(JSON_MODE, ENV_LOCATION, CLI));
    if (code !== 0) process.exit(code);
  } else if (cmd === "mcp-serve") {
    const remote = rest.includes("--remote");
    await runDevboxMcpServer(remote ? RemoteBoxManager.fromEnv() : new BoxManager());
  } else if (cmd === "doctor" || cmd === "whoami") {
    const report = await runDoctor({
      env: process.env,
      envLocation: ENV_LOCATION,
      tokenFromAlias: TOKEN_FROM_ALIAS,
      cli: CLI,
      gitOrigin: () => {
        const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
        return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
      },
    });
    if (JSON_MODE) printJson("doctor", report);
    else console.log(formatDoctor(report));
    if (!report.ok) process.exit(1);
  } else if (cmd === "mcp-config") {
    const { baseUrl } = requireConfig();
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            "flare-actions": {
              url: `${baseUrl}/mcp`,
              headers: { Authorization: "Bearer <runner-or-readonly-token>" },
            },
          },
          note: "Easiest: paste just the URL into Claude/ChatGPT/Cursor and connect with your dashboard login (OAuth). Or set Authorization to a dashboard API token (readonly reads, runner also dispatches).",
        },
        null,
        2,
      ),
    );
    nextPlain(`paste this into your agent's MCP settings, or run \`${CLI} forge connect-agent --client claude\` for a ready command`);
  } else {
    // A known command whose required args are missing.
    badArgs();
  }
} catch (err) {
  // Missing URL/token inside forge: the message carries its own next line.
  if (err instanceof ForgeConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof FlareApiError && err.hint) {
    console.error(err.code ? `hint [${err.code}]: ${err.hint}` : `hint: ${err.hint}`);
  }
  console.error(nextAfterError(CLI, err instanceof FlareApiError ? err : null));
  process.exit(1);
}
