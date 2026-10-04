# `flare.yml` pipeline reference

Put `flare.yml` in your repo root. On every push, Flare fetches it at that
exact commit and fans out jobs. Missing or invalid files fall back to one
default echo job — pushes never fail to dispatch.

```yaml
jobs:
  test:
    runs-on: linux                 # labels (string or list); omit = any runner
    needs: build                   # job name(s); waits for success, skips on failure
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
    steps:
      - run: npm ci && npm test
      - run: codecov                 # optional step; failure won't fail the job
        continue-on-error: true
```

## Semantics

- **Steps** run as `sh -c` in the checkout dir, fail-fast, 10 min each,
  32 KB captured output each. A step with `continue-on-error: true` is
  recorded as failed but does not stop the job or fail it (GitHub parity).
  `FLARE_REPO`, `FLARE_SHA`, `FLARE_RUN_ID`,
  `FLARE_JOB_ID`, and `FLARE_MATRIX_*` are always set.
- **Schedules** are configured per deployment (dashboard → Settings →
  Schedules), not in `flare.yml` — see the README's scheduled runs section.
- **`needs`** takes job names (pre-matrix). A job runs when all its needs
  succeed, skips when any need fails/errors/cancels/skips. Cycles and
  unknown names invalidate the file.
- **`retry`** (0–5) requeues a failed job for another attempt instead of
  going terminal; attempts are stamped, so the budget is exact and a
  failing job can never loop forever. The run only reports failure once
  retries are exhausted (each attempt is logged on the job).
- **`runs-on`** labels match runners that carry *every* listed label.
  Label-less jobs match any runner. See `docs/RUNNERS.md`.
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

## Limits

32 jobs post-expansion, 100 steps/job, 8 matrix keys × 16 values, 8 labels,
32 env vars, 8 services, 16 cache paths, 32 artifact paths, 64 KB file.

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
