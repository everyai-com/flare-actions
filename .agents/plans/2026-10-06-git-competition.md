# Git competition entry plan — Flare as the verification layer for agent-built code

Date: 2026-10-06. Deadline: Oct 14, 2026 (8 days).

## Goal

Enter Cloudflare's "next Git platform" competition with Flare positioned as
the CI/verification layer for the agentic era: concurrent agents push to
Artifacts repos and forks, and every push automatically dispatches a Flare
run — execute on seats, then digest + triage back into agent context —
without GitHub in the loop.

## Success Criteria

- A push to an Artifacts repo auto-dispatches a Flare run (new `artifacts`
  event) with no GitHub involvement.
- Seats execute the run checking out from Artifacts (existing mirror-first
  path, staging-proven).
- Every Artifacts run yields an agent-consumable verdict: digest + triage.
- Concurrent pushes from at least 2 agents each get independent, correct
  runs (the competition's stated minimum).
- Submission package delivered by Oct 14: 5–10 min video, MIT source link
  (repo is already MIT), run/try instructions.

## Approach

Reuse the existing agent surface; build only the Artifacts trigger seam.
Dispatch rides the proven `dispatchRun` path (cf. the `schedule` call at
`apps/worker/src/index.ts:2500`); delivery rides a new queue consumed by the
existing `queue()` handler (`index.ts:2454`, currently ack-only — it must
branch on message shape); execution rides the seats mirror-first checkout
(`renderMirrorRemote` + `ARTIFACTS_MIRROR_REMOTE/TOKEN` in
`apps/seats/src/seat.ts`, `seat-do.ts`); verdicts ride digest + triage.
`artifacts` runs skip GitHub-only surfaces (commit statuses, checks, PR
comment), exactly like `source` runs already do. Demo checkout stays on the
env-level mirror token; worker-minted per-job tokens are a stretch goal.

Alternatives rejected: a full Git-forge clone (the judges explicitly want
the layer *above* repos/branches/PRs, not GitHub with agents on top);
a GitHub-webhook-only demo (uses no Artifacts primitives, misses the
brief); Workflows-based orchestration (rejected by our own spike:
external executors can't run Workflow steps — `docs/SPIKES.md`).

## Steps

1. **Platform prereq (wrangler + binding).** Bump `wrangler` to ≥4.145.0
   (installed 4.142.0; binding types need 4.145+), add the `ARTIFACTS`
   binding (`namespace` configurable) to `wrangler.jsonc`, run
   `npm run types`. No other dependency.
2. **Trigger module (`apps/worker/src/artifacts.ts` + test).** Validate the
   `cf.artifacts.repo.pushed` envelope (source namespace/repo, payload
   ref/after), read `flare.yml` via binding `readFile`, dispatch via
   `dispatchRun` with event `artifacts`; pushes without a pipeline file
   ack cleanly with no run. Depends on 1.
3. **Queue + event subscription.** New `flare-actions-artifacts` queue
   (+ staging twin, DLQ), `queue()` branches Artifacts messages to the
   trigger module, `scripts/setup.mjs` gains a provisioning step for the
   queue and the `artifacts.repo`-source event subscription. Depends on 1;
   built alongside 2.
4. **Execution on staging.** Point the staging seats worker's existing
   mirror config at an Artifacts namespace, push → run → terminal E2E;
   document the manual provisioning (namespace, remote template, token
   rotation). Stretch: worker-minted `createToken("read")` per job passed
   through claims. Depends on 2+3.
5. **Multi-agent demo harness.** Script that imports/creates a repo, forks
   one repo per agent task, drives ≥2 concurrent pushes over git-HTTPS
   with binding-minted tokens, watches runs to terminal, prints digests.
   Full staging E2E incl. a failing push (triage visible). Depends on 4.
6. **Submission.** Run/try instructions doc (+ README pointer), record the
   5–10 min video with multi-agent concurrency front and center, submit at
   cloudflare.com/git-competition. Depends on 5. Docs-only; no code.

## Validation Plan

- Steps 1–3: `npm run types`, `npm run typecheck`, `npm test`,
  `npm run deploy:dry`. No new HTTP routes are planned (queue-only), so
  the OpenAPI gates stay untouched; if a route appears, run
  `node scripts/check-openapi.mjs` + `npm run lint:openapi`.
- Step 4 (highest-risk check): staging push → dispatched `artifacts` run →
  seats checkout from Artifacts (`[seat] checkout ok (mirror)` in log) →
  terminal digest; plus the negative (push with no `flare.yml` → ack, no
  run, no 500).
- Step 5: harness with 3 concurrent agents → 3 independent runs, all
  terminal, digests correct; one forced failure shows triage.
- Step 6: instructions followed cold on a fresh checkout; video checklist
  (concurrency visible, verdict loop visible, ≤10 min).

## Risks / Open Questions

- 8-day deadline: stretch items (per-job tokens, Artifacts-native heal
  push) cut first; heal stays GitHub-only for the entry.
- Event-subscription provisioning mechanics (exact API/wrangler calls) are
  not yet verified — first execution research item, before step 3.
- Queues are not preview-isolated — validate on the staging worker, never
  a branch preview.
- Artifacts is Paid-only; access is already proven (staging
  mirror-canary jobs). Billing starts Oct 15, after the deadline.
- Open questions: none blocking.

## Sources

- https://blog.cloudflare.com/next-git-platform-on-cloudflare/
- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/artifacts/guides/event-subscriptions/index.md
