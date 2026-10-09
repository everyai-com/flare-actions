# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are
tagged on `main` (`v0.1.0` is the first).

## [Unreleased]

### Added

- Oxlint is the lint gate: `npm run lint` now runs `oxlint .` (~50ms vs
  ~4s for eslint) with a parity `.oxlintrc.json` mirroring the old
  eslint rule set (the config never used type-aware rules, so the flip
  is lossless); `npm run lint:full` keeps eslint for slow passes.
- Mobile-friendly dashboard + attention-respecting notifications: a full
  ≤640px responsive pass (wrapping tabs, stacked card tables with
  full-width actions, stacked forms with 16px inputs, wrapped logs, no
  page-level horizontal scroll) and per-user notification prefs —
  UTC quiet hours plus notify-only-on-new-failure dedup across
  consecutive same-branch runs — via `GET|POST /v1/notify/prefs`
  (self-service for email logins, admins may target any email) and a
  "My notifications" card on the Apps tab. Missing pref rows preserve
  current behavior exactly; recovery always notifies.
- Template gallery, migration wizard, and feed dashboard: six bundled
  starter pipelines (node, python, go, rust, java, generic) served via
  `GET /v1/templates` + `GET /v1/templates/:id`, scaffolded with
  `cli init --template <id>`, and browsed in the dashboard Templates
  tab (view/copy YAML per card). The migration wizard converts a
  pasted Actions workflow via `POST /v1/migrate` (pure SDK-importer
  conversion, zero writes) and shows warnings before saving. The Feed
  tab lists the latest runs across repos (`GET /v1/feed`) with
  one-click rerun-failed (admin only), open-PR, and open-fix-PR/open-run
  actions per item.
- One-click GitHub App to auto-detected pipeline: `cli init` and `cli
  connect` scan repo manifests (Node, Python, Go, Rust, Ruby, Java, PHP,
  .NET, Elixir) and generate a stack-matched `flare.yml` starter —
  package-manager-aware installs, script-aware test/build steps — or
  convert the first convertible `.github/workflows` file via the SDK
  importer (`--stack <id>` forces a starter). `cli connect --init`
  scaffolds the missing pipeline in the same probe → wire → verify flow
  (with `--wire` for the webhook and the one-click App install URL in
  one command); without `--init` it suggests what `init` would do.
  Non-interactive with clear output plus `--json`, safe to re-run.
- Same-machine verify parity: one shared `runner-sdk/parity.ts` code
  path for step images, cache keys, and the curated step env
  (`buildFlareEnv`, one cache-key validator + R2 object mapping, one
  image resolver with mutable-tag detection) used by `cli local`, BYO
  runners, and managed seats. `cli local` now sets
  `FLARE_CHANGED_FILES` (working-tree diff) and a branch-derived
  `FLARE_REF`, and forces `CI=true` (job `env` may still override)
  while keeping its warm directory-scoped cache. `cli local --parity
  [--file] [job]` reports per-job divergences against the predicted
  seats/BYO lane — image, cache key + scope, the full env table, and
  warn/info findings — with `--json` for gating (`docs/PIPELINES.md`).
- Agent merge queue: agent PRs land one at a time against a moving
  main — enqueue, rebase onto the current head (update-branch), verify
  with a real CI run, merge on green. One live verification per repo
  (per-minute tick); entries whose base moves re-queue for a fresh
  verify instead of landing stale; GitHub failures park visibly in the
  entry note, never 500. A file-collision radar generalizes the
  tournament radar to queued PRs. `POST|GET /v1/merge-queue`,
  `DELETE /v1/merge-queue/:id`, `cli mergequeue
  <enqueue|status|cancel>`, and a dashboard Merge queue tab
  (`docs/MERGE-QUEUE.md`).
