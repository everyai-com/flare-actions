# AGENTS.md — Flare Actions

Open-source GitHub Actions alternative hosted on Cloudflare. TypeScript monorepo,
MIT licensed. One Worker serves the API + dashboard; runners are external pull clients.

## Commands (repo root)

- `npm install` / `npm ci` — install (workspaces: `apps/*`, `packages/*`)
- `npm run setup [-- --dry-run]` — provision D1 + queues, migrate, set secrets,
  deploy, write gitignored `.env`. Fully non-interactive; idempotent, safe to re-run.
- `npm run dev` — local Worker (`wrangler dev`, simulated D1 + queues)
- `npm run types` — regenerate `apps/worker/src/worker-configuration.d.ts`.
  Run after any `wrangler.jsonc` change. NOTE: output varies with `.dev.vars`
  presence (secrets become required bindings); code must compile both ways —
  see `WorkerSecrets` intersection in `apps/worker/src/index.ts`.
- `npm run typecheck` — `tsc --noEmit`, must be clean
- `npm test` — vitest, colocated `*.test.ts`, must pass
- `npm run deploy` / `npm run deploy:dry` — deploy / validate only
- `npm run runner` — external pull-runner (reads `.env` automatically)
- `npm run cli -- runs|logs <id>` — CLI (reads `.env` automatically)

## Architecture

- `apps/worker/src/index.ts` — routes + auth. On every request it runs
  `ensureSchema()` (self-migrates a fresh D1; isolate-cached promise).
- `apps/worker/src/{db,github,tokens,settings,schema,dashboard}.ts` — D1 access,
  GitHub App auth, API-token issue/verify, validators, schema, dashboard HTML.
- `apps/worker/migrations/*.sql` — tracked history; `schema.ts` mirrors it for
  one-click forks that skip manual migration. Update BOTH when changing schema.
- `packages/runner-sdk` — `FlareClient` + `loadEnv()` (walks up to repo `.env`).
  Must stay Node type-stripping compatible: NO parameter properties, enums, or
  namespaces — plain types only (runner/CLI run via `--experimental-strip-types`).
- `apps/runner`, `apps/cli` — thin SDK consumers.

Data flow: GitHub webhook → HMAC verify → D1 run+job rows → Queue (DLQ on
exhaustion) → runner polls `GET /v1/jobs/next` → executes → `POST /status`.

Auth model: env secrets take precedence; dashboard-managed D1 settings fill
gaps so one-click deploys need zero `wrangler secret` commands.

- Admin: `ADMIN_TOKEN` env or D1 `admin_password_hash` (first-run setup UI).
  `POST /v1/admin/setup` only works when NEITHER exists — never weaken this.
- Webhooks: `GITHUB_WEBHOOK_SECRET` env or D1 `webhook_secret` (Settings tab).
- API: legacy `RUNNER_TOKEN` env plus D1 `api_tokens` (`runner` = run+read,
  `readonly` = read). Hashes only in D1; plaintext shown once at creation.

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
- CI (`.github/workflows/ci.yml`) runs types + typecheck + test on push/PR.
