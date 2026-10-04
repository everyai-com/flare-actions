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
