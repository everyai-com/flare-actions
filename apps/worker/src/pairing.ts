import { nowIso, type Db } from "./db";
import { hashToken } from "./tokens";

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
