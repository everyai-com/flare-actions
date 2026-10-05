// Deterministic scheduling simulator: replays the claim rules
// (priority-first, longest-predicted-first, oldest-first, label match,
// repo allowlist, fair-share caps) over a queue snapshot so policy
// changes can be validated before
// they ship ("few surprises"). Greedy per-round assignment approximates
// independent pollers; ties break by job id, so output is stable for
// stable input. Dependency-free and runtime-free: the CLI imports this
// directly (keep it that way), and db.ts imports the matcher from here
// so the simulator can never drift from the claim path.

export function splitLabels(labels: string): string[] {
  return labels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

// "Can this runner take this job": the job's labels must all be present
// on the runner; an unlabeled job matches any runner.
export function labelsMatch(jobLabels: string, runnerLabels: string[]): boolean {
  const need = splitLabels(jobLabels);
  if (need.length === 0) return true;
  return need.every((l) => runnerLabels.includes(l));
}

export interface SimJob {
  id: string;
  repo: string;
  priority: number;
  priorMs: number;
  createdAt: string;
  labels: string;
}

export interface SimRunner {
  id: string;
  labels: string[];
  repos?: string[];
}

export interface SimClaim {
  jobId: string;
  repo: string;
  runnerId: string;
  round: number;
}

export function simulateDrain(
  jobs: SimJob[],
  runners: SimRunner[],
  fairSharePerRepo = 0,
  runningByRepo: Record<string, number> = {},
): SimClaim[] {
  const ordered = jobs
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.priorMs ?? 0) - (a.priorMs ?? 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const taken = new Set<string>();
  const running: Record<string, number> = { ...runningByRepo };
  const claims: SimClaim[] = [];
  let round = 0;
  for (;;) {
    let progressed = false;
    round += 1;
    for (const r of runners) {
      const job = ordered.find(
        (j) =>
          !taken.has(j.id) &&
          labelsMatch(j.labels, r.labels) &&
          (!r.repos || r.repos.length === 0 || r.repos.includes(j.repo)) &&
          !(fairSharePerRepo > 0 && (running[j.repo] ?? 0) >= fairSharePerRepo),
      );
      if (!job) continue;
      taken.add(job.id);
      running[job.repo] = (running[job.repo] ?? 0) + 1;
      claims.push({ jobId: job.id, repo: job.repo, runnerId: r.id, round });
      progressed = true;
    }
    if (!progressed || taken.size >= ordered.length) break;
  }
  return claims;
}
