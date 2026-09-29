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
- [ ] Cloudflare Containers managed executor (scale-to-zero) — scaffolded, see `docs/CONTAINERS.md`

## Phase 3 — Agentic layer (the moat, shipped)

- [x] Machine-readable run results (per-step exit/duration/output)
- [x] Failure triage: failing step → culprit file/command, fix suggestions (Workers AI, stored per job)
- [x] MCP server: agents query runs, re-run jobs, read logs natively (`docs/MCP.md`)
- [x] Natural-language pipelines ("test PRs, deploy main") compiled to `flare.yml`
- [x] Flaky-test detection with evidence (`GET /v1/flaky`)
- [x] Cost + time attribution per run vs Actions list price

## Phase 4 — Finish the migration story (shipped)

- [x] GitHub Actions YAML importer (`cli import`, translates runs-on/steps automatically)
- [x] macOS remote story (Mac Mini / hosted Mac runners via label protocol, `docs/RUNNERS.md`)
- [x] Windows BYO parity, status badges, required-checks UX (commit statuses)
- [x] SOC 2-friendly audit log (who ran what, where, with which token)

## Non-goals (for now)

- Replacing GitHub the forge (repos, PRs, reviews stay where they are).
- A marketplace of thousands of actions — ten excellent built-ins beat ten
  thousand unmaintained YAML wrappers.
