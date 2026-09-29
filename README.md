# Flare Actions

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/flare-actions)

Open-source GitHub Actions alternative you host on your own Cloudflare account.
One click deploys the Worker and auto-provisions its D1 database and queues.

GitHub App webhook → Worker (verify) → D1 run row → Queue dispatch → external pull-runner → status callback. Dashboard + API + CLI.

## Why

- Faster: warm edge dispatch, no 2–3 min hosted queue waits.
- Easier: TypeScript + `wrangler.jsonc`, local `wrangler dev`, no YAML push-test loop.
- Better: durable Queue retry + DLQ, D1 run history, fully open and self-hosted.

## Layout

- `apps/worker` — Cloudflare Worker: webhook verify, dispatch API, dashboard + admin API, queue consumer, D1 state
- `packages/runner-sdk` — shared types + pull/status client for runners
- `apps/runner` — minimal external pull-runner (polls jobs, runs, posts status)
- `apps/cli` — minimal CLI for runs and logs

## Quickstart

**One click (no terminal):** hit **Deploy to Cloudflare** above, then open
`https://&lt;your-worker&gt;/dashboard`:

1. Create your admin password (first-run setup, shown once ever).
2. Save your GitHub webhook secret in the Settings tab.
3. Issue runner tokens in the Access tab and create the GitHub App below.

**From source:**

```bash
npm install
npm run setup   # provisions D1 + queues, deploys, writes gitignored .env
```

`setup` prints your Worker URL and webhook secret. Then create the GitHub App
below, and run with zero config:

```bash
npm run runner            # external pull-runner (reads .env automatically)
npm run cli -- runs       # list runs
npm run cli -- logs <id>  # run logs
```

Manual fallback (if you prefer each step by hand): `wrangler d1 create`,
`wrangler queues create` × 2, `wrangler d1 migrations apply --remote`,
`wrangler secret put` for `GITHUB_WEBHOOK_SECRET` / `RUNNER_TOKEN` /
`ADMIN_TOKEN` (plus `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` for commit
statuses), then `npm run deploy`. Local dev: `npm run dev`.

## GitHub App setup

1. Create a GitHub App: webhook URL `https://<worker>/webhooks/github`, permissions: Contents read, Commit statuses write, Checks write (optional).
2. Subscribe to `push`, `pull_request`, `workflow_dispatch`.
3. Set webhook secret → `GITHUB_WEBHOOK_SECRET`. App ID + PEM → `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`.
4. Install the App on your repo.

## Dashboard

Open `https://<worker>/dashboard` and log in with your `ADMIN_TOKEN`
(shown once by `npm run setup`, kept in gitignored `.env`).

- **Runs** — see every run and drill into job logs.
- **Access** — issue named tokens to hand out: `runner` tokens can pull
  jobs and report status (for CI machines and teammates), `readonly`
  tokens can only view runs. Each token is shown once at creation;
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
  `FLARE_SHA`, `FLARE_RUN_ID`, `FLARE_JOB_ID` in the environment.
- Steps stop at the first non-zero exit; 10 min timeout and 32 KB of
  captured output per step. Limits: 32 jobs, 100 steps/job, 64 KB file.
- Every job records machine-readable results (`result` JSON: per-step
  command, exit code, duration, output) alongside the human log — this
  is what agents consume to triage failures.

## Runner

```bash
npm run runner
```

No env setup needed — `.env` from `setup` is loaded automatically
(explicit env vars still win). The runner shallow-checkouts the repo at
the push SHA into a temp dir (needs `git`; set `GITHUB_TOKEN` for
private repos) and executes each step there.

## AI failure triage

Every failed job is triaged automatically by Workers AI
(`@cf/meta/llama-3.1-8b-instruct-fp8-fast`, inside the 10k-neurons/day
free tier): likely cause, culprit file/command, and one concrete fix.
It appears on the job in the dashboard and CLI. Forks without the AI
binding simply skip triage — nothing breaks.

## CLI

```bash
npm run cli -- runs
npm run cli -- logs <runId>
```

## API

- `GET /dashboard` — dashboard UI (`/` redirects here)
- `POST /webhooks/github` — GitHub App webhook (HMAC verified)
- `GET /v1/runs` — list runs (admin, runner, or readonly token)
- `GET /v1/runs/:id` — run + jobs (admin, runner, or readonly token)
- `GET /v1/jobs/next` — pull next queued job (admin or runner token)
- `POST /v1/runs/:id/status` — runner status callback (admin or runner token)
- `GET /v1/admin/tokens` — list access tokens (admin only)
- `POST /v1/admin/tokens` — issue a token, shown once (admin only)
- `POST /v1/admin/tokens/:id/revoke` — revoke a token (admin only)

## Cost

Runs entirely on Cloudflare's free tier at small-to-medium scale:
Workers (100k requests/day), Queues (10k operations/day ≈ 3,300
dispatches/day), D1 (5M rows read + 100k rows written/day, 5 GB storage).
See [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/), and
[D1](https://developers.cloudflare.com/d1/platform/pricing/) pricing.

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
