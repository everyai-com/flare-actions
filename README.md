# Flare Actions

Open-source GitHub Actions alternative you host on your own Cloudflare account.

MVP A: GitHub App webhook → Worker (verify) → D1 run row → Queue dispatch → external pull-runner → status callback. API + CLI, no dashboard yet.

## Why

- Faster: warm edge dispatch, no 2–3 min hosted queue waits.
- Easier: TypeScript + `wrangler.jsonc`, local `wrangler dev`, no YAML push-test loop.
- Better: durable Queue retry + DLQ, D1 run history, fully open and self-hosted.

## Layout

- `apps/worker` — Cloudflare Worker: webhook verify, dispatch API, queue consumer, D1 state
- `packages/runner-sdk` — shared types + pull/status client for runners
- `apps/runner` — minimal external pull-runner (polls jobs, runs, posts status)
- `apps/cli` — minimal CLI for runs and logs

## Quickstart

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
`wrangler secret put` for `GITHUB_WEBHOOK_SECRET` / `RUNNER_TOKEN`
(plus `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` for commit statuses), then
`npm run deploy`. Local dev: `npm run dev`.

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

## Runner

```bash
npm run runner
```

No env setup needed — `.env` from `setup` is loaded automatically
(explicit env vars still win). MVP runner executes a safe echo step.
Bring your own executor next.

## CLI

```bash
npm run cli -- runs
npm run cli -- logs <runId>
```

## API

- `POST /webhooks/github` — GitHub App webhook (HMAC verified)
- `GET /v1/runs` — list runs (runner token)
- `GET /v1/runs/:id` — run + jobs (runner token)
- `GET /v1/jobs/next` — pull next queued job (runner token)
- `POST /v1/runs/:id/status` — runner status callback (runner token)

## License

MIT — see [LICENSE](LICENSE).
