import { FlareClient } from "@flare-actions/runner-sdk";

const baseUrl = process.env["FLARE_ACTIONS_URL"];
const token = process.env["RUNNER_TOKEN"];
if (!baseUrl || !token) {
  console.error("Set FLARE_ACTIONS_URL and RUNNER_TOKEN");
  process.exit(1);
}

const client = new FlareClient(baseUrl, token);

async function pollOnce(): Promise<boolean> {
  const job = await client.nextJob();
  if (!job) return false;
  console.log(JSON.stringify({ msg: "picked up job", jobId: job.id, repo: job.repo, sha: job.sha }));
  const started = Date.now();
  try {
    // MVP executor: safe echo step. Bring your own executor next.
    const log = [`repo: ${job.repo}`, `sha: ${job.sha}`, `step: echo hello`, `hello from flare-actions`].join("\n");
    await client.reportStatus(job.run_id, job.id, "success", log);
    console.log(JSON.stringify({ msg: "job done", jobId: job.id, ms: Date.now() - started }));
  } catch (err) {
    await client.reportStatus(job.run_id, job.id, "failure", String(err)).catch(() => undefined);
    console.error(JSON.stringify({ msg: "job failed", jobId: job.id, error: String(err) }));
  }
  return true;
}

async function main(): Promise<void> {
  for (;;) {
    try {
      const worked = await pollOnce();
      await new Promise((r) => setTimeout(r, worked ? 1000 : 5000));
    } catch (err) {
      console.error(JSON.stringify({ msg: "poll error", error: String(err) }));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

await main();
