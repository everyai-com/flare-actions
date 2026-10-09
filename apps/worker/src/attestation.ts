// Content-addressed verdict reuse: an identical tree + suite +
// environment short-circuits dispatch to a recorded verdict ("this exact
// state already passed, here is the receipt") instead of running.
// Receipts live in D1 (attestation_receipts, UNIQUE(repo, hash) —
// reuse never crosses repos); the tournament ledger is the prior art
// for the receipt shape. Runtime-free: hashing via WebCrypto, D1 via
// the Db seam, no cloudflare imports.
import { serializeDefinition, type PipelineJob } from "./pipeline";
import type { Db, JobRow, RunRow } from "./db";

export interface AttestationJob {
  name: string;
  definition: string;
  labels: string;
}

export interface AttestationInput {
  repo: string;
  sha: string;
  profile: string;
  jobs: AttestationJob[];
}

export interface AttestationReceiptRow {
  id: string;
  repo: string;
  sha: string;
  profile: string;
  hash: string;
  verdict: string;
  run_id: string;
  job_count: number;
  jobs_json: string;
  created_at: string;
}

export interface AttestedJobOutcome {
  name: string;
  status: string;
}

export interface AttestationVerification {
  verified: boolean | null;
  reason: string;
  runStatus: string | null;
}

// Verdicts worth reusing: terminal success/failure carry signal;
// cancelled/error runs record nothing (reruns and infra flakes must
// never mint a receipt).
const REUSABLE_VERDICTS = new Set(["success", "failure"]);

// Per-job statuses a receipt may replay. Anything else falls back to
// the run verdict so a corrupt jobs_json can never wedge a rollup.
const REPLAYABLE_STATUSES = new Set(["success", "failure", "error", "skipped", "cancelled"]);

