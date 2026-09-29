# Managed executor on Cloudflare Containers (scaffolded)

Status: planned, not live. Everything below is the build plan; the BYO
runner protocol (`docs/RUNNERS.md`) is the supported execution path today.

## Goal

Zero-box execution: push → edge dispatch → scale-to-zero container runs
the job → sleeps. Users who never want to operate a runner get one
without leaving Cloudflare.

## Design

1. **Runner image**: `apps/runner` packaged as a container (node:22-slim
   + git + docker CLI optional). Entrypoint polls `GET /v1/jobs/next`
   with the deployment's labels and exits idle after N minutes.
2. **Durable Object seat**: a `RunnerSeat` DO per concurrent slot with a
   `containers` binding. `startAndWait` semantics: on dispatch, the
   Worker wakes a seat; the seat starts the container with
   `FLARE_ACTIONS_URL` + a single-use runner token (short-lived,
   job-scoped) and blocks until the container reports terminal status.
3. **Single-use tokens**: extend `api_tokens` with `expires_at` and
   `run_id`; the seat mints one per job, the container consumes it, the
   Worker revokes on terminal status. Leaked tokens die with the job.
4. **Config**: `wrangler.jsonc` gains a `containers` binding and a
   `durable_objects` binding; the image lives in Cloudflare's registry
   (`wrangler containers push`). Preview envs share the staging image.
5. **Scheduling**: labels route container-eligible jobs (`runs-on` without
   `macos`/`windows`/`gpu`) to seats; everything else stays on BYO
   runners. `max_instances` caps spend; overflow waits in `blocked` with
   the group mechanism generalized to a `seats` semaphore.

## Why not yet

Shipping it needs a registry image build + DO migration + spend caps, and
every piece deserves live verification under real load. The scheduler
hooks it needs (labels, blocked/promote, queue fan-out) are already in
place — this doc is the remaining work list, not a redesign.

## Acceptance bar

- Push-to-green on a repo with zero BYO runners.
- Cold seat starts in <30s; warm reuses.
- Spend capped by `max_instances`; over-cap jobs queue visibly.
- Single-use tokens expire even if the container is killed.
