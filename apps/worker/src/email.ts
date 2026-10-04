import { getSetting, setSetting, type Db } from "./db";
import { timingSafeEqualHex } from "./github";

// Email + password login alongside GitHub OAuth. No email delivery is
// needed: trust comes from invite links (high-entropy, single-use,
// 24h) issued by the admin, and the first signup on a fresh deploy
// claims admin. Passwords are PBKDF2-SHA256 (WebCrypto, no native
// deps) with per-user salts.

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/;
const INVITE_TTL_MS = 24 * 3600000;
const RESET_TTL_MS = 3600000;

// Workers caps PBKDF2 at 100k iterations; OWASP's SHA-256 floor is 600k,
// so compensate with the platform max plus per-user salts. Revisit if
// the cap lifts (iteration count is stored per-hash, so upgrades roll).
const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateEmail(email: unknown): string | null {
  if (typeof email !== "string") return "invalid email address";
  const clean = normalizeEmail(email);
  if (clean.length > 254 || !EMAIL_RE.test(clean)) return "invalid email address";
  return null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    return "password must be 8-256 characters";
  }
  return null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations: PBKDF2_ITERATIONS },
      key,
      KEY_BYTES * 8,
    ),
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iter, saltHex, hashHex] = stored.split("$");
    if (scheme !== "pbkdf2" || !iter || !saltHex || !hashHex) return false;
    const iterations = Number(iter);
    if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 2000000) return false;
    const salt = new Uint8Array(saltHex.match(/[\da-f]{2}/gi)?.map((h) => parseInt(h, 16)) ?? []);
    if (salt.length === 0) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
        key,
        (hashHex.length / 2) * 8,
      ),
    );
    return timingSafeEqualHex(toHex(bits), hashHex.toLowerCase());
  } catch {
    return false;
  }
}

export function dummyPasswordHash(): string {
  // Shape-valid so a missing user still costs one full PBKDF2 verify
  // (no cheap user-enumeration oracle).
  return `pbkdf2$${PBKDF2_ITERATIONS}$${"00".repeat(SALT_BYTES)}$${"00".repeat(KEY_BYTES)}`;
}

function inviteKey(token: string): string {
  return `email_invite_${token}`;
}

export interface Invite {
  email: string;
  expiresAt: string;
}

export async function createInvite(db: Db, email: string): Promise<{ token: string; invite: Invite }> {
  const token = crypto.randomUUID();
  const invite: Invite = { email: normalizeEmail(email), expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
  await setSetting(db, inviteKey(token), JSON.stringify(invite));
  return { token, invite };
}

function parseInvite(raw: string | null): Invite | null {
  if (!raw) return null;
  try {
    const invite = JSON.parse(raw) as Invite;
    if (typeof invite.email !== "string" || typeof invite.expiresAt !== "string") return null;
    if (Date.parse(invite.expiresAt) <= Date.now()) return null;
    return invite;
  } catch {
    return null;
  }
}

async function readInvite(db: Db, token: string): Promise<Invite | null> {
  if (!/^[A-Za-z0-9-]+$/.test(token)) return null;
  return parseInvite(await getSetting(db, inviteKey(token)));
}

// Peek without consuming (powers the accept-invite screen).
export async function peekInvite(db: Db, token: string): Promise<Invite | null> {
  return readInvite(db, token);
}

// Single-use, atomically: DELETE ... RETURNING means two parallel
// registers can never both redeem the same invite. Expired invites are
// deleted too — they are garbage either way.
export async function consumeInvite(db: Db, token: string): Promise<Invite | null> {
  if (!/^[A-Za-z0-9-]+$/.test(token)) return null;
  const row = await db
    .prepare("DELETE FROM app_settings WHERE key = ? RETURNING value")
    .bind(inviteKey(token))
    .first<{ value: string }>();
  return parseInvite(row?.value ?? null);
}

// Password reset: single-use, 1-hour token, delivered by email when the
// deployment has a sender + EMAIL binding configured. Consume is atomic
// (DELETE ... RETURNING), so a leaked link cannot be redeemed twice.
function resetKey(token: string): string {
  return `email_reset_${token}`;
}

export async function createResetToken(db: Db, email: string): Promise<string> {
  const token = crypto.randomUUID();
  await setSetting(
    db,
    resetKey(token),
    JSON.stringify({ email: normalizeEmail(email), expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString() }),
  );
  return token;
}

export async function consumeResetToken(db: Db, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9-]+$/.test(token)) return null;
  const row = await db
    .prepare("DELETE FROM app_settings WHERE key = ? RETURNING value")
    .bind(resetKey(token))
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { email?: unknown; expiresAt?: unknown };
    if (typeof parsed.email !== "string" || typeof parsed.expiresAt !== "string") return null;
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed.email;
  } catch {
    return null;
  }
}

export async function listInvites(db: Db): Promise<Invite[]> {
  const res = await db
    .prepare("SELECT value FROM app_settings WHERE key LIKE 'email_invite_%'")
    .bind()
    .all<{ value: string }>();
  const out: Invite[] = [];
  for (const row of res.results) {
    try {
      const invite = JSON.parse(row.value) as Invite;
      if (typeof invite.email === "string" && typeof invite.expiresAt === "string" && Date.parse(invite.expiresAt) > Date.now()) {
        out.push(invite);
      }
    } catch {
      // Stale or corrupt rows expire out of view.
    }
  }
  return out;
}
