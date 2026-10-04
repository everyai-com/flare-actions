import { readFileSync } from "node:fs";
import {
  convertActionsWorkflow,
  FlareClient,
  isImportSuccess,
  loadEnv,
  type FlareRunDigest,
} from "@flare-actions/runner-sdk";
import { runLocal } from "./local.ts";
import { dispatchSource } from "./source.ts";

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
      "  cli artifacts <runId>                       list a run's artifacts",
      "  cli badge <repo> [branch]                   print badge markdown + url",
      "  cli import <workflow.yml>                   convert a GitHub Actions workflow to flare.yml",
      "  cli mcp-config                              print MCP client config for this server",
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
          note: "Replace <runner-or-readonly-token> with a dashboard token (readonly reads, runner also dispatches).",
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
