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
  secretsKey: "secrets_key",
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
