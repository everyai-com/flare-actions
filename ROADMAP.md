# Flare Actions Roadmap

Derived from a Blacksmith feature-gap analysis (Oct 2026) and a full read of
the Cloudflare blog + changelog window Aug–Oct 2026 (57 posts) and 9
Blacksmith engineering posts. Every item names the Cloudflare primitive it
builds on — nothing here needs off-platform infrastructure.

## Build status (Oct 4, 2026)

Shipped and tested (405 vitest, tsc clean, seats dry-run green):

- **Phase 0**: V2 seats on the `durable_object` policy — `ContainerSeatV2`
  + `SEATS_V2` binding (additive; V1 keeps serving in-flight jobs, rollback
  is a binding swap), same-`migrations` declaration per the migration guide,
  alarm keep-alive, `snapshotContainer`/restore plumbing, SSH enabled,
  `compatibility_date 2026-10-01`. Still open: Sandbox SDK 1.0 utils
  (Files/S3Mount/DirectoryBackup), `container.monitor()` pending-I/O
  keep-alive, Streamline local-Docker dev mode.
- **Phase 1**: monitors, JUnit analytics, `cli cache`/`cli usage`,
  Turnstile, tracing, Issues flag, D1 free-tier audit
  (`docs/d1-free-tier-audit.md` — found and fixed seat report caps +
  egress chunking). Still open: D1 FTS log search, K2 spike,
  least-privilege setup tokens, Billable Usage API in `cli usage`.
- **Phase 2**: snapshot-backed caches (image-lineage keyed, fail-fast
  degraded handling), retain-on-failure (`retain-on-failure` YAML key,
  30-min TTL alarm, SSH), per-job egress report (measured R2 transfers
  + interface delta; `/v1/runs/:id/egress`, digest, dashboard,
  `cli egress`), fair-share caps + deterministic simulator
  (`fairness.ts`, `/v1/admin/queue`, `cli queue`), peak-RSS sampling,
  new admin settings UI. Still open: named warm dev boxes + file sync,
  per-domain outbound interception, Artifacts mirroring, runtime priors,
  Workers VPC, browser-test jobs.
- **Phase 3**: AI Gateway fronting for triage + generate (env `AI_GATEWAY_ID`
  or D1, off by default), Web Search grounding for triage (opt-in
  `triage_web_search`, needs a gateway), MCP `2026-07-28` negotiation +
  `server/discover`, WriteGuard tiers + attributed audit + optional
  write-confirm gate. Still open: model refresh evals, `createMcpHandler` /
  OAuth Provider migration, WebMCP, CI analytics sinks, HealingAgent,
  Forge, agent-traces, Workflows spike, grants application.

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
generation, Actions importer, self-hosted seats.

## Phase 0 — Seats platform migration (unblocks Phase 2)

The Sept 30–Oct 1 platform drop changed how seats should be built. Migrate
`ContainerSeat` off the single-image container API. Deadline pressure is
real: the legacy Container/Sandbox classes get updates only through
Dec 31, 2026, and new capabilities are native-only.

- `durable_object` scheduling policy: per-job image + instance-size selection
  (public beta; migration is one-way — rehearse on a preview branch first).
  Carbon-copy their rollout pattern: image choice as code (canary by DO-id
  hash, pin active projects, rollback by changing future starts).
- Sandbox SDK 1.0 utilities: `Files` (stream files in/out), `S3Mount`
  (mount the R2 cache bucket; Worker signs requests so creds stay out of
  the sandbox), `DirectoryBackup` (dir → R2 → restore into any sandbox).
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
- **`cli cache` + `cli usage`**: list/purge cache entries; pull usage + cost
  data for billing workflows. `cli usage` should call the Billable Usage
  API (FOCUS-shaped, self-serve, daily rows) so cost attribution shows
  real Cloudflare dollars next to the GitHub-list-price comparison.
  Pairs with R2 bandwidth metrics (Sept 24) and R2 Data Access Logs (Sept 4).
- **Global log search**: D1 FTS5 confirmed available — build the Lucene-like
  query UX Blacksmith validated
  (`branch:main level:error (failure OR panic) -"econn refused"` compiled
  to SQL, materialized level column, row TTLs). Scale-out is Logpush (all
  plans, usage-based, Sept 30) → R2/Basin, or K2 streams (below).
- **K2 event streams spike** (public beta Oct 1, Workers Paid, free during
  beta): partitioned durable log on R2 with subscriptions + fan-out
  consumers. Candidate backbone for the log/event pipeline (one stream,
  many consumers: search index, analytics, webhooks). Queues stay the work
  primitive (per-item retries/DLQ); K2 is for high-scale data movement.
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
- **Least-privilege setup tokens**: mint API tokens with the new granular
  RBAC (Editor scoped to the one Worker; Metadata Read-Only for debug
  agents). Enriched 403s now link the missing permission — surface those
  in setup errors.
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
  eBPF + a DNS proxy; our equivalent is the Sandbox SDK outbound handler
  (per-hostname Worker handling, allow/deny lists, credential injection
  that never enters the sandbox). Ship a per-job domain+bytes egress
  report first, then opt-in per-repo domain allowlists (their Part 2 is
  still unannounced — we can ship first).
- **Artifacts repo mirroring** (open beta Oct 1, Paid-only, billing
  mid-Oct): mirror source repos into Git-speaking Artifacts repos; seats
  fetch only new commits; evaluate push-event subscriptions
  (`cf.artifacts.repo.pushed` → queue → workflow) as a trigger source.
  Optional: enter the "next Git platform" competition (deadline Oct 14,
  MIT/Apache/BSD + demo video; first prize $25k credits + Connect stage).
