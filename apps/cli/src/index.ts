import { FlareClient } from "@flare-actions/runner-sdk";

const baseUrl = process.env["FLARE_ACTIONS_URL"];
const token = process.env["RUNNER_TOKEN"];
if (!baseUrl || !token) {
  console.error("Set FLARE_ACTIONS_URL and RUNNER_TOKEN");
  process.exit(1);
}

const client = new FlareClient(baseUrl, token);
const [cmd, arg] = process.argv.slice(2);

if (cmd === "runs") {
  const runs = await client.listRuns();
  for (const r of runs) console.log(`${r.status}\t${r.id}\t${r.repo}@${r.sha.slice(0, 7)}\t${r.event}`);
} else if (cmd === "logs" && arg) {
  const { run, jobs } = await client.getRun(arg);
  console.log(`run ${run.id} ${run.status} ${run.repo}@${run.sha}`);
  for (const j of jobs) console.log(`--- job ${j.id} ${j.status} ---\n${j.log}`);
} else {
  console.log("usage: cli runs | logs <runId>");
  process.exit(2);
}
