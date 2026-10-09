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
import { BoxManager } from "./devbox.ts";
import { runDevboxMcpServer } from "./mcp-serve.ts";
import { simulateDrain } from "../../worker/src/fairness.ts";
import { ACTIONS_LIST_USD_PER_MIN } from "../../worker/src/cost.ts";
import { hasJsonFlag, printJson, splitPassthrough, stripJsonFlag } from "./json.ts";
import { explainDigest } from "./explain.ts";
import { formatCacheStats, parseCacheStats } from "./cache.ts";

loadEnv();

const [cmd, ...rawRest] = process.argv.slice(2);
// --json anywhere before a `--` separator switches the command to its
// versioned envelope; args past `--` (devbox exec) pass through verbatim.
const { head, tail } = splitPassthrough(rawRest);
const JSON_MODE = hasJsonFlag(head);
const rest = [...stripJsonFlag(head), ...tail];

function usage(): never {
  console.log(
    [
      "usage:",
      "  cli runs [agent]                          list recent runs, optionally one agent's",
      "  cli logs <runId>                           show run jobs, steps, triage, logs",
      "  cli explain <runId>                        one narrative: verdict, failures, next command",
      "  cli local [job] [--file flare.yml]         run the pipeline in this directory (no server, warm cache)",
      "  cli local --parity [--file] [job]          report local-vs-cloud divergences (image, cache, env) without running",
      "  cli run <repo> <sha|branch|tag> [ref]      dispatch, wait, print the compact digest (exit 1 on failure)",
      "  run/dispatch accept --agent <tag>          tag the run for per-agent caps + attribution",
      "  run/dispatch accept --profile <name>      run one CI profile from flare.yml (else the event default, else all jobs)",
      "  cli run <repo> --source [ref]              upload the working tree and run it (no commit needed)",
      "  append --dry-run to run/dispatch           plan the fan-out (queued/blocked/budget) without creating a run",
      "  cli watch <runId>                          wait for a run and print the compact digest",
      "  cli cancel <runId>                         cancel queued/blocked jobs of a run",
      "  cli dispatch <repo> <sha|branch|tag> [ref]  trigger a run without waiting",
      "  cli rerun <runId> <jobId>                   reset a finished job to queued",
      "  cli flaky <repo> [days]                     per-job failure rates, worst first",
      "  cli bottlenecks <repo> [days]               slowest checks: p50/p95 run time + queue wait",
      "  cli quarantine list <repo>                  quarantined (flaky) tests for a repo",
      "  cli quarantine add <repo> <test>            move a test out of the blocking gate",
      "  cli quarantine remove <repo> <test>         reinstate a quarantined test",
      "  cli init [--force] [--stack <id>] [--template <id>]  scaffold flare.yml (auto-detected stack) + AGENTS.md snippet",
      "  cli connect [repo] [--init] [--wire] [--dry-run]  detect stack, scaffold, wire, verify in one command",
      "  cli tests <runId>                           per-test results and failing tests",
      "  cli selection <runId>                       smart test selection: what was skipped and why",
      "  cli attestation <receiptId>                 verify a reused-verdict receipt",
      "  cli mergequeue enqueue <repo> <pr> <sha>   queue a PR for verify-then-land (--base, --agent)",
      "  cli mergequeue status <repo>                queue entries + file-collision radar",
      "  cli mergequeue cancel <entryId>             cancel a queued/verifying entry",
      "  cli egress <runId>                          per-job egress (uploads/downloads by host)",
      "  cli queue [labels]                        live queue + projected claim order (admin)",
      "  cli cache list [prefix]                     list cache entries (admin)",
      "  cli cache purge [prefix]                    delete cache entries (admin)",
      "  cli cache stats                             shared warm-cache hit rate (7d)",
      "  cli usage [days] [repo]                     runs, jobs, compute-minutes for billing",
      "  cli paused                                  repos auto-paused for runaway spend (admin)",
      "  cli resume <repo>                           resume a paused repo (admin)",
      "  cli github-jobs [repo]                    ephemeral runner-mode jobs (status, duration, list price)",
      "  cli search <query...>                       search all job logs (branch:main level:error ...)",
      "  cli artifacts <runId>                       list a run's artifacts",
      "  cli badge <repo> [branch]                   print badge markdown + url",
      "  cli import <workflow.yml>                   convert a GitHub Actions workflow to flare.yml",
      "  cli mcp-config                              print MCP client config for this server",
      "  cli devbox create <name> [--image img]      create a persistent warm dev box (local docker)",
      "  cli devbox exec <name> -- <cmd...>           run a command in the box (/work)",
      "  cli devbox sync <name> [--dir D] [paths..]  tar local paths into the box workdir",
      "  cli devbox fetch <name> <path> [dir]        copy a workdir-relative path out of the box",
      "  cli devbox snapshot <name> [tag]            commit the box filesystem to a local image tag",
      "  cli devbox restore <name> <tag>             recreate the box from a snapshot tag",
      "  cli devbox list                             list dev boxes",
      "  cli devbox destroy <name>                   remove the box (snapshot images kept)",
      "  cli mcp-serve                               stdio MCP server for dev boxes (local agents)",
      "",
      "run/dispatch accept --priority N (0-10): higher jumps queued batch work.",
      "every command accepts --json: stdout becomes one versioned envelope",
      "  { version: 1, command, data } (mcp-config stays paste-ready, mcp-serve ignores it).",
      "cli local reads FLARE_SECRET_<NAME> for ${{ secrets.NAME }} placeholders.",
      "env: FLARE_ACTIONS_URL + RUNNER_TOKEN (from `npm run setup` or the dashboard).",
      "Reads accept readonly tokens; dispatch/rerun need runner scope.",
    ].join("\n"),
  );
  process.exit(2);
}

