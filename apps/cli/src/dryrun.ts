import type { DryRunPlan } from "flare-actions-runner-sdk";

// Human-readable rendering of a dry-run dispatch plan: what would
// queue, what would park, and why — no run is created.
export function formatPlan(plan: DryRunPlan): string {
  const lines = [
    `dry run: ${plan.repo}@${plan.sha.slice(0, 12)} (${plan.branch || "-"}, pipeline: ${plan.pipelineSource}${plan.profile ? `, profile: ${plan.profile}` : ""})`,
    `would queue ${plan.queued}, block ${plan.blocked}${plan.totalPriorMs > 0 ? `, est prior ${Math.round(plan.totalPriorMs / 1000)}s` : ""}`,
  ];
  if (plan.paused) lines[1] += `, PAUSED since ${plan.pausedAt ?? "?"}`;
  if (plan.budget) {
    lines[1] += plan.budget.wouldBlock
      ? `, BUDGET WOULD BLOCK (${plan.budget.usedMinutes}/${plan.budget.cap} compute-minutes)`
      : `, budget ${plan.budget.usedMinutes}/${plan.budget.cap} (${plan.budget.mode})`;
  }
  for (const job of plan.jobs) {
    let status = job.status;
    if (job.status === "blocked") status += `:${job.blockedReason ?? "?"}`;
    const bits = [`[${status}] ${job.name}`];
    if (job.needs.length > 0) bits.push(`needs ${job.needs.join(",")}`);
    if (job.group) bits.push(`group ${job.group}${job.wouldCancelInProgress ? " (would cancel in-progress)" : ""}`);
    if (job.labels.length > 0) bits.push(`labels ${job.labels.join(",")}`);
    if (job.priorMs > 0) bits.push(`prior ${Math.round(job.priorMs / 1000)}s`);
    lines.push(`  ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}
