# Roadmap: crushing GitHub Actions

Thesis: GitHub bills per minute for cold VMs behind queues. Flare bills ~$0
for orchestration on Cloudflare's edge, executes on warm metal or
scale-to-zero containers, and wraps it in an agent-native experience.
Speed wins trials; price wins migrations; agents win the next decade.

## Why now — the market evidence

October 2026 was the month agent fleets broke the per-push model in
public: a 45K-view post on reworking agent-scale CI, a 650K-view "CI has
become the top bottleneck of every engineering team" thread, Linear's
write-up, HN discussions, and runaway-agent horror stories (an agent loop
burning $4,700 of CI). Every feature below traces to a pain voiced in
~100 customer/lead conversations or those public threads — tasks are
ranked by the evidence, not by novelty.

The recurring pains, in practitioners' own terms:

- "CI didn't get expensive, it got frequent" — agents push to learn
  whether code builds; every attempt bills a full run.
- "The queue is killing me" — 200+ PRs/day, congestion timeouts,
  superseded pushes running to completion.
- "12% of test files caught 90%+ of relevant tests" — test selection is
  the biggest cost lever; also the scariest (skipping the one test that
  mattered).
- "The bill is unpredictable" — one runaway loop, one 3x month; nobody
  wants to disable PR CI to survive it.
- "Flaky tests are the silent budget killer" and "full suite takes over
  an hour" — trust in verification is the bottleneck after speed.
- "Run it on the same machine where the code gets made" — the agent
  inner loop wants local parity, not a queue.
- "Two agents took the same migration number within a minute" — fleet
  coordination (merge queues, collisions) is the next wall.

## Shipped — the OSS foundation (MIT, free forever)

### Agent-native interface

- [x] `run_and_wait` — one-call verify loop over MCP, zero polling
- [x] MCP server with OAuth + tool discovery; token-efficient run digests
- [x] No-commit dispatch: verify uncommitted working trees / tarballs
- [x] `cli local` — local execution through the same orchestrator + warm cache
- [x] Priority lanes (0–10) so agent verification jumps batch work
- [x] Heartbeat + requeue — interrupted agents can't wedge the queue

### GitHub compatibility

- [x] `.github/workflows` importer (`cli import`) + native drop-in: no
      `flare.yml` → existing workflows run as-is, triggers included
      (push branches/tags, `paths`, PR base branch, `workflow_dispatch`,
      schedule cron; matrices, needs, concurrency, containers, cache,
      artifacts; job guards evaluated) — `docs/GITHUB-ACTIONS-COMPAT.md`
- [x] GitHub App (optional) + plain repo webhooks with HMAC verification
- [x] Check Runs with inline annotations, PR failure comments, statuses
- [x] macOS / Windows BYO parity, status badges, required-checks UX
- [x] SOC 2-friendly audit log (who ran what, where, with which token)

### Speed, waste-killing, caching

- [x] R2-backed cache + artifact store (zero egress)
- [x] Snapshot-backed caches (image-lineage keyed), scale-to-zero seats
- [x] Superseded-run collapsing: opt-in one-run-per-branch-head
      (`supersedeBranchRuns: push`) + concurrency groups
- [x] Sharding: `shards: N` with `FLARE_SHARD_INDEX` / `FLARE_SHARD_TOTAL`
- [x] `FLARE_CHANGED_FILES` + `paths:` filters (test-selection groundwork)
- [x] Budgets (per-repo monthly compute-minute caps, warn/block) and
      per-run cost + time attribution vs Actions list price

### Visibility

- [x] Dashboard, full CLI, REST API (OpenAPI served live)
- [x] Bottleneck report: per-check p50/p95 + median queue wait
      (dashboard "Slowest checks", `GET /v1/bottlenecks`, `cli bottlenecks`)
- [x] JUnit analytics, monitors, AI failure triage, NL pipeline generation,
      healing (draft PR + verification run)
- [x] D1 full-text log search, warm dev boxes, per-domain egress controls,
      browser-test jobs

### Tournaments

- [x] Race N agents on one task with real CI per attempt, deterministic
      verdict + AI why, immutable ledger, collision radar

## OSS roadmap (free forever)

### Now (days–weeks)

- [x] Superseded-run collapsing — shipped opt-in; remaining: default-on
      for agent-authored pushes
- [x] Bottleneck report — shipped; remaining: cache hit-rate and
      flakiness-rate on the same card
- [x] Cost & wall-clock anomaly alerts — an hourly fleet check compares
      today's runs/compute-minutes per repo against the trailing median
      and alerts (email + chat webhook) with the busiest branch, pointing
      at budgets; per-agent identity attribution is the remaining slice
- [x] Flaky auto-quarantine — flaky tests (≥2 failures and ≥1 pass in a
      week) enter quarantine automatically; failures that are entirely
      quarantined land as success with a log note (both executors), and
      tests reinstate after 3 consecutive passes. `cli quarantine`,
      `GET/POST /v1/quarantine`. Remaining: PR annotations + a dashboard
      view
- [x] Agent-led adoption: `cli init` (flare.yml converted from the repo's
      workflows + an idempotent AGENTS.md snippet + next steps), the
      `skills/flare-verify` skill for Claude Code / Codex / Cursor
- [x] `llms.txt` + `pricing.json` (machine-readable plans); [ ] MCP
      registry listings (mcp.so, Smithery) — manual submissions

### Next (weeks)

