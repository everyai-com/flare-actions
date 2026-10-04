import { getSetting, setSetting, type Db } from "./db";
import { decryptSettingValue, encryptSettingValue, resolveSecretsKey } from "./secrets";
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
    // Every default event needs a backing permission or GitHub rejects the
    // manifest ("Default events are not supported by permissions"): push is
    // covered by contents, pull_request requires pull_requests. checks:write
    // powers per-job Check Runs with failure output on the PR page;
    // pull_requests:write powers the per-run PR summary comment.
    default_permissions: { contents: "read", statuses: "write", checks: "write", pull_requests: "write" },
    default_events: ["push", "pull_request"],
    hook_attributes: { url: `${base}/webhooks/github`, active: true },
  };
}

export function suggestAppName(randomHex: string): string {
  return `flare-actions-${randomHex.slice(0, 6).toLowerCase()}`;
}

function stateKey(state: string): string {
  return `github_connect_${state}`;
}

export async function beginConnect(db: Db): Promise<string> {
  const state = crypto.randomUUID();
  await setSetting(db, stateKey(state), new Date().toISOString());
  return state;
}

// Single-use, atomically: DELETE ... RETURNING closes the replay race
// a read-then-delete leaves open between parallel callbacks.
export async function consumeConnectState(db: Db, state: string): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM app_settings WHERE key = ? RETURNING value")
    .bind(stateKey(state))
    .first<{ value: string }>();
  if (!row) return false;
  const ageMs = Date.now() - Date.parse(row.value);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < CONNECT_STATE_TTL_MS;
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

// The private key, client secret, and webhook secret encrypt with the
// shared data key before landing in D1; app id and slug stay plaintext
// (both are public). Values written by older versions read as plaintext
// and are upgraded on the next Connect.
export async function storeAppCredentials(db: Db, app: ConvertedApp, secretsKey: CryptoKey): Promise<void> {
  await setSetting(db, SETTING_KEYS.githubAppId, app.appId);
  await setSetting(db, SETTING_KEYS.githubPrivateKey, await encryptSettingValue(secretsKey, app.privateKey));
  await setSetting(db, SETTING_KEYS.githubAppSlug, app.slug);
  await setSetting(db, SETTING_KEYS.githubClientId, app.clientId);
  await setSetting(db, SETTING_KEYS.githubClientSecret, await encryptSettingValue(secretsKey, app.clientSecret));
  await setSetting(db, SETTING_KEYS.webhookSecret, await encryptSettingValue(secretsKey, app.webhookSecret));
}

export interface AppCreds {
  appId: string;
  privateKey: string;
}

// Env secrets take precedence; Connect-flow values in D1 fill the
// gaps. Shared shape so main and seats resolve identically; stored
// secrets decrypt with the shared data key (undecryptable values — a
// lost key — behave as unconfigured rather than crash-minting JWTs).
export async function resolveAppCreds(
  db: Db,
  envCreds: { appId?: string; privateKey?: string },
  secretsEnvKey?: string,
): Promise<AppCreds | null> {
  if (envCreds.appId && envCreds.privateKey) return { appId: envCreds.appId, privateKey: envCreds.privateKey };
  const [appId, privateKey] = await Promise.all([
    getSetting(db, SETTING_KEYS.githubAppId),
    getSetting(db, SETTING_KEYS.githubPrivateKey),
  ]);
  if (!appId || !privateKey) return null;
  try {
    const key = await resolveSecretsKey(db, secretsEnvKey);
    return { appId, privateKey: await decryptSettingValue(key, privateKey) };
  } catch {
    return null;
  }
}