- Attestation (content-addressed verdict reuse): dispatch computes a
  stable SHA-256 over repo + sha + CI profile + job set (names,
  definitions, labels), terminal runs file verdict receipts in D1, and
  a hash match short-circuits dispatch to the recorded verdict — the
  run lands terminal with zero queue sends, a receipt id in the
  response, an `attestation.reused` audit row, and a digest note
  (`cli explain` narrates it). Success upgrades a stored failure so a
  flaky red run never shadows the green rerun; reuse never crosses
  repos. Receipts verify independently via
  `GET /v1/attestations/:id` (the hash is recomputed from the witness
  run's live rows) and `cli attestation <receipt-id>`; reruns always
  execute, so a recorded failure is escapable in one command.
- Smart test selection: a job-level `test-selection` opt-in maps the
  diff to affected tests — a TypeScript/JavaScript import-graph walk
  (designed for more languages) plus a recent-JUnit-failure boost.
  Executors set `FLARE_SELECTED_TESTS` (newline-joined, empty = run
  everything) and `FLARE_TEST_SELECTION` (`off`/`full`/`select`) and
  record a per-run skip report surfaced in the run digest, the PR
  comment, `GET /v1/runs/:id/selection`, and `cli selection`. The
  safety net always runs the full suite on scheduled runs,
  merge-candidate profiles (`full-on-profiles`, default `[full]`) and
  branches, unknown diffs, and unmapped changes.
- CI profiles: an optional `profiles` block in `flare.yml` maps a profile
  name to a job selection (include/exclude by job name or `tags`), with a
  per-event `defaults` map for the smoke-per-push / full-suite-nightly
  pattern. Selection is explicit override (`profile` on dispatch +
  dry-run, `cli run` / `cli dispatch --profile`, MCP `dispatch_run` /
  `run_and_wait`) > schedule pin (optional `profile` on cron schedules) >
  event default > all jobs; unknown names fail with `unknown_profile`.
- Dashboard savings counter: a 30-day runs / compute-min / spend-avoided
  strip atop the Runs pane (60s cache so the runs poll never hammers
  the rollup query).
- `--json` on every CLI command: stdout becomes one versioned envelope
  `{ version: 1, command, data }` (failures keep stderr + exit codes;
  `mcp-config` stays paste-ready, `mcp-serve` ignores the flag).
- `cli explain <run-id>`: one narrative instead of raw rows —
  verdict-first summary plus failing steps, output tails, triage,
  and exact rerun commands (`--json` included).
- Dry-run dispatch: `POST /v1/runs/dispatch/dry-run` (and `--dry-run`
  on `cli run` / `cli dispatch`, incl. `--source` from the local
  `flare.yml` with no upload) plans the fan-out — resolved
  pipeline, queued/blocked + reasons, runtime priors, live group
  state, budget verdict — with zero writes, queue sends, or audits.
- Machine-actionable errors on the core lanes: dispatch, dry-run,
  claim, webhook, auth, and pairing failures now carry a stable
  `code` + next-step `hint` (`docs/ERRORS.md` catalogs all 21).
  Messages keep their wording; the SDK throws `FlareApiError`
  (status/code/hint props) and the CLI prints `hint [code]`.
- Quarantine surface: a dashboard Flaky tab (per-job failure rates +
  quarantine list with admin add/reinstate) and a "Quarantined — not
  blocking" section in the PR comment naming the skipped failures.
- Budget kill switches: `budgetKillMultiplier` auto-pauses a repo past
  N× its cap (dispatch/webhook/schedule/MCP refuse, alert via notify),
  `GET|DELETE /v1/admin/paused` lists (with per-actor attribution) and
  resumes, `cli paused` / `cli resume`, a dashboard Budgets resume
  button, and dry-run `paused` reporting.
- Per-agent identity + concurrency caps: dispatch tags runs with an
  `agent` slug (API, `cli run|dispatch --agent`, MCP `X-Flare-Agent`
  header fallback), `fairSharePerAgent` caps concurrently running jobs
  per agent (untagged runs bypass), `GET /v1/runs?agent=`, `cli runs
  [agent]`, and agent tags in the queue view.
- Tailscale-style runner pairing: dashboard Access mints a single-use
  10-minute code, `npm run runner -- --pair CODE` exchanges it for a
  runner token, writes `.env` (0600, merged), and starts polling —
  one pasted command, zero config files. IP-throttled exchange,
  atomic single-use consume, revoke like any token.
- One-command adoption: `npx flare connect [--wire] [--dry-run]` probes
  the deployment, prints the wiring recipe, optionally creates the repo
  webhook, then dispatches HEAD with a compact verdict (exit 0 verified,
  1 run failed, 2 usage). Plus the `skills/flare-setup` agent skill and
  a README "Or with your agent" paste prompt.
- `runs-on: flare` runner mode (opt-in, off by default): GitHub keeps
  orchestrating and Flare supplies ephemeral JIT self-hosted runners —
  one `runs-on:` line changes, checks/logs stay on GitHub. New
  `gh_runner_jobs` table, `workflow_job` ingest, `POST
  /v1/github/jobs/next` claim lane, `cli github-jobs`, `npm run runner
  -- --github`, dashboard Settings card, and `docs/GITHUB-RUNNERS.md`.
- Shared-warm-cache stats: every cache GET (BYO lane) and seat restore
  records its hit/miss outcome as one daily-aggregate `cache_stats`
  upsert — no per-event rows. `GET /v1/cache/stats` serves the
  trailing-7-day hit rate overall plus per cache scope, `cli cache
  stats` prints it (text + `--json`), and a dashboard strip shows the
  "one warm cache, every agent" proof.

### Changed

- Roadmap absorbs the master plan's agent-friendliness checklist
  (`--json` everywhere, `flare explain`, dry-run dispatch, per-agent
  caps/isolation), the normal-person UX list (auto-detected pipeline,
  template gallery, savings counter, runner pairing), and the
  hosted-tier pricing philosophy + agent-purchasing surface.

## [0.3.0] - 2026-10-07

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
