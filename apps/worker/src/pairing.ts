import { nowIso, type Db } from "./db";
import { hashToken } from "./tokens";
import { grantCredits } from "./cloud";

// Tailscale-style runner pairing: one pasted command, zero config
// files. The admin mints a short single-use code (dashboard Access
// tab); a fresh machine exchanges it for a runner-scoped API token,
// which the runner writes to its own `.env` before it starts polling.
// Codes live 10 minutes, only hashes rest in D1, and the exchange
// consumes the row atomically — a code can never mint two tokens.

export const PAIRING_CODE_TTL_MS = 10 * 60000;
export const PAIRING_PRUNE_LIMIT = 100;

// Unambiguous alphabet (no 0/O/1/I/L): typable over a call.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function validPairingCodeFormat(code: unknown): boolean {
  return typeof code === "string" && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export async function createPairingCode(db: Db, createdBy: string): Promise<PairingCode> {
  // Expired rows are inert (exchange rechecks the clock), but prune
  // them boundedly so the table cannot grow without bound.
  await db.prepare("DELETE FROM pairing_codes WHERE expires_at < ? LIMIT ?").bind(nowIso(), PAIRING_PRUNE_LIMIT).run();
  const code = newPairingCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
  await db
    .prepare("INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(code), createdBy.slice(0, 200), now.toISOString(), expiresAt)
    .run();
  return { code, expiresAt };
}

export type ExchangePairingCodeResult = { ok: true; createdBy: string } | { ok: false; reason: "unknown" | "expired" };

export async function exchangePairingCode(db: Db, code: string): Promise<ExchangePairingCodeResult> {
  if (!validPairingCodeFormat(code)) return { ok: false, reason: "unknown" };
  // Atomic consume: parallel exchanges for one code race here, and
  // exactly one wins — no second token, ever.
  const row = await db
    .prepare("DELETE FROM pairing_codes WHERE code_hash = ? RETURNING created_by, expires_at")
    .bind(await hashToken(code))
    .first<{ created_by: string; expires_at: string }>();
  if (!row) return { ok: false, reason: "unknown" };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, createdBy: row.created_by };
}

// Prepaid top-up links: the same single-use code machinery as runner
// pairing, but redeeming credits instead of minting a token. The admin
// mints a code (+ approval link) and hands it to whoever approves the
// spend; anyone holding the link redeems it — no login, so the redeem
// endpoints throttle per IP exactly like the pairing exchange.
// Codes live 72h by default (approvals need days, not minutes).
export const TOPUP_DEFAULT_TTL_HOURS = 72;
export const TOPUP_MAX_TTL_HOURS = 720;

export interface TopupLink {
  code: string;
  link: string;
  amountCents: number;
  expiresAt: string;
}

export async function createTopupLink(
  db: Db,
  opts: { amountCents: number; memo: string; ttlHours: number; createdBy: string; origin: string },
): Promise<{ ok: true; link: TopupLink } | { ok: false; error: string }> {
  const { amountCents, memo, ttlHours, createdBy, origin } = opts;
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 1_000_000_000) {
    return { ok: false, error: "amountCents must be an integer 1..1000000000" };
  }
  if (typeof memo !== "string" || memo.length > 280) return { ok: false, error: "memo must be a string ≤280 chars" };
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > TOPUP_MAX_TTL_HOURS) {
    return { ok: false, error: `ttlHours must be an integer 1..${TOPUP_MAX_TTL_HOURS}` };
  }
  await db.prepare("DELETE FROM topup_links WHERE expires_at < ? LIMIT ?").bind(nowIso(), PAIRING_PRUNE_LIMIT).run();
  const code = newPairingCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600000).toISOString();
  await db
    .prepare("INSERT INTO topup_links (code_hash, amount_cents, memo, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await hashToken(code), amountCents, memo, createdBy.slice(0, 200), now.toISOString(), expiresAt)
    .run();
  return {
    ok: true,
    link: { code, link: `${origin}/v1/cloud/topup-links/redeem?code=${code}`, amountCents, expiresAt },
  };
}

export type PreviewTopupLinkResult =
  | { ok: true; amountCents: number; memo: string; expiresAt: string }
  | { ok: false; reason: "unknown" | "expired" };

// GET preview: shows what a click would redeem WITHOUT consuming,
// so link unfurlers and curious approvers never burn the code.
export async function previewTopupLink(db: Db, code: string): Promise<PreviewTopupLinkResult> {
  if (!validPairingCodeFormat(code)) return { ok: false, reason: "unknown" };
  const row = await db
    .prepare("SELECT amount_cents, memo, expires_at FROM topup_links WHERE code_hash = ?")
    .bind(await hashToken(code))
    .first<{ amount_cents: number; memo: string; expires_at: string }>();
  if (!row) return { ok: false, reason: "unknown" };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, amountCents: row.amount_cents, memo: row.memo, expiresAt: row.expires_at };
}

export type RedeemTopupLinkResult =
  | { ok: true; amountCents: number; memo: string }
  | { ok: false; reason: "unknown" | "expired" };

// The default memo names the link by hash prefix, never the code
// itself: only hashes rest in D1 (memos surface via the balance API).
// POST redeem: grants first (idempotent `topup:<hash>` ref), then
// consumes — a crash between the two retries into a no-op grant and
// a successful consume, so money is never created or lost. Parallel
// redeems race the DELETE; exactly one wins.
export async function redeemTopupLink(db: Db, code: string): Promise<RedeemTopupLinkResult> {
  if (!validPairingCodeFormat(code)) return { ok: false, reason: "unknown" };
  const hash = await hashToken(code);
  const row = await db
    .prepare("SELECT amount_cents, memo, expires_at FROM topup_links WHERE code_hash = ?")
    .bind(hash)
    .first<{ amount_cents: number; memo: string; expires_at: string }>();
  if (!row) return { ok: false, reason: "unknown" };
  if (Date.parse(row.expires_at) <= Date.now()) {
    await db.prepare("DELETE FROM topup_links WHERE code_hash = ?").bind(hash).run();
    return { ok: false, reason: "expired" };
  }
  const granted = await grantCredits(db, row.amount_cents, row.memo || `top-up ${hash.slice(0, 8)}`, `topup:${hash}`);
  if (!granted.ok) return { ok: false, reason: "unknown" };
  const consumed = await db
    .prepare("DELETE FROM topup_links WHERE code_hash = ? RETURNING code_hash")
    .bind(hash)
    .first<{ code_hash: string }>();
  if (!consumed) return { ok: false, reason: "unknown" };
  return { ok: true, amountCents: row.amount_cents, memo: row.memo };
}
