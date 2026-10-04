import type { JobRow } from "./db";
import { getInstallationToken, mintAppJwt } from "./github";

// GitHub Check Runs: per-job checks with a rich output summary, so
// failures surface on the PR/commit page with the failing command and
// its output tail (commit statuses only give a colored dot). Needs the
// `checks: write` App permission — requested by the Connect manifest;
// env-managed apps must grant it themselves. Best-effort like every
// GitHub call: failures log, never throw, never block a status update.

export type CheckConclusion = "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "neutral";

function timedOut(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { timedOut?: unknown };
    return parsed?.timedOut === true;
  } catch {
    return false;
  }
}

export function checkConclusion(job: JobRow): CheckConclusion {
  if (job.status === "success") return "success";
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "skipped") return "skipped";
  if (job.status === "failure" || job.status === "error") {
    return timedOut(job.result) ? "timed_out" : "failure";
  }
  return "neutral";
}

export interface CheckOutput {
  title: string;
  summary: string;
}

// The check output agents and humans both want: which command failed,
// its exit code, and a bounded tail — plus the AI triage when present.
export function checkOutput(job: JobRow): CheckOutput {
  let failing: { command: string; exitCode: number; output: string } | null = null;
  try {
    const parsed = JSON.parse(job.result) as { steps?: unknown };
    if (parsed && Array.isArray(parsed.steps)) {
      for (const s of parsed.steps) {
        if (typeof s !== "object" || s === null) continue;
        const rec = s as Record<string, unknown>;
        if (typeof rec.exitCode === "number" && rec.exitCode !== 0 && typeof rec.command === "string") {
          failing = {
            command: rec.command,
            exitCode: rec.exitCode,
            output: typeof rec.output === "string" ? rec.output : "",
          };
          break;
        }
      }
    }
  } catch {
    // Legacy or missing structured result: fall back to the triage/status.
  }
  const name = job.name || job.id.slice(0, 8);
  if (!failing) {
    return {
      title: `${name}: ${job.status}`.slice(0, 255),
      summary: (job.triage || `job ${job.status}`).slice(0, 60000),
    };
  }
  const lines: string[] = [`\`${failing.command}\` exited ${failing.exitCode}`];
  if (job.triage) lines.push("", job.triage.slice(0, 1200));
  lines.push("", "```", failing.output.slice(-3000), "```");
  return {
    title: `${name}: \`${failing.command.trim().slice(0, 60)}\` failed (exit ${failing.exitCode})`.slice(0, 255),
    summary: lines.join("\n").slice(0, 60000),
  };
}

export interface CheckEnv {
  appId?: string;
  privateKey?: string;
  installationId: number | null;
  repo: string;
  sha: string;
  // Dashboard origin for the details link; "" omits it (seats have none).
  origin?: string;
}

export async function reportJobCheck(env: CheckEnv, job: JobRow): Promise<boolean> {
  try {
    if (!env.installationId || !env.appId || !env.privateKey) return false;
    const jwt = await mintAppJwt(env.appId, env.privateKey);
    const token = await getInstallationToken(jwt, env.installationId);
    if (!token) return false;
    const output = checkOutput(job);
    const res = await fetch(`https://api.github.com/repos/${env.repo}/check-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "flare-actions",
      },
      body: JSON.stringify({
        name: `flare / ${job.name || job.id.slice(0, 8)}`,
        head_sha: env.sha,
        status: "completed",
        conclusion: checkConclusion(job),
        ...(job.started_at ? { started_at: job.started_at } : {}),
        ...(job.finished_at ? { completed_at: job.finished_at } : {}),
        ...(env.origin ? { details_url: `${env.origin.replace(/\/$/, "")}/dashboard` } : {}),
        output: { title: output.title, summary: output.summary },
      }),
    });
    console.log(JSON.stringify({ level: res.ok ? "info" : "warn", msg: "github check posted", ok: res.ok, repo: env.repo, job: job.id }));
    return res.ok;
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "github check failed", job: job.id, error: String(err) }));
    return false;
  }
}
