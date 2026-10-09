import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeTar,
  buildFlareEnv,
  checkoutRepo,
  extractTar,
  FlareClient,
  loadEnv,
  parseJobSpec,
  runJob,
  selectTests,
  type FlareSelectionReport,
} from "flare-actions-runner-sdk";
import { collectWorkspaceFiles } from "../../../packages/runner-sdk/src/testselect-fs.ts";
import { runGithubLoop } from "./github.ts";
import { pairRunner } from "./pair.ts";

loadEnv();
const baseUrl = process.env["FLARE_ACTIONS_URL"];
let token = process.env["RUNNER_TOKEN"];
// Pairing first: this machine has no token yet by definition. The code
// buys a runner token, persisted to ./.env, and polling continues below.
const pairAt = process.argv.indexOf("--pair");
if (pairAt !== -1) {
  const code = process.argv[pairAt + 1] ?? "";
  if (!baseUrl) {
    console.error("Pairing needs FLARE_ACTIONS_URL — paste the full command from dashboard Access → Pair a runner");
    process.exit(2);
  }
  if (!code || code.startsWith("--")) {
    console.error("usage: npm run runner -- --pair <CODE> [--pair-name <name>]");
    process.exit(2);
  }
  if (token) {
    console.error("RUNNER_TOKEN is already set — unset it to re-pair this machine");
    process.exit(2);
  }
  const nameAt = process.argv.indexOf("--pair-name");
  const pairName = nameAt === -1 ? undefined : process.argv[nameAt + 1];
  try {
    const paired = await pairRunner({ baseUrl, code, ...(pairName ? { name: pairName } : {}), cwd: process.cwd() });
    token = paired.token;
    console.log(JSON.stringify({ msg: "runner paired", name: paired.name, env: paired.envPath }));
  } catch (err) {
    console.error(`pairing failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
if (!baseUrl || !token) {
  console.error("Run `npm run setup` first, pair with --pair <CODE>, or set FLARE_ACTIONS_URL and RUNNER_TOKEN");
  process.exit(1);
}

// Labels this runner accepts jobs for: os + arch plus FLARE_LABELS
// extras (e.g. "gpu,docker"). Label-less jobs match every runner.
// (--github mode declares its own extras via --labels instead.)
const OS_LABEL = platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux";
const LABELS = [OS_LABEL, arch(), ...(process.env["FLARE_LABELS"] ?? "").split(",").map((l) => l.trim()).filter(Boolean)];
if (!process.argv.includes("--github")) {
  console.log(JSON.stringify({ msg: "runner labels", labels: LABELS }));
}

const client = new FlareClient(baseUrl, token);

async function pollOnce(): Promise<boolean> {
  const { job, secrets, secretsError, selection } = await client.nextClaim(LABELS);
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
    if (job.source) {
      // Source dispatch: the workspace is an uploaded tarball of the
      // agent's working tree (no commit exists). Guard traversal, then
      // unpack instead of checking anything out.
      console.log(JSON.stringify({ msg: "unpacking source", jobId: job.id }));
      const blob = await client.getSource(job.source);
      await assertSafeTar(blob);
      mkdirSync(srcdir, { recursive: true });
      await extractTar(srcdir, blob);
    } else {
      await checkoutRepo({
        repo: job.repo,
        sha: job.sha,
        dir: srcdir,
        token: process.env["GITHUB_TOKEN"],
      });
    }
    // Smart test selection: the claim carries the server's safety-net
    // decision; `select` walks the checkout's import graph here (the
    // server never sees the source). FLARE_SELECTED_TESTS is the
    // newline-joined selection, or "" for the full suite.
    let selectionMode = "off";
    let selectedTests = "";
    let selectionReport: FlareSelectionReport | undefined;
    const selectionLines: string[] = [];
    if (spec.testSelection && selection && (selection.mode === "select" || selection.mode === "full")) {
      if (selection.mode === "full") {
        selectionMode = "full";
        selectionReport = { mode: "full", reason: selection.reason, selected: [], skipped: [] };
        selectionLines.push(`[select] full suite — ${selection.reason}`.slice(0, 500));
      } else {
        try {
          const harvest = collectWorkspaceFiles(srcdir);
          const result = selectTests({
            allFiles: harvest.files,
            contents: harvest.contents,
            changed: (job.changed_files ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
            failures: selection.recentFailures,
            ...(spec.testSelection.tests ? { testPatterns: spec.testSelection.tests } : {}),
          });
          selectionMode = result.mode;
          if (result.mode === "select") {
            selectedTests = result.selected.join("\n");
            selectionReport = {
              mode: "select",
              reason: result.reason,
              selected: result.selected,
              skipped: result.skipped,
            };
            const preview = result.selected.slice(0, 5).join(", ");
            selectionLines.push(
              `[select] ${result.reason}${result.selected.length > 5 ? ` (e.g. ${preview}…)` : `: ${preview}`}`.slice(0, 500),
            );
          } else {
            selectionReport = { mode: "full", reason: result.reason, selected: [], skipped: [] };
            selectionLines.push(`[select] full suite — ${result.reason}`.slice(0, 500));
          }
        } catch (err) {
          selectionMode = "full";
          selectionReport = { mode: "full", reason: "selection failed, ran everything", selected: [], skipped: [] };
          selectionLines.push(`[select] selection failed, ran everything (${String(err).slice(0, 200)})`);
        }
      }
    }
    const outcome = await runJob(spec, {
      cwd: srcdir,
      env: {
        ...process.env,
        ...buildFlareEnv({
          repo: job.repo,
          sha: job.sha,
          runId: job.run_id,
          jobId: job.id,
          ref: job.branch ?? "",
          changedFiles: job.changed_files ?? "",
          selectionMode,
          selectedTests,
        }),
      },
      client,
      jobId: job.id,
      secrets,
      secretsError,
    });
    const logWithSelection = selectionLines.length > 0 ? `${selectionLines.join("\n")}\n${outcome.log}` : outcome.log;
    await client.reportStatus(
      job.run_id,
      job.id,
      outcome.success ? "success" : "failure",
      logWithSelection,
      outcome.resultJson,
      selectionReport ? { selection: selectionReport } : undefined,
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

// Runner mode (the flare lane): this process serves GitHub-orchestrated
// jobs with the official actions/runner binary instead of Flare jobs.
// `--labels gpu,...` declares extra capabilities beyond the managed set.
if (process.argv.includes("--github")) {
  const at = process.argv.indexOf("--labels");
  const extra = at === -1 ? [] : (process.argv[at + 1] ?? "").split(",").map((l) => l.trim()).filter(Boolean);
  await runGithubLoop(client, { labels: extra });
} else {
  await main();
}
