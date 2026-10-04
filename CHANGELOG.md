# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are
tagged on `main` (`v0.1.0` is the first).

## [0.1.0] - 2026-10-04

### Added

- One-click deploy actually works now: the Deploy to Cloudflare button
  reads a root `wrangler.jsonc` deploy contract and auto-provisions D1,
  R2, queues, and Workers AI.
- npm packages prepared: `flare-actions-runner-sdk` and the `flare-actions`
  CLI (with a `flare` bin) ship TypeScript sources for Node's type
  stripping.
- `docs/OPERATIONS.md`: updating, D1 backup/restore, secret rotation,
  monitoring, and troubleshooting for self-hosters.
- Password reset: self-serve, single-use 1-hour email link, throttled,
  generic responses (no account enumeration); completing a reset drops
  every session for the account.
- Per-repo tokens: `repos` allowlist on api_tokens gates dispatch,
  job claims (SQL-filtered), runs, artifacts, rerun, status,
  heartbeats, flaky, secrets, and schedules. Empty = all repos.
- Run cancellation: `POST /v1/runs/:id/cancel` + `cli cancel` stop
  queued/blocked jobs (running work finishes naturally).
- `npm run bench`: measured dispatch → pickup → terminal latency against
  a local or deployed worker (p50 ≈ 38/17/63 ms locally).
- Source dispatch: upload a working-tree tarball (`POST /v1/source`,
  50 MB cap, traversal-guarded) and run it with no commit — `cli run
  <repo> --source` wraps the whole loop (tar, upload, dispatch, wait,
  digest).
- Webhook idempotency: `X-GitHub-Delivery` dedupes GitHub retries and
  manual redeliveries so a push can never create two runs.
- One PR summary comment per run, edited in place (build/permission:
  pull_requests:write).
- Job-level `if:` (always/failure/success/cancelled) evaluated when
  needs settle; per-step `timeout-minutes` (1–180) and `shell:`; the
  importer translates all three.
- `cli local`: run `flare.yml` in the working tree with no server and no
  commit — the same execution engine, a warm local cache, and artifacts
  under `.flare/`. The zero-latency inner loop for agents.
- Step conditionals: bounded `if:` subset (`always()`, `success()`,
  `failure()`, `cancelled()`, `!fn()`), so cleanup and notification steps
  still run after a failure. Unsupported expressions fail the parse.
- Check Runs now carry inline annotations parsed from `file:line` output,
  and the importer translates supported step conditions.
- GitHub Check Runs: every terminal job posts a rich check to the
  PR/commit page (failing command, exit code, bounded output tail,
  triage) — needs the App's checks:write, which the Connect manifest now
  requests.
- Per-job retries: `retry: 0–5` in `flare.yml` requeues failed jobs while
  the attempt budget remains, so flaky suites don't fail runs (or page
  humans) on the first flake.
- Agent fast lane: `priority` (0–10) on dispatch jumps queued batch work;
  `GET /v1/runs/:id/wait` blocks server-side until a run is terminal
  (no client poll loops); `GET /v1/runs/:id/digest` returns a compact,
  token-efficient result (failing step command/exit, bounded output tail,
  triage).
- MCP: `run_and_wait` (dispatch + block + digest in one call) and
  `get_run_digest` tools — the one-call verify loop for agents.
- CLI: `cli run` (dispatch → wait → digest, exit 1 on failure) and
  `cli watch`, plus `--priority` on dispatch.
- Runners poll every 2s idle / 500ms after a job for near-instant pickup.
- Scheduled runs: per-deployment cron schedules (repo + ref + 5-field
  UTC cron) with a Worker cron trigger, dashboard management, and a
  visible last-dispatch attempt so silently dead schedules are obvious.
- Chat notifications: Slack, Discord, and Mattermost-compatible webhook
  URLs (write-only, encrypted at rest), independent of email.
- `continue-on-error` for pipeline steps across parsing, both executors
  (BYO runners and seats), and the GitHub Actions importer.
- R2 retention: pruned runs delete their artifacts, and cache blobs
  older than 90 days are pruned.
- Managed executor: scale-to-zero Cloudflare Containers seats with an
  atomic claim, release semantics for unsupported jobs, live progress
  mirroring, and a dead-letter queue for wakes.
- Agentic layer: MCP server (`/mcp`), Workers AI failure triage stored per
  job, natural-language pipeline generation, flaky-test detection.
- GitHub Actions importer (`npm run cli -- import`).
- Auth: GitHub App one-click Connect, login with GitHub or email +
  password, single-use invites, audit log, per-email/per-IP rate limiting
  on auth endpoints.
- Pipelines: matrix builds, `needs`, concurrency groups,
  `cancel-in-progress`, containers, services, `runs-on` labels, timeouts,
  R2 cache, artifacts, repo secrets, email notifications, status badges
  with a private-repo opt-out.
- Runner/CLI: labels, checkout, docker executor, job timeout, structured
  step results; CLI for runs, logs, dispatch, rerun, flaky, artifacts,
  badges, import, MCP config.
- Preview environments via Cloudflare Worker Previews.

### Fixed

- `runJob` preserves per-step flags (`continue-on-error`, `if`) — they
  were silently dropped for anything running through the SDK orchestrator
  (BYO runners and `cli local`).
- Job claims no longer starve label-specific runners behind a fixed
  window of queued jobs for other labels.
- Late status callbacks from superseded executions (rerun, stale requeue)
  are dropped instead of clobbering the new queued row.
- Unparseable job definitions fail closed as `error` instead of running
  an echo substitute that reports success.
- Admin claim races (bootstrap / first GitHub login) and one-time token
  replays are closed with atomic writes.
- GitHub App private key, OAuth client secret, and webhook secret are
  encrypted at rest with the secrets data key.

### Security

- Auth endpoints throttle after repeated failures (per email and hashed
  client IP).
- Git checkout passes credentials via environment config, never argv.
