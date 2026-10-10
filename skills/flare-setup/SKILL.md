---
name: flare-setup
description: >-
  Set up Flare Actions CI for a repo end to end. Use when asked to set up,
  install, onboard, or wire up Flare (or CI) for a project. Probes the
  deployment, wires the repo, starts an executor, and verifies HEAD with
  a run digest.
---

# Flare setup

## Start here

1. Discover: `npx flare-forge doctor` says what is set up and ends with one `next:` command.
2. Onboard: `npx flare-forge login`, then `npx flare-forge connect --dry-run`, then `npx flare-forge connect` (first green check).
3. Daily loop: `npx flare-forge run <owner/repo> HEAD` per change; expert tools (Forge, runner mode, budgets) come after the first green.

One-command adoption: `npx flare-forge connect` does the probing, wiring, and
verification. Drive it; don't hand-roll the steps below except to explain
what needs a human click.

## The loop

1. **Dry-run first**: `npx flare-forge connect --dry-run` (needs
   `FLARE_ACTIONS_URL`). It prints the plan and changes nothing.
2. **Human clicks** (you cannot do these — link them, don't stall on them):
   - Deploy, if there is no deployment yet: `npm run setup` is
     non-interactive once `npx wrangler login` has run (or
     `CLOUDFLARE_API_TOKEN` is set) and prints the Worker URL; the one-click Deploy to
     Cloudflare button needs a human's Cloudflare consent.
   - Dashboard admin claim (first login) and **Connect GitHub**
     (GitHub App Create flow) — both are browser clicks at
     `https://<worker>/dashboard`.
3. **Wire the repo**: `npx flare-forge connect` prints the recipe for the
   situation (App install URL, or the no-App webhook recipe). With
   `GITHUB_TOKEN` and `FLARE_ADMIN_TOKEN` present you may pass `--wire`
   to create the repo webhook — ask the human before any GitHub-side
   change. If the repo has no pipeline, `connect` names the detected
   stack and what `init` would scaffold; pass `--init` to scaffold it
   (stack-matched starter or converted workflows) in the same flow.
4. **Executor**: if `connect` reports nothing picked the run up, start
   one — `npm run runner` from the Flare checkout (BYO machine), or
   managed seats (`npm run setup` on a docker machine). Runner mode
   (`runs-on: flare`) needs `npm run runner -- --github` instead.
5. **Verify**: `connect` dispatches HEAD and reports the digest itself.
   On failure, hand off to the verify loop (failing step + tail), not a
   blind re-run.

## Rules

- Never invent a deployment URL — ask for `FLARE_ACTIONS_URL` or deploy.
- Never claim "CI passed" without a run digest (see flare-verify).
- Workflows run unchanged: don't rewrite `.github/workflows` to adopt;
  `npx flare-forge init` is opt-in scaffolding, not a requirement.
- Runner mode is a human decision (it asks the GitHub App for
  `administration:write`): propose it, link
  `docs/GITHUB-RUNNERS.md`, and let them enable it in Settings.

## Reporting back

Deployment URL, wiring state (App vs webhook), executor in use, and the
verification digest (run id, status, failing step + one tail line).
