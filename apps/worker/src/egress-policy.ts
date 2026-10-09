// Per-repo egress allowlists: a repo default confines every job fanned
// out for that repo. Floor, not ceiling — a job that declares nothing
// inherits the repo list, so a hostile pipeline cannot escape by
// deleting its `egress:` block. Jobs may narrow the list; anything
// outside it is a fan-out violation (loud, before any writes), never
// a silent narrowing. Absent (or empty, defensively — the admin API
// never stores one) = no policy: observe-only, today's behavior.
import type { PipelineJob } from "./pipeline";

export interface EgressPolicyViolation {
  job: string;
  outside: string[];
}

export function applyRepoEgressPolicy(
  jobs: PipelineJob[],
  repoAllow: string[] | null,
): { jobs: PipelineJob[]; violations: EgressPolicyViolation[] } {
  if (!repoAllow || repoAllow.length === 0) return { jobs, violations: [] };
  const allowed = new Set(repoAllow);
  const violations: EgressPolicyViolation[] = [];
  const out = jobs.map((job) => {
    const declared = job.egress && job.egress.allow.length > 0 ? job.egress.allow : null;
    if (!declared) return { ...job, egress: { allow: [...repoAllow] } };
    const outside = declared.filter((d) => !allowed.has(d));
    if (outside.length > 0) violations.push({ job: job.name, outside });
    return job;
  });
  return { jobs: out, violations };
}

export class EgressPolicyViolationError extends Error {
  readonly repo: string;
  readonly jobs: string[];
  constructor(repo: string, repoAllow: string[], violations: EgressPolicyViolation[]) {
    const detail = violations.map((v) => `job "${v.job}" allows [${v.outside.join(", ")}]`).join("; ");
    super(
      `egress policy violation: ${detail} outside the ${repo} allowlist ([${repoAllow.join(", ")}]) — narrow the job's egress.allow, or widen the repo allowlist in dashboard Settings`,
    );
    this.name = "EgressPolicyViolationError";
    this.repo = repo;
    this.jobs = violations.map((v) => v.job);
  }
}
