# Roadmap: crushing GitHub Actions

Thesis: GitHub bills per minute for cold VMs behind queues. Flare bills ~$0
for orchestration on Cloudflare's edge, executes on warm metal or
scale-to-zero containers, and wraps it in an agent-native experience.
Speed wins trials; price wins migrations; agents win the next decade.

## Phase 1 — Dispatch core (shipped)

- GitHub App webhooks → edge dispatch → D1 + Queues + DLQ
- Dashboard (runs, access tokens, first-run setup), CLI, one-click deploy,
  branch previews, `npm run setup`, AGENTS.md.

## Phase 2 — Real execution (shipped)

- [x] `flare.yml` pipelines: jobs + steps fetched at dispatch, fanned out
- [x] Runner executes real shell steps with per-step results
- [x] Repo checkout in runner (shallow, per-job temp dir; `GITHUB_TOKEN` for private)
- [x] Docker executor: `container:` steps + `services:` on any docker runner
- [x] R2 build cache (zero egress) + artifact store
- [x] Matrix builds, service containers, concurrency groups, `needs:`, `runs-on:` labels
- [x] Cloudflare Containers managed executor (scale-to-zero seats, see `docs/CONTAINERS.md`)

## Phase 3 — Agentic layer (the moat, shipped)

- [x] Machine-readable run results (per-step exit/duration/output)
- [x] Failure triage: failing step → culprit file/command, fix suggestions (Workers AI, stored per job)
- [x] MCP server: agents query runs, re-run jobs, read logs natively (`docs/MCP.md`)
- [x] Natural-language pipelines ("test PRs, deploy main") compiled to `flare.yml`
- [x] Flaky-test detection with evidence (`GET /v1/flaky`)
- [x] Cost + time attribution per run vs Actions list price

## Phase 4 — Finish the migration story (shipped)

- [x] GitHub Actions YAML importer (`cli import`, translates runs-on/steps automatically)
- [x] Native `.github/workflows` drop-in: no flare.yml → matching workflow
      files run as-is, triggers included (`docs/GITHUB-ACTIONS-COMPAT.md`)
- [x] macOS remote story (Mac Mini / hosted Mac runners via label protocol, `docs/RUNNERS.md`)
- [x] Windows BYO parity, status badges, required-checks UX (commit statuses)
- [x] SOC 2-friendly audit log (who ran what, where, with which token)

## Phase 5 — Agent-native (shipped)

- [x] Blocking wait + compact digests (`GET /v1/runs/:id/wait|digest`),
      MCP `run_and_wait` — one call, zero sleep loops
- [x] Priority lane (0–10) so verification jumps queued batch work
- [x] `cli local`: run `flare.yml` in the working tree, warm cache, no server
- [x] Source dispatch: run an uploaded working tree with no commit
      (`cli run --source`) — something a forge-hosted CI cannot do
- [x] Rich GitHub surfaces: per-job Check Runs with failing-command
      output and inline annotations, one evolving PR summary comment
- [x] Reliability: webhook delivery dedupe, scheduled runs with
      last-dispatch visibility, per-job retries, `if:` conditionals

## Non-goals (for now)

- Replacing GitHub the forge (repos, PRs, reviews stay where they are).
- A marketplace of thousands of actions — ten excellent built-ins beat ten
  thousand unmaintained YAML wrappers.
