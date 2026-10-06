# Cloudflare API tokens (least privilege)

Agents, CI preview deploys, and `cli usage` dollars all need Cloudflare
API access — each with the smallest permission set that works. Mint
with the helper (needs a parent credential that can manage tokens):

```bash
npm run token:mint -- --profile ci --account <id>       # CI preview deploys
npm run token:mint -- --profile debug --account <id>    # read-only agent debugging
npm run token:mint -- --profile billing --account <id>  # Billable Usage API
npm run token:mint -- --profile setup --account <id>    # full npm run setup
npm run token:mint -- --profile ci --dry-run            # print the policy only
```

Run setup with the token instead of full-access OAuth (wrangler
honors the env automatically; setup's Artifacts REST calls reuse it):

```bash
CLOUDFLARE_API_TOKEN=<setup-token> CLOUDFLARE_ACCOUNT_ID=<id> npm run setup
```

Without a capable parent credential the command prints the exact
dashboard checklist instead (Create Token → Custom token → the groups
below, one account only). The value prints once: store it as
`CLOUDFLARE_API_TOKEN` (CI secrets for `ci`, local env for the rest).

## Profiles

| Profile | Permissions (account scope, one account) | Used by |
|---|---|---|
| `ci` | Workers Scripts Edit, D1 Edit, Queues Edit | `.github/workflows/ci.yml` preview job (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets) |
| `debug` | Workers Scripts Read, D1 Read, Queues Read, Account Settings Read, Audit Logs Read | debug agents, `wrangler tail/d1/queues` read-only work |
| `billing` | Billing Read | dashboard Settings → Cloudflare billing → `cli usage` dollars |
| `setup` | Workers Scripts Edit, D1 Edit, Queues Edit, Workers R2 Storage Edit, Workers Pipelines Edit, Containers Edit | `npm run setup` end to end (wrangler auth + Artifacts REST) |

Group names are resolved against the live permission-groups list at
mint time; any miss aborts with near-matches rather than minting a
half-permissioned token. Per-worker scoping can be tightened further
in the dashboard after minting.

## 403s

Cloudflare's enriched 403s link the missing permission. `setup`
echoes that link plus this fix path instead of failing bare: mint (or
re-mint) the matching profile above rather than widening to an
account key. If a mint fails with 403, the *parent* credential lacks
API Tokens Write — create the token in the dashboard checklist flow.
