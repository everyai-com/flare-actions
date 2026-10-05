// Worker environment: generated bindings (Env, from `npm run types`)
// plus optional secrets. Secrets are set via `wrangler secret put` /
// `.dev.vars`, never in wrangler.jsonc. `wrangler types` may or may not
// include them in the generated Env depending on whether `.dev.vars`
// exists, so intersect as optional: this compiles in both cases. Run
// `npm run types` to regenerate bindings after config changes.
export interface WorkerSecrets {
  GITHUB_WEBHOOK_SECRET?: string;
  RUNNER_TOKEN?: string;
  ADMIN_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  // Optional sender override for run emails; D1 notify_from_email fills
  // the gap (env wins, like every other credential).
  NOTIFY_FROM_EMAIL?: string;
  // Base64 32-byte data key for repo secrets; when absent a D1-held
  // key is auto-generated (works out of the box, weaker at-rest story).
  SECRETS_KEY?: string;
  // Turnstile bot defense for the auth endpoints; D1 settings fill
  // the gap (env wins, like every other credential). Unset = off.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  // AI Gateway id fronting Workers AI calls (triage/generate); D1
  // ai_gateway_id fills the gap (env wins). Unset = direct inference.
  AI_GATEWAY_ID?: string;
  // Billing-Read API token + account id for /v1/usage/billable (D1
  // billing_api_token / cloudflare_account_id fill the gaps; env wins).
  BILLING_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  // Triage model override (D1 triage_model fills the gap; unset =
  // TRIAGE_MODEL default). See docs/MODEL-EVAL.md before switching.
  TRIAGE_MODEL?: string;
  // "1" forces Web Search grounding for triage on (D1 triage_web_search
  // decides otherwise; anything else = D1 decides).
  TRIAGE_WEB_SEARCH?: string;
  // R2 bucket for cache + artifacts; absent on forks that skipped it.
  CACHE?: R2Bucket;
  // No seats binding here by design: wakes travel over the SEAT_QUEUE
  // producer (a plain queue binding like RUN_QUEUE), so the main worker
  // never couples — at deploy or runtime — to the seats worker.
}

export type WorkerEnv = Env & WorkerSecrets;
