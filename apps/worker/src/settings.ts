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
  billingApiToken: "billing_api_token",
  cloudflareAccountId: "cloudflare_account_id",
  triageModel: "triage_model",
  healOnFailure: "heal_on_failure",
  openRegistration: "open_registration",
  budgetMinutes: "budget_minutes",
  budgetMode: "budget_mode",
  supersedeBranchRuns: "supersede_branch_runs",
  // Internal: last hourly fleet check (anomaly alerts + flaky quarantine).
  fleetCheckedAt: "fleet_checked_at",
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

// Self-healing runs (off by default — each failure costs model
// inference plus a draft PR on a flare-heal/* branch). Same boolean
// shape as above.
export function parseHealOnFailure(value: unknown): { on: boolean } | { error: string } {
  if (typeof value === "boolean") return { on: value };
  if (value === "1" || value === "true") return { on: true };
  if (value === "0" || value === "false" || value === "" || value === null || value === undefined) return { on: false };
  return { error: "healOnFailure must be a boolean" };
}

// Open registration (off by default — invite links and the GitHub
// allow-list stay the only way in). When on, anyone can create a
// non-admin reader account from the dashboard, by email (no invite)
// or by GitHub login. Same boolean shape as above.
export function parseOpenRegistration(value: unknown): { on: boolean } | { error: string } {
  if (typeof value === "boolean") return { on: value };
  if (value === "1" || value === "true") return { on: true };
  if (value === "0" || value === "false" || value === "" || value === null || value === undefined) return { on: false };
  return { error: "openRegistration must be a boolean" };
}

// Spend guardrails: monthly compute-minute caps per repo, entered as
// "owner/name=minutes, owner/other=minutes". Stored as JSON; `block`
// refuses new runs once a repo is over its cap, `warn` (default) keeps
// dispatching but audits the overage.
export function parseBudgetMinutes(value: unknown): { budgets: Record<string, number> } | { error: string } {
  if (value === null || value === undefined || value === "") return { budgets: {} };
  if (typeof value !== "string" || value.length > 4096) {
    return { error: "budgetMinutes must be a string like owner/name=1200, other/name=600" };
  }
  const budgets: Record<string, number> = {};
  for (const raw of value.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.lastIndexOf("=");
    if (eq <= 0) return { error: `budget entry must be owner/name=minutes: "${part}"` };
    const repo = part.slice(0, eq).trim();
    const minutes = Number(part.slice(eq + 1).trim());
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: `budget repo must be owner/name: "${repo}"` };
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1_000_000) {
      return { error: `budget minutes must be 1-1000000: "${part}"` };
    }
    budgets[repo] = minutes;
  }
  if (Object.keys(budgets).length > 50) return { error: "at most 50 budget entries" };
  return { budgets };
}

// Tolerant reader for the stored JSON map (hand-edited rows degrade to {}).
export function parseStoredBudgets(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [repo, minutes] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) out[repo] = minutes;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseBudgetMode(value: unknown): { mode: "warn" | "block" } | { error: string } {
  if (value === "warn" || value === "block") return { mode: value };
  if (value === null || value === undefined || value === "") return { mode: "warn" };
  return { error: "budgetMode must be warn or block" };
}

// Auto-supersede: "push" cancels still-active jobs of earlier runs on the
// same branch when a new push arrives (one run per branch head); "off"
// (default) keeps every push's run.
export function parseSupersedeBranchRuns(value: unknown): { mode: "off" | "push" } | { error: string } {
  if (value === "off" || value === "push") return { mode: value };
  if (value === null || value === undefined || value === "" || value === "0" || value === "false") return { mode: "off" };
  return { error: "supersedeBranchRuns must be off or push" };
}

// Billing-Read API token for the Billable Usage API (write-only,
// encrypted at rest like the chat webhook). Tokens are long opaque
// strings; empty clears.
export function validateBillingApiToken(token: unknown): string | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 512) {
    return "billing API token must be 20-512 characters";
  }
  return null;
}

// Cloudflare account id scoping billable-usage reads (32 hex chars).
export function validateCloudflareAccountId(id: unknown): string | null {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/i.test(id.trim())) {
    return "Cloudflare account id must be 32 hex characters";
  }
  return null;
}

// Triage model override (see docs/MODEL-EVAL.md for the measured
// trade-offs). Workers AI model id; empty clears to the default.
export function validateTriageModel(model: unknown): string | null {
  if (typeof model !== "string" || !/^@[A-Za-z0-9/_.-]{1,127}$/.test(model.trim())) {
    return "triage model must be a Workers AI model id like @cf/vendor/name";
  }
  return null;
}
