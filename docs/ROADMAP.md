# Roadmap: crushing GitHub Actions

Thesis: GitHub bills per minute for cold VMs behind queues. Flare bills ~$0
for orchestration on Cloudflare's edge, executes on warm metal or
scale-to-zero containers, and wraps it in an agent-native experience.
Speed wins trials; price wins migrations; agents win the next decade.

October 2026 sharpened the thesis: agent fleets turned CI from a cost
center into the bottleneck — teams publishing that "CI is the top
bottleneck" (Linear's write-up, multiple viral founder threads, developers
disabling PR CI outright to dodge bills). Phase 6 is a direct answer to
what those threads keep asking for.

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

## Phase 6 — Agent-fleet CI (in progress)

Context: at 100s of pushes/day the per-push model breaks — every attempt
bills a full run, queues back up, and the wait tax lands on the agent loop
itself. Everything below answers that, in the order teams hit it.

### Already answering it

- [x] Flat cost at agent volume: orchestration on Cloudflare's free tier,
      BYO runners at box cost, no per-minute meter (managed seats are
      convenience, not the pricing model).
- [x] Agents don't poll: blocking wait + digest; MCP `run_and_wait`.
- [x] No commit needed to verify: `cli local` (warm cache, no server) and
      source dispatch (`cli run --source`).
- [x] Supersede control: concurrency groups + `cancel-in-progress` kill
      stale branch runs instead of letting every push pile up.
- [x] Dead-agent safety: the 20-minute heartbeat sweep requeues orphaned
      running jobs, so an interrupted agent can't wedge the queue.
- [x] Fleet-shared cache: R2 per-repo cache is one warm cache for ten
      worktrees/agents (plus local `~/.flare/cache` for `cli local`).
- [x] Per-run cost + time attribution vs Actions list price (`cli usage`,
      dashboard).
- [x] Runtime priors (p50 per job) already order dispatch and inform the
      dashboard.

### Next (queued)

- [x] Spend guardrails: per-repo monthly compute-minute budgets with
      warn/block modes, audit rows, and a dashboard form.
- [ ] Cost-per-merged-PR trend (the remaining slice of the budget story).
- [x] "What's blocking the merge" report: p50/p95 per check + median
      queue wait — dashboard card, `GET /v1/bottlenecks`, `cli
      bottlenecks`.
- [x] `paths:` trigger filters + `FLARE_CHANGED_FILES` exposed to steps,
      unlocking changed-file test selection recipes (unknown changes run
      conservatively, never silently skip).
- [x] Sharding: native `shards: N` splits a job across parallel cells
      with `FLARE_SHARD_INDEX`/`FLARE_SHARD_TOTAL` (setup overhead is what
      limits sharding — cache and preinstalled toolchains keep it down).
- [x] Auto-supersede: opt-in `one run per branch head` policy cancels
      still-active jobs of earlier same-branch runs on push.
- [x] Stale-job reclaims write a `[flare] requeued` line into the job log
      (visible in the dashboard); dead executors can't wedge the queue.
- [x] Recipes/docs: changed files, shards, and the check loop are covered
      in `PIPELINES.md`, `GITHUB-ACTIONS-COMPAT.md`, and `DEV-SPEED.md`.

### Research bets

- [ ] Merge queue for agent fleets: admission runs against the candidate
      merge commit, batched, with supersede semantics and conflict
      feedback — the `needs`/blocked-job machinery is the foundation.
- [ ] Run attestation: signed, SHA-pinned run manifests (digest + artifact
      hashes + executor identity) so a verification can be trusted without
      re-running it — starts as verifiable records, not a full
      supply-chain system.
- [ ] Test-impact selection: changed files → affected tests as a
      first-class pipeline helper (module graph or coverage map), with a
      full-suite fallback on any doubt.

## Known gaps (unscheduled)

- Cache management: `restore-keys` semantics + a dashboard cache
  browser/eviction.
- Step/job outputs and a richer `if:` expression subset.
- MCP tools for artifacts and schedules (runs/jobs/flaky already exist).
- Org-level allowlists for API tokens (repo allowlists shipped).
- Runner auto-update for BYO fleets.

## Non-goals (for now)

- Replacing GitHub the forge (repos, PRs, reviews stay where they are).
- Building the review UI: we cut the diff tax (triage, digests, one PR
  summary) but human review stays in GitHub.
- Full cryptographic supply-chain infra: attestation starts with signed,
  verifiable run records.
- A marketplace of thousands of actions — ten excellent built-ins beat ten
  thousand unmaintained YAML wrappers.
