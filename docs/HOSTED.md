# Flare Cloud scaffold

The OSS core is MIT and stays free forever, self-hosted on your own
Cloudflare account. Flare Cloud is the hosted control plane (one-click
onboarding, usage dashboard + billing, managed seats autoscaling).
This scaffold is the seam between them: flag-gated, inert by default,
and shaped so Cloud can provision without touching OSS behavior.

## The flag contract

- `FLARE_CLOUD=1` (env-only, set only on Flare Cloud) marks hosted
  mode. It is deliberately **not** a dashboard setting: no toggle can
  paywall a self-hosted deploy by accident.
- Self-hosted (`FLARE_CLOUD` unset): every Cloud surface 501s with
  `hosted_only`, dispatches skip the entitlement check with zero extra
  queries, and rollups skip metering entirely.
- Hosted without provisioning behaves like OSS (unlimited, unmetered):
  missing entitlements degrade to unlimited, metering defaults off.
  Cloud provisions explicitly via the admin settings API.

## Surfaces (all in `apps/worker/src/cloud.ts`)

- **Plan entitlements** — D1 `cloud_entitlements` JSON
  (`{"maxConcurrentJobs": N}`, provisioned via
  `POST /v1/admin/settings`). `cloudVerdict` counts active
  (queued + running + blocked) jobs and refuses new dispatches at
  the cap: 429 `plan_limit_exceeded` on the API/MCP lanes (job reruns
  included), skip-200 on webhooks, skip on schedules,
  `cloud.wouldBlock` on dry-run. The cap is also a hard limit at claim
  time: `claimJob` folds `COUNT(running) < cap` into its conditional
  UPDATE, so neither one large dispatch nor concurrent dispatches can
  run more than the cap at once — BYO runners get `{ job: null }`,
  seats leave the job queued and re-wake in 60s (30-minute horizon).
- **Credit ledger** — `credit_ledger` table (grants + run spend,
  `POST /v1/cloud/credits/grant` idempotent on `ref` so retried
  billing webhooks credit once — replays answer `duplicate: true`, and
  a reused ref with a different amount is a 409, never a silent no-op; `GET /v1/cloud/credits/balance`
  for `cli credits`). Balances may go negative: the scaffold
  **tracks, never blocks** — enforcement at zero is a future Cloud
  overage policy, not this seam.
- **Run metering** — terminal rollups record exactly-once spend at
  the list rate of 1¢/compute-minute, summed across jobs (parallel
  jobs both count), rounded up per run. Each rollup charges only the
  delta over what the run already paid, under `ref =
  run:<runId>:<cumulativeCents>` (legacy `run:<runId>` rows count as
  paid), so redeliveries are a no-op and a rerun that turns the run
  terminal again is billed for its new compute. Earlier attempts live
  in `jobs.billed_ms`: retries (`retry: N`) and reruns fold their
  elapsed time in before resetting `started_at`; seat fallbacks and
  dead-executor requeues do not (platform faults, not customer spend). Wired through every terminal path:
  worker finish/cancel/promote and both seat executors.
- **Capability probe** — public `GET /v1/cloud/status`
  (`{ hosted, metering, maxConcurrentJobs }`) so CLIs and agents
  adapt before calling anything gated.
- **Top-up links** — single-use prepaid codes (`POST
  /v1/cloud/topup-links` mints a code + approval link, `GET ...
  /redeem?code=` previews without consuming so unfurlers never burn
  it, `POST .../redeem` consumes + grants). Pairing-style public
  redeem with IP throttling; grant-then-consume ordering with an
  idempotent `topup:<hash>` ref means a crash between the two
  retries safely — money is never created or lost.

## Agent purchasing

`cli signup [--agent <tag>]` onboards against either plane from a
tokenless probe: hosted servers return the Cloud signup flow, OSS
servers print the self-host checklist (admin claim, Connect, pairing,
local verify). `cli credits` reads the ledger on hosted (on OSS it
says the deploy is unlimited and free). Prepaid credits (above) and
top-up links cover agent-held budgets; the x402 spike
(`docs/X402-SPIKE.md`, `POST /v1/cloud/x402/quote`) maps
machine-to-machine payment without a human billing event per run.

## What stays OSS-only (never gated)

Dispatch, claims, seats, runners, MCP tools, analytics, and the
dashboard work identically with the flag off — the gate sits
*around* dispatch (a pre-check) and *after* rollup (a ledger row),
never inside the execution path. Cloud adds capacity and billing;
it never removes OSS capability.
