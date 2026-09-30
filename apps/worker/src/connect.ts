import { getSetting, setSetting, type Db } from "./db";
import { SETTING_KEYS } from "./settings";

// One-click GitHub App creation via App Manifests: the dashboard
// POSTs a manifest to github.com, the user clicks Create, GitHub
// redirects back with a one-time code, and the callback exchanges it
// for the App id, private key, and webhook secret — stored in D1 so
// both workers pick them up with zero terminal commands.

export const GITHUB_MANIFEST_URL = "https://github.com/settings/apps/new";
const CONNECT_STATE_TTL_MS = 15 * 60000;

const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,33}$/;

export function validateAppName(name: unknown): string | null {
  if (typeof name !== "string" || !APP_NAME_RE.test(name)) {
    return "app name must be 1-34 chars: letters, numbers, dot, dash, underscore";
  }
  return null;
}

export interface AppManifest {
  name: string;
  url: string;
  setup_url: string;
  redirect_url: string;
  callback_urls: string[];
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  hook_attributes: { url: string; active: boolean };
}

export function buildManifest(name: string, origin: string): AppManifest {
  const base = origin.replace(/\/$/, "");
  return {
    name,
    url: base,
    setup_url: `${base}/dashboard`,
    redirect_url: `${base}/v1/admin/github/callback`,
    callback_urls: [`${base}/v1/admin/github/oauth/callback`],
    public: false,
    default_permissions: { contents: "read", statuses: "write" },
    default_events: ["push", "pull_request"],
    hook_attributes: { url: `${base}/webhooks/github`, active: true },
  };
}

export function suggestAppName(randomHex: string): string {
  return `flare-actions-${randomHex.slice(0, 4).toLowerCase()}`;
}

function stateKey(state: string): string {
  return `github_connect_${state}`;
}

export async function beginConnect(db: Db): Promise<string> {
  const state = crypto.randomUUID();
  await setSetting(db, stateKey(state), new Date().toISOString());
  return state;
}

// Single-use: an accepted state is deleted, so a captured callback
// URL cannot be replayed.
export async function consumeConnectState(db: Db, state: string): Promise<boolean> {
  const created = await getSetting(db, stateKey(state));
  if (!created) return false;
  await deleteConnectState(db, state);
  const ageMs = Date.now() - Date.parse(created);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < CONNECT_STATE_TTL_MS;
}

async function deleteConnectState(db: Db, state: string): Promise<void> {
  await db
    .prepare("DELETE FROM app_settings WHERE key = ?")
    .bind(stateKey(state))
    .run();
}

export interface ConvertedApp {
  appId: string;
  slug: string;
  webhookSecret: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<Response>;

export async function exchangeManifestCode(code: string, fetchImpl: FetchLike = fetch): Promise<ConvertedApp | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "flare-actions" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id?: unknown;
      slug?: unknown;
      webhook_secret?: unknown;
      pem?: unknown;
      client_id?: unknown;
      client_secret?: unknown;
    };
    if (typeof data.id !== "number" || typeof data.slug !== "string") return null;
    if (typeof data.webhook_secret !== "string" || !data.webhook_secret) return null;
    if (typeof data.pem !== "string" || !data.pem.includes("PRIVATE KEY")) return null;
    // OAuth login needs these; without them the App is half-connected.
    if (typeof data.client_id !== "string" || !data.client_id) return null;
    if (typeof data.client_secret !== "string" || !data.client_secret) return null;
    return {
      appId: String(data.id),
      slug: data.slug,
      webhookSecret: data.webhook_secret,
      privateKey: data.pem,
      clientId: data.client_id,
      clientSecret: data.client_secret,
    };
  } catch {
    return null;
  }
}

export function installUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

export async function storeAppCredentials(db: Db, app: ConvertedApp): Promise<void> {
  await setSetting(db, SETTING_KEYS.githubAppId, app.appId);
  await setSetting(db, SETTING_KEYS.githubPrivateKey, app.privateKey);
  await setSetting(db, SETTING_KEYS.githubAppSlug, app.slug);
  await setSetting(db, SETTING_KEYS.githubClientId, app.clientId);
  await setSetting(db, SETTING_KEYS.githubClientSecret, app.clientSecret);
  await setSetting(db, SETTING_KEYS.webhookSecret, app.webhookSecret);
}

export interface AppCreds {
  appId: string;
  privateKey: string;
}

// Env secrets take precedence; Connect-flow values in D1 fill the
// gaps. Shared shape so main and seats resolve identically.
export async function resolveAppCreds(
  db: Db,
  envCreds: { appId?: string; privateKey?: string },
): Promise<AppCreds | null> {
  if (envCreds.appId && envCreds.privateKey) return { appId: envCreds.appId, privateKey: envCreds.privateKey };
  const [appId, privateKey] = await Promise.all([
    getSetting(db, SETTING_KEYS.githubAppId),
    getSetting(db, SETTING_KEYS.githubPrivateKey),
  ]);
  if (appId && privateKey) return { appId, privateKey };
  return null;
}
