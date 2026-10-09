# `flare.yml` pipeline reference

Put `flare.yml` in your repo root. On every push, Flare fetches it at that
exact commit and fans out jobs. Missing or invalid files fall back to one
default echo job — pushes never fail to dispatch.

```yaml
jobs:
  test:
    if: always()                   # job-level condition; always() runs even after failed needs
    runs-on: linux                 # labels (string or list); omit = any runner
    needs: build                   # job name(s); waits for success, skips on failure
    tags: [fast]                   # selector labels for CI profiles (see below)
    strategy:
      matrix:
        node: [18, 20]             # cartesian fan-out; ${{ matrix.node }} in steps
    concurrency:
      group: main                  # serialize; cancel-in-progress: true cancels old
    container: node:20              # run every step inside this image (needs docker)
    services:
      db:
        image: postgres:16
        ports: ["5432:5432"]       # reachable on localhost
        env: { POSTGRES_PASSWORD: x }
    cache:
      key: node-modules            # R2 cache key (static string)
      paths: [node_modules]        # restored before, saved after success
    artifacts:
      name: build                  # single file uploads raw; else name.tar.gz
      paths: [dist]
    env: { TAG: v1 }               # extra step env; ${{ env.TAG }} in steps
    timeout-minutes: 30            # whole job (default 30, max 1440)
    retry: 2                       # requeue failed jobs up to 2 extra tries
    shards: 4                      # split into 4 cells (2-8) with FLARE_SHARD_*
    steps:
      - run: npm ci && npm test
      - run: ./slow-suite.sh         # per-step bound (1-180 minutes)
        timeout-minutes: 30
      - run: bash --version          # interpreter override (sh default)
        shell: bash
      - run: codecov                 # optional step; failure won't fail the job
        continue-on-error: true
      - run: ./scripts/cleanup.sh    # cleanup still runs after a failure
        if: always()
      - run: ./scripts/notify.sh     # only when something failed earlier
        if: failure()
    browser-checks:                # seats-only: Browser Rendering checks after steps
      - name: homepage
        url: https://example.com/
        expect-title: Example      # substring of <title> (or expect-text)
        screenshot: true           # PNG artifact, default true
    egress:                        # seats-only: outbound domain allowlist
      allow: [example.com]         # exact + subdomains pass; loopback always passes
    test-selection:                # opt-in: run only tests the diff can affect
      tests: ["tests/**/*.test.ts"] # which files count as tests (default: **/*.test.* + tests/**)
      full-on-profiles: [full]     # these profiles always run everything (default [full])
      full-on-branches: [main]     # these branches always run everything (default [])
      history-days: 7              # boost tests that failed in the last N days (1-30, default 7)
```

## Semantics

- **Steps** run as `sh -c` in the checkout dir, fail-fast, 10 min each
  (per-step `timeout-minutes: 1–180` overrides; `shell:` picks the
  interpreter, `sh` default), 32 KB captured output each. A step with
  `continue-on-error: true` is recorded as failed but does not stop the
  job or fail it (GitHub parity).
  Steps accept a bounded `if:` subset — `always()`, `success()`,
  `failure()`, `cancelled()`, and `!fn()` negations. After a failure,
  default (`success()`) steps are skipped while `failure()`/`always()`
  steps still run; anything outside the subset invalidates the file
  rather than guessing at expression soup.
  `FLARE_REPO`, `FLARE_SHA`, `FLARE_RUN_ID`,
  `FLARE_JOB_ID`, `FLARE_REF` (branch; empty for tags/source runs), and
  `FLARE_MATRIX_*` are always set. `FLARE_CHANGED_FILES` carries the
  run's changed files (newline-separated; empty = unknown) for
  changed-file test selection.
- **Shards** split a long job into parallel cells (`shards: 2-8`): each
  cell runs the same steps with `FLARE_SHARD_INDEX` (1-based) and
  `FLARE_SHARD_TOTAL` set, so a suite can shard itself:
  `npx vitest run --shard=$FLARE_SHARD_INDEX/$FLARE_SHARD_TOTAL`. Shards
  multiply with a matrix and obey the 32-job cap; the workflow is one
  job name rolled up as `name (shard=i/N)`.
- **Schedules** are configured per deployment (dashboard → Settings →
  Schedules), not in `flare.yml` — see the README's scheduled runs section.
- **`needs`** takes job names (pre-matrix). A job runs when all its needs
  succeed, skips when any need fails/errors/cancels/skips. Cycles and
  unknown names invalidate the file.
