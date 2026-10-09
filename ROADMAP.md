# Flare Actions Roadmap

Derived from a Blacksmith feature-gap analysis (Oct 2026) and a full read of
the Cloudflare blog + changelog window Aug–Oct 2026 (57 posts) and 9
Blacksmith engineering posts. Every item names the Cloudflare primitive it
builds on — nothing here needs off-platform infrastructure.

## Build status (Oct 8, 2026)

Shipped and tested (vitest green, tsc clean, seats dry-run green):

Oct 8 additions: one-command adoption (`cli connect` — probe, wire,
verify HEAD — plus the `skills/flare-setup` agent skill and a README
agent paste prompt) and `runs-on: flare` runner mode (opt-in ephemeral
JIT runners: `workflow_job` ingest, JIT claim lane, `runner -- --github`,
`cli github-jobs`, dashboard card, `docs/GITHUB-RUNNERS.md`), plus a
dashboard refresh (first-run onboarding checklist, auth divider,
small-screen responsive pass), plus `--json` everywhere, `cli explain`,
Tailscale-style runner pairing, dry-run dispatch (`--dry-run` on
`cli run` / `cli dispatch`), machine-actionable errors (21 codes +
hints, `docs/ERRORS.md`), and the quarantine surface (dashboard Flaky
tab + PR-comment section). OpenAPI is at 75 paths (was 68).

- **Phase 0**: V2 seats on the `durable_object` policy — `ContainerSeatV2`
  + `SEATS_V2` binding (additive; V1 keeps serving in-flight jobs, rollback
  is a binding swap), same-`migrations` declaration per the migration guide,
  alarm keep-alive, `snapshotContainer`/restore plumbing, SSH enabled,
  `compatibility_date 2026-10-01`. Shipped since: `container.monitor()`
  pending-I/O keep-alive (lazy `docker wait` race, exit 125 fail-fast),
  Streamline local-Docker dev mode (`apps/seats/src/local-docker.ts`),
  warm dev boxes (`cli devbox` + `cli mcp-serve`, snapshot lineage via
  `docker commit`), Sandbox SDK 1.0 utils (`sandbox-fs.ts`: Files
  integrated with exec fallbacks, S3Mount/DirectoryBackup plumbed
  with gateways; seat snapshot prune wired).
- **Phase 1**: monitors, JUnit analytics, `cli cache`/`cli usage`,
  Turnstile, tracing, Issues flag, D1 free-tier audit
  (`docs/d1-free-tier-audit.md` — found and fixed seat report caps +
  egress chunking), D1 FTS5 log search (`search.ts`, Lucene-like query
  UX), least-privilege setup tokens (`scripts/mint-token.mjs`, 4
  profiles, `docs/TOKENS.md`, per-Worker `--worker` scoping for ci +
  debug), Billable Usage API in `cli usage` (`/v1/usage/billable` +
  SDK + CLI + dashboard strip, R2-bandwidth pairing, truncation
  reporting past the 2000-row fetch cap). K2 spiked, no adoption
  (`docs/SPIKES.md`).
- **Phase 2**: snapshot-backed caches (image-lineage keyed, fail-fast
  degraded handling), retain-on-failure (`retain-on-failure` YAML key,
  30-min TTL alarm, SSH), per-job egress report (measured R2 transfers
  + interface delta + LD_PRELOAD per-domain rows; `/v1/runs/:id/egress`,
  digest, dashboard, `cli egress`), fair-share caps + deterministic
  simulator
  (`fairness.ts`, `/v1/admin/queue`, `cli queue`), seats peak-RSS
  sampling (`peakRssBytes`), hourly runtime priors (`priors.ts`, LPT
  claim order), job-level egress enforcement (`egress.allow`) +
  per-repo domain floor policy (`/v1/admin/egress-allowlist`, fan-out
  merge, dry-run preview, dashboard Settings UI),
  browser-checks, local named dev boxes (`cli devbox` + sync +
  snapshots), new admin settings UI. Still open: remote
  (seat-persisted) named warm boxes + Files-based sync,
  dashboard RSS graphs + label-size hints, BYO
  peak RSS/CPU self-report, Workers VPC (blocked on platform),
  browser preview self-verification + richer actions.
