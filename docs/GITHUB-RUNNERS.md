# GitHub runner mode (the flare lane)

Two lanes, one deployment. Full Flare orchestration replaces GitHub
Actions end to end; runner mode keeps GitHub orchestrating and has
Flare supply the machines. Existing workflows keep GitHub's checks,
logs, approvals, and branch protection — the bill moves.

## The one-line change

```yaml
# .github/workflows/ci.yml
jobs:
  test:
    runs-on: flare   # was: ubuntu-latest
```

Push, and GitHub routes the job to an ephemeral Flare runner. Extra
capabilities compose: `runs-on: [flare, gpu]` needs an executor that
declares `gpu` (`npm run runner -- --github --labels gpu`).

## Setup

1. Dashboard Settings → GitHub runners → check **runner mode on**.
   Off by default; the mode only touches jobs whose `runs-on`
   includes a managed label (default `flare`, up to 5).
2. If the App connected before this release, re-run **Connect
   GitHub**: runner mode needs `actions:read` (subscribe
   `workflow_job`) and `administration:write` (mint/delete ephemeral
   runners). GitHub shows the bump as a pending permission request on
   the old install; accepting it (or a fresh Connect) enables the
   lane.
3. Run an executor: `npm run runner -- --github` from the Flare
   checkout. First start downloads the official `actions/runner`
   release into `~/.flare/actions-runner/<version>/` (linux/macOS
   x64/arm64; pin with `FLARE_GH_RUNNER_VERSION`).
4. Push. `cli github-jobs` lists lane jobs; `cli usage` shows the
   runner-mode savings line.

## How it works

- The App subscribes to `workflow_job`. On `queued`, the worker
  records jobs aimed at a managed label in `gh_runner_jobs` and
  ignores everything else — GitHub-hosted and other self-hosted
  jobs are never touched.
- `POST /v1/github/jobs/next` (run scope, repo-allowlist aware)
  claims the oldest matching job and mints an **ephemeral JIT
  config** for it (1 hour TTL, single job). The JIT blob is
  single-use and never logged.
- The executor runs `run.sh --jitconfig <blob>` (one job per
  process), then repeats. `in_progress` / `completed` webhooks move
  the row to `running` / `completed` with the conclusion and
  duration; completions emit a `gha.job.completed` analytics event.
- Stale claims (no `running` within 15 minutes — the machine died
  before start) are swept by the per-minute cron: the orphaned JIT
  registration is deleted first, then the job requeues. The release
  is conditional, so a concurrent GitHub-side start always wins.

## Trust model

`administration:write` is a real ask (same class as ARC/`runs-on`):
it can register and delete self-hosted runners on repos where the
App is installed. Runner mode narrows it in practice:

- Off by default, and only jobs carrying a managed label are acted
  on. Everything else is ignored at ingest.
- One ephemeral runner per job, deleted when stale; registrations
  never linger past their TTL.
- Flare never sees job secrets: they stay in GitHub, interpolated
  by the official runner. The JIT blob grants exactly one job run.

## BYO toolchain note

Jobs execute under GitHub's official runner on your hardware, so
the toolchain is whatever the machine has (same as any self-hosted
runner). The lane adds no container, cache, or artifact layer of
its own: cache/artifacts come from GitHub, and Flare keeps the job
record for cost attribution, the dashboard card, and
`cli github-jobs`. Full logs stay on GitHub, but failed lane jobs get
a mirrored digest (error lines + tail, ≤4 KiB, fetched on completion):
it rides `GET /v1/github/jobs`, the dashboard card's first line, and
`cli github-jobs --logs <jobId>`.

## Org runner groups

Set an org group name in the lane settings (blank = the default
group) and JIT runners register into it — for orgs that route runners
by compliance boundary. The name resolves to a group id per org on
first claim (cached 1 hour; re-saving clears the cache). Unresolvable
names fail the claim loudly (`runner_group_unknown`, job stays queued)
rather than landing the runner in the wrong group, so check the group
exists and the repo can use it (selected-repositories access must
include the repo).

## Limits (deliberate)

- Managed-seat JIT runners: no (docker-in-docker is unsupported on
  Containers) — runner mode is BYO only.
- No Windows executors yet (the official runner ships a zip with a
  different bootstrap).
- No PAT fallback: the lane needs the App's admin grant. Repos that
  won't grant it stay on full Flare orchestration.
