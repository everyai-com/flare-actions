# Error codes

Failures on the core lanes (dispatch, dry-run, claim, webhook, auth,
pairing) return a stable `code` plus a `hint` naming the next step:

```json
{ "error": "token is not scoped to that repo", "code": "repo_not_allowed", "hint": "mint a token scoped to that owner/name in the dashboard Access tab, or drop the repo allowlist" }
```

The human `error` string keeps its wording, so clients that only read
`.error` see no change. `FlareApiError` (runner SDK) carries `status` /
`code` / `hint`; the CLI prints `hint [code]: …` on stderr after the
error line. Other routes still return bare `{ error }` — codes expand
lane by lane.

| code | status | meaning | next step |
| ---- | ------ | ------- | --------- |
| `unauthorized` | 401 | missing/invalid token or wrong scope | pass a token with the right scope (`Authorization: Bearer <token>`) |
| `repo_not_allowed` | 403 | token allowlist excludes the repo | mint a token scoped to that owner/name |
| `invalid_request` | 400 | field validation failed | fix the named field and retry |
| `invalid_pipeline` | 400 | inline `pipeline` did not parse | validate with `cli local`; read `docs/PIPELINES.md` |
| `unresolvable_ref` | 400 | branch/tag resolved to nothing | paste a full commit SHA |
| `unknown_profile` | 400 | `profile` names nothing in `flare.yml` | drop `--profile` / the field, or add the profile |
| `budget_exceeded` | 429 | monthly compute-minute cap hit (block mode) | raise `budgetMinutes` or wait for reset |
| `egress_policy_violation` | 400 | job declares domains outside the repo allowlist | narrow `egress.allow` or widen the repo list |
| `repo_paused` | 429 | repo auto-paused for runaway spend | resume in Settings → Budgets or `cli resume` |
| `rate_limited` | 429 | too many auth/pairing attempts | wait a minute and retry |
| `webhook_not_configured` | 500 | no webhook secret set | set it in dashboard Settings |
| `bad_signature` | 401 | HMAC mismatch | check `GITHUB_WEBHOOK_SECRET` matches the App |
| `payload_too_large` | 413 | webhook body over the cap | shrink the payload |
| `invalid_delivery` | 400 | malformed `X-GitHub-Delivery` | let GitHub deliver normally |
| `invalid_json` | 400 | webhook body was not JSON | check content type is `application/json` |
| `missing_repo_or_sha` | 400 | event lacks repo or SHA | must be a push / pull_request with repo + head SHA |
| `invalid_credentials` | 401 | wrong email/password | check credentials or reset the password |
| `already_claimed` | 403 | bootstrap after first admin | log in (`ADMIN_TOKEN` recovers a lost admin) |
| `invite_invalid` | 404 | invite unknown/consumed/expired | ask an admin for a fresh link |
| `email_taken` | 409 | email already registered | log in instead |
| `pairing_required` | 400 | exchange without a code | mint a code in dashboard Access first |
| `pairing_invalid` | 404 | code unknown/consumed/expired | mint a fresh code (single-use, 10 min) |
| `token_mint_failed` | 503 | installation token mint failed | reconnect the GitHub App, retry |
| `jit_mint_failed` | 503 | GitHub JIT config mint failed | check `administration:write`, reinstall, retry |
| `runner_group_unknown` | 503 | Runner group not found in the org | create the group, or fix its name in Settings |
| `plan_limit_exceeded` | 429 | hosted plan saturated (concurrent jobs at cap) | raise the cap in Cloud billing, or wait for drain |
| `hosted_only` | 501 | Cloud surface hit on a self-hosted deploy | runs on Flare Cloud only; OSS stays unlimited |
| `topup_invalid` | 404 | top-up link unknown/consumed/expired | ask an admin for a fresh link |
