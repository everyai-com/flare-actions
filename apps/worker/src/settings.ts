export const SETTING_KEYS = {
  webhookSecret: "webhook_secret",
  githubAppId: "github_app_id",
  githubPrivateKey: "github_private_key",
  githubAppSlug: "github_app_slug",
  githubClientId: "github_client_id",
  githubClientSecret: "github_client_secret",
  adminGithubUser: "admin_github_user",
  githubUsers: "github_users",
  adminEmail: "admin_email",
  notifyFromEmail: "notify_from_email",
  notifyMode: "notify_mode",
  notifyWebhookUrl: "notify_webhook_url",
  secretsKey: "secrets_key",
  badgeHiddenRepos: "badge_hidden_repos",
  turnstileSiteKey: "turnstile_site_key",
  turnstileSecretKey: "turnstile_secret_key",
  fairSharePerRepo: "fair_share_per_repo",
  aiGatewayId: "ai_gateway_id",
  mcpWriteConfirm: "mcp_write_confirm",
  triageWebSearch: "triage_web_search",
} as const;

export function validateWebhookSecret(secret: unknown): string | null {
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 512) {
    return "webhook secret must be 16-512 characters";
  }
  return null;
}

// Kept inline (not shared with email.ts) to avoid a settings<->email
// import cycle; exact deliverability is enforced by the send itself.
export function validateNotifyFromEmail(email: unknown): string | null {
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "notify sender must be a valid email address";
  }
  return null;
}

export function validateNotifyMode(mode: unknown): string | null {
  if (mode !== "all" && mode !== "failures" && mode !== "off") {
    return "notify mode must be all, failures, or off";
  }
  return null;
}

// Chat webhook destinations (Slack incoming webhooks, Discord, hosted
// Mattermost chat, …). https only — the URL itself is a credential.
export function validateNotifyWebhookUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length < 12 || url.length > 512) {
    return "webhook URL must be a 12-512 character https URL";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "webhook URL must be a valid https URL";
  }
  if (parsed.protocol !== "https:") return "webhook URL must use https";
  return null;
}

// Status badges are public by design; repos listed here serve "unknown"
// instead, so private repositories never leak pass/fail through a
// guessable owner/name. Comma-separated storage, case-insensitive match.
export function parseBadgeHiddenRepos(value: unknown): { repos: string[] } | { error: string } {
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) return { error: "badgeHiddenRepos must be a comma-separated string or an array" };
  const repos: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return { error: "badgeHiddenRepos entries must be strings" };
    const repo = item.trim();
    if (!repo) continue;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: `badgeHiddenRepos entry must be owner/name: ${repo}` };
    if (!repos.includes(repo)) repos.push(repo);
  }
  if (repos.length > 100) return { error: "badgeHiddenRepos supports at most 100 repos" };
  return { repos };
}

export function isBadgeHiddenRepo(raw: string | null, repo: string): boolean {
  if (!raw) return false;
  const needle = repo.toLowerCase();
  return raw.split(",").some((r) => r.trim().toLowerCase() === needle);
}

// Turnstile (bot defense for login/register/bootstrap/reset). The site
// key is public (shipped to the dashboard); the secret key encrypts at
// rest like the webhook secret. Either may come from env instead.
export function validateTurnstileSiteKey(key: unknown): string | null {
  if (typeof key !== "string" || !key.trim() || key.length > 128) {
    return "turnstile site key must be a non-empty string (max 128 chars)";
  }
  return null;
}

export function validateTurnstileSecretKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length < 16 || key.length > 512) {
    return "turnstile secret key must be 16-512 characters";
  }
  return null;
}

// Scheduling fairness: max concurrently running jobs per repo for the
// shared poll pool (0 = off, the default). Accepts the D1 string form
// and the admin API number form; anything else is an error.
export function parseFairSharePerRepo(value: unknown): { cap: number } | { error: string } {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 100) return { error: "fairSharePerRepo must be an integer 0-100 (0 disables)" };
  return { cap: n };
}

// AI Gateway id fronting inference (unified billing/logging/attribution).
// Gateway ids are URL slugs; empty clears back to direct inference.
export function parseAiGatewayId(value: unknown): { id: string } | { error: string } {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.trim())) {
    return { error: "aiGatewayId must be a 1-64 char slug ([a-z0-9_-])" };
  }
  return { id: value.trim() };
}

// MCP write-confirm gate (WriteGuard): when on, contained-write+ tools
// require confirm: true. Accepts booleans and "1"/"0".
export function parseMcpWriteConfirm(value: unknown): { on: boolean } | { error: string } {
  if (typeof value === "boolean") return { on: value };
  if (value === "1" || value === "true") return { on: true };
  if (value === "0" || value === "false" || value === "" || value === null || value === undefined) return { on: false };
  return { error: "mcpWriteConfirm must be a boolean" };
}

// Web Search grounding for triage (off by default — each failure costs a
// search call against gateway credits). Same boolean shape as above.
export function parseTriageWebSearch(value: unknown): { on: boolean } | { error: string } {
  if (typeof value === "boolean") return { on: value };
  if (value === "1" || value === "true") return { on: true };
  if (value === "0" || value === "false" || value === "" || value === null || value === undefined) return { on: false };
  return { error: "triageWebSearch must be a boolean" };
}
