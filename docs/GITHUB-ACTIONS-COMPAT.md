# GitHub Actions compatibility

Flare runs existing `.github/workflows/*.yml` files directly. There is no
conversion step: if a repo has no `flare.yml` at the commit, the matching
workflow files are fetched, translated, merged into one run, and executed.

Conversion is deliberately bounded — the same policy as `cli import`:
everything that maps cleanly runs as-is, everything that cannot be
faithfully represented is **dropped with a warning** rather than guessed
at. Warnings land in the worker log (`wrangler tail`) for server runs and
on stderr for `cli local` / `cli import`.

Want a warning report before pushing? Run the importer locally:

```bash
npm run cli -- import .github/workflows/ci.yml   # warnings on stderr
```

Every run records which pipeline produced it (`flare.yml`, `Actions`,
`default`, `inline`, or `source`) — the dashboard tags each run row with
it, and the run detail explains it. The dashboard's Settings tab also has
a "Coming from GitHub Actions?" card with the no-App webhook recipe.

For maximum fidelity, migrate to the native format (`cli import > flare.yml`);
`flare.yml` always wins when present.

## Triggers

A workflow runs only for the event that dispatched the run:

| Workflow `on:` | Runs when |
| --- | --- |
| `push` | a push webhook (branch runs; `branches` / `branches-ignore` filters apply, `!pattern` negations supported; `*` stays within a path segment, `**` crosses) |
| `push.tags` | a tag push, matched against the tag name (best effort — no branch filters allowed in the same block) |
| `paths` / `paths-ignore` | matched against the run's changed files (push compare / PR file list, exposed to steps as `FLARE_CHANGED_FILES`). Unknown changed files (fetch failure) run conservatively |
| `pull_request` | a PR webhook; `branches` filters match the **base** branch |
| `workflow_dispatch` | manual dispatch via `POST /v1/runs/dispatch`, the CLI (`cli run`), or MCP `dispatch_run` |
| `schedule` | a dashboard schedule firing; the workflow's `on.schedule[].cron` must equal the schedule's cron (whitespace-normalized, strict match) |

Any other event (`release`, `issues`, `workflow_run`, …) never matches —
the file is skipped for the run instead of being guessed into it.
`pull_request` `types:` filters are not applied (every PR webhook runs the
workflow).

## What runs as-is

