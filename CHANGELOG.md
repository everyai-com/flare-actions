# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are
tagged on `main` (`v0.1.0` is the first).

## [Unreleased]

### Added

- `paths:` / `paths-ignore:` trigger filters for Actions-compatible
  workflows, matched against the run's changed files; `FLARE_CHANGED_FILES`
  exposes that list (newline-separated) to steps for changed-file test
  selection. Unknown changes run conservatively, never silently skip.
- `shards: N` (2–8) in `flare.yml`: splits a job into parallel cells with
  `FLARE_SHARD_INDEX` / `FLARE_SHARD_TOTAL` for `vitest --shard`-style
  recipes; multiplies with matrices.
- "What's blocking the merge": `GET /v1/bottlenecks` + `cli bottlenecks`
  + a dashboard "Slowest checks (last 14 days)" report — p50/p95 run time
  and median queue wait per check.
- Spend guardrails: per-repo monthly compute-minute budgets
  (`budgetMinutes`), `budgetMode` warn|block — block skips webhooks (200),
  429s dispatch, and skips schedules once a repo is over; warn audits.
  Dashboard Settings manages both.
- Auto-supersede (`supersedeBranchRuns: push`): one run per branch head —
  a new push cancels still-active jobs of earlier same-branch runs.
- `llms.txt`: a model-readable index (docs, MCP config, quickstart) for
  agents and LLM tooling.
- Cost & wall-clock anomaly alerts: an hourly fleet check compares each
  repo's day against its trailing median and messages email + chat
  webhook with the busiest branch when usage spikes ("agent stuck in a
  loop" insurance).
- Flaky auto-quarantine: tests that fail ≥2 times yet pass in the week
  are quarantined automatically; a failure whose failing tests are all
  quarantined lands as success with a log note on both executors, and
  quarantined tests reinstate after 3 consecutive passes.
  `cli quarantine list|add|remove`, `GET/POST /v1/quarantine`.
- `cli init`: scaffolds `flare.yml` (converted from the repo's first
  convertible workflow, or a starter), writes an idempotent AGENTS.md
  snippet teaching the verify loop, and prints next steps.
- `skills/flare-verify/SKILL.md`: an agent skill (Claude Code / Codex /
  Cursor) for the one-call verify loop; `pricing.json` with
  machine-readable plans.

### Changed

- Roadmap restructured around the October 2026 market evidence: the
  recurring pains in practitioners' terms, the shipped OSS foundation,
  an OSS roadmap in Now/Next/Later waves, the planned hosted/paid tiers
  (Flare Cloud, Enterprise, private tournaments), and an expanded
  non-goals list (BYO-only Windows/macOS, no price war, no generic
  container-speed claims).
- README: a "Replace your GitHub Actions — pick your path" section —
  one click with the App, one click without it (repo webhooks), dispatch
  only, or self-host — all four run existing workflows unchanged.

## [0.2.0] - 2026-10-07

### Added

- Runs now record which pipeline produced their jobs (`pipeline_source`:
  flare.yml / Actions / default / inline / source); the dashboard tags
  every run row and the run detail explains it.
- Dashboard Settings: "Coming from GitHub Actions?" card — drop-in
  explanation, no-App repo-webhook recipe, and a link to the support
  matrix.
- Agent dev loop: `npm run check` (changed-file oxlint + one type check +
  `vitest --changed`, serialized across worktrees via slots),
  `npm run lint:fast` (oxlint), `npm run typecheck:fast` (TypeScript
  native). CI still gates on type-aware eslint + tsc. See
  `docs/DEV-SPEED.md`.
- vitest persists module transforms between runs (`fsModuleCache`).
- CI hygiene: `npm ci --prefer-offline --no-audit --fund=false`, explicit
  job timeouts, and docs-only PRs skip the preview deploy.
- Native `.github/workflows` compatibility: without a `flare.yml`, Flare
  fetches the repo's workflow files at the commit, matches `on:` triggers
  (push branches/tags, pull_request base branch, workflow_dispatch,
  schedule cron) and runs them — `cli local` falls back to local
  workflows too. Bounded translation drops unsupported `uses:` and
  expressions with warnings (`docs/GITHUB-ACTIONS-COMPAT.md`).
- `${{ github.* }}` builtins map onto `FLARE_SHA` / `FLARE_REPO` /
  `FLARE_RUN_ID` / `FLARE_JOB_ID` / `FLARE_REF` / `FLARE_WORKFLOW` (new
  `FLARE_REF` env on runners and seats).
- Job-guard evaluation: `if:` conditions comparing `github.event_name` /
  `.ref` / `.ref_name` / `.repository` are decided at translation time, so
  a job gated to another event is skipped exactly like Actions instead of
  running (e.g. preview deploys no longer leak into push runs).
- Job-level `if` translation in the Actions importer (bounded subset,
  warned otherwise).

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