// Canonical encoding: fixed key order, jobs sorted by name. Both hash
// sites (dispatch from PipelineJobs, terminal rollup from stored rows)
// reduce to this shape so equal states hash equal.
export function canonicalAttestationJson(input: AttestationInput): string {
  const jobs = input.jobs
    .map((j) => ({ definition: j.definition, labels: j.labels, name: j.name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({ jobs, profile: input.profile, repo: input.repo, sha: input.sha });
}

export async function attestationHash(input: AttestationInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalAttestationJson(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Dispatch-side input: the same serialized definitions the fan-out
// stores, so a later terminal rollup recomputes the identical hash.
export function attestationInputForJobs(
  repo: string,
  sha: string,
  profile: string | null,
  jobs: PipelineJob[],
): AttestationInput {
  return {
    repo,
    sha,
    profile: profile ?? "",
    jobs: jobs.map((job) => ({
      name: job.name,
      definition: serializeDefinition(job, job.base ?? job.name),
      labels: (job.labels ?? []).join(","),
    })),
  };
}

export async function findAttestationForDispatch(
  db: Db,
  repo: string,
  sha: string,
  profile: string | null,
  jobs: PipelineJob[],
): Promise<AttestationReceiptRow | null> {
  if (jobs.length === 0) return null;
  const hash = await attestationHash(attestationInputForJobs(repo, sha, profile, jobs));
  return db
    .prepare("SELECT * FROM attestation_receipts WHERE repo = ? AND hash = ?")
    .bind(repo, hash)
    .first<AttestationReceiptRow>();
}

export async function getAttestationReceipt(db: Db, id: string): Promise<AttestationReceiptRow | null> {
  return db.prepare("SELECT * FROM attestation_receipts WHERE id = ?").bind(id).first<AttestationReceiptRow>();
}

export function parseReceiptJobs(jobsJson: string, verdict: string): AttestedJobOutcome[] {
  try {
    const parsed = JSON.parse(jobsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: AttestedJobOutcome[] = [];
    for (const entry of parsed.slice(0, 32)) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.name !== "string" || !rec.name) continue;
      const status = typeof rec.status === "string" && REPLAYABLE_STATUSES.has(rec.status) ? rec.status : verdict;
      out.push({ name: rec.name.slice(0, 128), status });
    }
    return out;
  } catch {
    return [];
  }
}

// Pure: map a receipt onto a dispatch's job set — recorded per-job
// outcomes win, unknown names fall back to the run verdict.
export function planAttestedJobs(
  receipt: AttestationReceiptRow,
  jobs: PipelineJob[],
): { name: string; definition: string; labels: string; status: string }[] {
  const outcomes = new Map(parseReceiptJobs(receipt.jobs_json, receipt.verdict).map((o) => [o.name, o.status]));
  return jobs.map((job) => ({
    name: job.name,
    definition: serializeDefinition(job, job.base ?? job.name),
    labels: (job.labels ?? []).join(","),
    status: outcomes.get(job.name) ?? receipt.verdict,
  }));
}

// First verdict wins, except success upgrades a stored failure: a
// flaky red run must not shadow the green rerun forever, and a later
// failure never downgrades a recorded pass.
export async function storeVerdictReceipt(
  db: Db,
  input: { repo: string; sha: string; profile: string; hash: string; verdict: string; runId: string; jobs: AttestedJobOutcome[] },
): Promise<void> {
  if (!REUSABLE_VERDICTS.has(input.verdict)) return;
  const jobs = input.jobs.slice(0, 32).map((j) => ({ name: j.name.slice(0, 128), status: j.status.slice(0, 16) }));
  await db
    .prepare(
      `INSERT INTO attestation_receipts (id, repo, sha, profile, hash, verdict, run_id, job_count, jobs_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, hash) DO UPDATE SET
         verdict = CASE WHEN excluded.verdict = 'success' THEN 'success' ELSE attestation_receipts.verdict END,
         run_id = CASE WHEN excluded.verdict = 'success' AND attestation_receipts.verdict != 'success' THEN excluded.run_id ELSE attestation_receipts.run_id END,
         job_count = CASE WHEN excluded.verdict = 'success' AND attestation_receipts.verdict != 'success' THEN excluded.job_count ELSE attestation_receipts.job_count END,
         jobs_json = CASE WHEN excluded.verdict = 'success' AND attestation_receipts.verdict != 'success' THEN excluded.jobs_json ELSE attestation_receipts.jobs_json END`,
    )
    .bind(
      crypto.randomUUID(),
      input.repo,
      input.sha,
      input.profile,
      input.hash,
      input.verdict,
      input.runId,
      jobs.length,
      JSON.stringify(jobs),
      new Date().toISOString(),
    )
    .run();
}

// Terminal-rollup hook (shared by both executors via rollupRunStatus):
// recompute the state hash from the stored rows and file the receipt.
// Runs that were themselves short-circuited carry attested_by and are
// skipped — their receipt already exists.
export async function storeReceiptForRun(db: Db, runId: string, jobs: JobRow[], status: string): Promise<void> {
  if (!REUSABLE_VERDICTS.has(status) || jobs.length === 0) return;
  const run = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run || run.attested_by) return;
  const hash = await attestationHash({
    repo: run.repo,
    sha: run.sha,
    profile: run.profile ?? "",
    jobs: jobs.map((j) => ({ name: j.name, definition: j.definition, labels: j.labels })),
  });
  await storeVerdictReceipt(db, {
    repo: run.repo,
    sha: run.sha,
    profile: run.profile ?? "",
    hash,
    verdict: status,
    runId,
    jobs: jobs.map((j) => ({ name: j.name, status: j.status })),
  });
}

export async function setRunAttestation(db: Db, runId: string, receiptId: string): Promise<void> {
  await db.prepare("UPDATE runs SET attested_by = ?, updated_at = ? WHERE id = ?").bind(receiptId, new Date().toISOString(), runId).run();
}

// Independent verification: re-derive the hash from the recorded run's
// live rows and compare. Null when the run (or its jobs) has been
// pruned — the receipt still replays, but the witness is gone.
export async function verifyAttestationReceipt(db: Db, receipt: AttestationReceiptRow): Promise<AttestationVerification> {
  const run = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(receipt.run_id).first<RunRow>();
  if (!run) return { verified: null, reason: "recorded run was pruned", runStatus: null };
  if (run.repo !== receipt.repo || run.sha !== receipt.sha || (run.profile ?? "") !== (receipt.profile ?? "")) {
    return { verified: false, reason: "recorded run no longer matches the receipt", runStatus: run.status };
  }
  const jobs = await db.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(receipt.run_id).all<JobRow>();
  if (jobs.results.length === 0) return { verified: null, reason: "recorded run has no jobs", runStatus: run.status };
  const hash = await attestationHash({
    repo: receipt.repo,
    sha: receipt.sha,
    profile: receipt.profile ?? "",
    jobs: jobs.results.map((j) => ({ name: j.name, definition: j.definition, labels: j.labels })),
  });
  if (hash !== receipt.hash) return { verified: false, reason: "recomputed hash differs from the receipt", runStatus: run.status };
  return { verified: true, reason: "hash recomputed from the recorded run", runStatus: run.status };
}
