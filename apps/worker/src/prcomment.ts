import type { JobRow, RunRow } from "./db";
import { getInstallationToken, mintAppJwt } from "./github";
import { summarizeRunCost } from "./cost";

// One PR comment per run, created on first completion and edited in
// place afterwards — the agent/human surface that GitHub Actions fakes
// with a marketplace action. Needs pull_requests:write on the App.

const FAILED = ["failure", "error"];

function fmtDuration(ms: number | null): string {
  if (ms === null) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function runDurationMs(run: RunRow): number | null {
  const a = Date.parse(run.created_at);
  const b = Date.parse(run.updated_at);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

export interface FailingTestSnippet {
  jobName: string;
  suite: string;
  name: string;
  message: string;
}

export function buildPrComment(
  run: RunRow,
  jobs: JobRow[],
  origin: string,
  failingTests: FailingTestSnippet[] = [],
  quarantinedTests: FailingTestSnippet[] = [],
): string {
  const summary = summarizeRunCost(jobs);
  const duration = runDurationMs(run);
  const head = `**Flare ${run.status === "success" ? "passed" : `failed (${run.status})`}** — \`${run.repo}@${run.sha.slice(0, 7)}\` (${run.branch || "-"})`;
  const facts = `${summary.finishedJobs}/${summary.jobs} jobs · ${fmtDuration(duration)} · ${summary.computeMinutes} compute-min`;
  const failedJobs = jobs.filter((j) => FAILED.includes(j.status));
  const lines = [head, "", facts];
  for (const job of failedJobs) {
    lines.push("", `#### ${job.name || job.id.slice(0, 8)}`, "");
    let failing: { command: string; exitCode: number; output: string } | null = null;
    try {
      const parsed = JSON.parse(job.result) as { steps?: unknown };
      if (parsed && Array.isArray(parsed.steps)) {
        for (const s of parsed.steps) {
          const rec = s as Record<string, unknown>;
          if (typeof rec.exitCode === "number" && rec.exitCode !== 0 && typeof rec.command === "string") {
            failing = { command: rec.command, exitCode: rec.exitCode, output: typeof rec.output === "string" ? rec.output : "" };
            break;
          }
        }
      }
    } catch {
      // Legacy rows without structured results.
    }
    if (failing) {
      lines.push(`\`${failing.command.slice(0, 120)}\` exited ${failing.exitCode}`);
      if (failing.output.trim()) {
        lines.push("", "```", failing.output.slice(-1500), "```");
      }
    } else {
      lines.push(`job ${job.status}`);
    }
    if (job.triage) lines.push("", `> ${job.triage.slice(0, 600).replace(/\n/g, "\n> ")}`);
  }
  if (failingTests.length > 0) {
    lines.push("", `#### Failing tests (${failingTests.length} shown)`, "");
    for (const t of failingTests.slice(0, 15)) {
      const where = [t.jobName, t.suite].filter(Boolean).join(" / ");
      lines.push(`- \`${t.name.slice(0, 160)}\`${where ? ` — ${where.slice(0, 120)}` : ""}`);
      if (t.message.trim()) lines.push(`  > ${t.message.slice(0, 300).replace(/\n/g, " ")}`);
    }
  }
  if (quarantinedTests.length > 0) {
    lines.push("", `#### Quarantined — not blocking (${quarantinedTests.length} shown)`, "");
    for (const t of quarantinedTests.slice(0, 15)) {
      const where = [t.jobName, t.suite].filter(Boolean).join(" / ");
      lines.push(`- \`${t.name.slice(0, 160)}\`${where ? ` — ${where.slice(0, 120)}` : ""}`);
    }
    lines.push("", "> These failed but are quarantined as flaky, so the check stayed green. Reinstate from the dashboard Flaky tab or `cli quarantine remove`.");
  }
  if (origin) {
    lines.push("", `[Open the run in the dashboard](${origin.replace(/\/$/, "")}/dashboard)`);
  }
  lines.push("", "<sub>updated by Flare Actions</sub>");
  return lines.join("\n").slice(0, 60000);
}

export interface PrCommentEnv {
  appId?: string;
  privateKey?: string;
  installationId: number | null;
  repo: string;
  prNumber: number;
  existingCommentId: number | null;
  origin: string;
}

// Returns the comment id on success (existing or freshly created), null
// on any failure — never throws into the status callback.
export async function upsertPrComment(
  env: PrCommentEnv,
  run: RunRow,
  jobs: JobRow[],
  failingTests: FailingTestSnippet[] = [],
  quarantinedTests: FailingTestSnippet[] = [],
): Promise<number | null> {
  try {
    if (!env.appId || !env.privateKey || !env.installationId || !env.prNumber) return null;
    const jwt = await mintAppJwt(env.appId, env.privateKey);
    const token = await getInstallationToken(jwt, env.installationId);
    if (!token) return null;
    const body = JSON.stringify({ body: buildPrComment(run, jobs, env.origin, failingTests, quarantinedTests) });
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "flare-actions",
    };
    const url = env.existingCommentId
      ? `https://api.github.com/repos/${env.repo}/issues/comments/${env.existingCommentId}`
      : `https://api.github.com/repos/${env.repo}/issues/${env.prNumber}/comments`;
    const res = await fetch(url, { method: env.existingCommentId ? "PATCH" : "POST", headers, body });
    if (!res.ok) {
      console.log(JSON.stringify({ level: "warn", msg: "pr comment failed", repo: env.repo, pr: env.prNumber, status: res.status }));
      return env.existingCommentId;
    }
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return typeof data?.id === "number" ? data.id : env.existingCommentId;
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "pr comment failed", repo: env.repo, error: String(err) }));
    return null;
  }
}
