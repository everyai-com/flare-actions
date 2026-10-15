// Push + pull_request dedupe (runtime-free: tests drive it with a fake
// Db). A push to a branch with an open PR delivers two webhooks for the
// same sha ~20 ms apart; both used to fan out a full run. The second of
// the pair is now skipped when it would run exactly the same jobs.
//
// Safe rule — dedupe only when ALL hold:
//   * the two events are push and pull_request (never two of the same
//     event: a re-push of a sha keeps today's behavior),
//   * same repo + sha + branch (the PR's head ref is the pushed branch,
//     so fork PRs and the same sha pushed to another branch never pair),
//   * identical policed job set: same pipeline source, same profile,
//     same multiset of (name, serialized definition). actionsCompat
//     decides `on:` filters (pull_request-only workflows, base-branch
//     filters, paths) and `github.event_name` guards at translation
//     time, so a workflow that runs only on pull_request yields a
//     different job set and both runs happen,
//   * no job depends on per-event run data the definition cannot show:
//     test selection (push and PR diffs differ), browser checks (their
//     URLs may template the PR number), or steps that read
//     FLARE_CHANGED_FILES.
// Commit statuses and Check Runs are per-sha, so the surviving run's
// results already render on the PR; the PR number is stamped onto a
// surviving push run so the PR summary comment still posts.
//
// Race: both webhooks can load their pipelines concurrently, so a
// plain check-then-insert would let both through. Instead the first to
// claim `pair:<repo>@<sha>:<branch>:<fingerprint>` (an atomic
// webhook_deliveries insert, 24 h retention) creates the run; the loser
// waits briefly for the winner's run row and skips against it. If the
// winner's row never appears (its fan-out failed — the caller releases
// the claim — or it is too slow) the loser fails open and runs: a
// duplicate run is wasted compute, a missing run is missing CI.
import { claimWebhookDelivery, type Db } from "./db";

export const PAIR_EVENTS: readonly string[] = ["push", "pull_request"];

export interface DedupeJob {
  name: string;
  definition: string;
}

// Null when the job set is safe to share between a push and a PR run;
// otherwise the reason it is not.
export function pairDedupeBlocker(jobs: readonly DedupeJob[]): string | null {
  if (jobs.length === 0) return "no jobs";
  for (const job of jobs) {
    let def: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(job.definition);
      def = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      def = null;
    }
    if (!def) return "unparseable job definition";
    if (def["testSelection"] !== undefined && def["testSelection"] !== null) return "test selection depends on the event's diff";
    if (Array.isArray(def["browserChecks"]) && def["browserChecks"].length > 0) return "browser checks may template the PR number";
    if (job.definition.includes("FLARE_CHANGED_FILES")) return "steps read FLARE_CHANGED_FILES";
  }
  return null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Order-insensitive fingerprint of what a run would execute.
export async function jobSetFingerprint(input: {
  pipelineSource: string;
  profile: string | null;
  jobs: readonly DedupeJob[];
}): Promise<string> {
  const lines = input.jobs.map((j) => JSON.stringify([j.name, j.definition])).sort();
  return sha256Hex(JSON.stringify([input.pipelineSource, input.profile ?? "", lines]));
}

export function pairClaimKey(repo: string, sha: string, branch: string, fingerprint: string): string {
  return `pair:${repo}@${sha.toLowerCase()}:${branch}:${fingerprint}`;
}

export interface PairCandidate {
  id: string;
  event: string;
  status: string;
  pr_number: number | null;
  pipeline_source: string | null;
  profile: string | null;
}

export interface PairDedupeDeps {
  db: Db;
  sleep?: (ms: number) => Promise<void>;
  // Winner wait: attempts × interval bounds the loser's webhook latency.
  waitAttempts?: number;
  waitMs?: number;
}

export interface PairDedupeInput {
  repo: string;
  sha: string;
  branch: string;
  event: string;
  prNumber: number | null;
  pipelineSource: string;
  profile: string | null;
  jobs: readonly DedupeJob[];
}

export type PairDedupeOutcome =
  // Create the run. claimKey is set when this webhook holds the pair
  // claim: release it if the fan-out fails so the twin can run.
  | { action: "run"; reason: string; claimKey?: string }
  | { action: "skip"; runId: string; runEvent: string; runStatus: string; stampedPr: boolean };

async function findTwin(
  db: Db,
  input: PairDedupeInput,
  fingerprint: string,
): Promise<{ twin: PairCandidate | null; sameEvent: boolean }> {
  const res = await db
    .prepare(
      `SELECT id, event, status, pr_number, pipeline_source, profile FROM runs
       WHERE repo = ? AND sha = ? AND branch = ? AND event IN ('push', 'pull_request') AND status != 'cancelled'
       ORDER BY created_at DESC LIMIT 5`,
    )
    .bind(input.repo, input.sha, input.branch)
    .all<PairCandidate>();
  let sameEvent = false;
  for (const cand of res.results) {
    const jobs = await db
      .prepare("SELECT name, definition FROM jobs WHERE run_id = ?")
      .bind(cand.id)
      .all<DedupeJob>();
    const fp = await jobSetFingerprint({
      pipelineSource: cand.pipeline_source ?? "",
      profile: cand.profile,
      jobs: jobs.results,
    });
    if (fp !== fingerprint) continue;
    if (cand.event === input.event) {
      sameEvent = true;
      continue;
    }
    return { twin: cand, sameEvent };
  }
  return { twin: null, sameEvent };
}

export async function resolvePairDedupe(deps: PairDedupeDeps, input: PairDedupeInput): Promise<PairDedupeOutcome> {
  if (!PAIR_EVENTS.includes(input.event)) return { action: "run", reason: "not a push/pull_request event" };
  if (!input.branch) return { action: "run", reason: "no branch" };
  const blocker = pairDedupeBlocker(input.jobs);
  if (blocker) return { action: "run", reason: blocker };
  const fingerprint = await jobSetFingerprint(input);
  const claimKey = pairClaimKey(input.repo, input.sha, input.branch, fingerprint);
  if (await claimWebhookDelivery(deps.db, claimKey)) return { action: "run", reason: "first of pair", claimKey };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.waitAttempts ?? 8;
  for (let i = 0; i < attempts; i++) {
    const { twin, sameEvent } = await findTwin(deps.db, input, fingerprint);
    if (twin) {
      let stampedPr = false;
      if (input.event === "pull_request" && input.prNumber !== null && twin.pr_number === null) {
        const res = (await deps.db
          .prepare("UPDATE runs SET pr_number = ? WHERE id = ? AND pr_number IS NULL")
          .bind(input.prNumber, twin.id)
          .run()) as { meta?: { changes?: number } };
        stampedPr = (res?.meta?.changes ?? 0) > 0;
      }
      return { action: "skip", runId: twin.id, runEvent: twin.event, runStatus: twin.status, stampedPr };
    }
    // The claim belongs to an earlier same-event delivery of this sha
    // (e.g. a re-push): not a push/PR pair, keep today's behavior.
    if (sameEvent) return { action: "run", reason: "claim held by a same-event run" };
    if (i < attempts - 1) await sleep(deps.waitMs ?? 250);
  }
  return { action: "run", reason: "pair claim held but no twin run appeared (fail open)" };
}