- **Job `if`** (same bounded subset as steps) is evaluated when the needs
  settle: default/`success()` requires all-success, `failure()` runs only
  after a failed need, `always()` runs either way — the notify/cleanup
  pattern. With no `needs`, `failure()` never runs.
- **`retry`** (0–5) requeues a failed job for another attempt instead of
  going terminal; attempts are stamped, so the budget is exact and a
  failing job can never loop forever. The run only reports failure once
  retries are exhausted (each attempt is logged on the job).
- **`runs-on`** labels match runners that carry *every* listed label.
  Label-less jobs match any runner. See `docs/RUNNERS.md` — including
  the `size-s/m/l/xl` right-sizing convention from peak-RSS hints.
- **`concurrency`** groups serialize across runs of the same repo (oldest
  first). With `cancel-in-progress: true`, a new run cancels
  queued/running/blocked same-group jobs from other runs.
- **Interpolation**: `${{ matrix.key }}` and `${{ env.KEY }}` expand in
  `run:` lines at dispatch; `${{ secrets.NAME }}` expands executor-side
  from the repo's secrets (missing names render empty). Anything else
  passes through untouched so shell syntax never breaks.
- **Secrets** (`${{ secrets.NAME }}` in steps, job `env`, and service
  `env`) are AES-GCM encrypted at rest, delivered only inside
  authenticated job claims, and masked (`***`) in every log and result.
  Manage them in the dashboard (Settings → Repository secrets). Set the
  `SECRETS_KEY` secret (base64, 32 bytes) for a real at-rest story —
  without it an auto-generated D1 key is used instead.
- **Cache** restores before steps (miss = clean build, never an error) and
  saves after successful runs only. Keys are static — no expressions.
- **Artifacts** upload after steps regardless of outcome (test reports on
  failure included). Caps: 1000 files, 400 MB total per job.
- **Services** start before steps and are removed after (`docker rm -f`
  always runs). Steps reach them on `localhost:<port>`.
- **`container`** runs each step as `docker run --rm -v <checkout>:/work
  -w /work`, forwarding only `FLARE_*`, job `env`, and matrix vars.
- **`browser-checks`** (managed seats only) run worker-side via Browser
  Rendering after successful steps: each check loads its `url`
  (https only), asserts `expect-title` and/or `expect-text`
  substrings (at least one required), and stores a PNG screenshot as
  a `browser-<name>.png` artifact (unless `screenshot: false`). Any
  miss fails the job. BYO runners and `cli local` fail closed on the
  key rather than silently skipping; seats without the `BROWSER`
  binding fail with a configuration pointer. Skipped when steps fail.
- **`egress.allow`** (managed seats only) is enforced by the
  LD_PRELOAD shim at `connect()` time: exact names and subdomains
  pass, loopback always passes (services), DNS always passes,
  everything else fails with `EACCES` (denials are logged as
  `[seat] egress blocked N connects (...)`). Unknown IPs fail closed,
  so direct-IP externals break by design; statically linked binaries
  bypass the shim (as with attribution), and connectionless UDP is
  unenforced. BYO runners and `cli local` fail closed on the key.
  Absent the key, seats observe without enforcing. A repo-level floor
  policy (`/v1/admin/egress-allowlist`, dashboard Settings) merges at
  fan-out: jobs that declare nothing inherit the repo list, narrower
  job lists pass, anything outside rejects the dispatch
  (`egress_policy_violation`); dry-run previews the effective list
  per job. (`cli local` cannot read the repo policy, so it runs
  unmerged — local is dev-only, never a security boundary.)
- **`test-selection`** (opt-in smart test selection) maps the run's
  changed files to affected tests: the executor walks the import
  graph (TypeScript/JavaScript; more languages later) from each
  changed file to the test files that import it, boosts tests with
  recent JUnit failures, sets `FLARE_SELECTED_TESTS`
  (newline-separated; empty means run everything) and
  `FLARE_TEST_SELECTION` (`off`/`full`/`select`), and records a
  per-run skip report (what was skipped and why) surfaced in the run
  digest, the PR comment, `GET /v1/runs/:id/selection`, and `cli
  selection`. The safety net always runs the full suite on scheduled
  (nightly) runs, on `full-on-profiles` (default `[full]`, the merge
  candidate), on `full-on-branches`, when the diff is unknown, and
  whenever a change cannot be mapped (other languages, deleted
  files, non-code files) or maps to zero tests. `true` selects with
  defaults; `false`/absent disables. Recipes consume the list, e.g.
  `vitest run $(echo "$FLARE_SELECTED_TESTS")` guarded on
  `FLARE_TEST_SELECTION = select`.

