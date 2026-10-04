import type { Db } from "./db";
import { hashToken } from "./tokens";

// Brute-force protection for the unauthenticated auth endpoints
// (login / register / bootstrap). Failures accrue per key — the email
// and the hashed client IP — in a sliding window; at the threshold the
// key is refused until the block expires. Successful sign-ins clear
// their keys so a legitimate user cannot be locked out permanently by
// someone else's guessing. Recording prunes rows whose window closed,
// so spraying random emails cannot grow the table without bound.

export const AUTH_WINDOW_MS = 15 * 60000;
export const AUTH_MAX_FAILURES = 10;
export const AUTH_BLOCK_MS = 15 * 60000;

// Hashed so raw client IPs never land in D1 (they already land in logs).
async function ipThrottleKey(request: Request): Promise<string | null> {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return null;
  return `ip:${await hashToken(ip)}`;
}

export async function authThrottleKeys(request: Request, email?: string): Promise<string[]> {
  const keys: string[] = [];
  if (email) keys.push(`email:${email}`);
  const ipKey = await ipThrottleKey(request);
  if (ipKey) keys.push(ipKey);
  return keys;
}

async function isBlocked(db: Db, key: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT blocked_until FROM auth_attempts WHERE key = ?")
    .bind(key)
    .first<{ blocked_until: string | null }>();
  return !!row?.blocked_until && Date.parse(row.blocked_until) > Date.now();
}

export async function authThrottleBlocked(db: Db, keys: string[]): Promise<boolean> {
  for (const key of keys) {
    if (await isBlocked(db, key)) return true;
  }
  return false;
}

export async function recordAuthFailure(db: Db, key: string): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoff = new Date(now - AUTH_WINDOW_MS).toISOString();
  const blockUntil = new Date(now + AUTH_BLOCK_MS).toISOString();
  await db
    .prepare(
      `INSERT INTO auth_attempts (key, failures, window_started_at, blocked_until) VALUES (?, 1, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET
         failures = CASE WHEN auth_attempts.window_started_at < ? THEN 1 ELSE auth_attempts.failures + 1 END,
         window_started_at = CASE WHEN auth_attempts.window_started_at < ? THEN ? ELSE auth_attempts.window_started_at END,
         blocked_until = CASE
           WHEN auth_attempts.window_started_at < ? THEN NULL
           WHEN auth_attempts.failures + 1 >= ? THEN ?
           ELSE auth_attempts.blocked_until END`,
    )
    .bind(key, nowIso, cutoff, cutoff, nowIso, cutoff, AUTH_MAX_FAILURES, blockUntil)
    .run();
  // Bounded table: an expired window with no live block is garbage.
  await db
    .prepare("DELETE FROM auth_attempts WHERE window_started_at < ? AND (blocked_until IS NULL OR blocked_until < ?)")
    .bind(cutoff, nowIso)
    .run();
}

export async function clearAuthFailures(db: Db, keys: string[]): Promise<void> {
  for (const key of keys) {
    await db.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key).run();
  }
}
