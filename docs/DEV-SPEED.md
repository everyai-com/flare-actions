# Dev + CI speed at agent scale

This repo is developed by several coding agents in parallel. That changes
what "fast" means: every agent runs lint, type checks, and tests after
every change, so the costs multiply, and simultaneous heavy runs on one
laptop thrash memory. The setup below is tuned for that loop — and this
doc records what was measured, what was adopted, and what was skipped,
against the "our dev setup and CI couldn't keep up" playbook
(oxlint/oxfmt, TypeScript 7 native, a single changed-only check script,
cross-worktree concurrency limits, CI setup/runtime cuts).

## Measured on this repo

Local (warm, M-series laptop):

| Step | Before | Now | Notes |
| --- | --- | --- | --- |
| Lint (full repo) | `eslint .` — 3.9s | `oxlint .` — ~0.05s | oxlint is the lint gate since Oct 9 (parity config; the eslint rule set was never type-aware, so nothing was lost) |
| Type check | `tsc --noEmit` — 3.5s, 475 MB peak RSS | `tsgo --noEmit` — 1.9s, 252 MB peak RSS | ~2x faster, half the memory (same ratio as the playbook's 9.5 GB → 16 GB story) |
| Tests (full suite) | 6.0s | ~5.1s warm | vitest `fsModuleCache` persists transforms between runs |
| Agent check loop | lint + full typecheck + full tests (~13s, unbounded concurrency) | `npm run check` — ~2-5s scoped | lint only changed files, `vitest --changed HEAD`, one type check |

CI (GitHub-hosted runner, `verify` job, 50s total):

| Step | Time |
| --- | --- |
| setup-node (npm cache) + checkout | 3s |
| `npm ci` | 6s |
| `npm run types` | 2s |
| `npm run typecheck` (tsc) | 2s |
| `npm run lint` (oxlint) | <1s |
| `npm test` (661 tests) | 5s |
| deploy dry-runs + OpenAPI checks | ~25s (seats dry-run is the long pole at 22s) |

The CI was already in good shape (under two minutes end to end), so the
changes here are mostly hygiene: `npm ci --prefer-offline --no-audit
--fund=false`, explicit `timeout-minutes`, and the preview deploy now
skips docs-only PRs instead of building them.

## The check script

```bash
npm run check            # fast loop: changed lint + typecheck + affected tests
npm run check -- --full  # whole suite, for pre-push
FLARE_CHECK_SLOTS=3 npm run check
FLARE_CHECK_TSC=tsc npm run check
```

`scripts/check.mjs`:

- **Changed-file lint** — `oxlint` over files reported by `git status`
  (tracked diffs + untracked). No changed lint targets, no lint run.
- **One type check** — `tsgo` when installed (2x faster, half the memory),
  `tsc` otherwise (`FLARE_CHECK_TSC=tsc` forces the canonical one).
- **Affected tests only** — `vitest run --changed HEAD` resolves the module
  graph of the change; `--passWithNoTests` keeps clean trees green.
- **Cross-worktree slots** — every worktree of this clone shares a lock
  directory under the git common dir (`.git/flare-check-slots`); at most
  `FLARE_CHECK_SLOTS` (default 3) checks run their heavy steps at once, so
  ten agents don't stack ten type checks. Stale locks (owner gone for 15+
  minutes) are stolen automatically. `--no-slots` / `FLARE_CHECK_NO_SLOTS=1`
  bypass for scripts.

## What is the CI gate

Local speed must not weaken CI. The `verify` job runs the canonical
`tsc --noEmit`, `oxlint .`, the full vitest suite, both Workers dry-runs,
and the OpenAPI checks. The Oct 9 lint flip was lossless: the old
`eslint.config.js` used the non-type-checked recommended set plus only
`no-unused-vars` / `no-explicit-any` / `eqeqeq`, all mirrored in
`.oxlintrc.json` (verified by probe: each rule fires, exit 1 on errors).
tsgo stays a **local** speed tool; `npm run lint:full` (eslint) remains
for the occasional slow pass.

## Deliberately not adopted

- **oxfmt / prettier-style auto-formatting** — this repo has no formatter
  today; adopting one would churn every file. Revisit if style drift
  becomes real.
- **A pnpm-binary install trick** — the playbook's 50x CI setup win was
  pnpm/action-setup hanging through npm. This repo is npm workspaces with
  `setup-node` npm caching; `npm ci` measures 6s.
- **Bigger CI runners** — the playbook's 9.5 GB type check needed a 16 GB
  runner. This repo's tsc peaks at ~475 MB, so the standard runner is
  fine.
- **Formatter-on-edit hooks** — environment-side (editor/agent config),
  not repo config. `npm run check` is the portable version: run it after
  every change.

## For agents

Run `npm run check` after every change instead of full-repo commands.
It is scoped (fast), serialized (won't thrash with sibling agents), and
loud about which step failed. Before pushing, `npm run check -- --full`
plus `npm run deploy:dry` matches what CI will do.
