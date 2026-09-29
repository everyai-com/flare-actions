import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRepo, executeSteps, FlareClient, loadEnv, parseDefinition } from "@flare-actions/runner-sdk";

loadEnv();
const baseUrl = process.env["FLARE_ACTIONS_URL"];
const token = process.env["RUNNER_TOKEN"];
if (!baseUrl || !token) {
  console.error("Run `npm run setup` first, or set FLARE_ACTIONS_URL and RUNNER_TOKEN");
  process.exit(1);
}

const client = new FlareClient(baseUrl, token);

async function pollOnce(): Promise<boolean> {
  const job = await client.nextJob();
  if (!job) return false;
  console.log(JSON.stringify({ msg: "picked up job", jobId: job.id, name: job.name, repo: job.repo, sha: job.sha }));
  const started = Date.now();
  const workdir = mkdtempSync(join(tmpdir(), "flare-job-"));
  try {
    const srcdir = join(workdir, "src");
    await checkoutRepo({
      repo: job.repo,
      sha: job.sha,
      dir: srcdir,
      token: process.env["GITHUB_TOKEN"],
    });
    const steps = parseDefinition(job.definition ?? "") ?? [{ run: "echo hello from flare-actions" }];
    const outcome = await executeSteps(steps, {
      cwd: srcdir,
      env: {
        ...process.env,
        FLARE_REPO: job.repo,
        FLARE_SHA: job.sha,
        FLARE_RUN_ID: job.run_id,
        FLARE_JOB_ID: job.id,
      },
    });
    await client.reportStatus(
      job.run_id,
      job.id,
      outcome.success ? "success" : "failure",
      outcome.log,
      JSON.stringify({ steps: outcome.results }),
    );
    console.log(JSON.stringify({ msg: "job done", jobId: job.id, ms: Date.now() - started, success: outcome.success }));
  } catch (err) {
    await client.reportStatus(job.run_id, job.id, "failure", String(err)).catch(() => undefined);
    console.error(JSON.stringify({ msg: "job failed", jobId: job.id, error: String(err) }));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
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