- **Phase 3**: AI Gateway fronting for triage + generate (env `AI_GATEWAY_ID`
  or D1, off by default), Web Search grounding for triage (opt-in
  `triage_web_search`, needs a gateway), MCP `2026-07-28` negotiation +
  `server/discover`, WriteGuard tiers + attributed audit + optional
  write-confirm gate. Shipped after: SDK `createMcpHandler` transport +
  OAuth Provider v1 (dynamic clients, consent, dual-auth with legacy API
  tokens, D1-backed store, no new infrastructure), WebMCP dashboard
  tools (session-cookie path + 5 native page tools), CI analytics
  sinks (Analytics Engine hot path + Basin cold path + SQL cookbook),
  HealingAgent self-heal runs (opt-in toggle, draft PR + verify run),
  evaluation spikes (K2/Forge/Workflows verdicts in `docs/SPIKES.md`),
  model refresh evals (second run + Clef judge gate), `openapi.yaml`
  for the v1 API (75 paths, CI coverage gate), agent-traces for warm
  boxes + heal + generate, and self-service OAuth grants (dashboard
  Apps tab + `GET`/`DELETE /v1/oauth/grants` with scope descriptions).
  The spec is served live (`/openapi.yaml` + `/docs`) with a Redocly
  validity gate in CI next to the coverage gate.
- **Git competition entry** ("next Git platform", deadline Oct 14):
  **Flare Tournaments** — race N agents in Artifacts forks, verify each
  with real CI, collision radar, deterministic verdict + AI Why, winner
  fast-forwarded from the Worker, append-only ledger
  (`docs/TOURNAMENTS.md`, `npm run harness`). Shipped Oct 6:
  Artifacts trigger + seats checkout, tournament API + board, verdict +
  MCP `tournament_why`, isomorphic-git promote with blessed-pointer
  fallback. Staging-green 3x in a row on the fast-forward path, run/try
  guide verified cold from a fresh clone. Still open: record the video
  (`docs/VIDEO-SCRIPT.md`) and submit.

## Strategy note: @cloudflare/ci and where Flare wins

Cloudflare now ships its own CI story: the `@cloudflare/ci` SDK (Aug 4,
"a CI/CD pipeline is just a Workflow") — TypeScript-defined pipelines,
Artifacts push triggers, sandbox snapshots in R2 for caching, and a
HealingAgent that opens fix branches. That validates our space but does not
overlap our core: Cloudflare's is Artifacts-first, TypeScript-defined, and
platform-oriented. Flare wins on: GitHub-native (webhooks, checks, statuses),
YAML pipelines with an Actions importer, BYO runners on any infra, and the
agent surface (MCP, `run_and_wait`, digests). Borrow their patterns
(snapshot caching, heal-on-failure, push-triggered workflows); don't chase
their shape.

## Where we already match or lead Blacksmith

Console run history, flaky detection, PR failure comments, check runs with
annotations, per-run cost attribution, R2 cache + artifacts, full CLI, GitHub
App, notifications, retries/concurrency/schedules. Ahead on agent surface
(MCP, `run_and_wait`, blocking wait, digests), AI failure triage, NL pipeline
generation, Actions importer, self-hosted seats — and, since Oct 8,
one-command adoption (`cli connect`) plus a `runs-on: flare` runner mode
that answers Jog-style "change one line" pitches without asking anyone
to leave GitHub Actions (ephemeral JIT runners, checks/logs stay put;
see `docs/GITHUB-RUNNERS.md`).

## Phase 0 — Seats platform migration (unblocks Phase 2)

The Sept 30–Oct 1 platform drop changed how seats should be built. Migrate
`ContainerSeat` off the single-image container API. Deadline pressure is
real: the legacy Container/Sandbox classes get updates only through
Dec 31, 2026, and new capabilities are native-only.

