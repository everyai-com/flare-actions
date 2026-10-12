# Bring your GitHub repo to Flare Forge

> Provenance: agent-drafted 2026-10-12.
> - Behavior claims come from `apps/worker/src/forge-github.test.ts`
>   (real bare git repos served over an in-process `git http-backend`:
>   one plays GitHub, one the Artifacts trunk; isomorphic-git + MemoryFS
>   sync them exactly as the Worker does) and
>   `apps/worker/src/trunk-ci.test.ts`. Both pass under `npm test`
>   (2026-10-12).
> - Not yet measured against live github.com + Artifacts: import time
>   for large repos, and push-back latency. Treat timings as unknown.

Forge works on the repo you already have. You don't have to move your
team, your issues, your reviewers or your CI. Import the repo once, let
agents work on it through Forge, and the landed result comes back to
GitHub as an ordinary pull request.

```
                    import (once, server-side)
  GitHub repo  ───────────────────────────────►  Forge trunk (Artifacts)
  (humans,                                        agents fork i-<id>,
   reviews,     ◄───── landed work: 1 rolling PR   trains land on main
   Actions)            (or a branch / fast-forward) only after CI is green
               ───────► human commits + merged PRs
                        fast-forward back in
```

## Start in one minute

Dashboard: **Agent forge → Import from GitHub**. Paste `owner/name` or
any `github.com` URL, pick how landed work goes back, press **Import**.

CLI (admin token):

```bash
npm run cli -- forge import https://github.com/acme/widgets
# ready: github.com/acme/widgets -> trunk gh-acme-widgets
#   sync: pr (flare/trunk); pull upstream: on
```

MCP (any agent, admin token): `import_github_repo { github: "acme/widgets" }`.

REST: `POST /v1/forge/github/links {"github":"acme/widgets"}`.

Then hand the trunk to agents as usual (`docs/FORGE-AGENTS.md`):
`plan_goal { repo: "gh-acme-widgets", text: "…", plan: true }`.

## What happens

1. **Import.** The Worker calls the Artifacts `import` binding. The
   history never passes through the Worker, so repo size isn't limited
   by Worker memory. A private repo is fetched with a short-lived GitHub
   App installation token. The token is used only in memory and is never
   stored or logged. The trunk is named `gh-<owner>-<name>` by default,
   which never collides with the CI mirror (`<owner>-<name>`).
2. **`main` alias.** Forge trunks land on `main`. If GitHub's default
   branch has another name (for example `master`), the first sync
   creates `main` at the same commit and tracks your branch from then
   on.
3. **CI comes with the repo.** Trains verify every combined SHA with
   `flare.yml` when the repo has one. Otherwise they use the repo's own
   `.github/workflows`: the files are read straight out of the trunk and
   translated by the same Actions-compatibility layer the GitHub webhook
   uses (`docs/GITHUB-ACTIONS-COMPAT.md`). Workflows that run on `push`
   to the default branch, or on `pull_request` into it, become the
   landing gate. Release-only or schedule-only workflows don't. A repo
   with neither file can't land anything, because CI is the gate.
4. **Work lands on the trunk** through trains, exactly as in
   `docs/FORGE.md`. Agents never hold a trunk token.
5. **Landed work goes back to GitHub** after every train that lands
   something, according to the link's sync mode:

   | `syncMode` | What GitHub sees | Force push? |
   |---|---|---|
   | `pr` (default) | `flare/trunk` updated, plus **one rolling PR** into the default branch listing the landed intents | only on `flare/trunk`, which Forge owns |
   | `branch` | `flare/trunk` updated, no PR | only on `flare/trunk` |
   | `direct` | the default branch fast-forwards to the trunk head | **never**: if GitHub moved, the sync reports `diverged` and waits |
   | `off` | nothing; the work stays in Forge | — |

6. **GitHub work comes back in.** A push to the tracked branch (the
   GitHub App webhook) fast-forwards the trunk when the trunk is an
   ancestor of it. This covers human commits, and it covers a merged
   sync PR: the merge commit contains the trunk, so the loop closes on
   its own. If the two histories diverged, nothing is rewritten. The
   link reports `diverged`, and merging the sync PR on GitHub resolves
   it. Trains that were in flight see `main` move and rebuild; their
   compare-and-swap already handles that.

## Rules that keep it safe

- **Only two writers of trunk `main`: trains and this bridge.** Both
  only fast-forward. Both use write tokens minted for the one push and
  never returned. Agents still get fork-scoped tokens only (§3.2
  invariant 1 in `docs/COMPETITION-PLAN.md`).
