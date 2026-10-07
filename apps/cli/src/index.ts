import { readFileSync } from "node:fs";
import {
  convertActionsWorkflow,
  FlareClient,
  isImportSuccess,
  loadEnv,
  type FlareRunDigest,
} from "flare-actions-runner-sdk";
import { runLocal } from "./local.ts";
import { dispatchSource } from "./source.ts";
import { runInit } from "./init.ts";
import { BoxManager } from "./devbox.ts";
import { runDevboxMcpServer } from "./mcp-serve.ts";
import { simulateDrain } from "../../worker/src/fairness.ts";

loadEnv();

const [cmd, ...rest] = process.argv.slice(2);

function usage(): never {
  console.log(
    [
      "usage:",
      "  cli runs                                  list recent runs",
      "  cli logs <runId>                           show run jobs, steps, triage, logs",
      "  cli local [job] [--file flare.yml]         run the pipeline in this directory (no server, warm cache)",
      "  cli run <repo> <sha|branch|tag> [ref]      dispatch, wait, print the compact digest (exit 1 on failure)",
      "  cli run <repo> --source [ref]              upload the working tree and run it (no commit needed)",
      "  cli watch <runId>                          wait for a run and print the compact digest",
      "  cli cancel <runId>                         cancel queued/blocked jobs of a run",
      "  cli dispatch <repo> <sha|branch|tag> [ref]  trigger a run without waiting",
      "  cli rerun <runId> <jobId>                   reset a finished job to queued",
      "  cli flaky <repo> [days]                     per-job failure rates, worst first",
      "  cli bottlenecks <repo> [days]               slowest checks: p50/p95 run time + queue wait",
      "  cli quarantine list <repo>                  quarantined (flaky) tests for a repo",
      "  cli quarantine add <repo> <test>            move a test out of the blocking gate",
      "  cli quarantine remove <repo> <test>         reinstate a quarantined test",
      "  cli init [--force]                          scaffold flare.yml + AGENTS.md snippet + next steps",
      "  cli tests <runId>                           per-test results and failing tests",
      "  cli egress <runId>                          per-job egress (uploads/downloads by host)",
      "  cli queue [labels]                        live queue + projected claim order (admin)",
      "  cli cache list [prefix]                     list cache entries (admin)",
      "  cli cache purge [prefix]                    delete cache entries (admin)",
      "  cli usage [days] [repo]                     runs, jobs, compute-minutes for billing",
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
  printDigest(digest);
  return digest;
}

try {
  if (cmd === "runs") {
    const runs = await client().listRuns();
    for (const r of runs) console.log(`${r.status}\t${r.id}\t${r.repo}@${r.sha.slice(0, 7)}\t${r.event}`);
  } else if (cmd === "logs" && rest[0]) {
    const { run, jobs } = await client().getRun(rest[0]);
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
  } else if (cmd === "local") {
    let file: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--file") {
        file = rest[++i];
      } else {
        positional.push(rest[i]);
      }
    }
    const result = await runLocal({ cwd: process.cwd(), file, job: positional[0] });
    process.exitCode = result.ok ? 0 : 1;
  } else if (cmd === "run" && rest[0]) {
    const { args, priority } = takePriority(rest);
    const sourceMode = args.includes("--source");
    const positional = args.filter((a) => a !== "--source");
    const repo = positional[0];
    if (!repo || (!sourceMode && !positional[1])) usage();
    if (sourceMode) {
      const out = await dispatchSource(client(), {
        repo,
        ref: positional[1],
        cwd: process.cwd(),
        ...(priority !== undefined ? { priority } : {}),
      });
      console.error(`source run ${out.runId} dispatched (upload ${out.sourceId.slice(0, 8)}…) — waiting for the digest…`);
      const digest = await waitAndDigest(client(), out.runId);
      process.exitCode = digest.status === "success" ? 0 : 1;
    } else {
      const out = await client().dispatch(repo, positional[1] as string, {
        ...(positional[2] ? { ref: positional[2] } : {}),
        ...(priority !== undefined ? { priority } : {}),
      });
      console.error(`run ${out.runId} dispatched — waiting for the digest…`);
      const digest = await waitAndDigest(client(), out.runId);
      process.exitCode = digest.status === "success" ? 0 : 1;
    }
  } else if (cmd === "watch" && rest[0]) {
    const digest = await waitAndDigest(client(), rest[0]);
    process.exitCode = digest.status === "success" ? 0 : 1;
  } else if (cmd === "cancel" && rest[0]) {
    const cancelled = await client().cancelRun(rest[0]);
    console.log(JSON.stringify({ ok: true, cancelled }));
  } else if (cmd === "dispatch" && rest[0] && rest[1]) {
    const { args, priority } = takePriority(rest);
    if (!args[0] || !args[1]) usage();
    const out = await client().dispatch(args[0], args[1], {
      ...(args[2] ? { ref: args[2] } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
    console.log(JSON.stringify(out));
  } else if (cmd === "rerun" && rest[0] && rest[1]) {
    await client().rerun(rest[0], rest[1]);
    console.log(JSON.stringify({ ok: true }));
  } else if (cmd === "flaky" && rest[0]) {
    const days = rest[1] === undefined ? 30 : Number(rest[1]);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      console.error("days must be an integer 1-365");
      process.exit(2);
    }
    const stats = await client().getFlaky(rest[0], days);
    for (const s of stats) {
      console.log(`${(s.rate * 100).toFixed(1)}%\t${s.failures}/${s.runs}\t${s.job}`);
    }
  } else if (cmd === "bottlenecks" && rest[0]) {
    const days = rest[1] === undefined ? 14 : Number(rest[1]);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      console.error("days must be an integer 1-90");
      process.exit(2);
    }
    const checks = await client().getBottlenecks(rest[0], days);
    console.log("check\tp50\tp95\tqueue p50\tjobs\tfailed");
    for (const c of checks) {
      const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
      console.log(`${c.check}\t${secs(c.p50Ms)}\t${secs(c.p95Ms)}\t${secs(c.queueP50Ms)}\t${c.jobs}\t${c.failures}`);
    }
    if (checks.length === 0) console.log("(no finished jobs in the window)");
  } else if (cmd === "quarantine" && rest[0]) {
    const sub = rest[0];
    if (sub === "list" && rest[1]) {
      const tests = await client().getQuarantine(rest[1]);
      if (tests.length === 0) console.log("no quarantined tests");
      for (const t of tests) console.log(`${t.status}\t${t.name}\t${t.reason}`);
    } else if (sub === "add" && rest[1] && rest[2]) {
      const name = rest.slice(2).join(" ");
      await client().setQuarantine(rest[1], name, "add");
      console.log(`quarantined: ${name}`);
    } else if (sub === "remove" && rest[1] && rest[2]) {
      const name = rest.slice(2).join(" ");
      await client().setQuarantine(rest[1], name, "remove");
      console.log(`reinstated: ${name}`);
    } else {
      console.error("usage: cli quarantine <list <repo> | add <repo> <test> | remove <repo> <test>>");
      process.exit(2);
    }
  } else if (cmd === "init") {
    const result = runInit({ cwd: process.cwd(), force: rest.includes("--force") });
    if (result.error) {
      console.error(result.error);
      process.exit(2);
    }
    console.log(`wrote ${result.pipelinePath} (${result.pipelineSource === "converted" ? `from .github/workflows/${result.convertedFrom}` : "starter template"})`);
    for (const warning of result.warnings.slice(0, 20)) console.log(`  warning: ${warning}`);
    if (result.warnings.length > 20) console.log(`  … ${result.warnings.length - 20} more warnings`);
    console.log(`updated ${result.agentsPath} (idempotent snippet; agents learn the verify loop)`);
    console.log("");
    console.log("next steps:");
    console.log("  1. npx flare local                 # verify in this working tree, no server");
    console.log("  2. npx flare mcp-config            # teach your agent the MCP verify loop");
    console.log("  3. deploy: https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/flare-actions");
    console.log("  docs: docs/GITHUB-ACTIONS-COMPAT.md · docs/PIPELINES.md · skills/flare-verify");
  } else if (cmd === "tests" && rest[0]) {
    const t = await client().getRunTests(rest[0]);
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
  } else if (cmd === "egress" && rest[0]) {
    const e = await client().getRunEgress(rest[0]);
    console.log(`up ${e.totals.reqBytes}b / down ${e.totals.respBytes}b`);
    for (const j of e.jobs) {
      console.log(`  ${j.jobId} ${j.host}: up ${j.reqBytes}b / down ${j.respBytes}b`);
    }
  } else if (cmd === "queue") {
    const q = await client().listQueue();
    const labels = (rest[0] ?? "").split(",").map((l) => l.trim()).filter(Boolean);
    console.log(`${q.jobs.length} queued (fair-share cap: ${q.fairSharePerRepo === 0 ? "off" : `${q.fairSharePerRepo}/repo`})`);
    for (const j of q.jobs) {
      console.log(`  p${j.priority} ${j.repo} ${j.name} [${j.labels || "any"}] ${j.id}`);
    }
    const claims = simulateDrain(
      q.jobs.map((j) => ({ id: j.id, repo: j.repo, priority: j.priority, priorMs: j.priorMs ?? 0, createdAt: j.createdAt, labels: j.labels })),
      [{ id: "you", labels }],
      q.fairSharePerRepo,
    );
    console.log(`projected order for [${labels.join(",") || "unlabeled-only"}]:`);
    for (const c of claims) {
      console.log(`  ${c.jobId} (${c.repo})`);
    }
  } else if (cmd === "cache" && rest[0] === "list") {
    const entries = await client().listCache(rest[1] ?? "");
    for (const e of entries) {
      console.log(`${e.key}\t${e.size}b\t${e.uploaded}`);
    }
  } else if (cmd === "search") {
    const query = rest.join(" ").trim();
    if (!query) usage();
    const hits = await client().searchLogs(query);
    for (const h of hits) {
      console.log(`${h.created_at} ${h.repo}@${h.branch || "-"} [${h.level}] (${h.run_id.slice(0, 8)}/${h.job_id.slice(0, 8)})`);
      console.log(`  ${h.line}`);
    }
    if (hits.length === 0) console.log("No matching log lines.");
  } else if (cmd === "cache" && rest[0] === "purge") {
    const out = await client().purgeCache(rest[1] ?? "");
    console.log(JSON.stringify(out));
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
    console.log(
      `${u.days}d: ${u.runs} runs, ${u.jobs} finished jobs, ${u.computeMinutes} compute-min (~$${u.actionsListUsd} at Actions list price)`,
    );
    for (const [status, n] of Object.entries(u.runsByStatus)) console.log(`  ${status}: ${n}`);
    for (const r of u.topRepos) console.log(`  ${r.repo}: ${r.jobs} jobs, ${r.computeMinutes} compute-min`);
    // Real Cloudflare dollars when the caller is admin and billing is
    // configured; readonly tokens and outages print nothing extra.
    if (!repo) {
      const billable = await c.getBillableUsage(days).catch(() => null);
      if (billable?.configured && typeof billable.totalCost === "number") {
        const fams = (billable.families ?? []).slice(0, 5).map((f) => `${f.family} $${f.cost}`).join(", ");
        console.log(`  Cloudflare billable (${billable.from}..${billable.to}): $${billable.totalCost} ${billable.currency ?? "USD"}${fams ? ` (${fams})` : ""}`);
      }
    }
  } else if (cmd === "artifacts" && rest[0]) {
    const artifacts = await client().listArtifacts(rest[0]);
    for (const a of artifacts) {
      console.log(`${a.jobName}\t${a.name}\t${a.size}b\t${a.uploaded}`);
    }
  } else if (cmd === "badge" && rest[0]) {
    const baseUrl = process.env["FLARE_ACTIONS_URL"];
    const qs = `repo=${encodeURIComponent(rest[0])}${rest[1] ? `&branch=${encodeURIComponent(rest[1])}` : ""}`;
    console.log(`${baseUrl}/v1/badge.svg?${qs}`);
    console.log(`[![flare](${baseUrl}/v1/badge.svg?${qs})](${baseUrl}/dashboard)`);
  } else if (cmd === "import" && rest[0]) {
    const text = readFileSync(rest[0], "utf8");
    const res = convertActionsWorkflow(text);
    if (!isImportSuccess(res)) {
      console.error(`import failed: ${res.error}`);
      process.exit(1);
    }
    for (const w of res.warnings) console.error(`warn: ${w}`);
    process.stdout.write(res.yaml);
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
      console.log(`created ${created.name} (${created.container}, ${created.image})`);
    } else if (sub === "exec" && dargs[0]) {
      const sep = dargs.indexOf("--");
      const command = (sep === -1 ? dargs.slice(1) : dargs.slice(sep + 1)).filter((a) => a !== "--");
      if (command.length === 0) {
        console.error("usage: cli devbox exec <name> -- <cmd...>");
        process.exit(2);
      }
      const res = await boxes.exec(dargs[0], command);
      if (res.stdout) process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`);
      if (res.stderr) process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`);
      process.exitCode = res.exitCode;
    } else if (sub === "sync" && dargs[0]) {
      const dir = takeFlag("--dir") ?? process.cwd();
      const paths = dargs.slice(1);
      const res = await boxes.sync(dargs[0], dir, paths.length > 0 ? paths : ["."]);
      console.log(`synced ${res.bytes} bytes (${res.paths.join(", ")}) into ${dargs[0]}:/work`);
    } else if (sub === "fetch" && dargs[0] && dargs[1]) {
      const res = await boxes.fetch(dargs[0], dargs[1], dargs[2] ?? process.cwd());
      console.log(`fetched ${res.path} (${res.bytes} bytes) from ${dargs[0]} into ${dargs[2] ?? process.cwd()}`);
    } else if (sub === "snapshot" && dargs[0]) {
      const snap = await boxes.snapshot(dargs[0], dargs[1]);
      console.log(`snapshot ${dargs[0]}:${snap.tag}`);
    } else if (sub === "restore" && dargs[0] && dargs[1]) {
      const restored = await boxes.restore(dargs[0], dargs[1]);
      console.log(`restored ${dargs[0]} from ${dargs[1]} (${restored.image})`);
    } else if (sub === "list") {
      const list = boxes.list();
      if (list.length === 0) console.log("no dev boxes");
      for (const b of list) {
        console.log(`${b.name}\t${b.image}\t${b.workdir}\tsnapshots:${b.snapshots.map((s) => s.tag).join(",") || "-"}\t${b.createdAt}`);
      }
    } else if (sub === "destroy" && dargs[0]) {
      const destroyed = await boxes.destroy(dargs[0]);
      console.log(`destroyed ${destroyed.name}`);
      for (const img of destroyed.imagesKept) console.log(`  kept image ${img}`);
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
  process.exit(1);
}