- `durable_object` scheduling policy: per-job image + instance-size selection
  (public beta; migration is one-way — rehearse on a preview branch first).
  Carbon-copy their rollout pattern: image choice as code (canary by DO-id
  hash, pin active projects, rollback by changing future starts).
- Sandbox SDK 1.0 utilities (shipped: `@cloudflare/sandbox@1.0.0`,
  `sandbox-fs.ts` adapters + `S3Gateway`/`DirectoryBackupGateway`
  exports, in-image `sandbox-shim`, fuse3/s3fs in the Dockerfile):
  `Files` (stream files in/out) is integrated — JUnit discovery and
  the egress-log read prefer it with exec fallbacks for pre-shim
  images; `S3Mount` (mount the R2 cache bucket; Worker signs requests
  so creds stay out of the sandbox) and `DirectoryBackup` (dir → R2
  → restore into any sandbox) are plumbed, credential-gated, and
  unit-tested, with warm boxes as the first consumer. The dead
  `pruneSeatSnapshots` is wired into the webhook sweep.
- Filesystem snapshots (public beta): point-in-time save/restore across
  sleep, restart, and DO handoff. The primitive behind warm boxes, caches,
  and retain-on-failure. 648ms median cold start on the new path; 100k
  containers burst-tested.
- Pending-I/O keep-alive (compat date `2026-10-01`): `container.monitor()`,
  `waitUntil()`, and timers keep the DO alive without a connected client.
  Retires the "open request keeps the seat alive" constraint in `seat.ts`.
- Headroom (Oct 2 limits refresh): 6 TiB mem / 1,500 vCPU / 30 TB disk per
  account, custom instance sizes for all, no disk:memory ratio, DOs stay
  alive 15 min on active outbound conns, 1M subrequests, 32 MiB WS
  messages. Revisit seats sizing tiers against these.
- Adopt the Streamline pattern (Oct 2) as the reference architecture:
  Worker (control API) + Durable Object (orchestrator, session locks,
  max-duration guard) + Container (execution), with local-Docker dev mode.

## Phase 1 — Worker-only wins (no platform risk)

Ship while Phase 0 bakes. Pure Worker + D1 + R2 + cron:

- **Monitors** (extends `notify.ts`): rules for consecutive failures on a
  branch, duration thresholds on running jobs, skipped steps, log-pattern
  match → Slack/Discord webhook. Duration checks ride the existing
  per-minute cron. Watch the Custom Alerts beta (SQL-defined alerts,
  webhooks on all plans) as a future substrate.
- **Test analytics (JUnit)**: runners/seats upload JUnit XML as first-class
  artifacts; worker parses per-test results into D1; failing tests join the
  PR comment and get a Tests tab in the dashboard. Upgrades run-level flaky
  to test-level.
- **`cli cache` + `cli usage`** (shipped: list/purge, usage + cost
  data, Billable Usage API dollars via `/v1/usage/billable` + SDK +
  CLI + dashboard strip): cost attribution shows real Cloudflare
  dollars (FOCUS-shaped, self-serve, daily rows) next to the
  GitHub-list-price comparison, paired with R2 bandwidth metrics
  (GraphQL, best-effort) and labeled partial past the 2000-row
  fetch cap. Still open: R2 Data Access Logs (Sept 4) pairing.
- **Global log search**: D1 FTS5 confirmed available — build the Lucene-like
  query UX Blacksmith validated
  (`branch:main level:error (failure OR panic) -"econn refused"` compiled
  to SQL, materialized level column, row TTLs). Scale-out is Logpush (all
  plans, usage-based, Sept 30) → R2/Basin, or K2 streams (below).
- **K2 event streams spike** (spiked 2026-10-05, see `docs/SPIKES.md`):
  no adoption. K2 (public beta Oct 1, Paid only, ~1s p99 produce) is
  Basin's ingestion layer; Flare's consumers all run in-Worker, Queues
  keep the retry/DLQ semantics runners need, and the Basin binding
  already rides K2. Revisit for external event consumers (webhooks).
