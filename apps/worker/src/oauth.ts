import { getSetting, setSetting, type Db } from "./db";
import { SETTING_KEYS } from "./settings";

// Login with GitHub, using the connected App's OAuth credentials.
// First GitHub user to log in claims admin; after that, the admin
// plus allow-listed usernames may log in. No passwords anywhere —
// `ADMIN_TOKEN` env survives only as break-glass recovery.

export const SESSION_COOKIE = "flare_session";
export const SESSION_TTL_DAYS = 30;
const OAUTH_STATE_TTL_MS = 15 * 60000;

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

export function validateGithubLogin(login: unknown): string | null {
  if (typeof login !== "string" || !LOGIN_RE.test(login) || login.startsWith("-") || login.endsWith("-")) {
    return "invalid GitHub username";
  }
  return null;
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, scope: "read:user" });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export async function exchangeOAuthCode(
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "flare-actions" },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: unknown; error?: unknown };
    return typeof data.access_token === "string" && data.access_token ? data.access_token : null;
  } catch {
    return null;
  }
}

export async function fetchGithubLogin(accessToken: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "flare-actions" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { login?: unknown };
    return typeof data.login === "string" && validateGithubLogin(data.login) === null ? data.login : null;
  } catch {
    return null;
  }
}

function oauthStateKey(state: string): string {
  return `github_oauth_${state}`;
}

export async function beginOAuth(db: Db): Promise<string> {
  const state = crypto.randomUUID();
  await setSetting(db, oauthStateKey(state), new Date().toISOString());
  return state;
}

export async function consumeOAuthState(db: Db, state: string): Promise<boolean> {
  const created = await getSetting(db, oauthStateKey(state));
  if (!created) return false;
  await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(oauthStateKey(state)).run();
  const ageMs = Date.now() - Date.parse(created);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < OAUTH_STATE_TTL_MS;
}

export interface LoginDecision {
  allowed: boolean;
  isAdmin: boolean;
  claimed: boolean;
}

export async function decideLogin(db: Db, login: string): Promise<LoginDecision> {
  const admin = await getSetting(db, SETTING_KEYS.adminGithubUser);
  if (!admin) return { allowed: true, isAdmin: true, claimed: false };
  if (login.toLowerCase() === admin.toLowerCase()) return { allowed: true, isAdmin: true, claimed: true };
  const allowed = await listAllowedUsers(db);
  if (allowed.map((u) => u.toLowerCase()).includes(login.toLowerCase())) {
    return { allowed: true, isAdmin: false, claimed: true };
  }
  return { allowed: false, isAdmin: false, claimed: true };
}

export async function claimAdmin(db: Db, login: string): Promise<void> {
  await setSetting(db, SETTING_KEYS.adminGithubUser, login);
}

export async function listAllowedUsers(db: Db): Promise<string[]> {
  const raw = await getSetting(db, SETTING_KEYS.githubUsers);
  if (!raw) return [];
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

export async function addAllowedUser(db: Db, login: string): Promise<string[]> {
  const users = await listAllowedUsers(db);
  if (!users.map((u) => u.toLowerCase()).includes(login.toLowerCase())) users.push(login);
  await setSetting(db, SETTING_KEYS.githubUsers, users.join(","));
  return users;
}

export async function removeAllowedUser(db: Db, login: string): Promise<string[]> {
  const users = (await listAllowedUsers(db)).filter((u) => u.toLowerCase() !== login.toLowerCase());
  await setSetting(db, SETTING_KEYS.githubUsers, users.join(","));
  return users;
}

export function parseSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = rest.join("=").trim();
      return /^[A-Za-z0-9-]+$/.test(value) ? value : null;
    }
  }
  return null;
}

export function sessionSetCookie(sessionId: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_DAYS * 86400}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function sessionClearCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
}