| Workflow feature | Behavior |
| --- | --- |
| `run:` steps under sh | kept (the runner's shell), `shell: bash` kept, other shells warned + dropped |
| top-level, job, and step `env` | kept |
| step `if` and job `if` | bounded subset: `always()` / `success()` / `failure()` / `cancelled()` and `!fn()` negations; job guards comparing `github.event_name` / `.ref` / `.ref_name` / `.repository` are **evaluated** (a false guard skips the job, so deploy jobs keep their event gates); anything else warned + dropped |
| `strategy.matrix` | kept, expanded to jobs (`test (node=20)`), including `include` / `exclude` with GitHub's algorithm (exclude first; include extends matching cells or adds new ones). `fromJSON(...)` matrices are dropped with a warning |
| `runs-on: ${{ matrix.os }}` | resolved per cell (`ubuntu-*` → `linux`, `macos-*` → `macos`, `windows-*` → `windows`) |
| `$GITHUB_OUTPUT` / `$GITHUB_ENV` / `$GITHUB_PATH` / `$GITHUB_STEP_SUMMARY` | supported, both `NAME=value` and `NAME<<EOF` heredoc forms. Env and PATH additions reach later steps of the same job; summaries are appended to the job log. `NODE_OPTIONS`, `PATH`, `LD_*`, `DYLD_*`, and `FLARE_*` / `GITHUB_*` / `RUNNER_*` names are ignored in `$GITHUB_ENV` |
| `needs` | kept (within one workflow file, like Actions) |
| `concurrency` | kept, including `cancel-in-progress` |
| `container:` / `services:` | kept (BYO runners with docker; managed seats route these to runners) |
| `actions/checkout` | dropped — Flare checks out natively |
| `actions/setup-node` / `setup-python` / `setup-go` / `setup-java` / `setup-ruby` | become a version-probe step (`node --version`, …); install the toolchain on your runner (warned) |
| `actions/cache` | becomes the job's native cache (`with.path` + `with.key`; expression keys staticized) |
| `actions/upload-artifact` | becomes the job's native artifact upload (`with.path`, `with.name`) |
| `timeout-minutes`, `continue-on-error` | kept (step and job) |
| `defaults.run.working-directory` | wrapped into `cd` subshells (warned) |

Everything else — any other `uses:`, `permissions`, job `outputs`,
`strategy.fail-fast` / `max-parallel`, container options/volumes,
`defaults.run.shell` — is dropped with a warning. Reusable workflows and
composite actions are not supported.

## Expressions

GitHub's expression engine is not implemented. A bounded mapping keeps
the common cases working in shell:

| Expression | Becomes |
| --- | --- |
| `${{ github.sha }}` | `${FLARE_SHA}` |
| `${{ github.repository }}` | `${FLARE_REPO}` |
| `${{ github.run_id }}` | `${FLARE_RUN_ID}` |
| `${{ github.job }}` | `${FLARE_JOB_ID}` |
| `${{ github.ref_name }}` | `${FLARE_REF}` (the branch) |
| `${{ github.head_ref }}` | `${FLARE_REF}` (PR runs carry the head branch) |
| `${{ github.ref }}` | `refs/heads/${FLARE_REF}` |
| `${{ github.workflow }}` | `${FLARE_WORKFLOW}` |
| `${{ secrets.NAME }}` | left for executor-side secret interpolation (masked in logs) |
| `${{ matrix.* }}` / `${{ env.* }}` | substituted at parse time |
| `${{ steps.<id>.outputs.<key> }}` | `${FLARE_STEPS_<ID>_<KEY>}` — the value arrives as step env, never pasted into the script |
| `${{ needs.<job>.outputs.<key> }}` / `${{ needs.<job>.result }}` | `${FLARE_NEEDS_<JOB>_<KEY>}` / `${FLARE_NEEDS_<JOB>_RESULT}` |
| anything else (`runner.*`, `github.event.*`, `github.actor`, `inputs.*`, …) | **scrubbed to empty** with a warning |

`FLARE_REF` is empty for tag and source runs.

**Job guards.** Job-level `if:` keeps the bounded subset (status
functions plus `needs.*` comparisons with `&&` / `||` / `!` / parens —
no `steps.*`, unknowable before steps run) and still evaluates
`github.event_name`, `github.ref`, `github.ref_name`, and
`github.repository` comparisons at translation time, since the run's
event, branch, and repo are already known. A guard that evaluates false
**skips the job entirely**, exactly like Actions would, so
`if: github.event_name == 'pull_request'` cannot leak a preview deploy
into a push run — and a root `if: failure()` now skips at fan-out
instead of queueing. Undecidable guards (anything else) keep the job
and warn. Step-level conditions outside the subset still run with a
warning — keep an eye on the log for those.

## Merging and limits

- All workflow files matching the run's event fan out into **one run**.
- With more than one matching file, job names and `needs` references get a
  `<workflow name>: ` prefix so same-named jobs (`build`, `test`) cannot
  collide. Single-workflow runs keep bare names.
- Limits: first 10 workflow files (alphabetical), 64 KiB per file,
  32 jobs after matrix expansion (the platform-wide cap).
- A file that fails to parse or translates to zero runnable jobs is
  skipped with a warning; other files still run.

## GitHub App vs. no App

| Capability | App connected | No App (plain repo webhook + token) |
| --- | --- | --- |
| Automatic push / PR runs | yes | public repos: point a repo webhook at `https://<worker>/webhooks/github` with the secret from Settings → Webhooks |
| Actions-workflow drop-in | yes | yes (public repos) |
| Private repos | yes | no |
| Commit statuses, Check Runs, PR comments | yes | no |
| Manual / agent dispatch (CLI, API, MCP) | yes | yes, with an API token |
| Scheduled runs | yes | yes (public repos) |

## Local runs

`cli local` with no `flare.yml` in the working tree falls back to the
local `.github/workflows/*.yml` files and runs all of them (no event to
match locally), with the same translation and warnings. `cli run --source`
still takes `flare.yml` or an inline pipeline.

## Known differences

- No expression engine, no reusable/composite workflows, no JS or
  container actions. Step and job outputs transfer through static refs
  (`steps.<id>.outputs.<key>`, `needs.<job>.outputs.<key>`); computed
  expressions (`format()`, `toJSON()`, `contains()`, …) do not.
- `setup-*` actions probe the host toolchain instead of installing it,
  so a `node-version: ${{ matrix.node }}` matrix runs the runner's one
  Node in every cell. Install the versions on the runner (or use a
  `container:` image per cell).
- `${{ github.ref }}` is `refs/heads/<branch>`; tag runs see an empty
  branch. `github.event.*`, `github.actor`, and `runner.os` are not
  mapped — scrubbed with a warning.
- Caches use Flare's cache semantics (exact-key restore, then
  `restore-keys` prefixes newest-first; saves always land under the
  exact key, even on an exact hit).
- `runs-on` labels map `ubuntu-*` / `macos-*` / `windows-*` onto portable
  runner labels; anything else matches BYO runner labels verbatim.
- Artifacts land in Flare's artifact store (downloadable via the
  dashboard, CLI, and Run Artifacts mirror), not GitHub's.
