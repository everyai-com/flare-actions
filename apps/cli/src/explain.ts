import type { FlareDigestJob, FlareRunDigest } from "flare-actions-runner-sdk";

// `cli explain <run-id>`: one narrative instead of raw rows. Pure and
// unit-tested; the CLI fetches the digest, this module tells the story:
// verdict first, then each failing job with its failing step + triage,
// then the exact next command to run.

export interface ExplainedFailure {
  jobId: string;
  jobName: string;
  status: string;
  command?: string;
  exitCode?: number;
}

export interface RunExplanation {
  runId: string;
  verdict: "success" | "failure" | "pending";
  failedJobs: number;
  totalJobs: number;
  failing: ExplainedFailure[];
  narrative: string;
  // The one next move, copy-pasteable (also the narrative's last line).
  next: string;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "unknown time";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function tailLines(text: string, n: number): string[] {
  return text.split("\n").filter((l) => l.trim()).slice(-n);
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${u === 0 ? Math.round(n) : Math.round(n * 10) / 10} ${units[u]}`;
}

// `cli` is how the user invoked the CLI (default: the short `cli` form).
export function explainDigest(digest: FlareRunDigest, cli = "cli"): RunExplanation {
  const pendingStates = new Set(["queued", "running", "blocked"]);
  const okStates = new Set(["success", "skipped"]);
  // Anything neither ok nor pending is a terminal failure — including
  // unknown future statuses (visible is safer than silent).
  const failing = digest.jobs.filter((j) => !okStates.has(j.status) && !pendingStates.has(j.status));
  const pending = digest.jobs.filter((j) => pendingStates.has(j.status));
  const verdict = failing.length > 0 ? "failure" : pending.length > 0 || digest.status === "running" || digest.status === "queued" ? "pending" : "success";
  const lines: string[] = [];
  const where = `${digest.repo}@${digest.sha.slice(0, 7)} (${digest.branch || "-"}, ${digest.event || "-"})`;

  if (verdict === "success") {
    lines.push(`Run ${digest.runId} passed: all ${digest.totalJobs} jobs green in ${where}, took ${fmtDuration(digest.durationMs)}.`);
    const slowest = [...digest.jobs]
      .filter((j): j is FlareDigestJob & { durationMs: number } => typeof j.durationMs === "number")
      .sort((a, b) => b.durationMs - a.durationMs)[0];
    if (slowest && digest.jobs.length > 1) {
      lines.push(`Slowest job: ${slowest.name} (${fmtDuration(slowest.durationMs)}).`);
    }
  } else if (verdict === "pending") {
    const done = digest.totalJobs - pending.length;
    lines.push(`Run ${digest.runId} is ${digest.status}: ${done}/${digest.totalJobs} jobs finished in ${where}.`);
  } else {
    lines.push(
      `Run ${digest.runId} failed: ${digest.failedJobs}/${digest.totalJobs} jobs failed in ${where} after ${fmtDuration(digest.durationMs)}.`,
    );
    for (const job of failing.slice(0, 5)) {
      lines.push("");
      lines.push(`${job.status === "cancelled" ? "Cancelled" : "Failed"}: ${job.name} (${fmtDuration(job.durationMs)})`);
      if (job.failing) {
        lines.push(`  $ ${job.failing.command} (exit ${job.failing.exitCode}, ${fmtDuration(job.failing.durationMs)})`);
        for (const line of tailLines(job.failing.outputTail, 6)) lines.push(`  | ${line.slice(0, 200)}`);
      } else {
        lines.push("  (no failing step captured — the job never started its steps)");
      }
      if (job.triage) {
        const first = job.triage.split("\n").filter((l) => l.trim())[0]?.slice(0, 300);
        if (first) lines.push(`  triage: ${first}`);
      }
      lines.push(`  rerun: ${cli} rerun ${digest.runId} ${job.id}`);
    }
    if (failing.length > 5) lines.push("", `…and ${failing.length - 5} more failing jobs (see: ${cli} logs ${digest.runId})`);
  }
  const heaviest = [...digest.jobs]
    .filter((j): j is FlareDigestJob & { peakRssBytes: number } => typeof j.peakRssBytes === "number")
    .sort((a, b) => b.peakRssBytes - a.peakRssBytes)[0];
  if (heaviest) {
    lines.push(
      `Heaviest job: ${heaviest.name} (peak ${fmtBytes(heaviest.peakRssBytes)}${heaviest.sizeHint ? `, ${heaviest.sizeHint}` : ""}).`,
    );
  }
  if (digest.testSelection && digest.testSelection.jobs > 0) {
    const sel = digest.testSelection;
    const noun = sel.jobs === 1 ? "job" : "jobs";
    lines.push("", `Smart test selection ran in ${sel.jobs} ${noun}: ${sel.selected} test(s) selected, ${sel.skipped} skipped (see: ${cli} selection ${digest.runId}).`);
  }
  if (digest.attestation?.reused) {
    lines.push("", `Reused verdict ${digest.attestation.verdict}: this exact tree + suite + environment already ran — zero compute spent (receipt: ${cli} attestation ${digest.attestation.receiptId}).`);
  }

  // Failed: fix, then verify the working tree without a commit. Still
  // going: keep watching. Green: nothing to fix, see recent checks.
  const next =
    verdict === "failure"
      ? `next: fix the failing step, then ${cli} run ${digest.repo} --source   (checks your local changes, no commit needed)`
      : verdict === "pending"
        ? `next: ${cli} watch ${digest.runId}`
        : `next: ${cli} runs   (all green)`;
  lines.push("", next);

  return {
    runId: digest.runId,
    next,
    verdict,
    failedJobs: digest.failedJobs,
    totalJobs: digest.totalJobs,
    failing: failing.slice(0, 10).map((j) => ({
      jobId: j.id,
      jobName: j.name,
      status: j.status,
      ...(j.failing ? { command: j.failing.command, exitCode: j.failing.exitCode } : {}),
    })),
    narrative: lines.join("\n"),
  };
}