- **Turnstile on auth forms** (Spin GA): harden login/register/bootstrap
  alongside `ratelimit.ts`; Spin's agent-driven install fits our workflow.
- **Workers tracing APIs** (Sept 25: `getActiveSpan`, `recordException`,
  `startSpan`, `setAttributes` + auto JS-RPC spans): instrument hot paths;
  traces surface in custom dashboards (Oct 2) and Cloudflare Traces
  (open beta). Add `user.id`/`run.id` span attributes per the Issues
  contextualization pattern.
- **Issues for Workers** (open beta, Sept 30): set
  `observability.issues.enabled: true`, dogfood error-to-agent routing for
  our own worker; validates the triage direction. Note unified
  observability pricing lands Dec 1, 2026 — budget seats log volume.
- **D1 free-tier query limits** (enforced Sept 1: 5M reads / 100k writes
  per day): audit one-click-deploy query volume so fresh forks can't trip
  limits; document the Paid step-up.
- **Least-privilege setup tokens** (shipped: `scripts/mint-token.mjs`,
  ci/debug/billing/setup profiles in `scripts/api-tokens.mjs`,
  dashboard checklist in `docs/TOKENS.md`, enriched-403 hints in
  setup): tokens mint at account scope with granular groups (one
  account only, never All), and debug composes explicit read groups
  rather than a single metadata role. Per-Worker scoping shipped via
  `--worker` (ci: Individual Workers edit replaces Scripts Edit;
  debug: per-Worker Metadata Read-Only replaces code reads).
- **cf CLI tracking** (open beta Sept 28): JSON-first, 3,000+ ops,
  `cloudflare.config.ts`, Vite-based. Wrangler gets a final major + 18
  months maintenance after beta ends. No migration yet; track for setup
  scripts. Preview caveat: queue consumers and cross-Worker service
  bindings are not yet preview-isolated.

## Phase 2 — Seats-powered differentiators

Needs Phase 0 done:

- **Warm remote dev boxes** (our Testbox answer): snapshot-persisted seat
  container + incremental source sync over `Files` + a `cli` command and MCP
  tools wired into `run_and_wait`. The best fit in the whole list for our
  agent-first direction.
- **Snapshot-backed caches**: Docker layers / pulled images and repo
  checkouts captured as snapshots per repo/branch and restored on the next
  job. Apply Blacksmith's measured rules: scope by image lineage (not by
  repo); persist mount state, not just layers (their Rust dep-change:
  3.6s persistent vs 164s export backend vs 19s no cache); fail fast on
  degraded cache (a miss beats a 10-minute fetch); benchmark by change
  class (cold/warm/source-change/dep-change), not by "second build" demos.
- **Retain-on-failure + debug terminals**: keep the failed container, expose
  the SDK 1.0 browser terminal; destroy after TTL. Copy Blacksmith's SSH
  UX: instant hostname, identity-keyed access (GitHub keys), grace period
  on teardown when a session is active.
- **Per-job egress observability + policy**: Blacksmith built this with
  eBPF + a DNS proxy. Shipped the report first via a passive
  `LD_PRELOAD` shim (`apps/seats/egress.c`, compiled into the seat
  image): per-domain req/resp bytes in `job_egress` next to the `r2:*`
  and `(interface)` rows — zero traffic-path change, staging-validated
  across curl/Node/Python with byte-exact counts. Shipped next, ahead
  of their still-unannounced Part 2: opt-in per-repo domain floor
  policy — repo default merged at fan-out (undeclared jobs inherit,
  narrower job lists pass), strict-subset violations reject the whole
  dispatch with zero writes (`egress_policy_violation` on the API,
  200-skip on webhooks), dry-run previews the effective list per job;
  the seat shim enforces, BYO runners fail closed.