function client(): FlareClient {
  const baseUrl = process.env["FLARE_ACTIONS_URL"];
  const token = process.env["RUNNER_TOKEN"];
  if (!baseUrl || !token) {
    console.error("Run `npm run setup` first, or set FLARE_ACTIONS_URL and RUNNER_TOKEN");
    process.exit(1);
  }
  return new FlareClient(baseUrl, token);
}

// --priority N anywhere in the args; returns the remaining positionals.
function takePriority(args: string[]): { args: string[]; priority?: number } {
  const out = args.slice();
  const i = out.indexOf("--priority");
  if (i === -1) return { args: out };
  const value = Number(out[i + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    console.error("--priority must be an integer 0-10");
    process.exit(2);
  }
  out.splice(i, 2);
  return { args: out, priority: value };
}

function takeAgent(args: string[]): { args: string[]; agent?: string } {
  const out = args.slice();
  const i = out.indexOf("--agent");
  if (i === -1) return { args: out };
  const value = out[i + 1] ?? "";
  if (!/^[\w.-]{1,64}$/.test(value)) {
    console.error("--agent must be 1-64 chars: letters, digits, dot, dash, underscore");
    process.exit(2);
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
    console.error("--profile must be 1-64 chars: letters, digits, dot, dash, underscore");
    process.exit(2);
  }
  out.splice(i, 2);
  return { args: out, profile: value };
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
      console.error(`timed out waiting for ${runId} (15m) — check back with \`cli watch ${runId}\``);
      process.exit(2);
    }
    console.error(`still running (${Math.round((Date.now() - started) / 1000)}s)…`);
  }
  const digest = await c.getRunDigest(runId);
  if (!JSON_MODE) printDigest(digest);
  return digest;
}

