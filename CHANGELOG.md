# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
deploys from `main` and does not cut versioned releases yet.

## [Unreleased]

### Added

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
