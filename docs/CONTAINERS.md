# Managed executor: seats on Cloudflare Containers

Push → edge dispatch → a scale-to-zero container runs your job → it goes
away. No box to operate. BYO runners stay the backstop for everything
seats can't do (macOS, Windows, GPUs, docker-in-docker, private repos
without App credentials).

## How it works

```
dispatch → D1 job row (queued) ─┬─→ flare-actions-runs ─→ BYO runners poll
                                 └─→ flare-actions-seats ─→ seats worker
                                                            └─ one ContainerSeat DO + container per job
```

- The main worker drops eligible queued jobs onto the seats queue
  (best-effort; queue missing or seats undeployed degrades silently).
- The seats worker's queue consumer routes each message to the
  `ContainerSeat` Durable Object named for the job. Seats execute
  **inline**: `/run` awaits the whole job and answers with the outcome,
  and the consumer acks after completion (natural retry). Inline
  execution is load-bearing — the open request keeps the seat alive
  across long steps, where a detached `waitUntil` could hibernate
  mid-job and strand the claim.
- The seat **claims** the job with an atomic conditional update — exactly
  one executor (seat or runner) wins — boots its container with internet,
  then drives the whole job through `exec`: checkout, cache restore,
  steps, cache save, artifacts. Steps run with cwd `/work` (the
  checkout); checkout targets `FETCH_HEAD` so shas, branches, and `HEAD`
  all resolve. D1/R2 writes go direct; no tokens, no polling, no
  affinity problem.
- Anything a seat can't do **releases** the job to `queued` (container
  won't start, checkout fails, unknown repo) so a BYO runner can take
  it. The release reason is written into the job log, so every release
  is self-diagnosing via the API.

## Eligibility

A job runs on a seat when its definition has no `container:`, no
`services:`, and labels ⊆ `{linux}` (label-less included). Matrix jobs,
`needs`, groups, cache, and artifacts all work — they're executor
agnostic. Runners advertise `[os, arch, ...]`; seats are x86_64 Linux
with node, git, python3, sh, and tar.

## Limits and caps

- `max_instances: 10` concurrent seats (spend cap in
  `apps/seats/wrangler.jsonc`). A seat that never boots releases with
  an automatic delayed re-wake (60 s, only while the run is under
  30 min old), so saturation never strands a job with no BYO runners
  around; wakes also fire on every fan-out, promotion, and re-run.
- Seat blob cap 50 MB per cache/artifact transfer (DO memory is 128 MB;
  larger blobs skip with a log line — BYO runners have the 512 MB cap).
- Step output: only a bounded 32 KB tail crosses from container to D1.
- Step timeout 10 min (process killed), job `timeout-minutes` honored
  between steps (default 30). Every container wait is bounded — boot
  (120 s × 3, throw-tolerant polling), checkout (3 min), even the
  `exec` call itself — so a wedged container surfaces as a release,
  never a stuck `running` row.

## Provisioning

`npm run setup` does it when docker is available: builds the image for
`linux/amd64` (content-tagged, rebuilt only when the Dockerfile changes),
pushes to your account's registry, patches the image tag into
`apps/seats/wrangler.jsonc`, sets `SEATS_TOKEN`, deploys the seats
worker. Without docker it skips with a pointer here; re-run setup (or
the manual steps below) once docker exists.

Manual fallback:

```bash
docker build --platform linux/amd64 -t flare-actions-seat:<tag> apps/seats
npx wrangler containers push flare-actions-seat:<tag>   # note the full registry path
# set apps/seats/wrangler.jsonc containers[0].image to it
npx wrangler secret put SEATS_TOKEN --config apps/seats/wrangler.jsonc
npx wrangler deploy --config apps/seats/wrangler.jsonc
```

Notes:

- Tags must be immutable (`:latest` is rejected); bump the tag when the
  Dockerfile changes.
- The image tag embeds your account id — forks get their own on setup.
- The seats queue (`flare-actions-seats`) is created by setup alongside
  the other queues; previews never wake seats (`ENVIRONMENT` guard), so
  no staging seats queue is needed.
- `SEATS_TOKEN` gates the seats public URL for direct debugging only;
  main↔seats traffic travels the private queue, never HTTPS (worker to
  `*.workers.dev` subrequests are edge-rejected, error 1042).

## Observability

- Result JSON carries `executor: "seat"`; log lines are `[seat]`-prefixed.
- Progress mirrors to the job row live: claim, boot, checkout, each
  step start, and any release reason. The job log is the source of
  truth — a failure never leaves a blank log.
- Every wake lands in the audit log as `seat-wake wake.enqueued|<jobId>`
  (or `wake.failed`).
- `wrangler tail flare-actions-seats` shows worker fetch logs; seat
  internals live in the job log instead (DO logs don't stream there).

## Private repos

Seats check out with a GitHub App installation token when the run has an
`installation_id` and the seats worker has `GITHUB_APP_ID` /
`GITHUB_PRIVATE_KEY` secrets (same values as the main worker; set
manually — setup never sees them). Without either, private checkouts
fail and the job releases to BYO runners with `GITHUB_TOKEN`.
