// Flare Cloud scaffold: hosted-mode flag, plan entitlements, and a
// prepaid credit ledger. Everything here is INERT on self-hosted
// deploys: the flag is env-only (FLARE_CLOUD=1, set only on Flare
// Cloud — never a dashboard toggle, so OSS can never be paywalled
// by accident), entitlements default to unlimited, and metering
// defaults off even in hosted mode until Cloud provisions it.
// The ledger only ever TRACKS usage; blocking at zero balance is a
// future Cloud overage policy, not this scaffold. See docs/HOSTED.md.
import type { Db } from "./db";

// List rate for spend accounting: 1¢ per compute-minute. Cloud bills
// capacity (concurrent runners), not meters — this rate only prices
// the ledger rows that track what ran, for invoices and showback.
export const CLOUD_CENTS_PER_MINUTE = 1;

// Largest single grant or spend, in cents ($10M — a sanity bound, not
// a business rule; larger movements split into multiple rows).
const MAX_LEDGER_CENTS = 1_000_000_000;

// Founding Cloud price: $49 per concurrent runner per month (see
// docs/ROADMAP.md pricing). The x402 quote prices whole runner-months;
// settlement wiring is future (docs/X402-SPIKE.md).
export const CLOUD_RUNNER_MONTH_CENTS = 4900;
export const X402_QUOTE_TTL_MS = 15 * 60000;

export interface X402Quote {
  runners: number;
  amountCents: number;
  asset: string;
  network: string;
  // Null until Cloud provisions a settlement address: the scaffold
  // quotes, it never takes money. See docs/X402-SPIKE.md.
  payTo: string | null;
  expiresAt: string;
}

export function x402Quote(runners: number): { ok: true; quote: X402Quote } | { ok: false; error: string } {
  if (!Number.isInteger(runners) || runners < 1 || runners > 1000) {
    return { ok: false, error: "runners must be an integer 1..1000" };
  }
  return {
    ok: true,
    quote: {
      runners,
      amountCents: runners * CLOUD_RUNNER_MONTH_CENTS,
      asset: "USDC",
      network: "base",
      payTo: null,
      expiresAt: new Date(Date.now() + X402_QUOTE_TTL_MS).toISOString(),
    },
  };
}

// Hosted control plane? Env-only by design (see module comment).
export function hostedMode(env: { FLARE_CLOUD?: string }): boolean {
  return env.FLARE_CLOUD === "1";
}

// The one bit threaded into rollup so run-terminal spend can be
// recorded without touching the hot path signature everywhere.
export function cloudMetering(env: { FLARE_CLOUD?: string }): { hosted: boolean } {
  return { hosted: hostedMode(env) };
}

// D1 cloud_entitlements is a JSON object like
// {"maxConcurrentJobs": 4}. Unknown keys are ignored; anything
// unparseable or out of range degrades to unlimited — a corrupt
// row must never block dispatches.
export function parseCloudEntitlements(raw: string | null): { maxConcurrentJobs: number | null } {
  if (!raw) return { maxConcurrentJobs: null };
  try {
    const parsed = JSON.parse(raw) as { maxConcurrentJobs?: unknown };
    if (typeof parsed !== "object" || parsed === null) return { maxConcurrentJobs: null };
    const cap = parsed.maxConcurrentJobs;
    if (cap === undefined || cap === null) return { maxConcurrentJobs: null };
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > 10000) {
      return { maxConcurrentJobs: null };
    }
    return { maxConcurrentJobs: cap };
  } catch {
    return { maxConcurrentJobs: null };
  }
}

// Sum of per-job durations in ms (compute spend), unlike the wall
// clock in analytics runDurationMs: two parallel 1-minute jobs burn
// 2 compute-minutes. Jobs that never started carry no signal.
export function runComputeMs(jobs: { started_at: string | null; finished_at: string | null }[]): number {
  let total = 0;
  for (const job of jobs) {
    if (!job.started_at || !job.finished_at) continue;
    const s = Date.parse(job.started_at);
    const f = Date.parse(job.finished_at);
    if (!Number.isFinite(s) || !Number.isFinite(f) || f < s) continue;
    total += f - s;
  }
  return total;
}

// Cents for a run: whole minutes, rounded up, minimum one minute
// once anything ran (a 5s run still costs a minute of bookkeeping).
export function runSpendCents(jobs: { started_at: string | null; finished_at: string | null }[]): number {
  const ms = runComputeMs(jobs);
  if (ms <= 0) return 0;
  return Math.ceil(ms / 60000) * CLOUD_CENTS_PER_MINUTE;
}

function validCents(amountCents: unknown): amountCents is number {
  return (
    typeof amountCents === "number" &&
    Number.isInteger(amountCents) &&
    amountCents >= 1 &&
    amountCents <= MAX_LEDGER_CENTS
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

// Prepaid top-up. ref is caller-supplied for idempotent retries
// (grants from a retried webhook pass the same ref twice).
export async function grantCredits(
  db: Db,
  amountCents: number,
  memo: string,
  ref: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!validCents(amountCents)) return { ok: false, error: "amountCents must be an integer 1..1000000000" };
  if (typeof memo !== "string" || memo.length > 280) return { ok: false, error: "memo must be a string ≤280 chars" };
  if (typeof ref !== "string" || ref.length < 1 || ref.length > 128) {
    return { ok: false, error: "ref must be a string 1..128 chars" };
  }
  await db
    .prepare("INSERT OR IGNORE INTO credit_ledger (kind, amount_cents, memo, ref, created_at) VALUES ('grant', ?, ?, ?, ?)")
    .bind(amountCents, memo, ref, isoNow())
    .run();
  return { ok: true };
}

// Current balance in cents (grants minus spend). May go negative —
// the scaffold tracks, it never blocks (see module comment).
export async function creditBalance(db: Db): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'grant' THEN amount_cents ELSE -amount_cents END), 0) AS balance
       FROM credit_ledger`,
    )
    .bind()
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

export interface LedgerRow {
  id: number;
  kind: string;
  amountCents: number;
  memo: string;
  ref: string;
  createdAt: string;
}

export async function recentLedger(db: Db, limit: number): Promise<LedgerRow[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit) || 20), 100);
  const res = await db
    .prepare(
      "SELECT id, kind, amount_cents AS amountCents, memo, ref, created_at AS createdAt FROM credit_ledger ORDER BY id DESC LIMIT ?",
    )
    .bind(capped)
    .all<{ id: number; kind: string; amountCents: number; memo: string; ref: string; createdAt: string }>();
  return res.results ?? [];
}

// Exactly-once spend for a terminal run: the UNIQUE ref
// (`run:<runId>`) makes redelivered rollups a no-op, and a zero
// spend (nothing ran) writes nothing. The caller (rollup) checks the
// D1 cloud_metering switch first — this module stays free of settings
// imports so db.ts can use it without a cycle. Best-effort: a ledger
// write must never fail a status update.
export async function recordRunSpend(
  db: Db,
  runId: string,
  jobs: { started_at: string | null; finished_at: string | null }[],
): Promise<void> {
  const cents = runSpendCents(jobs);
  if (cents <= 0) return;
  await db
    .prepare("INSERT OR IGNORE INTO credit_ledger (kind, amount_cents, memo, ref, created_at) VALUES ('spend', ?, ?, ?, ?)")
    .bind(cents, `run ${runId}`, `run:${runId}`, isoNow())
    .run()
    .catch(() => undefined);
}