- [ ] Smart test selection — diff → affected tests (import graph +
      history), with a full-suite safety net on the merge candidate and
      nightly, and a per-run report of what was skipped and why
      (`FLARE_CHANGED_FILES` is the groundwork)
- [ ] Budget kill switches — per-identity attribution, auto-pause on
      runaway loops, alert (PR comment/webhook), resume in one click
      (per-repo caps + warn/block shipped)
- [ ] CI profiles — first-class "smoke per push / full suite nightly + on
      the landing candidate" config block (the $0-bill pattern)
- [ ] Shared-warm-cache stats — hit-rate over a week, published as the
      "one cache, ten agents" proof (the #1 challenged claim; prove it)

### Later (months)

- [ ] Attestation — content-addressed verdict reuse: identical tree +
      suite + environment → "this exact state already passed, here's the
      receipt" (extends the tournament ledger; starts as verifiable
      records, not a full supply-chain system)
- [ ] Agent merge queue — serialize agent PRs against a moving main:
      rebase, verify, land, with collision detection across concurrent
      agents (generalizes the tournament collision radar)
- [ ] Same-machine verify parity — `cli local` exists; remaining: mirror
      cloud runs exactly (images, cache keys) so "works on my machine"
      and "in CI" are the same sentence

### Agent-friendliness (checklist)

- [x] Token-efficient digests with hard caps (bounded commands, triage,
      output tails) and machine-readable per-step results
- [x] Priority lanes, blocking wait, MCP `run_and_wait` — no polling
- [ ] `--json` on every CLI command with versioned schemas
- [ ] Machine-actionable errors (stable codes + next-step hints)
- [ ] `flare explain <run-id>` — one narrative instead of raw rows
- [ ] Dry-run dispatch (`flare run --dry-run` plans without spending)
- [ ] Per-agent concurrency caps + per-agent run isolation (per-repo
      fair-share caps shipped; identity is the missing half — also gates
      anomaly attribution, see Known gaps)

### Normal-person UX

- [ ] One-click GitHub App → auto-detected pipeline (detect the stack
      and suggest/convert a workflow)
- [ ] Template gallery + migration wizard; feed-style dashboard with
      one-click actions (rerun, open PR, fix)
- [ ] Savings counter on the dashboard (spend avoided vs Actions list
      price); mobile-friendly layout; attention-respecting notifications
- [ ] Tailscale-style runner pairing (one command, zero config)
- [x] Plain-English PR comments (one evolving run summary)
- [x] 5-minute quickstart (README pick-your-path table, one-click deploy)

## Hosted & paid tiers (outside OSS scope)

The OSS core is MIT and stays free forever, self-hosted on your own
Cloudflare account. Planned paid surfaces, for clarity:

- **Flare Cloud** — the hosted control plane: one-click onboarding
  (no wrangler), usage dashboard + billing, managed seats autoscaling.
  Founding price ~$49/concurrent runner/month, validated with the first
  design partners.
- **Enterprise** (annual) — SSO/SAML + SCIM, RBAC, audit-log export /
  SIEM, policy engine (allowed repos/runners, org-wide budget caps),
  DPA/trust center, SLA; BYOC/in-VPC and data residency are satisfied by
  construction ("no multi-tenant vendor storage of your code"); SOC 2
  Type 2 is a funded milestone, not day one.
- **Private tournaments** — flat per event; public tournaments stay free
  marketing.

**Pricing philosophy** (from 46+ pricing-sentiment sources): price
capacity, not meters — unlimited minutes and seats, bill = concurrent
runners ("how many things running at once is your bill"); one developer
runs 10+ agents, so per-seat pricing is dead and per-minute billing taxes
the behavior it should reward. BYO minutes are unlimited and free. No
round-ups, no creeping meters. Enterprise bills as platform fee + runner
pool + published overage + a hard cap: over-budget runs are rejected, not
just alerted — "estimate next month's bill in under five minutes."

**Agent purchasing** (hosted tier): [ ] `flare signup --agent`, prepaid
credits (buy runner-months), approval-link top-ups, a skill buy-flow, and
an x402 spike — mapped so an agent can buy capacity without a human
billing event per run.

## Non-goals (for now)

- Replacing GitHub the forge (repos, PRs, reviews stay where they are).
- Managed Windows/macOS runners — BYO only (a capex game; we lose it on
  purpose).
- A $/minute price war with funded runner vendors — compete on the agent
  interface, not the meter.
- Generic "faster containers" claims — table stakes, not differentiation.
- Building the review UI: we cut the diff tax (triage, digests, one PR
  summary) but human review stays in GitHub.
- Full cryptographic supply-chain infra: attestation starts with signed,
  verifiable run records.
- A marketplace of thousands of actions — ten excellent built-ins beat
  ten thousand unmaintained YAML wrappers.

## Known gaps (unscheduled)

- Quarantine surface: PR annotations + a dashboard view for quarantined
  tests (CLI/API exist).
- Per-agent-identity attribution for anomaly alerts (repo + branch land
  today).
- Cost-per-merged-PR trend (the remaining slice of the budget story).
- Cache management: `restore-keys` semantics + a dashboard cache
  browser/eviction.
- Step/job outputs and a richer `if:` expression subset.
- MCP tools for artifacts and schedules (runs/jobs/flaky already exist).
- Org-level allowlists for API tokens (repo allowlists shipped).
- Runner auto-update for BYO fleets.
