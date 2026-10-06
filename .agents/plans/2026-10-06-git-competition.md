# Git competition entry plan — Flare Tournaments: the pull request for the agent era

Date: 2026-10-06 (rev 3: detailed execution spec). Deadline: Oct 14, 2026.

## Goal

Enter Cloudflare's "next Git platform" competition with a genuinely new
object: the **tournament**. For one task, N agents race in isolated
Artifacts forks; Flare verifies every attempt with real CI, detects
collisions *between* attempts, composes an AI review *across* attempts,
promotes the winner to the blessed ref, and writes the whole story —
intent → attempts → verdicts → decision — into a permanent ledger.
Win condition: a top-3 finish decided by a flawless, reproducible demo
of the race → review → decision arc — not by feature count.

## Success Criteria

- One task → N isolated agent forks (fork-per-claim) racing concurrently.
- Every push auto-verified: seats execute from Artifacts, digest + triage
  per attempt, no GitHub in the loop.
- Overlap radar fires when two attempts touch the same files (conflict
  foresight, demoed with a forced collision; presented honestly as
  file-level, never oversold as semantic).
- Cross-attempt AI verdict ranks attempts and names a winner with
  rationale; a tournament board shows race → review → decision live.
- Winner resolved to the blessed ref (blessed pointer banked first,
  isomorphic-git fast-forward as the upgrade) and the decision ledger
  records intent, evidence, and rationale — queryable, including via MCP.
- Tournament harness green 3x in a row on staging (repeatability is the
  live-demo qualifier).
- Submission package by Oct 14: 5–10 min video opening with the
  tournament story in the first 60 seconds, MIT source link (repo is
  already MIT), run/try instructions that work cold.

## Approach

E2E-first: bank a working race → verdict → decision loop as early as
possible, then upgrade its parts. The blessed pointer lands before the
isomorphic-git fast-forward; the harness runs against whichever promote
cut exists. Five small D1-backed modules on the existing agent surface,
each reusing a proven pattern: dispatch rides `dispatchRun`
(`apps/worker/src/index.ts:2500`); delivery rides a new Artifacts queue
consumed by `queue()` (`index.ts:2454`, today ack-only — must branch on
message shape); execution rides the seats mirror-first checkout
(`renderMirrorRemote` + `ARTIFACTS_MIRROR_REMOTE/TOKEN`); verdicts ride
digest + triage; claims ride the atomic-claim pattern (`heal_claims`,
webhook idempotency); the cross-attempt review rides the triage
inference pattern (Workers AI, degrade-to-skip, never 500).
`artifacts` runs skip GitHub-only surfaces like `source` runs do.
Programmatic promote has no REST endpoint (verified: the REST API is
repos/forks/imports/tokens/content-reads only), so the upgrade path
goes through git itself via the documented isomorphic-git-in-Workers
push pattern, isolated in its own module.

Alternatives rejected: a full Git-forge clone (judges want the layer
*above* repos/branches/PRs); per-push CI with no tournament (safe but
reads as GitHub Actions on a new remote); Workflows orchestration (our
own spike verdict stands); agent-to-agent chat/awareness (a second
product, cut for the deadline).

## Schedule (8 days, milestones are the boss)

- Day 1 (Oct 6–7): steps 1–3. Done when: trigger + queue unit-tested,
  `deploy:dry` green. Fallback trigger: if event-subscription
  provisioning mechanics aren't solved by EOD, switch to documented
  manual subscription + static config and keep building.
- Day 2–3 (Oct 7–8): step 4 → **M1: single-push E2E green on staging**
  (push → `artifacts` run → mirror checkout → terminal digest).
- Day 3–4 (Oct 8–9): step 5 (tournaments + board).
- Day 4–5 (Oct 9–10): step 6 (radar + verdict + ledger) and step 7a
  (blessed pointer) → **M2: full tournament loop E2E green**.
  Rough video cut against M2 on Day 5 evening whatever the polish.
- Day 6 (Oct 11): step 7b (isomorphic-git upgrade, droppable) + step 8
  (harness to 3x green). Drop trigger: if 7b isn't staging-green by EOD,
  it stays cut and the entry ships on the blessed pointer.
- Day 7 (Oct 12–13): buffer for red items, then final video + docs.
- Day 8 (Oct 14): submit early in the day; keep the evening as portal
  buffer. No code changes after submission except a demo-breaking fix.

## Steps

1. **Platform prereq (wrangler + binding).** Bump `wrangler` to ≥4.145.0
   (installed 4.142.0; binding types need 4.145+), add the `ARTIFACTS`
   binding (`namespace` configurable) to `wrangler.jsonc`, run
   `npm run types`. Touches: `package.json`, `wrangler.jsonc`, generated
   types. Done when: `typecheck` + `deploy:dry` green.
2. **Trigger module (`apps/worker/src/artifacts.ts` + test).** Validate
   the `cf.artifacts.repo.pushed` envelope (source namespace/repo,
   payload ref/after), read `flare.yml` via binding `readFile`, dispatch
   via `dispatchRun` with event `artifacts`; pushes without a pipeline
   file ack cleanly with no run. Done when: unit tests cover valid push,
   missing pipeline (clean ack), malformed envelope (ack, no 500).