- **The bridge never force-pushes a branch a human owns.** In `branch`
  and `pr` modes the only forced ref is the sync branch (default
  `flare/trunk`). In `direct` mode nothing is forced.
- **Unlinking is non-destructive.** `DELETE /v1/forge/github/links/<repo>`
  (or `cli forge unlink`) drops the link. The trunk and the GitHub repo
  stay exactly as they are.
- **Errors never leak credentials.** Sync errors are stored on the link
  with URLs and tokens redacted.
- **Permissions.** Importing, changing sync settings and unlinking need
  an admin token. A manual sync needs run scope. Repo-scoped tokens see
  only their own trunks.

## GitHub App permissions

| Need | Permission | Without it |
|---|---|---|
| Import a private repo | `contents:read` | public repos still import |
| Push landed work back | `contents:write` | the import warns; push-sync reports how to fix it |
| Open/update the sync PR | `pull_requests:write` | the branch still updates; the PR step reports it |
| Pull GitHub commits automatically | `push` webhook events | `cli forge sync <repo> --pull` does it on demand |
| Push landed commits that edit `.github/workflows/*` | `workflows:write` | GitHub rejects that push; the link records the error, and other syncs keep working once it is granted or the change is dropped |

The Connect flow in the dashboard already asks for everything above
except `workflows:write`: `contents`, `pull_requests` and `push` events
are the same permissions self-healing uses. Existing installs pick them
up by re-running Connect. Grant `workflows:write` in the App settings
only if agents are meant to change CI files.

## Day-two operations

```bash
npm run cli -- forge links                       # every link: mode, last push/pull, PR, errors
npm run cli -- forge sync gh-acme-widgets        # pull then push, now
npm run cli -- forge sync gh-acme-widgets --pull # GitHub -> trunk only
npm run cli -- forge link-set gh-acme-widgets --sync direct --pull off
npm run cli -- forge unlink gh-acme-widgets
```

| Endpoint | Scope | Purpose |
|---|---|---|
| `GET /v1/forge/github/links` | read | list links (repo-scoped) |
| `POST /v1/forge/github/links` | admin | import + link (idempotent for the same GitHub repo) |
| `GET /v1/forge/github/links/:repo` | read | one link |
| `PATCH /v1/forge/github/links/:repo` | admin | `syncMode`, `syncBranch`, `pullUpstream` |
| `POST /v1/forge/github/links/:repo/sync` | run | `direction: pull \| push \| both` |
| `DELETE /v1/forge/github/links/:repo` | admin | unlink (non-destructive) |

MCP: `import_github_repo`, `github_links`, `sync_github`.

Imports that are still settling (`status: importing`) are finished by
the per-minute cron. Sync outcomes are recorded on the link (`detail`,
`lastPushedSha`, `lastPulledSha`, `prUrl`) and in the audit log
(`forge.github.*`).

## Migration paths, side by side

| You want… | Use | Change on GitHub |
|---|---|---|
| Faster CI, same workflows | Flare Actions (`README.md`): your `.github/workflows` run unchanged | none (or `runs-on: flare`) |
| Many agents on one repo without stepping on each other | **This bridge** + Forge | one rolling PR from `flare/trunk` |
| Everything in Forge, GitHub as a mirror | `syncMode: direct` | the default branch fast-forwards |
| Try Forge with no write access to GitHub | any public repo + `syncMode: off` | none |

## Implementation map

| Piece | File |
|---|---|
| Import, pull, push, PR, link table (runtime-free) | `apps/worker/src/forge-github.ts` |
| Worker wiring (isomorphic-git, App auth, hooks) | `apps/worker/src/forge-github-env.ts` |
| Trunk CI: `flare.yml`, else `.github/workflows` | `apps/worker/src/trunk-ci.ts` |
| REST/MCP operations | `apps/worker/src/forge-service.ts` (`importGithubOp`, `syncGithubOp`, …) |
| Train hook (sync after landing) | `apps/worker/src/train-workflow.ts` |
| Webhook hook (pull on push) | `apps/worker/src/index.ts` |
| Schema | `apps/worker/migrations/0047_forge_github_links.sql` + `schema.ts` |
| CLI | `apps/cli/src/forge.ts` (`import`, `links`, `sync`, `link-set`, `unlink`) |
| Dashboard | Forge toolbar → Import from GitHub |
