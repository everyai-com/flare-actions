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
} as const;

export function validateWebhookSecret(secret: unknown): string | null {
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 512) {
    return "webhook secret must be 16-512 characters";
  }
  return null;
}