## CI profiles (smoke per push / full suite nightly)

An optional `profiles` block maps a profile name to a job selection.
Each `include`/`exclude` entry matches a job's base (pre-matrix) name or
one of its `tags`; absent `include` means every job, excludes apply after
includes, and `needs` edges into excluded jobs are dropped (excluded jobs
never run). A `defaults` mapping picks the profile per dispatch event
(`push`, `pull_request`, `schedule`, `dispatch`, `source`); without any
match every job runs, so pipelines without profiles behave exactly as
before.

```yaml
jobs:
  lint: {tags: [fast], steps: [{run: npm run lint}]}
  unit: {tags: [fast], steps: [{run: npm test}]}
  e2e: {steps: [{run: ./e2e.sh}]}
profiles:
  smoke: {include: [fast]}       # lint + unit
  full: {}                       # every job (empty selection = all)
  defaults: {push: smoke, pull_request: smoke, schedule: full}
```

Selection precedence is explicit override → schedule pin → event default:
`profile` on `POST /v1/runs/dispatch` (and dry-run), `cli run` /
`cli dispatch --profile`, the MCP `dispatch_run` / `run_and_wait`
`profile` param, and an optional `profile` on each cron schedule
(dashboard → Settings → Schedules is API-only for now: `POST
/v1/admin/schedules`). Unknown names fail the dispatch (`unknown_profile`,
never silent widening); webhooks with a broken selection run everything
so pushes never fail to dispatch. Dry-run plans report the selected
profile.

## Local ⇄ cloud parity

`cli local` runs the same execution engine as the cloud on the same
`JobSpec`, and all three executors (`cli local`, BYO runners, managed
seats) build the curated step environment from one shared path
(`buildFlareEnv` in `packages/runner-sdk/src/parity.ts`): `FLARE_REPO`
/ `FLARE_SHA` / `FLARE_RUN_ID` / `FLARE_JOB_ID` / `FLARE_REF` /
`FLARE_CHANGED_FILES`, `CI=true`, and the test-selection contract.
Locally the identity values are working-tree readings (`local`, the
git branch for `FLARE_REF`, the `git diff --name-only` for
`FLARE_CHANGED_FILES`); job `env` may still override any of them,
including `CI`. A host `CI=false` export no longer leaks into local
steps — the cloud never sees it either.

Two splits remain by design:

- **Images**: `container:` jobs pull the same ref through docker on
  both sides (seats hand such jobs to BYO). Without `container:`,
  steps run natively — on your kernel locally, on the seat's Linux or
  the runner host in the cloud. Pin exact tags or digests: `:latest`
  (or an untagged ref) can resolve to different bytes per pull.
- **Cache keys**: the key string is identical and validated by the
  same expression everywhere, but local entries live in a
  directory-scoped warm cache (`~/.flare/cache/<repo>`) while the
  cloud shares one global R2 keyspace — the first cloud run after
  local-only work misses.

`cli local --parity [--file] [job]` reports every divergence per job
without running anything: the predicted cloud lane (`seats` vs `byo`),
image and cache-key comparison, the full curated-env table (`=` same,
`~` expected placeholder, `!` divergence), and warn/info findings
(mutable tags, cross-kernel host execution, host env vars seats never
provide). `--json` emits the same report for gating (`ok` is false
when any warning fires; the command itself exits 0).

## Limits

32 jobs post-expansion, 100 steps/job, 8 matrix keys × 16 values, 8 labels,
32 env vars, 8 services, 16 cache paths, 32 artifact paths,
10 browser-checks/job (30 s each), 32 egress allow domains, 64 KB file.
16 profiles, 32 include/exclude entries/profile, 8 tags/job.

## Generating pipelines

Describe what you want and get YAML back (admin only):

```bash
curl -X POST $WORKER/v1/admin/generate \
  -H "Authorization: Bearer $FLARE_ADMIN_TOKEN" \
  -d '{"prompt":"node CI: install, lint, test on 18 and 20"}'
```
(`$FLARE_ADMIN_TOKEN` is an `admin` token issued in the dashboard Access tab.)

Agents can do the same through the MCP `generate_pipeline` tool.
Validate output with `cli import`-style roundtrips or just dispatch it:
`POST /v1/runs/dispatch` accepts an inline `pipeline` for exactly this.
