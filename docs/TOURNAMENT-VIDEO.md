# Forge demo video script (Cloudflare git competition)

> Provenance: agent-drafted. Verified claims: harness green with KEEP=1 on the
> `try-tournaments` preview on Oct 9 2026 (`HARNESS_URL=... HARNESS_ADMIN_TOKEN=$(cat /tmp/tour-token.txt) KEEP=1 npm run harness`,
> winner alpha, 4 repos kept and browsable via `/v1/repos`); suite 101 files /
> 1256 tests green; preview redeployed same day. Timings below are targets —
> rehearse once and trim narration to fit.

Target length: **7–8 minutes** (rules require 5–10). The spine is the four
questions from the announcement post, in order. Judging weights: originality
50%, concurrency/coordination/review/conflicts 25%, UX 25% — so every answer
gets a live-screen moment, not slides.

Record against the live preview (hard-refresh first, ⌘⇧R):

- Races: https://try-tournaments-flare-actions.everyai-com.workers.dev/dashboard#/tournaments
- Repositories: https://try-tournaments-flare-actions.everyai-com.workers.dev/dashboard#/repos
- Fresh decided race after the KEEP=1 warm (Oct 9): open Races and pick the
  newest `harness race …` row; the video race from the rehearsal is
  `d7bc9be3-0dda-4035-ae9a-9f90d900075e`.

## Pre-flight (morning of recording)

1. One more green harness, keeping repos (also re-warms seats):
   `HARNESS_URL="https://try-tournaments-flare-actions.everyai-com.workers.dev" HARNESS_ADMIN_TOKEN="$(cat /tmp/tour-token.txt)" KEEP=1 npm run harness`
2. Open the newest decided race; confirm verdict + rationale rendered.
3. Open Repositories; confirm ≥4 repos with heads and trees.
4. Terminal ready with `export FLARE_ACTIONS_URL=<preview> RUNNER_TOKEN=$(cat /tmp/tour-token.txt)` for the CLI shots.
5. No secrets on screen: token stays in env, never pasted. No competitor
   bashing anywhere (rules disqualify personal attacks on products).

## Shots

1. **Hook (0:00–0:45)** — Races tab, newest decided race open.
   "What does GitHub look like when a thousand agents share one codebase?
   Four questions: how does an agent know what the others are doing, what
   happens on conflicting changes, how do humans review it all, and where is
   the *why* recorded? This is our answer — a forge on Workers and Artifacts,
   with real CI as the referee."
2. **Q1 — awareness (0:45–2:30)** — start a live race (`npm run harness` in
   the terminal, no KEEP this time so it cleans up after itself). Cut to the
   board: three lanes appear (alpha / beta / gamma), each an isolated
   Artifacts fork. "Every agent gets its own fork, its own lane, and a live
   board. The radar shows who is touching what *while* they work — not after
   the merge conflict."
3. **Q2 — conflicts (2:30–4:00)** — collision radar close-up: all three
   touched `greeting.txt`. Open Merge queue. "Conflicts are prevented, not
   merged-after-the-fact. The radar flags file collisions before anything
   lands; the merge queue verifies each entry against current main and lands
   them one at a time."
4. **Q3 — human review (4:00–5:30)** — verdict panel: ranking + rationale,
   then `cli verdict <id>` in the terminal showing the same. "Humans review
   the decision, not the diff soup. Deterministic ranking first — passing
   verification beats failing — then the model writes the rationale. Same
   verdict in the dashboard and the CLI."
5. **Q4 — the why (5:30–6:30)** — scroll the immutable ledger (opened →
   claimed → pushed → terminal → collision → verdict → promoted), then
   Repositories → source repo → History. "Every step is an append-only
   ledger entry. The *why* ships with the *what* — six months later you can
   still ask why main looks like this."
6. **Under the hood (6:30–7:15)** — Repositories tree + one verification run
   (Flare CI jobs, steps, triage). "The forge is thin: Artifacts forks,
   a Worker for coordination, and our Flare CI engine running every
   verification. Same pipeline language, same runners, same dashboard —
   races are just runs with a referee."
7. **Close (7:15–7:45)** — back to the race board. "Three agents, one task,
   one auditable winner. MIT-licensed, runs on your own Cloudflare account
   in ten minutes — link below."

## Submit checklist (due Oct 14, 11:59 PM PDT)

- [ ] Record the shots above (7–8 min) against the live preview.
- [ ] Submit at the competition page: video + repo link
  (`https://github.com/everyai-com/flare-actions`) + run instructions
  (README `npm install && npm run setup`, then
  [docs/TOURNAMENTS.md](docs/TOURNAMENTS.md) for the forge path).
- [ ] Confirm the submission renders (video plays, link resolves).
- [ ] Eligibility: entrants must be US/Canada residents 18+ and finalists
  must present live in San Francisco on Oct 21 — confirm before submitting.
- [ ] After the deadline: tear down the preview
  (`npx wrangler preview delete --name try-tournaments`)
  and `git branch -D try-tournaments` (the branch carries no unique commits).
