export const SETTING_KEYS = {
  adminPasswordHash: "admin_password_hash",
  webhookSecret: "webhook_secret",
  githubAppId: "github_app_id",
  githubPrivateKey: "github_private_key",
  githubAppSlug: "github_app_slug",
} as const;

export function validateNewPassword(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < 12 || pw.length > 256) {
    return "password must be 12-256 characters";
  }
  return null;
}

export function validateWebhookSecret(secret: unknown): string | null {
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 512) {
    return "webhook secret must be 16-512 characters";
  }
  return null;
}
