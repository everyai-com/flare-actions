# Roadmap: crushing GitHub Actions

Thesis: GitHub bills per minute for cold VMs behind queues. Flare bills ~$0
for orchestration on Cloudflare's edge, executes on warm metal or
scale-to-zero containers, and wraps it in an agent-native experience.
Speed wins trials; price wins migrations; agents win the next decade.

## Phase 1 — Dispatch core (shipped)

- GitHub App webhooks → edge dispatch → D1 + Queues + DLQ
- Dashboard (runs, access tokens, first-run setup), CLI, one-click deploy,
  branch previews, `npm run setup`, AGENTS.md.

## Phase 2 — Real execution (in progress)

- [x] `flare.yml` pipelines: jobs + steps fetched at dispatch, fanned out
- [x] Runner executes real shell steps with per-step results
- [x] Repo checkout in runner (shallow, per-job temp dir; `GITHUB_TOKEN` for private)
- [ ] Docker executor option (BYO box or laptop)
- [ ] Cloudflare Containers managed executor (scale-to-zero)
- [ ] R2 build cache (zero egress) + artifact store
- [ ] Matrix builds, service containers, concurrency groups

## Phase 3 — Agentic layer (the moat)

- [ ] Machine-readable run results (shipped: per-step exit/duration/output)
- [x] Failure triage: failing step → culprit file/command, fix suggestions (Workers AI, stored per job)
- [ ] MCP server: agents query runs, re-run jobs, read logs natively
- [ ] Natural-language pipelines ("test PRs, deploy main") compiled to `flare.yml`
- [ ] Flaky-test detection with evidence, smart retries
- [ ] Cost + time attribution per PR, developer, and step

## Phase 4 — Finish the migration story

- [ ] GitHub Actions YAML importer (translate `runs-on`/steps automatically)
- [ ] macOS remote story (Mac Mini / hosted Mac runners via same protocol)
- [ ] Windows BYO parity, status badges, required-checks UX
- [ ] SOC 2-friendly audit log (who ran what, where, with which token)

## Non-goals (for now)

- Replacing GitHub the forge (repos, PRs, reviews stay where they are).
- A marketplace of thousands of actions — ten excellent built-ins beat ten
  thousand unmaintained YAML wrappers.
