# Flare Actions

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/flare-actions)

Open-source GitHub Actions alternative you host on your own Cloudflare account.
One click deploys the Worker and auto-provisions its D1 database and queues.

GitHub App webhook → Worker (verify) → D1 run row → Queue dispatch → external pull-runner → status callback. Dashboard + API + CLI.

## Why

- Faster: warm edge dispatch, no 2–3 min hosted queue waits.
- Easier: TypeScript + `wrangler.jsonc`, local `wrangler dev`, no YAML push-test loop.
- Better: durable dispatch signals with Queue retry + DLQ, D1 run history,
  fully open and self-hosted.

## Layout

- `apps/worker` — Cloudflare Worker: webhook verify, dispatch API, MCP
  server, dashboard + admin API, queue consumer, D1 state, R2 cache/artifacts
- `packages/runner-sdk` — shared client (pull/status/cache/artifacts),
  job orchestrator, Actions importer
- `apps/runner` — external pull-runner: labels, checkout, containers,
  services, cache, artifacts
- `apps/cli` — CLI: runs, logs, dispatch, rerun, flaky, import, badges, MCP config
- `apps/seats` — managed executor worker (seat DO + container image)
- `docs/` — [pipeline reference](docs/PIPELINES.md),
  [runners](docs/RUNNERS.md), [MCP](docs/MCP.md),
  [roadmap](docs/ROADMAP.md), [economics](docs/ECONOMICS.md)

## Quickstart

**One click (no terminal):** hit **Deploy to Cloudflare** above, then open
`https://&lt;your-worker&gt;/dashboard`:

1. Open the dashboard and **create your admin account** (email +
   password) — first signup claims admin.
2. Hit **Connect GitHub** (one click, no naming — the App name is
   automatic), install the App on your repos, and push. Prefer GitHub
   login? Connect first, then Login with GitHub instead. Invite
   teammates by email from the Access tab; managed seats need nothing
   else, and runner tokens are only for BYO machines.

**From source:**

```bash
npm install
npm run setup   # provisions D1 + queues + R2, deploys, writes gitignored .env
```

`setup` prints your Worker URL. Open the dashboard, Connect GitHub,
install the App, Login with GitHub — then run with zero config:

```bash
npm run runner            # external pull-runner (reads .env automatically)
npm run cli -- runs       # list runs
npm run cli -- logs <id>  # run logs
```

Manual fallback (if you prefer each step by hand): `wrangler d1 create`,
`wrangler queues create` × 4 (`-runs`, `-dlq`, `-seats`, `-seats-dlq`),
`wrangler r2 bucket create flare-actions-cache`,
`wrangler d1 migrations apply --remote`, `wrangler secret put` for
`RUNNER_TOKEN`, then `npm run deploy` — Connect GitHub in the
dashboard manages the webhook secret + App credentials, and the first
GitHub login claims admin. Only set GitHub values as env secrets if
you want the manual App flow instead (then also set `ADMIN_TOKEN`,
which becomes the dashboard recovery password). Local dev:
`npm run dev`.

## GitHub App setup

**One click:** dashboard → Settings → **Connect GitHub**. GitHub shows a
pre-filled App (Contents read, Pull requests read, Commit statuses write,
Checks write, `push` + `pull_request` events, webhook URL wired) — click
Create, then install it on your repos. App ID, private key, and webhook
secret land in D1, so the main worker and managed seats both pick them
up. The checks:write permission is what makes failures show up as rich
Check Runs (failing command + output tail) on the PR page; apps created
before it existed just need the permission added in App settings.

**Manual fallback** (env-managed instead): create the App yourself with
the same permissions/events and webhook URL
`https://<worker>/webhooks/github`, then set `GITHUB_WEBHOOK_SECRET`,
`GITHUB_APP_ID`, and `GITHUB_PRIVATE_KEY` via `wrangler secret put`
(env takes precedence; Connect refuses while any of them is set).
Install the App on your repo either way.

## Dashboard

Open `https://<worker>/dashboard` and log in with GitHub or email
(first login of either kind claims admin). Allow more GitHub users or
invite teammates by email in the Access tab. The CLI works with any
token scope — `readonly` reads, `runner` also dispatches and reruns;
issue named tokens in the Access tab.

- **Runs** — see every run and drill into job logs; admins can dispatch
  runs by branch, tag, or SHA, and re-run finished jobs from the detail view.
  Every terminal job also posts a GitHub **Check Run** — the PR page shows
  the failing command, its output tail, and inline annotations parsed from
  `file:line` output — without opening the dashboard (requires the App's
  checks:write permission; commit statuses still work without it).
