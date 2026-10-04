# Operating a Flare Actions deployment

Everything here applies to deployments created either by the **Deploy to
Cloudflare** button or by `npm run setup` — they are the same worker with
the same root `wrangler.jsonc`.

## What the button provisions (and what it does not)

The button reads the root `wrangler.jsonc` and auto-provisions the D1
database, R2 bucket, queues (`-runs`, `-dlq`, `-seats`, `-seats-dlq`),
and the Workers AI binding. It does not configure:

- **Managed seats** — run `npm run setup` on a machine with docker to
  build/push the seat image and deploy the seats worker.
- **Notification email** — set a sender in dashboard Settings (domain
  enabled for Email Sending) or `NOTIFY_FROM_EMAIL`.
- **Scheduled runs** — add them in dashboard Settings → Schedules.

## Updating a deployment

Run from a checkout of the repo you deployed (the button clones one into
your GitHub account, so update that clone):

```bash
git pull
npm ci
npm run deploy        # or re-run the button's deploy, or let Workers Builds do it
```

Schema changes self-heal: `ensureSchema()` runs on the first request
after a deploy and adds missing tables/columns. `apps/worker/migrations/`
exists for `wrangler d1 migrations apply` if you prefer tracked history.

If you use Workers Builds (the button default), pushing to the deployed
repo's `main` redeploys automatically.

## Backups and restore

- **D1** (runs, jobs, settings, users): `npx wrangler d1 export
  flare-actions --remote --output backup.sql` — schedule this wherever
  you keep backups; the file is a full SQL dump.
- **R2** (cache, artifacts, source uploads): cache and artifacts are
  derived data and prune automatically (90 days; sources after 7). No
  backup needed unless you treat artifacts as deliverables.
- Restore: `npx wrangler d1 execute flare-actions --remote --file
  backup.sql`.

## Secrets and rotation

| Secret | What it protects | Rotation |
| --- | --- | --- |
| `SECRETS_KEY` | AES-GCM key for repo secrets + stored GitHub App creds | Set once, ideally at setup. Rotating it makes existing ciphertext unreadable — re-enter repo secrets and reconnect GitHub afterwards. |
| `RUNNER_TOKEN` | Legacy env runner token | Revoke/issue tokens in the dashboard instead; unset the env var to retire it. |
| `ADMIN_TOKEN` | Break-glass login | Optional; rotate by `wrangler secret put ADMIN_TOKEN` with a new value. |
| GitHub App key / webhook secret | Connect flow manages these in D1 (encrypted) | Disconnect/reconnect GitHub in Settings, or edit the App in GitHub — the next Connect write re-encrypts. |
| API tokens | Runner/readonly/admin access | Revoke in the Access tab; revocations are immediate. |
| `SEATS_TOKEN` | Debug access to the seats worker URL | `wrangler secret put SEATS_TOKEN --config apps/seats/wrangler.jsonc` on the seats worker. |

Never put secret values in commands or config files — `wrangler secret
put` reads from stdin, and `.dev.vars` (local) is gitignored.

## Monitoring and troubleshooting

- **Logs**: `npx wrangler tail` for the main worker; every line is
  structured JSON. `wrangler tail flare-actions-seats` for seats.
- **Stuck jobs**: runners heartbeat and seats mirror progress; jobs quiet
  for 20 minutes are automatically requeued by the next webhook or status
  callback. No manual intervention needed.
- **Queue backlog**: check the Cloudflare dashboard Queues view. The runs
  queue and seats queue both have dead-letter queues; DLQ messages are
  dispatcher-side noise, not job failures.
- **Schema drift**: if a deploy half-applied, the next request re-runs
  `ensureSchema()`; to force it, hit `GET /v1/admin/status`.
- **Auth lockout**: login/register/reset throttle after repeated failures
  (15-minute windows). Waiting resolves it; `auth_attempts` rows are
  pruned automatically.
- **Emails not arriving**: the sender domain must be onboarded for
  Cloudflare Email Sending and the destination must be a verified address
  in that account — otherwise sends are skipped by design (the run still
  completes).

## Cost guardrails

- Workers, D1, and R2 fit the free tier at small scale; queues have a
  daily operation allowance. Managed seats need Workers Paid.
- Bound spend at the job level: `timeout-minutes` per job and per step,
  `retry: 0-5` to stop retry loops, and concurrency `cancel-in-progress`
  to keep only the newest run of a group.
- Retention is automatic: runs + artifacts prune after 90 days, cache
  after 90 days, source uploads after 7 days.
