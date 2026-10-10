---
name: flare-migrate
description: >-
  Move a repo's CI from GitHub Actions to Flare Actions. Use when asked to
  replace, migrate off, speed up, or cut the cost of GitHub Actions, or to
  "run my workflows on Flare". Picks the right path (local, runner mode,
  full replace), checks workflow compatibility, and verifies a green run
  before anything on GitHub changes.
---

# Migrate from GitHub Actions to Flare

Flare runs existing `.github/workflows/*.yml` files **unchanged** when a
repo has no `flare.yml`. Migration is mostly choosing a path and proving
it green. Never delete or rewrite `.github/workflows` as part of this —
the human decides when GitHub-hosted runs stop.

## 1. Pick the path (ask only if the human hasn't said)

| Situation | Path | Needs |
| --- | --- | --- |
| Just try it, no account, no server | **Local**: `npx flare-forge local` | Node 22.6+, Docker only for `services:`/`container:` jobs |
| Keep GitHub as the UI (checks, logs, approvals) | **Runner mode**: change `runs-on:` to `flare` | A Flare deployment with runner mode on + one runner machine |
| Replace Actions fully (faster dispatch, D1 history, agent digests) | **Full**: deploy + `connect` | A Flare deployment (Cloudflare account) |

There is no public hosted Flare yet — every server path needs a Flare
deployment on someone's Cloudflare account. If `FLARE_ACTIONS_URL` is
unset, start with **Local** and tell the human the deploy step is theirs.

## 2. Check compatibility first (no server needed)

```bash
npx flare-forge import .github/workflows/ci.yml   # prints flare.yml + a warning report
npx flare-forge local --parity                     # local-vs-cloud differences, without running
```

Read every warning. Things that commonly need a human decision
(full list: docs/GITHUB-ACTIONS-COMPAT.md):

- `uses:` actions outside the supported set are dropped (checkout, cache,
  upload-artifact, setup-* are handled; `setup-*` checks the host
  version rather than installing).
- Reusable workflows (`uses: ./.github/workflows/x.yml`) and composite
  local actions are not expanded.
- `github.event.*` expressions are scrubbed to empty strings.

Report the warnings as a short list with the affected job names. Do not
"fix" a workflow to silence a warning without asking.

## 3. Run it

**Local:** `npx flare-forge local` from the repo root. Done when
every job is green; report the digest.

**Runner mode:**
1. Human: dashboard → Settings → enable runner mode (re-run Connect
   GitHub if the App predates `administration:write`).
2. Start a runner on a machine: `npm run runner -- --github` from a Flare
   checkout (or the one-line `runner.sh` the dashboard Home shows).
3. Propose a one-line diff per job: `runs-on: ubuntu-latest` →
   `runs-on: flare`. Open it as a PR; the PR's own checks
   prove it.

**Full:**
1. Human: deploy (Deploy to Cloudflare button, or
   `npx wrangler login && npm run setup` in a Flare checkout), open
   `/dashboard`, create the owner account, click **Connect GitHub**, and
   install the App on the repo.
2. Ask the human for a one-time code (dashboard Settings → Pair a
   runner), then `npx flare-forge login --url https://<worker>
   --code XXXX-XXXX`. It saves `FLARE_ACTIONS_URL` + `RUNNER_TOKEN` to
   `./.env` (0600) — confirm `.env` is gitignored first. Then
   `npx flare-forge connect --dry-run`, then
   `npx flare-forge connect`. It dispatches HEAD and reports
   the verdict (exit 0 green, 1 run failed, 2 usage).
3. Wire the agent loop: `claude mcp add --transport http flare
   https://<worker>/mcp` (OAuth in the browser; other clients:
   `npx flare-forge mcp-config`).

## 4. Done means

- A Flare run of the repo's HEAD is green (`run_and_wait` or `connect`
  verdict), or the failures are listed with the digest's failing step.
- The compatibility warnings are reported.
- Nothing on GitHub changed without the human's yes (webhooks, App
  installs, `runs-on:` edits, workflow deletions).

When it's green, hand off to the `flare-verify` skill for the day-to-day
loop.