- **Access** — allow GitHub users (view runs), invite teammates by
  email (single-use links, 24h), and issue named tokens: `runner`
  tokens pull jobs and report status (CI machines, teammates),
  `readonly` tokens only view runs, `admin` tokens do everything (CLI
  admin commands). Each token is shown once at creation;
  revoke any token and it stops working immediately.

## Preview environments

Every branch gets an isolated staging environment — separate D1 database
and queues from production — via Cloudflare Worker Previews:

```bash
git checkout -b my-feature
npx wrangler preview --config apps/worker/wrangler.jsonc
# → https://my-feature-flare-actions.<you>.workers.dev
```

All previews share one staging database (isolated from prod, not from each
other). Preview secrets live in the shared base config, distinct from prod
values — set once with `wrangler preview base-config secret put NAME`.
Delete a preview with `wrangler preview delete --name my-feature`.

On pull requests, CI deploys a preview automatically once you add
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets. Mint that
token with the per-Worker **Editor** role scoped to your Worker plus D1 and
Queues edit access — least privilege for CI and agents, per [Cloudflare's
granular authorization launch](https://blog.cloudflare.com/workers-granular-authorization/).

## Pipelines (`flare.yml`)

Put a `flare.yml` in your repo root. On every push, Flare fetches it at
that exact commit, fans out one job per entry, and runners execute the
steps:

```yaml
jobs:
  test:
    steps:
      - run: node --version
      - run: npm ci && npm test
```

- Lookup: `flare.yml` at the push SHA (public fast path, no auth;
  private repos via the GitHub App installation token). Missing or
  invalid files fall back to one default echo job — pushes never fail
  to dispatch.
- Each step runs as `sh -c` in a fresh temp dir with `FLARE_REPO`,
  `FLARE_SHA`, `FLARE_RUN_ID`, `FLARE_JOB_ID`, and `CI=true` (GitHub
  parity) in the environment.
- Steps stop at the first non-zero exit; 10 min timeout and 32 KB of
  captured output per step. A step marked `continue-on-error: true`
  is recorded as failed but doesn't fail the job. Steps accept a bounded
  `if:` subset — `always()`, `failure()`, `success()`, `cancelled()` and
  `!fn()` negations — so cleanup and notification steps still run after a
  failure. Jobs can declare `retry: 2` (0–5): a failed attempt requeues
  automatically until the budget is exhausted, so flaky suites stop
  paging humans. Limits: 32 jobs, 100 steps/job, 64 KB file.
- Every job records machine-readable results (`result` JSON: per-step
  command, exit code, duration, output) alongside the human log — this
  is what agents consume to triage failures.
- `${{ secrets.NAME }}` in steps and `env` reads per-repo secrets
  (Settings tab, write-only), encrypted at rest and masked in logs.

Full reference (matrix, `needs`, concurrency, containers, services,
cache, artifacts, labels, timeouts): [docs/PIPELINES.md](docs/PIPELINES.md).

## Scheduled runs

Cron schedules live on the deployment — dashboard → Settings → Schedules,
or `GET|POST|DELETE /v1/admin/schedules` — not in `flare.yml`: a repo, a
ref (branch or tag), and a 5-field UTC cron, checked every minute by a
Worker cron trigger. Each entry shows its last dispatch attempt, so a
schedule that silently stops is visible instead of invisible — the exact
failure mode GitHub's best-effort `on: schedule` is known for. Previews
never fire schedules, failed attempts are stamped (no hot-looping), and
a schedule's run gets commit statuses and private-repo pipeline fetching
like any other dispatch.

## Runner

```bash
npm run runner
```

No env setup needed — `.env` from `setup` is loaded automatically
(explicit env vars still win). The runner shallow-checkouts the repo at
the push SHA into a temp dir (needs `git`; set `GITHUB_TOKEN` for
private repos) and executes each step there.

Runners advertise `[os, arch, ...FLARE_LABELS]` and only take jobs whose
`runs-on` labels they all carry — this is how macOS, Windows, GPU, and
docker boxes coexist. Any OS runs the same protocol; see
[docs/RUNNERS.md](docs/RUNNERS.md). Job caches and artifacts live in
your deployment's R2 bucket (created by `npm run setup`).

Prefer zero boxes? `npm run setup` also provisions the **managed
executor**: scale-to-zero seat containers on Cloudflare that pick up
eligible Linux jobs automatically, with BYO runners as the backstop.
See [docs/CONTAINERS.md](docs/CONTAINERS.md).

## MCP server (agents)

Every deployment is an MCP server at `/mcp`: list runs, read logs and
triage, dispatch runs, **run and wait in one call** with compact
digests, re-run jobs, check flakes, generate pipelines.
`npm run cli -- mcp-config` prints a paste-ready client config; details
in [docs/MCP.md](docs/MCP.md).

## Built for agents

GitHub Actions is built for humans — commit, push, then stare at a queue.
Flare is built for agents: trigger, wait, and read results over the API,
MCP, or CLI. No git ceremony, no sleep loops, no log spelunking.

- **One-call verify loop** — `run_and_wait` (MCP) or `cli run` dispatches
  and blocks until the run is terminal
  (`GET /v1/runs/:id/wait?timeout=60` under the hood). Verify → fix →
  repeat, without a polling loop.
- **Zero-latency inner loop** — `cli local` runs `flare.yml` in the current
  working tree, on this machine, with no server and no commit: the
  working-tree code, a warm local cache (`~/.flare/cache`), artifacts in
  `.flare/artifacts/`, and the same execution engine as the server
  (`continue-on-error`, `if:`, needs, matrix). Server dispatch stays the
  parity check.
- **Priority lane** — `priority: 0–10` on dispatch jumps queued batch
  work, so an agent's verification beats the nightly backlog.
- **Token-efficient digests** — `GET /v1/runs/:id/digest` (or
  `get_run_digest`) returns each job's failing step command, exit code, a
  bounded output tail, and AI triage in a few KB — context-window friendly,
  no megabyte logs.
- **Near-instant pickup** — BYO runners poll every 2s idle / 500ms after a
  job; managed seats wake immediately over the queue.
- **Machine-readable everything** — per-step structured results with exit
  codes and durations; the dashboard is optional.
- **No git required** — dispatch by SHA or branch with an inline
  `pipeline` to try a workflow without merging it anywhere.

```bash
# agent inner loop: run the working tree locally, no server, no commit
npm run cli -- local                 # all jobs; warm cache across runs
npm run cli -- local test --file flare.yml

# agent verify loop: dispatch, wait, print the digest (exit 1 on failure)
npm run cli -- run owner/repo "$(git rev-parse HEAD)" --priority 9
npm run cli -- watch <runId>        # block on an existing run + digest
npm run cli -- dispatch owner/repo main --priority 9   # fire and forget
```

## Importing from GitHub Actions

```bash
npm run cli -- import .github/workflows/ci.yml > flare.yml
```

Translates `runs-on`, steps, matrices, needs, concurrency, containers,
services, caches, and artifacts; everything unmappable becomes a warning
on stderr (exit stays 0) so you see exactly what needs a human eye.

## Status badges

Public, embeddable, no token needed:

```markdown
[![flare](https://<worker>/v1/badge.svg?repo=owner/name&branch=main)](https://<worker>/dashboard)
```

`npm run cli -- badge owner/name main` prints the snippet. For
private repositories, list them under Settings → Status badges so the
public endpoint serves `unknown` instead of leaking pass/fail. For
required-checks UX, the GitHub App already posts commit statuses on
every run — mark them required in repo Settings → Branches.

## AI failure triage

Every failed job is triaged automatically by Workers AI
(`@cf/meta/llama-3.1-8b-instruct-fp8-fast`, inside the 10k-neurons/day
free tier): likely cause, culprit file/command, and one concrete fix.
It appears on the job in the dashboard and CLI. Forks without the AI
binding simply skip triage — nothing breaks.

## Notifications

Every finished run emails all registered email users: status, branch,
jobs, cost, and the AI triage excerpt on failures. Set the sender in
dashboard Settings → Run notifications (the domain must be enabled for
[Email Sending](https://developers.cloudflare.com/email-service/) first);
pick all completions, failures only, or off. Env `NOTIFY_FROM_EMAIL`
overrides the dashboard value. Deployments without a sender simply
skip — nothing breaks.

**Chat webhooks:** paste a Slack, Discord, or Mattermost-compatible
webhook URL in Settings → Run notifications and the same summary posts
there on every finished run — independently of email, so it works even
with no sender configured. The URL is write-only and encrypted at rest
with the secrets data key.

## CLI

```bash
npm run cli -- runs                    # list runs
npm run cli -- local [job]             # run flare.yml here (no server, warm cache)
npm run cli -- run <repo> <sha>        # dispatch, wait, print the compact digest (exit 1 on failure)
npm run cli -- watch <runId>           # wait on an existing run + digest
npm run cli -- logs <runId>            # jobs, steps, triage, logs
npm run cli -- dispatch <repo> <sha> [--priority N]   # trigger a run
npm run cli -- rerun <runId> <jobId>   # reset a finished job
npm run cli -- flaky <repo>            # per-job failure rates
npm run cli -- artifacts <runId>       # list artifacts
npm run cli -- badge <repo> [branch]   # badge snippet
npm run cli -- import <workflow.yml>   # Actions -> flare.yml
npm run cli -- mcp-config              # MCP client config
```

## API

- `GET /dashboard` — dashboard UI (`/` redirects here)
- `POST /webhooks/github` — GitHub App webhook (HMAC verified)
- `GET /mcp` — MCP server metadata (public); `POST /mcp` — MCP JSON-RPC
- `POST /v1/runs/dispatch` — trigger a run by SHA, branch, or tag, optional inline `pipeline` and `priority` (0–10)
- `GET /v1/runs/:id/wait?timeout=` — block until terminal (1–90s), returns the run + `timedOut`
- `GET|POST|DELETE /v1/admin/secrets` — repo secrets, names listed, values write-only (admin only)
- `GET /v1/runs?limit=&offset=` — list runs, newest first (admin, runner, or readonly token; limit 1–200)
- `GET /v1/runs/:id` — run + jobs + cost summary (admin, runner, readonly)
- `GET /v1/runs/:id/digest` — compact agent digest: failing steps, bounded tails, triage (read scope)
- `GET /v1/runs/:id/artifacts` — list a run's artifacts (read scope)
- `GET /v1/jobs/next?labels=` — pull next matching queued job (run scope)
- `POST /v1/runs/:id/status` — runner status callback (admin or runner token)
- `POST /v1/runs/:id/jobs/:jobId/rerun` — reset a finished job (run scope)
- `POST /v1/runs/:id/jobs/:jobId/heartbeat` — executor liveness; running jobs quiet 20m+ are requeued (run scope)
- `PUT|GET /v1/cache/:key` — build cache blobs (run scope)
- `PUT|GET /v1/jobs/:jobId/artifacts/:name` — artifacts (run to write, read to fetch)
- `GET /v1/badge.svg?repo=&branch=` — status badge (public)
- `GET /v1/flaky?repo=&days=` — per-job failure rates (read scope)
- `GET /v1/admin/tokens` — list access tokens (admin only)
- `POST /v1/admin/tokens` — issue a token, shown once (admin only)
- `POST /v1/admin/tokens/:id/revoke` — revoke a token (admin only)
- `GET /v1/admin/audit` — audit log (admin only)
- `GET|POST /v1/admin/schedules` — list / create cron schedules (admin only)
- `POST /v1/admin/schedules/:id` — enable or disable a schedule (admin only)
- `DELETE /v1/admin/schedules/:id` — delete a schedule (admin only)
- `POST /v1/admin/generate` — natural language → `flare.yml` (admin only)
- `GET|POST /v1/admin/settings` — webhook secret, run notifications, badge visibility (admin only)
- `GET /v1/admin/users` — allowed GitHub users, email users, invites (admin only)
- `POST /v1/admin/users|users/email|users/invite` — allow/remove users, mint single-use invite links (admin only)
- `POST /v1/admin/register` — redeem an invite (public, throttled)
- `POST /v1/admin/bootstrap` — first-run admin claim (open until claimed, throttled)
- `POST /v1/admin/login`, `POST /v1/admin/logout` — email sessions (throttled)
- `GET|POST /v1/admin/github/*` — GitHub App connect + login flows
- `GET /v1/admin/status` — setup state for the dashboard (public)

## Cost

The core — webhooks, dispatch, dashboard, D1 history, queues, R2
cache/artifacts — fits Cloudflare's free tier at small-to-medium scale:
Workers (100k requests/day), Queues (10k operations/day ≈ 3,300
dispatches/day), D1 (5M rows read + 100k rows written/day, 5 GB storage),
R2 (10 GB storage, zero egress). The **managed seats** executor adds
Cloudflare Containers, which need the Workers Paid plan ($5/mo base) —
BYO runners stay free. Retention keeps storage honest: finished runs and
their artifacts prune after 90 days, cache blobs after 90 days without a
hit, all bounded per pass. Every run reports its compute minutes
plus the Actions list-price equivalent, so the gap is a number, not a claim.
See [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/), and
[R2](https://developers.cloudflare.com/r2/pricing/) pricing.

## Give it to your agent

Clone the repo and point any coding agent at it — [AGENTS.md](AGENTS.md)
teaches it the stack, commands, architecture, and conventions.
`npm run setup` is fully non-interactive (preview with
`npm run setup -- --dry-run`), and `npm test` / `npm run typecheck`
verify every change. For Cloudflare access, mint the agent a per-Worker
**Editor** token (plus D1/Queues edit) as described above — never your
account-wide credentials. (Cloudflare's new `cf` CLI, open beta since
2026-09-28, looks promising for agent-driven Cloudflare work; until it
stabilizes, wrangler remains this repo's supported path.)

## License

MIT — see [LICENSE](LICENSE).