- **Artifacts repo mirroring** (open beta Oct 1, Paid-only, billing
  from Oct 15): shipped seats-side mirror preference
  (`ARTIFACTS_MIRROR_REMOTE` template + read-scoped token, mirror
  first with GitHub fallback, fail-closed template check,
  encoded-token scrubbing) — staging-validated
  (`mirror-canary-job-02/04`). Still manual: per-repo provisioning +
  yearly token rotation. The Oct 1 "next Git platform" post shipped
  the primitives the open items ride on: the `ARTIFACTS` Workers
  binding (fork/inspect/read + repo-scoped Git tokens → worker-minted
  per-job tokens), event subscriptions (`cf.artifacts.repo.pushed` →
  queue → workflow, plus created/forked/deleted/cloned/fetched →
  push-event triggers), Workers Builds integration (push → deploy,
  branch → Preview), per-namespace US/EU data jurisdiction, and
  dashboard/API metrics. Shipped since: per-job checkout tokens via
  the binding (1h read tokens for in-namespace mirrors) and
  push-event triggers (`artifacts-push.ts` + artifacts queue consumer
  + setup opt-in). Still open: hands-free per-repo provisioning +
  token-rotation automation. Entered the
  "next Git platform" competition — deadline Oct 14, 5–10 min demo
  video + MIT/Apache/BSD source + run instructions, multi-agent
  concurrency required; top 3 fly to Connect SF, first prize $25k
  credits + VIP dinner. Flare's angle: **Flare Tournaments**, the pull
  request for the agent era (race → verify → radar → verdict →
  promote → ledger on Artifacts repos; entry status in Build status
  above, execution spec in `.agents/plans/2026-10-06-git-competition.md`).
- **Per-job CPU/mem + right-sizing** (shipped: seats peak-RSS sampling
  via exec/cgroupfs into result-JSON `peakRssBytes`, hourly
  per-job-name runtime priors with LPT claim order in `priors.ts`):
  still open are BYO peak RSS/CPU self-report in status callbacks,
  dashboard RSS graphs, and label-size hints. Container-native
  metrics stay the fallback when the API exposes them.
- **Scheduling fairness**: oldest-first within priority already matches;
  add per-org/repo concurrency shares so one tenant's burst can't starve
  others, and a deterministic simulator to validate policy changes
  (their words: "operating the software comes with few surprises").
- **Workers VPC for seats** (open beta, assessed Oct 5 2026 — blocked
  on platform): `vpc_services`/`vpc_networks` are Worker bindings
  (`env.BINDING.fetch()` via Tunnel/Mesh) with no container attachment;
  seat containers egress independently, so steps cannot reach private
  origins through it. Option when that lands: attach seats to the VPC
  and staging-validate private checkout + step egress. Until then,
  private origins stay a BYO-runner story (run the runner inside your
  network), like static egress IPs, which have no Containers
  equivalent.
- **Browser-test jobs**: shipped `browser-checks` (seats-only YAML
  key, max 10/job, https-only, ≥1 assertion required): the seat DO
  drives Browser Rendering via the `BROWSER` binding
  (`@cloudflare/puppeteer`) after successful steps, asserts
  title/text substrings, stores `browser-<name>.png` screenshots as
  artifacts, and fails the job on any miss. BYO runners and
  `cli local` fail closed (never silent green); missing binding
  fails with a configuration pointer. Staging-validated
  (`browser-canary-job-02/03`, incl. a live assertion-miss and a
  real PNG in R2). Still open: preview-deploy self-verification
  jobs, richer actions (click/type/wait) if demand appears.

## Phase 3 — AI + agent surface + scale

