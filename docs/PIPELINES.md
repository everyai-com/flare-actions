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
    steps:
      - run: npm ci && npm test
```

## Semantics

- **Steps** run as `sh -c` in the checkout dir, fail-fast, 10 min each,
  32 KB captured output each. `FLARE_REPO`, `FLARE_SHA`, `FLARE_RUN_ID`,
  `FLARE_JOB_ID`, and `FLARE_MATRIX_*` are always set.
- **`needs`** takes job names (pre-matrix). A job runs when all its needs
  succeed, skips when any need fails/errors/cancels/skips. Cycles and
  unknown names invalidate the file.
- **`runs-on`** labels match runners that carry *every* listed label.
  Label-less jobs match any runner. See `docs/RUNNERS.md`.
- **`concurrency`** groups serialize across runs of the same repo (oldest
  first). With `cancel-in-progress: true`, a new run cancels
  queued/running/blocked same-group jobs from other runs.
- **Interpolation**: `${{ matrix.key }}` and `${{ env.KEY }}` expand in
  `run:` lines; unknown expressions (e.g. `${{ secrets.X }}`) pass through.
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
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"prompt":"node CI: install, lint, test on 18 and 20"}'
```

Agents can do the same through the MCP `generate_pipeline` tool.
Validate output with `cli import`-style roundtrips or just dispatch it:
`POST /v1/runs/dispatch` accepts an inline `pipeline` for exactly this.
