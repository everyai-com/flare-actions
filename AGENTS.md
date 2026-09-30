# AGENTS.md — Flare Actions

Open-source GitHub Actions alternative hosted on Cloudflare. TypeScript monorepo,
MIT licensed. One Worker serves the API + dashboard; runners are external pull clients.

## Commands (repo root)

- `npm install` / `npm ci` — install (workspaces: `apps/*`, `packages/*`)
- `npm run setup [-- --dry-run]` — provision D1 + queues + R2, migrate, set
  secrets, deploy, write gitignored `.env`, and (docker available)
  provision the managed seats worker. Fully non-interactive;
  idempotent, safe to re-run.
- `npm run dev` — local Worker (`wrangler dev`, simulated D1 + queues)
- `npm run types` — regenerate `apps/worker/src/worker-configuration.d.ts`.
  Run after any `wrangler.jsonc` change. NOTE: output varies with `.dev.vars`
  presence (secrets become required bindings); code must compile both ways —
  see `WorkerSecrets` intersection in `apps/worker/src/index.ts`.
- `npm run typecheck` — `tsc --noEmit`, must be clean
- `npm test` — vitest, colocated `*.test.ts`, must pass
- `npm run deploy` / `npm run deploy:dry` — deploy / validate only
- `npm run runner` — external pull-runner (reads `.env` automatically)
- `npm run cli -- <runs|logs|dispatch|rerun|flaky|artifacts|badge|import|mcp-config>`
  — CLI (reads `.env` automatically)

## Architecture

- `apps/worker/src/index.ts` — routes + auth. On every request it runs
  `ensureSchema()` (self-migrates a fresh D1; isolate-cached promise).
- `apps/worker/src/{db,github,tokens,settings,schema,dashboard}.ts` — D1 access,
  GitHub App auth, API-token issue/verify, validators, schema, dashboard HTML.
- `apps/worker/src/{pipeline,mcp,cache,artifacts,badge,cost,generate}.ts` —
  `flare.yml` parse/expand/serialize, MCP server, R2 cache/artifacts, badges,
  cost attribution, NL pipeline generation.
- `apps/worker/migrations/*.sql` — tracked history; `schema.ts` mirrors it for
  one-click forks that skip manual migration. Update BOTH when changing schema.
  `ensureSchema` also runs best-effort `ALTER`s so existing DBs self-heal.
- `packages/runner-sdk` — `FlareClient` + `loadEnv()` (walks up to repo `.env`),
  job orchestrator (`job.ts`), spec reader (`spec.ts`), tar cache (`cache.ts`),
  docker (`services.ts`), Actions importer (`importActions.ts`).
  Must stay Node type-stripping compatible: NO parameter properties, enums, or
  namespaces — plain types only (runner/CLI run via `--experimental-strip-types`).
  Relative imports in runner/CLI/SDK must include the `.ts` extension
  (extensionless resolution doesn't apply under strip mode; vitest won't
  catch this — always smoke-run the CLI after touching imports).
- `apps/runner`, `apps/cli` — thin SDK consumers. Runner advertises
  `[os, arch, ...FLARE_LABELS]`, checkouts (`checkout.ts`, shallow per-job
  temp dir, token scrubbed from errors) then `runJob`: services → cache →
  steps → cache save → artifacts → teardown, inside a job timeout.
- Failure triage (`triage.ts`): on job failure/failure-callback, a
  `waitUntil` (never blocking) calls Workers AI (`ai` binding) and stores
  ≤4KB text in `jobs.triage`, surfaced in dashboard + CLI. Missing AI
  binding or model errors must degrade to skip, never to 500.
- Scheduling: `needs`/`concurrency` park jobs as `blocked` at fan-out;
  terminal callbacks `rollupRunStatus` then `promoteBlockedJobs` (oldest
  first, so groups serialize). `cancel-in-progress` cancels other runs'
  same-group jobs at fan-out. Run/job statuses: queued, running, blocked,
  success, failure, error, cancelled, skipped.

Data flow: GitHub webhook → HMAC verify → D1 run+job rows → Queue (DLQ on
exhaustion) → runner polls `GET /v1/jobs/next?labels=` → executes →
`POST /status` → rollup + promote + triage + commit status.

- `apps/seats` — managed executor. `ContainerSeat` DO (one container per
  job) orchestrates via `exec` (`seat.ts`, testable with fakes;
  `seat-do.ts` holds the `cloudflare:workers` import so vitest never
  touches it). Shares worker modules (`db`, `finish`, `pipeline`,
  `github`, `triage`) by relative import — bundled by wrangler.
- Wakes travel the `flare-actions-seats` queue (main produces, seats
  consumes). Never worker→workers.dev HTTPS (edge error 1042) and never
  a service binding in the committed config (deploy-time validation
  would couple one-click deploys to the seats worker).