try {
  if (cmd === "runs") {
    const runs = await client().listRuns(rest[0]);
    if (JSON_MODE) printJson("runs", { runs, agent: rest[0] ?? null });
    else for (const r of runs) console.log(`${r.status}\t${r.id}\t${r.repo}@${r.sha.slice(0, 7)}\t${r.event}${r.agent ? `\t@${r.agent}` : ""}`);
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
    }
  } else if (cmd === "explain" && rest[0]) {
    const digest = await client().getRunDigest(rest[0]);
    const out = explainDigest(digest);
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
      else console.log(formatParityReport(report));
    } else {
      const result = await runLocal({
        cwd: process.cwd(),
        file,
        job: positional[0],
        ...(JSON_MODE ? { quiet: true } : {}),
      });
      if (JSON_MODE) printJson("local", result);
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
    if (!repo || (!sourceMode && !positional[1])) usage();
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
      else console.log(formatPlan(plan));
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
    else console.log(JSON.stringify({ ok: true, cancelled }));
  } else if (cmd === "dispatch" && rest[0] && rest[1]) {
    const { args: noPriority, priority } = takePriority(rest);
    const { args: noAgent, agent } = takeAgent(noPriority);
    const { args, profile } = takeProfile(noAgent);
    const positional = args.filter((a) => a !== "--dry-run");
    if (!positional[0] || !positional[1]) usage();
    if (args.includes("--dry-run")) {
      const plan = await client().dryRunDispatch(positional[0], positional[1], {
        ...(positional[2] ? { ref: positional[2] } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      if (JSON_MODE) printJson("dispatch", plan);
      else console.log(formatPlan(plan));
    } else {
      const out = await client().dispatch(positional[0], positional[1], {
        ...(positional[2] ? { ref: positional[2] } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      if (JSON_MODE) printJson("dispatch", out);
      else console.log(JSON.stringify(out));
    }
  } else if (cmd === "rerun" && rest[0] && rest[1]) {
    await client().rerun(rest[0], rest[1]);
    if (JSON_MODE) printJson("rerun", { ok: true, runId: rest[0], jobId: rest[1] });
    else console.log(JSON.stringify({ ok: true }));
  } else if (cmd === "flaky" && rest[0]) {
    const days = rest[1] === undefined ? 30 : Number(rest[1]);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      console.error("days must be an integer 1-365");
      process.exit(2);
    }
    const stats = await client().getFlaky(rest[0], days);
    if (JSON_MODE) printJson("flaky", { repo: rest[0], days, stats });
    else {
      for (const s of stats) {
        console.log(`${(s.rate * 100).toFixed(1)}%\t${s.failures}/${s.runs}\t${s.job}`);
      }
    }
  } else if (cmd === "bottlenecks" && rest[0]) {
    const days = rest[1] === undefined ? 14 : Number(rest[1]);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      console.error("days must be an integer 1-90");
      process.exit(2);
    }
    const checks = await client().getBottlenecks(rest[0], days);
    if (JSON_MODE) printJson("bottlenecks", { repo: rest[0], days, checks });
    else {
      console.log("check\tp50\tp95\tqueue p50\tjobs\tfailed");
      for (const c of checks) {
        const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
        console.log(`${c.check}\t${secs(c.p50Ms)}\t${secs(c.p95Ms)}\t${secs(c.queueP50Ms)}\t${c.jobs}\t${c.failures}`);
      }
      if (checks.length === 0) console.log("(no finished jobs in the window)");
    }
  } else if (cmd === "quarantine" && rest[0]) {
    const sub = rest[0];
    if (sub === "list" && rest[1]) {
      const tests = await client().getQuarantine(rest[1]);
      if (JSON_MODE) printJson("quarantine", { action: "list", repo: rest[1], tests });
      else {
        if (tests.length === 0) console.log("no quarantined tests");
        for (const t of tests) console.log(`${t.status}\t${t.name}\t${t.reason}`);
      }
    } else if (sub === "add" && rest[1] && rest[2]) {
      const name = rest.slice(2).join(" ");
      await client().setQuarantine(rest[1], name, "add");
      if (JSON_MODE) printJson("quarantine", { action: "add", repo: rest[1], name, ok: true });
      else console.log(`quarantined: ${name}`);
    } else if (sub === "remove" && rest[1] && rest[2]) {
      const name = rest.slice(2).join(" ");
      await client().setQuarantine(rest[1], name, "remove");
      if (JSON_MODE) printJson("quarantine", { action: "remove", repo: rest[1], name, ok: true });
      else console.log(`reinstated: ${name}`);
    } else {
      console.error("usage: cli quarantine <list <repo> | add <repo> <test> | remove <repo> <test>>");
      process.exit(2);
    }
  } else if (cmd === "init") {
    const stackAt = rest.indexOf("--stack");
    const stack = stackAt === -1 ? undefined : rest[stackAt + 1];
    if (stackAt !== -1 && !stack) {
      console.error("--stack needs a stack id (node, python, go, rust, ruby, java, php, dotnet, elixir, generic)");
      process.exit(2);
    }
    const result = runInit({
      cwd: process.cwd(),
      force: rest.includes("--force"),
      ...(stack ? { stack } : {}),
    });
    if (result.error) {
      console.error(result.error);
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
          : `${result.starterStack} starter`;
      console.log(`wrote ${result.pipelinePath} (${origin})`);
      for (const warning of result.warnings.slice(0, 20)) console.log(`  warning: ${warning}`);
      if (result.warnings.length > 20) console.log(`  … ${result.warnings.length - 20} more warnings`);
      console.log(`updated ${result.agentsPath} (idempotent snippet; agents learn the verify loop)`);
      console.log("");
      console.log("next steps:");
      console.log("  1. npx flare local                 # verify in this working tree, no server");
      console.log("  2. npx flare mcp-config            # teach your agent the MCP verify loop");
      console.log("  3. deploy: https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/flare-actions");
      console.log("  docs: docs/GITHUB-ACTIONS-COMPAT.md · docs/PIPELINES.md · skills/flare-verify");
    }
  } else if (cmd === "connect") {
    const baseUrl = process.env["FLARE_ACTIONS_URL"];
    if (!baseUrl) {
      console.error("Set FLARE_ACTIONS_URL to your deployment first (from `npm run setup` or the dashboard)");
      process.exit(2);
    }
    const token = process.env["RUNNER_TOKEN"];
    const positional = rest.filter((a) => !a.startsWith("--"));
    if (positional.length > 1) usage();
    const dryRun = rest.includes("--dry-run");
    const lines: string[] = [];
    const out = await runConnect({
      cwd: process.cwd(),
      baseUrl,
      ...(positional[0] ? { repo: positional[0] } : {}),
      wire: rest.includes("--wire"),
      init: rest.includes("--init"),
      dryRun,
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
    }
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
    }
  } else if (cmd === "selection" && rest[0]) {
    const s = await client().getRunSelection(rest[0]);
    if (JSON_MODE) {
      printJson("selection", s);
    } else if (s.jobs.length === 0) {
      console.log("no test selection ran for this run (jobs did not opt in)");
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
    }
  } else if (cmd === "mergequeue" && rest[0]) {
    const sub = rest[0];
    if (sub === "enqueue" && rest[1] && rest[2] && rest[3]) {
      const pr = Number(rest[2]);
      if (!Number.isInteger(pr) || pr < 1) {
        console.error("pr must be a pull request number");
        process.exit(2);
      }
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
      else console.log(`enqueued ${rest[1]}#${pr} as ${out.id}`);
    } else if (sub === "status" && rest[1]) {
      const q = await client().getMergeQueue(rest[1]);
      if (JSON_MODE) {
        printJson("mergequeue", { action: "status", ...q });
      } else if (q.entries.length === 0) {
        console.log(`merge queue for ${rest[1]} is empty`);
      } else {
        for (const e of q.entries) {
          console.log(`${e.status}\t#${e.pr}\t${e.headSha.slice(0, 7)}${e.agent ? `\t@${e.agent}` : ""}\t${e.note || "-"}\t${e.id.slice(0, 8)}`);
        }
        for (const c of q.collisions) {
          console.log(`collision: #${c.prs[0]} x #${c.prs[1]}: ${c.paths.join(", ")}`);
        }
      }
    } else if (sub === "cancel" && rest[1]) {
      const out = await client().cancelMerge(rest[1]);
      if (JSON_MODE) printJson("mergequeue", { action: "cancel", entryId: rest[1], ...out });
      else console.log(out.cancelled ? `cancelled ${rest[1]}` : `${rest[1]} was already terminal`);
    } else {
      console.error("usage: cli mergequeue <enqueue <repo> <pr> <sha> [--base b] [--agent a] | status <repo> | cancel <entryId>>");
      process.exit(2);
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
    }
  } else if (cmd === "cache" && rest[0] === "list") {
    const entries = await client().listCache(rest[1] ?? "");
    if (JSON_MODE) printJson("cache", { action: "list", prefix: rest[1] ?? "", entries });
    else {
      for (const e of entries) {
        console.log(`${e.key}\t${e.size}b\t${e.uploaded}`);
      }
    }
  } else if (cmd === "search") {
    const query = rest.join(" ").trim();
    if (!query) usage();
    const hits = await client().searchLogs(query);
    if (JSON_MODE) {
      printJson("search", { query, hits });
    } else {
      for (const h of hits) {
        console.log(`${h.created_at} ${h.repo}@${h.branch || "-"} [${h.level}] (${h.run_id.slice(0, 8)}/${h.job_id.slice(0, 8)})`);
        console.log(`  ${h.line}`);
      }
      if (hits.length === 0) console.log("No matching log lines.");
    }
  } else if (cmd === "cache" && rest[0] === "purge") {
    const out = await client().purgeCache(rest[1] ?? "");
    if (JSON_MODE) printJson("cache", { action: "purge", prefix: rest[1] ?? "", ...out });
    else console.log(JSON.stringify(out));
  } else if (cmd === "cache" && rest[0] === "stats") {
    const stats = parseCacheStats(await client().getCacheStats());
    if (!stats) {
      console.error("unexpected cache stats response");
      process.exit(2);
    }
    if (JSON_MODE) printJson("cache", { action: "stats", ...stats });
    else console.log(formatCacheStats(stats));
  } else if (cmd === "paused") {
    const paused = await client().listPaused();
    if (JSON_MODE) printJson("paused", { paused });
    else if (paused.length === 0) console.log("no paused repos");
    else {
      for (const p of paused) {
        const actors = p.topActors.map((a) => `${a.actor} (${a.dispatches})`).join(", ");
        console.log(`${p.repo} paused ${p.pausedAt} — ${p.usedMinutes}/${p.cap ?? "?"} compute-min${actors ? ` — top: ${actors}` : ""}`);
      }
    }
  } else if (cmd === "resume" && rest[0]) {
    const resumed = await client().resumeRepo(rest[0]);
    if (JSON_MODE) printJson("resume", { repo: rest[0], resumed });
    else console.log(resumed ? `${rest[0]} resumed` : `${rest[0]} was not paused`);
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
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      console.error("days must be an integer 1-365");
      process.exit(2);
    }
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
        console.log(`  Cloudflare billable (${billable.from}..${billable.to}): $${billable.totalCost} ${billable.currency ?? "USD"}${fams ? ` (${fams})` : ""}`);
      }
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
      if (jobs.length === 0) console.log("(no runner-mode jobs)");
    }
  } else if (cmd === "artifacts" && rest[0]) {
    const artifacts = await client().listArtifacts(rest[0]);
    if (JSON_MODE) printJson("artifacts", { runId: rest[0], artifacts });
    else {
      for (const a of artifacts) {
        console.log(`${a.jobName}\t${a.name}\t${a.size}b\t${a.uploaded}`);
      }
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
    }
  } else if (cmd === "import" && rest[0]) {
    const text = readFileSync(rest[0], "utf8");
    const res = convertActionsWorkflow(text);
    if (!isImportSuccess(res)) {
      console.error(`import failed: ${res.error}`);
      process.exit(1);
    }
    if (JSON_MODE) {
      printJson("import", { file: rest[0], yaml: res.yaml, warnings: res.warnings });
    } else {
      for (const w of res.warnings) console.error(`warn: ${w}`);
      process.stdout.write(res.yaml);
    }
  } else if (cmd === "devbox") {
    const boxes = new BoxManager();
    const [sub, ...dargs] = rest;
    const takeFlag = (flag: string): string | undefined => {
      const i = dargs.indexOf(flag);
      if (i === -1) return undefined;
      const v = dargs[i + 1];
      if (!v) {
        console.error(`${flag} needs a value`);
        process.exit(2);
      }
      dargs.splice(i, 2);
      return v;
    };
    if (sub === "create" && dargs[0]) {
      const image = takeFlag("--image");
      const created = await boxes.create(dargs[0], { image });
      if (JSON_MODE) printJson("devbox", { action: "create", ...created });
      else console.log(`created ${created.name} (${created.container}, ${created.image})`);
    } else if (sub === "exec" && dargs[0]) {
      const sep = dargs.indexOf("--");
      const command = (sep === -1 ? dargs.slice(1) : dargs.slice(sep + 1)).filter((a) => a !== "--");
      if (command.length === 0) {
        console.error("usage: cli devbox exec <name> -- <cmd...>");
        process.exit(2);
      }
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
      else console.log(`synced ${res.bytes} bytes (${res.paths.join(", ")}) into ${dargs[0]}:/work`);
    } else if (sub === "fetch" && dargs[0] && dargs[1]) {
      const res = await boxes.fetch(dargs[0], dargs[1], dargs[2] ?? process.cwd());
      if (JSON_MODE) printJson("devbox", { action: "fetch", box: dargs[0], dir: dargs[2] ?? process.cwd(), ...res });
      else console.log(`fetched ${res.path} (${res.bytes} bytes) from ${dargs[0]} into ${dargs[2] ?? process.cwd()}`);
    } else if (sub === "snapshot" && dargs[0]) {
      const snap = await boxes.snapshot(dargs[0], dargs[1]);
      if (JSON_MODE) printJson("devbox", { action: "snapshot", box: dargs[0], ...snap });
      else console.log(`snapshot ${dargs[0]}:${snap.tag}`);
    } else if (sub === "restore" && dargs[0] && dargs[1]) {
      const restored = await boxes.restore(dargs[0], dargs[1]);
      if (JSON_MODE) printJson("devbox", { action: "restore", box: dargs[0], tag: dargs[1], ...restored });
      else console.log(`restored ${dargs[0]} from ${dargs[1]} (${restored.image})`);
    } else if (sub === "list") {
      const list = boxes.list();
      if (JSON_MODE) printJson("devbox", { action: "list", boxes: list });
      else {
        if (list.length === 0) console.log("no dev boxes");
        for (const b of list) {
          console.log(`${b.name}\t${b.image}\t${b.workdir}\tsnapshots:${b.snapshots.map((s) => s.tag).join(",") || "-"}\t${b.createdAt}`);
        }
      }
    } else if (sub === "destroy" && dargs[0]) {
      const destroyed = await boxes.destroy(dargs[0]);
      if (JSON_MODE) printJson("devbox", { action: "destroy", ...destroyed });
      else {
        console.log(`destroyed ${destroyed.name}`);
        for (const img of destroyed.imagesKept) console.log(`  kept image ${img}`);
      }
    } else {
      console.error("usage: cli devbox <create|exec|sync|fetch|snapshot|restore|list|destroy> ...");
      process.exit(2);
    }
  } else if (cmd === "mcp-serve") {
    await runDevboxMcpServer(new BoxManager());
  } else if (cmd === "mcp-config") {
    const baseUrl = process.env["FLARE_ACTIONS_URL"];
    const token = process.env["RUNNER_TOKEN"];
    if (!baseUrl || !token) {
      console.error("Run `npm run setup` first, or set FLARE_ACTIONS_URL and RUNNER_TOKEN");
      process.exit(1);
    }
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
  } else {
    usage();
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof FlareApiError && err.hint) {
    console.error(err.code ? `hint [${err.code}]: ${err.hint}` : `hint: ${err.hint}`);
  }
  process.exit(1);
}