- **Per-job CPU/mem + right-sizing**: BYO runners self-report peak RSS/CPU
  with status callbacks now; seats sample via exec (cgroupfs) until the
  container API exposes metrics — then dashboard graphs and label-size
  hints. Add Blacksmith's scheduler lesson: hourly per-job-name runtime
  priors to predict drain order and cut wide-job tail latency.
- **Scheduling fairness**: oldest-first within priority already matches;
  add per-org/repo concurrency shares so one tenant's burst can't starve
  others, and a deterministic simulator to validate policy changes
  (their words: "operating the software comes with few surprises").
- **Workers VPC for seats** (open beta): private access to databases/internal
  APIs as the Cloudflare-native answer where Blacksmith sells static IPs.
  True static egress IPs have no Containers equivalent — that stays a
  BYO-runner story.
- **Browser-test jobs (later in phase)**: Browser Run + Kitesurf
  (3–7x cheaper than Chromium on CPU/mem, CDP/Playwright/Puppeteer/MCP,
  `env.BROWSER.quickAction()` binding) as the engine for screenshot/
  e2e-test steps and for verifying our own preview deploys.

## Phase 3 — AI + agent surface + scale

- **Triage/generate model refresh**: currently
  `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. Evaluate GLM-5.3/Flash (1M
  context, Aug 26–28), DeepSeek V4 Flash/Pro (Aug 14), Qwen 3.8 27B
  (Aug 17) for long-tail quality; eval Clef/Clef-flash decision models
  (Oct 1: Jev-API compatible, 64k ctx, vision encoder, typed
  probabilities, 39/209ms, Apache-2.0, RL fine-tuning via AI Gateway
  datasets + Containers sandboxes) for flaky-vs-real classification and
  escalate/don't routing. Consider `cloudflare/auto` (Auto Router beta,
  free) for cost-aware routing.
- **AI Gateway in front of inference** (one-line change:
  `{ gateway: { id: 'default' } }` auto-creates): unified billing,
  full request/response logging, token + cost attribution, User Insights
  (overkill/spend analysis), identity-aware controls. Model-first routing
  and server tools (web search as a native tool) are coming.
- **Web Search API** (beta Oct 2, via the AI binding or REST, list price,
  no markup, BYOK): ground triage and `generate` in live docs/error
  search instead of training cutoff.
- **MCP upgrade**: protocol `2024-11-05` → `2026-07-28` (stateless, no
  handshake; `Mcp-Method`/`Mcp-Name` headers; `server/discover`;
  MRTR elicitation; CIMD preferred, DCR deprecated, removal after summer
  2027) via `createMcpHandler` (Agents SDK, now in the official TS SDK,
  Web Standards transport) + Workers OAuth Provider v1 (Oct 1) alongside
  Bearer tokens. Serve old + new stateless clients from one route during
  migration. MCP server portals GA (Sept 24) is the enterprise
  distribution path.
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
- **WebMCP for the dashboard**: the Site MCP Server pack proxies a site's
  own `/mcp` endpoint to browser agents with zero code (dev preview).
  Our dashboard + `/mcp` endpoint is a natural fit once deployed on CF.
- **CI analytics**: Analytics Engine custom metrics from the worker,
  queryable via the unified SQL API (beta) + native Worker binding for
  customer-facing dashboards and billing workflows; Basin (GA Oct 1:
  Pipelines → Catalog → SQL on Iceberg/R2, zero egress) as the
  log/telemetry sink if D1 FTS outgrows; AI Search (GA Oct 1, billing
  Nov 1, free embedding/rerank on default models) over run history as a
  semantic-search experiment with a public `/mcp` endpoint option.
- **Self-healing runs (HealingAgent pattern)**: on failure, optional
  agent step that proposes a fix on a new branch (source run stays
  failed; fix verified before surfacing). Triage is step one; this is
  step two. Keep human review mandatory.
- **Forge evaluation** (Apache-2.0, open source): generate CLI, SDK,
  docs, and MCP surfaces from an OpenAPI spec of our API, with
  per-PR preview builds. Our hand-rolled CLI/SDK/MCP triple is exactly
  the drift Forge eliminates.
- **Agent-traces for agent features**: emit OTel GenAI-convention spans
  (Agents view supports Think/Flue/AI SDK today, raw OTel soon) so warm
  boxes and heal-agents are replayable/debuggable.
- **Handle busy-rejection**: Workers AI sync inference now rejects when
  busy (Sept 17) — confirm triage/generate degrade-to-skip covers it.
- **Workflows as orchestration (spike, strengthened)**: exports-declared
  workflows, `.subscribe()` events, 25k steps/instance, 50k concurrent
  instances, Artifacts event triggers. The CI SDK proves the pattern;
  our D1+queues machinery works — evaluate a Workflow-backed executor
  path, don't adopt yet.
- **`@cloudflare/computer` watch** (early preview): isolate-first agent
  runtime (just-bash in Dynamic Workers, FUSE-synced SQLite workspace,
  container only when needed, <10% container goal). Long-term this could
  run simple steps without containers at all.
- **Community Engineers grants**: $1M OSS fund over two years, applications
  opening later — Flare qualifies thematically (OSS on CF infra). Apply.

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
- Blacksmith blog: 10M-jobs scheduler (Sep 18), Docker physics (Jul 31),
  network observability P1 (Jul 20), storage (Jul 24), code-mode
  (Aug 24), cache RE (2025), ClickHouse logging (2025), SSH (2025);
  skimmed: [code]smith mascot (no signal); skipped: outage postmortems,
  funding news, pricing/economics, Tailscale, rebrand.
- Research notes: `/tmp/cfposts/` (57 extracted posts), `/tmp/cf_posts.json`
  (93-post archive index), `/tmp/bsposts/` (Blacksmith extracts).