- **Triage/generate model refresh** (refreshed 2026-10-05, second
  eval run, see `docs/MODEL-EVAL.md`): default stays
  `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (only triage model stable
  across both runs); deepseek quality-first pick; glm regressed to
  0.50 (avoid); full Clef (stable 1.00) wired as the HealingAgent
  judge gate (`judge.ts`, skips heals at p(flaky) ≥ 0.5, fails open).
  `cloudflare/auto` considered and declined (variance in scripted
  slots). Re-run `npm run eval:models` after prompt/model changes.
- **AI Gateway in front of inference** (one-line change:
  `{ gateway: { id: 'default' } }` auto-creates): unified billing,
  full request/response logging, token + cost attribution, User Insights
  (overkill/spend analysis), identity-aware controls. Model-first routing
  and server tools (web search as a native tool) are coming.
- **Web Search API** (beta Oct 2, via the AI binding or REST, list price,
  no markup, BYOK): ground triage and `generate` in live docs/error
  search instead of training cutoff.
- **MCP upgrade** (shipped 2026-10-05): protocol `2024-11-05` →
  `2026-07-28` via the official TS SDK's `createMcpHandler` (stateless
  per-request servers, Web Standards transport — the Agents SDK wrapper
  was evaluated and skipped: DO sessions, `node:async_hooks`, and client
  code add nothing for a stateless server) + Workers OAuth Provider v1
  (role-based AS+RS, dynamic client registration, consent page,
  `flare:read`/`flare:run`/`offline_access` scopes) alongside
  Bearer tokens. Serve old + new stateless clients from one route during
  migration on a D1-backed store (`oauth_kv`, zero new infrastructure).
  MCP server portals GA (Sept 24) is the enterprise distribution path.
- **WriteGuard pattern for our MCP tools**: risk tiers per tool
  (read-only vs `dispatch_run`/`rerun` as contained-write/critical),
  agent attribution on writes, async scrubbed audit events, server-side
  blocks that no client switch can bypass. Design per the Agent Access
  Model: short-lived task-scoped credentials, enforcement in the harness,
  human approval only for exceptional actions.
- **Stable typed MCP result envelopes** ("muscle memory" lesson): every
  tool returns a small stable schema (field names + broad types), never
  raw unbounded payloads — digests already do this; extend to all tools
  so agents stop guessing fields.
- **WebMCP for the dashboard** (shipped 2026-10-05): session-cookie
  path on `POST /mcp` for same-origin browser callers (the Site MCP
  Server pack proxies with `credentials: same-origin`; CSRF gates hold)
  plus five native `modelContext` page tools (reads for everyone,
  dispatch/rerun for admins), feature-detected. Pack toggle documented
  for custom domains; native tools work everywhere including workers.dev.
- **CI analytics** (shipped 2026-10-05, see `docs/ANALYTICS.md`):
  Analytics Engine hot path (`run.dispatched`/`run.terminal`/
  `job.terminal`, documented slot schema + SQL cookbook) emitted by
  both executors, plus a Basin Pipeline cold path (`CI_EVENTS` stream,
  optional paid-plan binding provisioned best-effort by setup) landing
  the same events as Iceberg rows for Basin SQL. AI Search evaluated
  and deferred: it is a site/document RAG pipeline, not a metrics
  sink — the future fit is retrieval over the triage/log corpus once
  that corpus exists (billing from Nov 1).
- **Self-healing runs (HealingAgent pattern)** (shipped 2026-10-05,
  see `docs/HEALING.md`): opt-in `heal_on_failure` toggle; failures
  file an atomic claim, the scheduled tick drains it (model proposes
  full-file fixes, Git Data API pushes `flare-heal/*`, draft PR
  opens, verification run dispatches with `source: heal:*`). Source
  run stays failed; no heal loops; human merge mandatory. Needs App
  `contents:write` (manifest bumped; older installs must re-accept).
- **Forge evaluation** (spiked 2026-10-05, see `docs/SPIKES.md`):
  spec first, pipeline later. Forge (Sept 28, Apache-2.0) is young
  (`cf` CLI only in prod); our CLI/MCP surfaces are bespoke, not
  REST-mapped. The spec prerequisite shipped 2026-10-05
  (`openapi.yaml`, 75 paths as of Oct 8, CI-enforced); Forge
  re-evaluation is future work once Forge matures past `cf`-CLI-only.
- **Agent-traces for agent features** (shipped 2026-10-05): OTel
  GenAI-convention spans on triage/generate/judge/heal inference plus
  root-span annotations for warm boxes (seat run/job/snapshot
  lifecycle), heal claim→drain outcomes, and generate requests —
  warm boxes and heal-agents are replayable from a run id.
- **Handle busy-rejection**: Workers AI sync inference now rejects when
  busy (Sept 17) — confirm triage/generate degrade-to-skip covers it.
- **Workflows as orchestration** (spiked 2026-10-05, see
  `docs/SPIKES.md`): don't migrate the core. External executors
  (BYO poll, seats DO+container) can't run Workflow steps, D1 is the
  SQL read model the dashboard/CLI/API share, and free-tier steps
  don't cover real CI. The `@cloudflare/ci` pattern fits
  Artifacts-first pipelines, not GitHub-native YAML. Workflows stay
  an option for future self-contained orchestration only.
- **`@cloudflare/computer` watch** (early preview): isolate-first agent
  runtime (just-bash in Dynamic Workers, FUSE-synced SQLite workspace,
  container only when needed, <10% container goal). Long-term this could
  run simple steps without containers at all.
- **Community Engineers grants**: $1M OSS fund; the 2026 application
  window closed September 6 (annual process). Revisit next cycle —
  Flare qualifies thematically (OSS on CF infra).

## Explicitly not chasing

- Cloud coding agents ([code]smith-class): a whole second company. (But
  steal Code Mode's context economics: tools-as-code + sandbox-side
  aggregation + shape cache.)
- Hosted macOS/Windows/GPU runners: Containers are Linux-only; that matrix
  stays BYO-runner by design.
- Dynamic Workers for untrusted code: our step conditions stay a bounded
  subset; no eval needed. (Revisit only via @cloudflare/computer.)
- Monetization Gateway (closed beta, US-only) + Wallets: only if we ever
  charge agents per API call. Watch.
- Rust Emscripten preview, WSGI/Django Workers, Hyperdrive MySQL GA,
  gRPC/TCP ingress (private beta): no Flare surface touches them.
- K2 Express tier / Kafka-compat: evaluate only if the K2 spike succeeds.
- KV Instant (private beta, $100/MB/mo storage): wrong shape for CI data;
  at most tiny hot flags later.
- Cloudflare OS / managed agent workspaces: interesting distribution
  (Flare as a Gatekeeper'd tool?), not a build target.

## Sequencing

Phase 0 keep-alive + policy migration first (smallest, de-risks snapshots),
then snapshot/restore, then SDK helpers. Phase 1 ships in parallel
(Monitors + JUnit analytics first: highest value, zero platform risk).
Phase 2 starts when snapshots land. Phase 3 is continuous eval.

## Sources

- Cloudflare blog Aug 5–Oct 2, 2026 (57 posts read in full; skipped as
  low-relevance: Rust Emscripten, Kimi/GLM serving internals, Radar
  Researcher, OS-internal usage, Python-RPC, plus network/security/CA
  posts) + changelog RSS (799 entries) + docs pages for Sandbox SDK 1.0,
  snapshots, scheduling policy, keep-alive, Artifacts, OAuth Provider v1.
  Plus the Oct 1 "next Git platform on Cloudflare" post (Artifacts open
  beta: Workers binding, event subscriptions, Builds integration, data
  jurisdiction, metrics, Oct 15 billing; competition deadline Oct 14).
- Blacksmith blog: 10M-jobs scheduler (Sep 18), Docker physics (Jul 31),
  network observability P1 (Jul 20), storage (Jul 24), code-mode
  (Aug 24), cache RE (2025), ClickHouse logging (2025), SSH (2025);
  skimmed: [code]smith mascot (no signal); skipped: outage postmortems,
  funding news, pricing/economics, Tailscale, rebrand.
- Research notes: `/tmp/cfposts/` (57 extracted posts), `/tmp/cf_posts.json`
  (93-post archive index), `/tmp/bsposts/` (Blacksmith extracts).