- Seats claim atomically (`claimJob`) and release what they can't do;
  `/run` executes inline and answers with the outcome (an open request
  keeps the seat alive; detached `waitUntil` hibernates mid-job).
  Progress mirrors to the job log live; release reasons included.
  Image tags must be immutable (`:latest` rejected); build
  `--platform linux/amd64`.

Auth model: env secrets take precedence; dashboard-managed D1 settings fill
gaps so one-click deploys need zero `wrangler secret` commands.

- Auth: Login with GitHub (`oauth.ts`; sessions in D1 `sessions`,
  cookie `flare_session`). First login claims admin
  (`admin_github_user`); admin + allow-listed `github_users` may log
  in (non-admin reads). Connect is open pre-claim, admin-only after.
  `ADMIN_TOKEN` env is break-glass recovery only (recovery field
  appears iff set); setup never mints it.
- Webhooks: `GITHUB_WEBHOOK_SECRET` env or D1 `webhook_secret` (Settings tab).
- GitHub App: Connect flow (`connect.ts` manifest + callback; creds in
  D1 under `github_app_*`, incl. OAuth client id/secret) or env
  `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY` (env wins; Connect 409s while
  env manages any of them; manual flow needs `ADMIN_TOKEN` for
  dashboard access since OAuth is impossible). Both workers resolve
  via `resolveAppCreds`.
- API: legacy `RUNNER_TOKEN` env plus D1 `api_tokens` (`admin` =
  everything, `runner` = run+read, `readonly` = read). Hashes only in
  D1; plaintext shown once at creation.

## Conventions

- Strict TS, no `any`, no `as unknown as` casts, no floating promises
  (await / return / `ctx.waitUntil()` — never destructure `ctx`).
- No module-level request state (isolate caches like `ensureSchema`'s memo
  are fine and must be documented as such).
- Timing-safe secret comparisons (`bytesEqual` / `timingSafeEqualHex` /
  digest-then-compare for strings). Never `===` on secrets.
- Structured JSON logs, explicit try/catch, no `passThroughOnException`.
- Dashboard is one inline HTML string (`dashboard.ts`); embedded JS must avoid
  backticks and `${` (outer template literal) and must use `textContent`, never
  `innerHTML`, for API data.
- Tests colocated as `*.test.ts`; keep Worker unit tests runtime-free
  (`timingSafeEqual` doesn't exist in Node — `bytesEqual` has the fallback).

## Secrets

- Local: `apps/worker/.dev.vars` (gitignored). Remote: `wrangler secret put`
  via stdin pipe — never secret values in argv, never printed. `.env` (root,
  gitignored) is written by `setup` for runner/CLI.
- Never commit secrets. Before pushing, `git status` must show no `.env`,
  `.dev.vars`, or `worker-configuration.d.ts` (all gitignored).

## Verification

- After Worker edits: `npm run types`, `npm run typecheck`, `npm test`,
  `npm run deploy:dry`.
- After behavior changes: drive the real flow with `wrangler dev` (fresh
  `--persist-to` dir for first-run paths) or the deployed worker; keep
  throwaway probe scripts in `/tmp`, out of the repo.
- CI (`.github/workflows/ci.yml`) runs types + typecheck + test on push/PR,
  plus a branch Preview deploy on PRs when `CLOUDFLARE_API_TOKEN` repo
  secrets exist (skips otherwise).

## Preview environments

- `wrangler.jsonc` has a `previews` block: staging D1
  (`flare-actions-staging`, bound by id) + staging queues (bound by name),
  shared by all previews and isolated from prod. Only Durable Objects and
  Containers auto-isolate per preview; D1/queues do not.
- Branch flow: `git checkout -b feat && npx wrangler preview --config
  apps/worker/wrangler.jsonc` → `https://<branch>-flare-actions.<sub>.workers.dev`.
  Delete with `wrangler preview delete --name <branch>`.
- Preview base secrets (values distinct from prod) are set once via
  `wrangler preview base-config secret put NAME`; new previews inherit them.
- Never point a preview at production resources, and never reuse prod
  secret values for previews.

## Tooling notes

- Wrangler (pinned in devDependencies, needs ≥4.135 for previews) is the
  supported CLI. Cloudflare's new `cf` CLI + `cloudflare.config.ts`
  (open beta since 2026-09-28) was evaluated: promising for agent
  workflows (JSON-first, `cf cli search`) but requires interactive login
  and is too new to be the primary path. Revisit after GA.
- For Cloudflare API access, agents/CI should use a least-privilege token:
  per-Worker Editor role on the Worker plus D1/Queues edit — never
  account-wide credentials.
