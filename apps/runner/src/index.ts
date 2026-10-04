import { mkdtempSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRepo, FlareClient, loadEnv, parseJobSpec, runJob } from "@flare-actions/runner-sdk";

loadEnv();
const baseUrl = process.env["FLARE_ACTIONS_URL"];
const token = process.env["RUNNER_TOKEN"];
if (!baseUrl || !token) {
  console.error("Run `npm run setup` first, or set FLARE_ACTIONS_URL and RUNNER_TOKEN");
  process.exit(1);
}

// Labels this runner accepts jobs for: os + arch plus FLARE_LABELS
// extras (e.g. "gpu,docker"). Label-less jobs match every runner.
const OS_LABEL = platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux";
const LABELS = [OS_LABEL, arch(), ...(process.env["FLARE_LABELS"] ?? "").split(",").map((l) => l.trim()).filter(Boolean)];
console.log(JSON.stringify({ msg: "runner labels", labels: LABELS }));

const client = new FlareClient(baseUrl, token);

async function pollOnce(): Promise<boolean> {
  const { job, secrets, secretsError } = await client.nextClaim(LABELS);
  if (!job) return false;
  console.log(JSON.stringify({ msg: "picked up job", jobId: job.id, name: job.name, repo: job.repo, sha: job.sha }));
  // Fail closed on corrupt or newer-format definitions: substituting an
  // echo job would report a false green for work that never ran.
  const spec = parseJobSpec(job.definition ?? "");
  if (!spec) {
    await client
      .reportStatus(
        job.run_id,
        job.id,
        "error",
        "job definition could not be parsed (corrupt or from a newer version); refusing to run",
      )
      .catch(() => undefined);
    console.error(JSON.stringify({ msg: "unparseable job definition", jobId: job.id }));
    return true;
  }
  // Liveness proof: quiet jobs get requeued past the stale horizon, so
  // long runs heartbeat until they report. Best effort, never fatal.
  const heartbeat = setInterval(() => {
    client.heartbeat(job.run_id, job.id).catch(() => undefined);
  }, 60000);
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
    const outcome = await runJob(spec, {
      cwd: srcdir,
      env: {
        ...process.env,
        FLARE_REPO: job.repo,
        FLARE_SHA: job.sha,
        FLARE_RUN_ID: job.run_id,
        FLARE_JOB_ID: job.id,
      },
      client,
      jobId: job.id,
      secrets,
      secretsError,
    });
    await client.reportStatus(
      job.run_id,
      job.id,
      outcome.success ? "success" : "failure",
      outcome.log,
      outcome.resultJson,
    );
    console.log(JSON.stringify({ msg: "job done", jobId: job.id, ms: Date.now() - started, success: outcome.success }));
  } catch (err) {
    await client.reportStatus(job.run_id, job.id, "failure", String(err)).catch(() => undefined);
    console.error(JSON.stringify({ msg: "job failed", jobId: job.id, error: String(err) }));
  } finally {
    clearInterval(heartbeat);
    rmSync(workdir, { recursive: true, force: true });
  }
  return true;
}

async function main(): Promise<void> {
  for (;;) {
    try {
      const worked = await pollOnce();
      // Agent-speed pickup: 2s idle, 500ms right after a job so a
      // queued backlog drains without a human-perceptible gap.
      await new Promise((r) => setTimeout(r, worked ? 500 : 2000));
    } catch (err) {
      console.error(JSON.stringify({ msg: "poll error", error: String(err) }));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

await main();
