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
npm run types

# local D1 + queues (simulated)
npm run dev

# create resources (first deploy auto-provisions with these names)
npx wrangler d1 create flare-actions
npx wrangler queues create flare-actions-runs
npx wrangler queues create flare-actions-dlq
npx wrangler d1 migrations apply flare-actions --remote

# secrets (never commit values)
wrangler secret put GITHUB_WEBHOOK_SECRET --config apps/worker/wrangler.jsonc
wrangler secret put RUNNER_TOKEN --config apps/worker/wrangler.jsonc
# optional for commit-status callbacks:
wrangler secret put GITHUB_APP_ID --config apps/worker/wrangler.jsonc
wrangler secret put GITHUB_PRIVATE_KEY --config apps/worker/wrangler.jsonc

npm run deploy
```

## GitHub App setup

1. Create a GitHub App: webhook URL `https://<worker>/webhooks/github`, permissions: Contents read, Commit statuses write, Checks write (optional).
2. Subscribe to `push`, `pull_request`, `workflow_dispatch`.
3. Set webhook secret → `GITHUB_WEBHOOK_SECRET`. App ID + PEM → `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`.
4. Install the App on your repo.

## Runner

```bash
export FLARE_ACTIONS_URL=https://<worker>
export RUNNER_TOKEN=[redacted]
npm --workspace apps/runner start
```

MVP runner executes a safe echo step. Bring your own executor next.

## CLI

```bash
export FLARE_ACTIONS_URL=https://<worker>
export RUNNER_TOKEN=[redacted]
npm --workspace apps/cli start -- runs
npm --workspace apps/cli start -- logs <runId>
```

## API

- `POST /webhooks/github` — GitHub App webhook (HMAC verified)
- `GET /v1/runs` — list runs (runner token)
- `GET /v1/runs/:id` — run + jobs (runner token)
- `GET /v1/jobs/next` — pull next queued job (runner token)
- `POST /v1/runs/:id/status` — runner status callback (runner token)

## License

MIT — see [LICENSE](LICENSE).
