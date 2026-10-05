import { getSetting, type Db } from "./db";
import { decryptSettingValue, resolveSecretsKey } from "./secrets";
import { SETTING_KEYS } from "./settings";

// Turnstile verification for the auth endpoints (login, register,
// bootstrap, reset). Unconfigured = current behavior (rate limits
// only), so one-click deploys stay zero-config; configured = every
// auth POST must carry a fresh `turnstileToken`.

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 5000;

export async function verifyTurnstileToken(secret: string, token: string, remoteip?: string): Promise<boolean> {
  if (!secret || !token || token.length > 8192) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteip) body.set("remoteip", remoteip);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { success?: unknown } | null;
    return data?.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface TurnstileEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SECRETS_KEY?: string;
}

// Public site key for the dashboard widget: env wins, D1 fills the gap.
export async function getTurnstileSiteKey(db: Db, env: TurnstileEnv): Promise<string | null> {
  if (env.TURNSTILE_SITE_KEY?.trim()) return env.TURNSTILE_SITE_KEY.trim();
  const stored = await getSetting(db, SETTING_KEYS.turnstileSiteKey);
  return stored?.trim() || null;
}

// Secret key for server-side verification: env wins, D1 (encrypted)
// fills the gap. Null when Turnstile is unconfigured.
export async function getTurnstileSecret(db: Db, env: TurnstileEnv): Promise<string | null> {
  if (env.TURNSTILE_SECRET_KEY?.trim()) return env.TURNSTILE_SECRET_KEY.trim();
  const stored = await getSetting(db, SETTING_KEYS.turnstileSecretKey);
  if (!stored) return null;
  try {
    const key = await resolveSecretsKey(db, env.SECRETS_KEY);
    return await decryptSettingValue(key, stored);
  } catch {
    return null;
  }
}

// Returns an error string when the request's Turnstile token is
// missing/invalid, null when checks pass or Turnstile is off.
export async function checkTurnstile(
  db: Db,
  env: TurnstileEnv,
  token: unknown,
  remoteip?: string,
): Promise<string | null> {
  const secret = await getTurnstileSecret(db, env);
  if (!secret) return null;
  if (typeof token !== "string" || !token) return "captcha verification required";
  const ok = await verifyTurnstileToken(secret, token, remoteip);
  return ok ? null : "captcha verification failed";
}
