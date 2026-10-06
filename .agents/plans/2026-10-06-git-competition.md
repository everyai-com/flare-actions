# Git competition entry plan — Flare Tournaments: the pull request for the agent era

Date: 2026-10-06 (rev 4: first-principles execution spec). Deadline: Oct 14, 2026.

## First principles (why this shape, derived — not brainstormed)

The brief reduces to five irreducible questions. Everything in this plan
exists because one of them demands it; anything no question demands is cut.

- Q1 coordination ("how do agents know what others work on?") → demands a
  shared, live record of who claimed what and where each attempt stands.
  Minimal answer: atomic task claims + a board. Rejected: agent chat
  (a second product), polling each other (no primitive, no story).
- Q2 conflicts ("what happens on conflicting changes?") → demands
  foresight, not post-hoc merge pain. Minimal honest answer: file-set
  intersection across attempt diffs — computable from binding reads,
  demoable, never oversold as semantic. Rejected: real merge (needs a
  merge primitive that doesn't exist), ignoring it (leaves a brief
  question unanswered).
- Q3 review ("how do you review everything?") → demands verdicts that
  scale with attempt count and compose across attempts. Minimal answer:
  per-attempt digest/triage (already built) + one cross-attempt ranking
  review. Rejected: human-in-the-loop per attempt (doesn't scale — the
  brief's whole point), single-attempt-only review (no comparison).
- Q4 why ("not just what changed, but why?") → demands an append-only
  record binding intent → evidence → decision, queryable later.
  Minimal answer: decision ledger + read-only query. Rejected: commit
  messages (agents don't write them reliably), nothing (fails the brief
  verbatim).
- Q5 compare/decide ("compare multiple changes, decide which ships") →
  demands ranking + resolution to one blessed outcome. Minimal answer:
  verdict ranking + blessed pointer, upgraded to a real fast-forward if
  time allows. Rejected: dashboard-only with no resolution (no decision),
  auto-merge without verification (unsafe story).

Fixed constraints: 8 days; Workers + Artifacts primitives only; the demo
must be live and repeatable (finalists demo in SF); every claim in the
video must survive the question "show me". Hence E2E-first ordering,
explicit cut order, and the 3x-green harness bar.

Primitive map (subsystem → platform primitive → codebase pattern):

- claims/board → D1 + dashboard → `heal_claims` atomic-claim pattern
- push trigger → event subscription → queue → `queue()` branch
- pipeline read → binding `readFile` → webhook dispatch shape
- isolation → binding `fork()` → per-job temp-dir isolation idea
- verify → seats containers + mirror checkout → existing executor
- radar → binding `readTree`/`log` diffs → new, pure function + test
- verdict → Workers AI over digests → `triage.ts` inference pattern
- ledger → D1 append-only → audit-log pattern; query → MCP read tool
- promote → git itself (isomorphic-git) → documented push pattern,
  with a D1-pointer fallback

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
cut exists.

Data model (new D1 tables; `schema.ts` + migration together, per repo
rule that both change as one):

- `tournaments`: id, task intent text, source repo + base ref, state
  (open → verifying → decided), created_at.
- `attempts`: id, tournament id, agent label, fork repo name, claim
  state (claimed → pushing → verifying → terminal), linked run id,
  verdict rank (nullable until decided). One UNIQUE guard so a second
  claim on the same (tournament, agent) slot fails atomically.
- `verdicts`: tournament id, ranking JSON (bounded), rationale text
  (bounded like triage ≤4KB), model id, created_at.
- `ledger`: append-only rows (tournament id, kind, body, created_at):
  intent recorded, attempt terminal, collision fired, verdict reached,
  winner resolved. Never updated, never deleted.

Lifecycles: attempt moves claimed → pushing (first push event) →
verifying (run dispatched) → terminal (run terminal; digest stored).
Tournament moves open → verifying (first attempt verifying) → decided
(verdict + resolution recorded). Verdict runs once all linked runs are
terminal or a bounded wait expires (a stuck attempt must not veto a
tournament — expiry recorded in the ledger).

Verdict function inputs (ranked, deterministic first): run terminal
status (success outranks failure — a green attempt always beats red),
failing-test count from JUnit where present, then Workers AI rationale
over digests for ordering among greens and the human-readable why.
Inference outage degrades to digest-order ranking, recorded, no 500.

Radar definition: for each attempt pair, intersect changed-file sets
(from binding diff reads); non-empty intersection with both attempts
non-terminal-failed → collision row + board flag. File-level only —
the honest scope, stated in docs and video.

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
   file ack cleanly with no run. Tests: valid push dispatches; missing
   pipeline clean-acks; malformed envelope acks without 500; redelivery
   of the same push is idempotent (delivery-guard like webhooks).
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
5. **Tournaments (`tournaments.ts` + board + migration + test).** Task
   intent + atomic agent claims (one claim → one binding `fork()`;
   double-claim fails atomically), live attempt states on a tournament
   board (dashboard view; CLI read only if free). Tests: claim/fork
   link, double-claim atomicity, state transitions, tournament decided
   only via verdict+resolution. Done when: 2 claims race cleanly and the
   board shows live states.
6. **Overlap radar + AI verdict + ledger (+ migration + tests + MCP
   `why`).** Radar as defined above; verdict per the ranking inputs
   above; ledger append-only per the data model; MCP read-only `why`
   tool answers "why did attempt X win/lose?" from the ledger. Tests:
   intersection logic incl. empty/disjoint sets, verdict ordering among
   green/green and green/red, inference-outage degradation, ledger
   append-only (no update path exists). Done when: forced collision
   fires, known-good ranks first, ledger + `why` agree.
7. **Promote the winner, two cuts.** 7a (banked): blessed-sha pointer in
   D1 + dashboard/API + one-command adopt → M2. 7b (upgrade, droppable):
   `promote.ts` isomorphic-git fast-forward of the blessed ref from the
   Worker (strip `?expires=` per the docs; MemoryFS; auth-failure and
   non-fast-forward both fail closed with ledger rows, never half-push).
   Done when: 7a always; 7b only if staging-green by the Day 6 trigger.
8. **Tournament-mode demo harness.** Script: open a task, fork per agent,
   drive ≥3 concurrent pushes (one forced failure, one forced file
   collision) over git-HTTPS with binding-minted tokens, run verdict +
   promote, print the ledger. Works on 7a or 7b (fallback-tolerant).
   Done when: green 3x in a row on staging.
9. **Video + submission.** Run/try instructions doc (+ README pointer)
   verified cold on a fresh checkout; video per the beats below; submit
   at cloudflare.com/git-competition on Day 8 morning. Docs-only; no
   code. Done when: the submission checklist below is fully ticked.

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

Submission checklist: video 5–10 min; MIT source link; run/try
instructions verified cold; multi-agent concurrency undeniable on
screen; radar + verdict + promote all visible; nothing claimed that
isn't shown.

## Validation Plan

- Steps 1–3: `npm run types`, `npm run typecheck`, `npm test`,
  `npm run deploy:dry`. Queue-only + dashboard-view additions: no new
  public API routes planned, so OpenAPI gates stay untouched; if a route
  appears, run `node scripts/check-openapi.mjs` + `npm run lint:openapi`.
- Step 4 (first high-risk check): M1 E2E + negatives as above.
- Steps 5–7 (highest-risk check): 3-agent tournament E2E — all attempts
  verified, radar fires, verdict sensible, winner resolved, ledger
  complete; negatives: double-claim atomic, verdict outage degrades,
  7b non-fast-forward fails closed.
- Step 8: harness green 3x; ledger query + MCP `why` agree.
- Step 9: cold fresh-checkout instructions run; video checklist ticked.

## Failure modes & cut order

- Cut order (first to go): per-job tokens → CLI board reads → 7b
  isomorphic-git promote (→ 7a pointer) → JUnit-aware verdict ordering
  (→ status + AI rationale only). Heal stays GitHub-only, always.
- A stuck attempt never vetoes a tournament (bounded wait, ledger row).
- Inference outages never 500 (verdict degrades, radar is pure logic).
- Push without pipeline, malformed events, redeliveries: ack, never poison.
- No code changes after Day 8 submission except a demo-breaking fix.

## Risks / Open Questions

- 8 days for a big swing — the schedule's fallback triggers are the
  mitigation, and they have dates, not vibes.
- Event-subscription provisioning mechanics still unverified — first
  execution research item, with the Day 1 fallback trigger.
- isomorphic-git is the newest dependency (bundle, MemoryFS, push-auth
  all unproven here) — isolated module + Day 6 drop trigger; the
  harness never depends on it.
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
