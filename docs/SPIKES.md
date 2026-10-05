# Evaluation Spikes (2026-10-05)

Time-boxed build/don't-build verdicts on three Cloudflare-adjacent
bets. Each spike answers one question with current (Oct 2026) platform
facts; "revisit when" triggers keep the verdicts fresh without
re-litigating them every month.

## K2 event streams: no adoption

K2 (public beta Oct 1 2026, Workers Paid only) is a partitioned,
durable, ordered log on R2: HTTP + Worker bindings, subscriptions
with leased at-least-once delivery, independent read positions per
subscription, 7-day default retention, ~1s p99 produce latency. It is
the ingestion layer underneath Basin Pipelines.

Evaluated fits, all rejected:

- **Replace Queues for job dispatch?** No. BYO runners poll over
  plain HTTPS with runner tokens; K2 consumers would need Cloudflare
  API tokens on every runner box (worse auth story), and K2 has no
  per-item retry/DLQ semantics — leases redeliver, then nothing.
  Queues stay the work primitive.
- **Log/event backbone with fan-out?** No. Every Flare event
  consumer (FTS index, AE/Basin emitters, monitors, checks) runs
  in-Worker as a direct call. Routing through K2 adds a paid-plan
  requirement plus ~1s latency for zero architectural gain at our
  scale.
- **Replace the Basin stream binding?** No. Basin streams already
  ride K2 under the hood; writing raw K2 buys nothing over the
  typed `CI_EVENTS` binding.

Revisit when: Flare grows external event consumers (customer
webhooks-as-a-service) or needs multi-consumer replay on CI events.
K2 is the right substrate for that; it is not a core primitive today.

## Forge generation pipeline: spec first, pipeline later

Forge (Sept 28 2026, Apache-2.0, `github.com/cloudflare/forge`) is a
pluggable OpenAPI → SDK/CLI/docs/MCP pipeline that runs in CI with
per-PR preview builds. It is explicitly young: production use today
is the `cf` CLI; Cloudflare's own SDKs and docs migrate "in the
coming months."

The blocking fact for Flare is not Forge's maturity but the missing
input: **Flare has no OpenAPI spec.** Writing one is the ordered
first step — it pays off with or without Forge (API docs, request
validation, agent tool generation, `cf`-style CLI interop). Even
with a spec, generation saves less here than at Cloudflare scale:
our CLI has bespoke UX a generator cannot emit (local execution,
watch mode, Actions import), our MCP surface is curated for agents
(digests, `run_and_wait`) rather than REST-mapped, and
`packages/runner-sdk` is an orchestrator plus a thin client, not a
pure API client.

Verdict: do not adopt the pipeline now. Author `openapi.yaml` for
the v1 API as its own roadmap item; re-evaluate Forge once the spec
exists and Forge has multi-product production use.

## Workflows as orchestration: don't migrate the core

Workflows (durable per-instance orchestration: `step.*` primitives,
`waitForEvent`, sleeps, `.subscribe()` live events; 1024 steps
default, 25k configurable; waiting instances don't count toward
concurrency; paid steps billed past 500k/mo) plus the
`@cloudflare/ci` "a pipeline is just a Workflow" pattern prove
durable CI orchestration works — for Artifacts-first,
TypeScript-defined, platform-executed pipelines.

Flare's shape differs on every axis that matters:

- **Executors are external.** BYO runners poll HTTPS; seats are
  DO+container. A Workflow step cannot execute a job — it can only
  `waitForEvent` on a callback the worker bridges in, which keeps
  all current machinery (claims, heartbeats, stale sweeps) plus a
  Workflow layer on top.
- **D1 is the read model.** Dashboard, CLI, flaky rates, FTS search,
  and the API all query D1. Workflow instance state is not
  SQL-queryable, so migration means dual-writing every transition
  back to D1 — the current code, plus steps billing.
- **Free tier.** 3k steps/day covers a toy; real CI on the free tier
  would exhaust it. D1+queues keep one-click deploys free.

Verdict: keep D1+queues as the scheduling core. Consider Workflows
only for new self-contained orchestrations where durability matters
and SQL queryability doesn't (warm-box lifecycle, multi-stage
rollouts) — none of which exist yet.

## Summary

| Spike | Verdict | Revisit trigger |
|-------|---------|-----------------|
| K2 streams | No adoption | External event consumers / replay needs |
| Forge pipeline | Spec first, pipeline later | `openapi.yaml` exists + Forge matures |
| Workflows core | Don't migrate | New orchestration need outside D1 reads |
