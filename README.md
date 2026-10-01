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
`wrangler queues create` × 3 (`-runs`, `-dlq`, `-seats`),
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
pre-filled App (Contents read, Pull requests read, Commit statuses write, `push` +
`pull_request` events, webhook URL wired) — click Create, then install
it on your repos. App ID, private key, and webhook secret land in D1,
so the main worker and managed seats both pick them up.

**Manual fallback** (env-managed instead): create the App yourself with
the same permissions/events and webhook URL
`https://<worker>/webhooks/github`, then set `GITHUB_WEBHOOK_SECRET`,
`GITHUB_APP_ID`, and `GITHUB_PRIVATE_KEY` via `wrangler secret put`
(env takes precedence; Connect refuses while any of them is set).
Install the App on your repo either way.

## Dashboard

Open `https://<worker>/dashboard` and log in with GitHub or email
(first login of either kind claims admin). Allow more GitHub users or
invite teammates by email in the Access tab. For CLI admin commands,
issue an `admin` token in the Access tab instead.

- **Runs** — see every run and drill into job logs.
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
  `FLARE_SHA`, `FLARE_RUN_ID`, `FLARE_JOB_ID` in the environment.
- Steps stop at the first non-zero exit; 10 min timeout and 32 KB of
  captured output per step. Limits: 32 jobs, 100 steps/job, 64 KB file.
- Every job records machine-readable results (`result` JSON: per-step
  command, exit code, duration, output) alongside the human log — this
  is what agents consume to triage failures.

Full reference (matrix, `needs`, concurrency, containers, services,
cache, artifacts, labels, timeouts): [docs/PIPELINES.md](docs/PIPELINES.md).

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
triage, dispatch runs, re-run jobs, check flakes, generate pipelines.
`npm run cli -- mcp-config` prints a paste-ready client config; details
in [docs/MCP.md](docs/MCP.md).

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
required-checks UX, the GitHub App already posts commit statuses on
every run — mark them required in repo Settings → Branches.

## AI failure triage

Every failed job is triaged automatically by Workers AI
(`@cf/meta/llama-3.1-8b-instruct-fp8-fast`, inside the 10k-neurons/day
free tier): likely cause, culprit file/command, and one concrete fix.
It appears on the job in the dashboard and CLI. Forks without the AI
binding simply skip triage — nothing breaks.

## CLI

```bash
npm run cli -- runs                    # list runs
npm run cli -- logs <runId>            # jobs, steps, triage, logs
npm run cli -- dispatch <repo> <sha>   # trigger a run
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
- `POST /v1/runs/dispatch` — trigger a run, optional inline `pipeline`
- `GET /v1/runs` — list runs (admin, runner, or readonly token)
- `GET /v1/runs/:id` — run + jobs + cost summary (admin, runner, readonly)
- `GET /v1/runs/:id/artifacts` — list a run's artifacts (read scope)
- `GET /v1/jobs/next?labels=` — pull next matching queued job (run scope)
- `POST /v1/runs/:id/status` — runner status callback (admin or runner token)
- `POST /v1/runs/:id/jobs/:jobId/rerun` — reset a finished job (run scope)
- `PUT|GET /v1/cache/:key` — build cache blobs (run scope)
- `PUT|GET /v1/jobs/:jobId/artifacts/:name` — artifacts (run to write, read to fetch)
- `GET /v1/badge.svg?repo=&branch=` — status badge (public)
- `GET /v1/flaky?repo=&days=` — per-job failure rates (read scope)
- `GET /v1/admin/tokens` — list access tokens (admin only)
- `POST /v1/admin/tokens` — issue a token, shown once (admin only)
- `POST /v1/admin/tokens/:id/revoke` — revoke a token (admin only)
- `GET /v1/admin/audit` — audit log (admin only)
- `POST /v1/admin/generate` — natural language → `flare.yml` (admin only)

## Cost

Runs entirely on Cloudflare's free tier at small-to-medium scale:
Workers (100k requests/day), Queues (10k operations/day ≈ 3,300
dispatches/day), D1 (5M rows read + 100k rows written/day, 5 GB storage),
R2 (10 GB storage, zero egress). Every run reports its compute minutes
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
