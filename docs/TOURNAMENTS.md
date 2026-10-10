# Resolution races (a Flare Forge capability)

> Provenance: agent-drafted, revised 2026-10-10 to fold the original
> "Flare Tournaments" page into Forge. Race mechanics below are read from
> `apps/worker/src/tournaments.ts`, `verdict.ts` and `replay.ts`
> (`chooseStrategy`, `raceReplay`, `pollRaces`), which have colocated
> tests (`npm test`). The harness section was verified green on the
> `try-tournaments` preview on 2026-10-09 (`npm run harness`).

A **resolution race** runs N attempts at one piece of work side by side.
Each attempt gets its own isolated
[Artifacts](https://developers.cloudflare.com/artifacts/) fork, real
Flare CI verifies every attempt, a collision radar records who touched
the same files, a deterministic verdict ranks the attempts (Workers AI
writes the rationale), and an append-only ledger records each decision.

Races were the first thing we built on Artifacts. They are now one tool
inside [Flare Forge](FORGE-AGENTS.md), used in two ways:

| Use | Trigger | Who lands the winner |
|---|---|---|
| **Conflict resolution** (the Forge path) | A train hits a real merge conflict, and `.flare/policy.yml` sets `replay.race_k` above 1 | A normal CI-verified **train**. The race never writes trunk. |
| **Standalone race** | `POST /v1/tournaments`, then agents claim lanes | The race itself: the winner fast-forwards the source branch |

```
conflict or task ──▶ fork per attempt ──▶ push ──▶ verify (seats) ──▶ radar ──▶ verdict ──▶ train (Forge) | promote (standalone) ──▶ ledger
```

## In Forge: racing a conflict

Forge resolves a merge conflict by **replaying** the dropped intent on
the new trunk, never by hand-editing trunk. The replay strategy comes
from policy and from what the deployment has bound
(`replay.chooseStrategy`):

| Strategy | When | What happens |
|---|---|---|
| `notify` | No Workers AI, or more than 3 conflicting files | The owning agent gets a mailbox note with both intents' reasoning and replays the change itself (`claim_conflict`, then `resolve_conflict`) |
| `auto` | Small conflict, AI bound, `race_k` = 1 (the default) | One AI replay is committed to a new fork and re-enters the queue as a ready intent |
| `race` | Small conflict, AI bound, `race_k` 2–8 | K AI resolver attempts race as a tournament, one fork each, with CI on each fork. The verdict's green winner becomes the intent's replay |

Turn races on in the trunk's policy file:

```yaml
# .flare/policy.yml
replay:
  race_k: 3        # 1-8; 1 (default) means a single auto replay
  max_attempts: 2  # 0-10
```

Guarantees, each enforced in `replay.ts`:

- **A race never writes trunk.** The race is created on `forge/replay`,
  and a `promote-failed` stop row is filed up front so no tournament
  path can push the winner. The winner's fork and SHA go through
  `resolveConflictFor`, and the intent rides the next train like any
  other ready intent. The train verifies the exact combined SHA.
- **Only a green winner counts.** If the winning run is not `success`,
  the conflict claim is released and the owner replays by hand.
- **Races are bounded.** A race still undecided after 2 hours, with no
  attempt still running, goes back to the owner.
- **The owner is always notified**, whatever strategy runs.
- Both the conflict and the intent get a `race` row in the Forge ledger
  that points at the race id, so the history shows how a conflict was
  resolved.

Race boards show up in the dashboard **Races** tab and in `cli races`,
next to the Forge **Conflicts** view.

## Standalone races (try it on a staging preview, ~10 minutes)

A standalone race is the same machinery without an intent: one task,
N agents, and the winner promoted directly. It is the quickest way to
watch forks, CI, radar and verdict work end to end.

You need Node 22.6+, a Cloudflare account with Workers Paid (Artifacts
needs it), and `npx wrangler login`. Managed seats must exist once per
account; `npm run setup` provisions them when Docker is available.

```bash
git clone https://github.com/everyai-com/flare-actions.git
cd flare-actions
npm install
git checkout -b try-tournaments
npx wrangler preview
# → https://try-tournaments-flare-actions.<you>.workers.dev
```

Give the preview its own admin token (a staging-only value, never prod):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > /tmp/tour-token.txt
tr -d '\n' < /tmp/tour-token.txt | npx wrangler preview secret put ADMIN_TOKEN --name try-tournaments
```

Run one full race. Three agents race: two go green on the same file (a
forced collision) and one goes red. The board reaches `decided`, the
winner promotes, the ledger prints, and 12 checks assert:

```bash
HARNESS_URL="https://try-tournaments-flare-actions.<you>.workers.dev" \
HARNESS_ADMIN_TOKEN="$(cat /tmp/tour-token.txt)" \
npm run harness
```

To watch it live, open
`https://try-tournaments-flare-actions.<you>.workers.dev/dashboard` on
the Races tab while the harness runs. To ask why, use the read-tier MCP
tool `tournament_why` (`npx flare-forge mcp-config` prints the client
config).

Clean up with `npx wrangler preview delete --name try-tournaments`. The
harness deletes its own repos; the race rows stay in staging D1.

## How a race works

- **Claim** (`POST /v1/tournaments/:id/claims`) forks the source repo
  through the `ARTIFACTS` binding. It is atomic: `UNIQUE(tournament_id,
  agent)` wins first, and a lost claim never forks.
- **Poll** (the production cron, or `POST /v1/admin/tournaments/tick` on
  staging) watches fork heads, reads `flare.yml` at each new SHA, and
  dispatches `event: "artifacts"` verification runs. These are
  seats-only: BYO runners never see artifact jobs.
- **Verify.** Managed seats check out the fork over git-HTTPS with a
  1-hour fork-scoped token (memory-only, fail-closed, no GitHub
  fallback) and run the pipeline.
- **Radar** diffs every fork against the race base and records
  file-level collisions (`agent x agent: paths`) in the ledger.
- **Verdict** ranks deterministically: terminal state, then status,
  then failing tests, then agent name. Workers AI writes only the why.
  The stored rationale always leads with the deterministic winner, and
  an AI outage falls back to the deterministic text, never a 500.
- **Promote** (standalone races only). The winner's SHA becomes a
  blessed pointer, then the Worker fast-forwards the source branch with
  isomorphic-git (memory filesystem, per-repo tokens). Any rejection
  falls back to the pointer, with a ledger row. Forge resolution races
  skip this step; trains land them. A Forge trunk (any repo with goals
  or intents) is never promoted: only the train moves its main.
  `POST /v1/tournaments` answers 409 `forge_trunk_promote` unless the
  create says `promote: false` (which pre-files the `promote-failed`
  stop row), and `fastForwardWinner` re-checks at push time, filing
  `promote-failed` with the reason.
- **Ledger** (`GET /v1/tournaments/:id` board): opened → claimed →
  pushed → terminal → collision → verdict → resolved → promoted. It is
  append-only; there is no update path.

## API and MCP surface

| Call | Effect |
| --- | --- |
| `POST /v1/tournaments` | Open a race (`intent`, `sourceRepo`, `baseRef`, `baseSha`) |
| `POST /v1/tournaments/:id/claims` | Claim a lane as `agent` (forks) |
| `GET /v1/tournaments`, `GET /v1/tournaments/:id` | List races; one board with attempts, verdict and ledger |
| `POST /v1/admin/tournaments/tick` | One machine tick (admin; staging and demo) |
| MCP `tournament_why` | Read tier: winner, rationale and collisions |
| `cli races\|claim\|verdict` | List boards, claim a lane, read the verdict |
| `GET /v1/repos…` | Browse the Artifacts namespace (Repositories tab) |

Full shapes are in `openapi.yaml` (`Tournament`, `TournamentAttempt`,
`TournamentBoard`) and `docs/MCP.md`. The API keeps the `tournaments`
name for compatibility.

## Notes

- Queues are not preview-isolated. Validate on the staging worker only,
  never prod. Previews share the staging D1.
- A verdict is decided when every attempt is terminal, or 30 minutes
  after the oldest activity once at least one run is terminal. A stuck
  attempt never vetoes, and the timeout is ledgered.
- Event subscriptions (push → queue) are the production trigger,
  provisioned by setup (`ARTIFACTS_SUBSCRIBE_REPOS` plus
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). The poller covers
  dynamic forks. Either path dispatches, and both dedupe.
