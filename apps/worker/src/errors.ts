// Machine-actionable API errors: every failure on the core lanes
// (dispatch, claim, webhook, auth, pairing) carries a stable `code`
// agents can switch on plus a `hint` naming the next step. The human
// `error` string stays first and keeps its wording, so existing
// clients that read `.error` see no change.

export const ERROR_CODES = [
  "unauthorized",
  "repo_not_allowed",
  "invalid_request",
  "invalid_pipeline",
  "unresolvable_ref",
  "unknown_profile",
  "budget_exceeded",
  "egress_policy_violation",
  "repo_paused",
  "rate_limited",
  "webhook_not_configured",
  "bad_signature",
  "payload_too_large",
  "invalid_delivery",
  "invalid_json",
  "missing_repo_or_sha",
  "invalid_credentials",
  "already_claimed",
  "invite_invalid",
  "email_taken",
  "pairing_required",
  "pairing_invalid",
  "token_mint_failed",
  "jit_mint_failed",
  "runner_group_unknown",
  "plan_limit_exceeded",
  "hosted_only",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HINTS: Record<ErrorCode, string> = {
  unauthorized: "pass a token with the right scope: Authorization: Bearer <token> (mint one in the dashboard Access tab)",
  repo_not_allowed: "mint a token scoped to that owner/name in the dashboard Access tab, or drop the repo allowlist",
  invalid_request: "fix the named field and retry",
  invalid_pipeline: "validate locally with `cli local`, or read docs/PIPELINES.md for the schema",
  unresolvable_ref: "paste a full commit SHA, or push the branch/tag so it resolves",
  unknown_profile: "drop --profile (or the profile field) to run every job, or add the profile to the flare.yml profiles block",
  budget_exceeded: "raise budgetMinutes in dashboard Settings, or wait for the monthly reset",
  egress_policy_violation: "narrow the job's egress.allow to the repo list, or widen the repo allowlist in dashboard Settings",
  repo_paused: "the repo was auto-paused for runaway spend — resume it in dashboard Settings → Budgets (or `cli resume owner/name`)",
  rate_limited: "too many attempts — wait a minute and retry",
  webhook_not_configured: "set the webhook secret in the dashboard Settings tab",
  bad_signature: "check GITHUB_WEBHOOK_SECRET matches the secret in the GitHub App settings",
  payload_too_large: "shrink the payload (pushes with huge file lists can exceed the cap)",
  invalid_delivery: "let GitHub deliver normally — hand-forged X-GitHub-Delivery ids must be 8-64 letters/digits/dashes",
  invalid_json: "the body was not JSON — check the webhook content type is application/json",
  missing_repo_or_sha: "push and pull_request events must carry repository.full_name and a head SHA",
  invalid_credentials: "check the email/password, or use password reset if locked out",
  already_claimed: "an admin already exists — log in instead (ADMIN_TOKEN recovers a lost admin)",
  invite_invalid: "invites are single-use and expire in 24h — ask an admin for a fresh link",
  email_taken: "that email already has an account — log in instead",
  pairing_required: "mint a single-use code in the dashboard Access tab first",
  pairing_invalid: "codes are single-use and expire in 10 minutes — mint a fresh one in the dashboard",
  token_mint_failed: "reconnect the GitHub App in the dashboard, then retry",
  jit_mint_failed: "check the App accepted administration:write (reinstall), then retry",
  runner_group_unknown: "create the runner group in the org (or fix its name in Settings), then retry",
  plan_limit_exceeded: "raise the concurrent-runner cap in Flare Cloud billing, or wait for running jobs to drain",
  hosted_only: "that surface runs on Flare Cloud only (FLARE_CLOUD=1) — self-hosted deploys stay free and unlimited",
};

export interface ApiErrorBody {
  error: string;
  code: ErrorCode;
  hint: string;
}

// Build the JSON body for a coded failure. `hint` overrides the
// catalog default when the route knows something more specific
// (e.g. which token scope the endpoint needs).
export function apiError(code: ErrorCode, message: string, hint?: string): ApiErrorBody {
  return { error: message, code, hint: hint ?? ERROR_HINTS[code] };
}

// dispatchRun throws plain Errors from its load phase; map the known
// messages to codes so the dispatch catch stays a one-liner.
export function dispatchErrorCode(message: string): ErrorCode {
  if (message === "pipeline parse failed") return "invalid_pipeline";
  if (message.startsWith("could not resolve ref")) return "unresolvable_ref";
  if (message.startsWith("unknown profile")) return "unknown_profile";
  if (message.includes("selected no jobs")) return "invalid_pipeline";
  if (message.startsWith("egress policy violation")) return "egress_policy_violation";
  return "invalid_request";
}