3. **Queue + event subscription.** New `flare-actions-artifacts` queue
   (+ staging twin, DLQ), `queue()` branches Artifacts messages to the
   trigger module, `scripts/setup.mjs` gains a provisioning step for the
   queue and the `artifacts.repo`-source event subscription. First
   execution research item: exact provisioning calls. Done when: an
   Artifacts push event flows queue → trigger on staging.
4. **Execution on staging (M1).** Point the staging seats worker's
   existing mirror config at an Artifacts namespace; document the manual
   provisioning (namespace, remote template, token rotation). Env-level
   mirror token for the entry; per-job `createToken("read")` is cut
   unless free. Done when: push → run → `[seat] checkout ok (mirror)` →
   terminal digest, plus the no-`flare.yml` negative.
5. **Tournaments (`tournaments.ts` + board).** Task intent + atomic agent
   claims (one claim → one binding `fork()`; double-claim fails
   atomically), live attempt states (claimed → pushing → verifying →
   terminal) on a tournament board (dashboard view; CLI read only if
   free). Done when: 2 claims race cleanly, board shows live states.
6. **Overlap radar + AI verdict + ledger.** File-level collision
   detection across attempt diffs (binding `readTree`/`log`); Workers AI
   review over all digests ranking attempts with rationale
   (degrade-to-skip like triage; outage → digest-order ranking, no 500);
   append-only decision ledger (intent → attempts → verdicts → decision)
   with an MCP read-only `why` tool. Done when: forced collision fires
   the radar, verdict ranks a known-good attempt first, ledger + `why`
   agree.
7. **Promote the winner, two cuts.** 7a (banked): blessed-sha pointer in
   D1 + dashboard/API + one-command adopt → M2. 7b (upgrade, droppable):
   `promote.ts` isomorphic-git fast-forward of the blessed ref from the
   Worker (strip `?expires=` per the docs). Done when: 7a always; 7b
   only if staging-green by the Day 6 drop trigger.
8. **Tournament-mode demo harness.** Script: open a task, fork per agent,
   drive ≥3 concurrent pushes (one forced failure, one forced file
   collision) over git-HTTPS with binding-minted tokens, run verdict +
   promote, print the ledger. Done when: green 3x in a row on staging.
9. **Video + submission.** Run/try instructions doc (+ README pointer)
   verified cold; video per the narrative beats below; submit at
   cloudflare.com/git-competition on Day 8 morning. Docs-only; no code.

## Video narrative beats (the 60-second rule)

- 0:00–1:00 — one task, three agents racing in isolated forks, live
  board filling. No architecture, no setup story. The tournament idea
  must land before minute one ends.
- 1:00–4:00 — every attempt verified (real test runs), collision fires
  the radar, AI verdict ranks with rationale, winner promoted, ledger
  records the why. Show the MCP `why` query once.
- 4:00–6:00 — how it works (events → queue → seats → verdict), one
  breath on scaling (queue fan-out, scale-to-zero seats; no unproven
  numbers), where to run it. Hard stop ≤10:00.
- Rough cut Day 5 against M2 (finds every demo gap); final cut Day 7.

## Validation Plan

- Steps 1–3: `npm run types`, `npm run typecheck`, `npm test`,
  `npm run deploy:dry`. Queue-only + dashboard-view additions: no new
  public API routes planned, so OpenAPI gates stay untouched; if a route
  appears, run `node scripts/check-openapi.mjs` + `npm run lint:openapi`.
- Step 4 (first high-risk check): M1 E2E + negatives as above.
- Steps 5–7 (highest-risk check): 3-agent tournament E2E — all attempts
  verified, radar fires, verdict sensible, winner resolved, ledger
  complete; negatives: double-claim atomic, verdict outage degrades.
- Step 8: harness green 3x; ledger query + MCP `why` agree.
- Step 9: instructions followed cold on a fresh checkout; video
  checklist (tournament lands <1:00, collision + verdict + promote
  visible, ≤10:00).

## Risks / Open Questions

- 8 days for a big swing: cut order is explicit — per-job tokens, CLI
  board reads, then 7b isomorphic-git promote (→ 7a blessed pointer),
  in that order. Heal stays GitHub-only.
- Event-subscription provisioning mechanics still unverified — first
  execution research item, with the Day 1 fallback trigger above.
- isomorphic-git is the newest dependency (bundle, MemoryFS, push-auth
  all unproven here) — hence isolated module + drop trigger, and the
  harness never depends on it (works on 7a).
- Queues are not preview-isolated — validate on the staging worker.
- Artifacts is Paid-only; access already proven (staging mirror-canary
  jobs). Billing starts Oct 15, after the deadline.
- Open questions: none blocking.

## Sources

- https://blog.cloudflare.com/next-git-platform-on-cloudflare/
- https://www.cloudflare.com/git-competition/
- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/artifacts/guides/event-subscriptions/index.md
- https://developers.cloudflare.com/artifacts/examples/isomorphic-git/index.md
- https://developers.cloudflare.com/artifacts/api/rest-api/index.md
