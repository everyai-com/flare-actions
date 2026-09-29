import { readFileSync } from "node:fs";
import { convertActionsWorkflow, FlareClient, isImportSuccess, loadEnv } from "@flare-actions/runner-sdk";

loadEnv();

const [cmd, ...rest] = process.argv.slice(2);

function usage(): never {
  console.log(
    [
      "usage:",
      "  cli runs                                  list recent runs",
      "  cli logs <runId>                           show run jobs, steps, triage, logs",
      "  cli dispatch <repo> <sha> [ref]            trigger a run (ref optional branch label)",
      "  cli rerun <runId> <jobId>                   reset a finished job to queued",
      "  cli flaky <repo> [days]                     per-job failure rates, worst first",
      "  cli artifacts <runId>                       list a run's artifacts",
      "  cli badge <repo> [branch]                   print badge markdown + url",
      "  cli import <workflow.yml>                   convert a GitHub Actions workflow to flare.yml",
      "  cli mcp-config                              print MCP client config for this server",
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
} else if (cmd === "dispatch" && rest[0] && rest[1]) {
  const out = await client().dispatch(rest[0], rest[1], rest[2] ? { ref: rest[2] } : undefined);
  console.log(JSON.stringify(out));
} else if (cmd === "rerun" && rest[0] && rest[1]) {
  await client().rerun(rest[0], rest[1]);
  console.log(JSON.stringify({ ok: true }));
} else if (cmd === "flaky" && rest[0]) {
  const stats = await client().getFlaky(rest[0], rest[1] ? Number(rest[1]) : 30);
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
  console.log(`[![flare](<url>)]( ${baseUrl}/dashboard )`.replace("<url>", `${baseUrl}/v1/badge.svg?${qs}`));
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
