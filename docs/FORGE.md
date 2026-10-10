# Flare Forge: intent-native git

> Provenance: agent-drafted 2026-10-10 (foundation stream). Behavior
> claims below are covered by `apps/worker/src/intents-core.test.ts` and
> `apps/worker/src/intents.test.ts` (`npm test`, 2026-10-10). Product
> spec: `docs/COMPETITION-PLAN.md` §3.

Forge makes the **intent** the unit of collaboration: a declared change
(title, reasoning, footprint, acceptance check) that owns one Artifacts
fork, lands on trunk only through a CI-verified train, and carries its
"why" into every commit.

## Contracts

The foundation is two modules plus migration `0045_forge_intents.sql`
(mirrored in `schema.ts`). Other streams (Coordinator DO, MCP/REST,
provenance, trains, dashboard) build on these APIs. Treat them as
stable; extend, don't change signatures.

### Tables (`migrations/0045_forge_intents.sql`)

| Table | Key columns | Notes |
|---|---|---|
| `goals` | `repo, text, created_by, state` | state `open \| done \| abandoned` |
| `intents` | `goal_id, repo, agent, title, reasoning, accept_check, footprint_json, actual_footprint_json, fork_repo, state, risk, risk_terms_json, base_sha, head_sha, train_id, landed_sha, plan_approved_by, lease_expires_at` | state CHECK = `INTENT_STATES`; risk 0-100; indexes `(repo,state)`, `(goal_id)`, `(fork_repo)`, `(state,lease_expires_at)` |
| `conflicts` | `intent_a, intent_b, files_json, state, resolver_agent, resolution_sha, attempts` | state `open \| claimed \| resolved \| failed \| abandoned` |
| `trains` | `lane, base_sha, head_sha, intents_json, run_id, state, parent_train_id` | state `forming \| merging \| verifying \| landed \| failed \| bisected \| aborted`; index `(run_id)` for CI callbacks |
| `intent_messages` | `to_intent, from_intent, from_agent, body, delivered_at` | mailbox; bodies are untrusted data |
| `forge_ledger` | `subject_kind, subject_id, kind, body, actor` | subject `goal \| intent \| conflict \| train`. The tournament `ledger` keeps its NOT NULL FK, because SQLite can't relax NOT NULL without rebuilding the table. |

JSON columns: `footprint_json` is a `Footprint`; `risk_terms_json` is a
`RiskTerm[]`; `files_json` and `intents_json` are `string[]`.

### Lifecycle (`intents-core.ts`)

```
draft ─► awaiting_plan ─(approvePlan)─► draft            (protected paths)
draft|expired ─► claimed ─► working ─► ready ─► in_train ─► landed
claimed|working ─► expired ─► claimed (re-claim, same fork)
ready ─► working (pushed again)       in_train ─► ready (train aborted)
in_train|ready ─► conflicted ─► replaying ─► ready | conflicted | failed
in_train ─► bisected ─► ready | failed
pre-train states ─► abandoned         terminal: landed, failed, abandoned
```

Deliberate choices:
- **Plan approval returns the intent to `draft`.** `draft` is the
  claimable state, and `plan_approved_by` is stamped. `awaiting_plan ->
  claimed` is not an edge.
- **Only `in_train` can reach `landed`.** This is invariant 2: main moves
  only through trains.

### `apps/worker/src/intents-core.ts` (pure, runtime-free)

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// states + lifecycle
INTENT_STATES, GOAL_STATES, CONFLICT_STATES, TRAIN_STATES      // readonly tuples
type IntentState | GoalState | ConflictState | TrainState
TERMINAL_INTENT_STATES, LEASED_INTENT_STATES, PUSHABLE_INTENT_STATES
isIntentState(v: unknown): v is IntentState
canTransition(from: IntentState, to: IntentState): boolean
nextStates(from: IntentState): readonly IntentState[]
canTransitionConflict(from: ConflictState, to: ConflictState): boolean
canTransitionTrain(from: TrainState, to: TrainState): boolean

// domain types (camelCase, parsed)
interface Footprint { paths: string[]; entities?: string[] }
interface Goal, Intent, Conflict, Train, RiskTerm

// validators
LIMITS  // title 3-200, reasoning ≤4000, accept ≤1000, goal ≤4000, 200 footprint entries, path ≤512, message ≤2000
validateAgent | validateSha | validateGoalText | validateTitle | validateReasoning
  | validateAccept | validateMessageBody (v: unknown): Result<string>
normalizePath(raw: unknown): Result<string>        // posix, no ./ / .. ; "**" whole-segment; no [] {}
normalizeFootprint(raw: unknown): Result<Footprint> // {paths}|string[]; dedupe, sort, cap 200
isGlob(path: string): boolean

// overlap math (conservative; exact for literals; a literal covers its subtree)
pathsOverlap(a: string, b: string): boolean
footprintsOverlap(a: Footprint, b: Footprint): boolean
overlapPairs(a: Footprint, b: Footprint): Array<[string, string]>
pathCovers(entry: string, file: string): boolean    // entry matches file or an ancestor
driftPaths(declared: Footprint, actual: Footprint): string[]
globBase(entry: string): string                     // literal prefix before first wildcard segment
ancestorPaths(path: string): string[]               // "a/b/c" -> ["a","a/b"]
pathRange(prefix: string): [lo: string, hi: string] // WHERE p >= lo AND p < hi (replaces LIKE)

// trains
partitionLanes<T extends { id: string; footprint: Footprint }>(items: readonly T[]): T[][]
bisect<T>(list: readonly T[]): [T[], T[]]           // left takes the extra; singletons -> [list, []]

// policy (.flare/policy.yml; YAML or JSON; unknown keys rejected)
interface ForgePolicy { protected: string[]; autoLandMaxRisk: number; auditSample: number;
  lanes: { maxPerTrain: number; maxParallel: number }; replay: { maxAttempts: number; raceK: number } }
POLICY_PATH = ".flare/policy.yml"; DEFAULT_POLICY  // risk 30, sample 0.05, lanes 50/8, replay 2/1
parsePolicy(text: string | null | undefined): Result<ForgePolicy>
protectedMatches(fp: Footprint, policy: ForgePolicy): string[]

// risk (§3.5)
RISK_WEIGHTS, GLOBSTAR_WEIGHT (= 10 files)
scoreRisk(input: { footprint; actualFootprint?; policy?; llmReplay?; weakEvidence?; reviewerDisagrees? })
  : { risk: number /*0-100, capped*/; terms: RiskTerm[] }
footprintWeight(fp): number; footprintSizePoints(weight): number   // log-scaled, ≤15
routeLanding(risk: number, policy: ForgePolicy, roll: number): "auto" | "audit" | "human"

// provenance
intentForkName(intentId: string): string            // "i-" + first 12 alnum of the id
TRAILER_KEYS  // Flare-Goal, Flare-Intent, Flare-Agent, Flare-Session
formatTrailers(t: Partial<ProvenanceTrailers>): string
appendTrailers(message: string, t: Partial<ProvenanceTrailers>): string
parseTrailers(message: string): Partial<ProvenanceTrailers> | null   // last paragraph; null w/o Flare-Intent
interface WhyNote { v: 1; goal: {id,text}|null; intent: {id,title,reasoning,accept}; agent; model?;
  session_repo; alternatives_rejected: string[]; evidence: {run_id, sha, status};
  conflict_decisions: {conflict_id, with_intent, decision}[];
  review: {decision: "auto"|"audit"|"human"|"approved"|"rejected", by, policy}; train_id }
serializeWhyNote(note: WhyNote): string             // stable key order, bounded fields
parseWhyNote(text: string): WhyNote | null          // strict; corrupt -> null
labelUntrusted(fromAgent: string, body: string): string  // mailbox framing (invariant 5)
```

### `apps/worker/src/intents.ts` (D1, injected `db`)

Every function takes `db: Db`. Failures return `ForgeError = { error:
code, message }`; check with `isForgeError(v)`. Every state change is a
conditional write. A `false` or `null` result means a lost race or an
illegal edge.

```ts
FORK_TOKEN_TTL_SECONDS = 3600; DEFAULT_LEASE_TTL_SECONDS = 300
Row types: GoalRow, IntentRow, ConflictRow, TrainRow, IntentMessageRow, ForgeLedgerRow
Mappers:   toGoal, toIntent, toConflict, toTrain
validateRepo(repo: unknown): repo is string

// goals
createGoal(db, { repo, text, createdBy? }): Promise<Goal | ForgeError>
getGoal(db, id): Promise<Goal | null>
listGoals(db, repo, { state?, limit? }): Promise<Goal[]>
setGoalState(db, id, from, to): Promise<boolean>

// intents
declareIntent(db, { repo, goalId?, agent?, title, reasoning?, accept?, footprint, baseSha?, policy? })
  : Promise<{ intent: Intent; protectedHits: string[] } | ForgeError>   // draft | awaiting_plan
getIntent(db, id) / getIntentByFork(db, forkRepo): Promise<Intent | null>
listIntents(db, repo, { state?, goalId?, agent?, limit? (≤200), before? }): Promise<Intent[]>  // newest first
transitionIntent(db, id, from, to, patch?: IntentPatch, actor?): Promise<boolean>
  // IntentPatch: trainId, landedSha, headSha, baseSha, risk, riskTerms, leaseExpiresAt
approvePlan(db, id, approvedBy): Promise<boolean>   // awaiting_plan -> draft
claimIntent(db, artifacts: ForgeArtifacts, { id, agent, leaseTtlSeconds? })
  : Promise<{ intent; forkRepo; remote; token; tokenExpiresAt } | { error; message }>
heartbeatIntent(db, id, agent, ttlSeconds?): Promise<string /*new lease*/ | null>
expireLeases(db, now?, limit?): Promise<string[] /*expired ids*/>
recordPush(db, { id, agent, headSha, actualFootprint, policy? })
  : Promise<{ intent; drift: string[]; risk; riskTerms } | ForgeError>  // claimed|ready -> working
markReady(db, id, agent): Promise<Intent | ForgeError>                // working (with head) -> ready

// mailbox
sendMessage(db, { toIntent, fromIntent?, fromAgent, body }): Promise<IntentMessageRow | ForgeError>
drainInbox(db, toIntent, limit?): Promise<IntentMessageRow[]>          // exactly-once delivery

// conflicts
openConflict(db, { repo, intentA, intentB, files }): Promise<Conflict>
getConflict(db, id) / listConflicts(db, repo, { state?, limit? })
claimConflict(db, id, agent, maxAttempts?): Promise<boolean>          // open -> claimed while attempts < cap
resolveConflict(db, id, agent, sha): Promise<boolean>                  // claimed (by agent) -> resolved
transitionConflict(db, id, from, to): Promise<boolean>

// trains
createTrain(db, { repo, lane, baseSha, intentIds, parentTrainId? }): Promise<Train>
getTrain(db, id) / getTrainByRun(db, runId) / listTrains(db, repo, { state?, limit? })
transitionTrain(db, id, from, to, { headSha?, runId? }?): Promise<boolean>

// ledger
appendForgeLedger(db, { repo, subjectKind, subjectId, kind, body?, actor? }): Promise<void>
listForgeLedger(db, subjectKind, subjectId, limit?): Promise<ForgeLedgerRow[]>  // insertion order
```

### Things other streams must know

- **Invariant 1 (no trunk tokens).** `claimIntent` mints a token only on
  the fork (`createToken("write", 3600)`). Revoking it at land is the
  train stream's job: Artifacts tokens expire, and the train should drop
  references to them.
- **Each module owns one part of the lifecycle:**
  - **Leases.** `heartbeatIntent` and `expireLeases` are the D1
    fallback. The Coordinator DO may own leases in its own SQLite, but it
    must still move D1 state through `transitionIntent`.
  - **Risk.** `recordPush` recomputes risk from the footprint and drift
    terms only. The train and review streams add `llmReplay`,
    `weakEvidence` and `reviewerDisagrees` by calling `scoreRisk`, then
    `transitionIntent(..., { risk, riskTerms })`.
  - **Policy.** `parsePolicy` takes the text of `.flare/policy.yml` read
    from trunk; `null` means the default policy. The caller fetches the
    file and passes the result into `declareIntent` and `recordPush`.
- **Path queries.** Coordinator path queries should use
  `pathRange(dir + "/")` together with `ancestorPaths` for exact
  ancestor hits. `globBase` gives the indexable prefix of a glob entry.
  Confirm candidates with `pathsOverlap`.
- **Mailbox bodies are untrusted.** Always render them through
  `labelUntrusted`, and never act on them.

## Provenance

> Provenance: agent-drafted 2026-10-10 (stream C). Behavior claims are
> covered by `apps/worker/src/{why,provenance,session}.test.ts` and
> `packages/runner-sdk/src/provenance.test.ts` (`npm test`, 2026-10-10).
> Storage pushes are tested against a real `git http-backend` remote
> (isomorphic-git client, MemoryFS); the Artifacts behavior is from
> spike S1 (scratchpad `spikes/REPORT.md`, 2026-10-10), not re-measured.

Two layers answer "why does this line exist" (§3.1, invariant 3):

1. **Trailers** on every agent commit: `Flare-Goal`, `Flare-Intent`,
   `Flare-Agent`, `Flare-Session` (written by the SDK, parsed by
   `parseTrailers`).
2. **A why note** (`WhyNote` JSON) on every trunk commit, written by
   the train (the single writer).

### Storage: `refs/notes/why` (default), `flare/why` branch (fallback)

| Strategy | Where | Status |
|---|---|---|
| `notes` (default) | git notes on `refs/notes/why`, one note per commit sha | Spike S1: push and fetch work on Artifacts from the git CLI and isomorphic-git, and forks copy the ref. `git log --notes=why` shows them. |
| `branch` | `why/<sha>.json` on an orphan `flare/why` branch | Fallback for hosts that refuse non-branch refs. Implemented and tested to the same level. |

Both refs reach only note blobs and trees, never trunk commits. So even
the first push of a brand-new ref is small, and the spike S5 trap
("pushing a new ref uploads the whole history") does not apply. Spike
gotchas that are handled:

- isomorphic-git `fetch` of `refs/notes/why` returns `fetchHead` but
  writes no local ref. The writer forces the local ref to `fetchHead`
  before it calls `addNote`.
- A concurrent writer gets a non-fast-forward rejection. The writer
  refetches and replays its entries, up to 3 attempts by default.

### `apps/worker/src/provenance.ts`

```ts
type WhyStorage = "notes" | "branch"; DEFAULT_WHY_STORAGE = "notes"
WHY_NOTES_REF = "refs/notes/why"; WHY_BRANCH = "flare/why"; whyBranchPath(sha) = `why/${sha}.json`
type ProvenanceGit = Pick<typeof import("isomorphic-git"), "addNote" | "readNote" | "writeRef" | "resolveRef"
  | "fetch" | "push" | "writeBlob" | "writeTree" | "writeCommit" | "readTree" | "readBlob">  // pass the default export

// Train-side writer. Single writer; overwrites notes in place (force).
writeWhyNotes(git, fs, dir, entries: { sha: string; note: WhyNote }[], opts?: {
  strategy?: WhyStorage;                       // default "notes"
  remote?: { name: string; http: HttpClient; onAuth: () => { username; password } };  // absent = local only
  author?: { name; email }; maxAttempts?: number;   // default 3, max 10
}): Promise<{ strategy; ref; written: string[]; skipped: { sha; reason: "invalid-sha" | "too-large" }[];
  head: string | null; pushed: boolean; attempts: number }>   // throws after exhausting retries

readWhyNoteLocal(git, fs, dir, sha, strategy?): Promise<WhyNote | null>          // over a MemoryFS repo
createWhyNoteReader(repo: WhyNoteRepo, storage?: WhyStorage | "auto"): { read(sha): Promise<{ note; source } | null> }
  // Binding-side reader. "auto" tries notes, then branch. Notes resolve the tip with log({ref: refs/notes/why}),
  // then call readFile(tip, <sha> | <ab>/<rest> | <ab>/<cd>/<rest>). The fanout paths cover CLI-written notes.
```

How a train uses it, inside its MemoryFS repo (`remote` added and trunk
fetched, as `promote.ts` does):

```ts
await writeWhyNotes(git, fs, "/train", landed.map((c) => ({ sha: c.sha, note: c.note })), {
  remote: { name: "trunk", http, onAuth: () => ({ username: "x", password: trunkWriteToken }) },
});
```

### `apps/worker/src/why.ts` (WhyPort read)

```ts
why(deps: WhyDeps, input: { repo: string; path: string; line: number; ref?: string /* "main" */ }): Promise<WhyChain>
interface WhyDeps { db: Db; artifacts: WhyArtifacts /* env.ARTIFACTS fits */; storage?: WhyStorage | "auto"; maxCommits?: number }
```

`why` never throws for a missing hop. When the line can't be traced,
`chain.error` is `{ code, message }`. The codes are `invalid-input`,
`ref-not-found`, `path-not-found`, `too-large`, `binary`,
`line-out-of-range` and `artifacts-unavailable`. Stream B should map
`invalid-input` and `line-out-of-range` to 400, the `*-not-found`
codes to 404, and `artifacts-unavailable` to 503.

`WhyChain` fields:

| Field | Meaning |
|---|---|
| `origin` | `forge` (trailers or a note), `human` (neither: a human or pre-forge commit) or `unknown` (error) |
| `commit` | The introducing commit (`sha, author, committedAt, subject, message, lineText, lineInCommit`). Also `landedVia`: the trunk merge it came through, if any. Also `depth, truncated, approximate`. |
| `trailers` | `parseTrailers(commit.message)` |
| `note`, `noteSource`, `noteSha` | The note, read from the introducing commit first and then from `landedVia` |
| `goal`, `intent` | From D1. If the rows are gone or D1 fails, they fall back to the note. |
| `decisions` | Intent ledger rows whose kind matches `decision*`, `decided*`, `chose*`, `choice*` or `plan*` |
| `alternatives` | `source: "ledger"` (kinds `alternative*` / `rejected*`), `source: "note"` (`alternatives_rejected`) and `source: "tournament"` (losing attempts plus the verdict rationale) |
| `conflicts` | Conflicts the intent was part of, with `decision` taken from the note's `conflict_decisions` |
| `review` | `note.review`. Otherwise the first intent or train ledger row whose kind matches `review*`, `routed*`, `route*`, `audit*`, `approved*` or `landed*`. |
| `evidence` | `{ runId, sha, status, source }`. The live run status comes from `runs`, using the note's `evidence.run_id` or else the train's `run_id`. |
| `train` | The intent's train |
| `session` | `{ repo, branch: "flare/session" }` |
| `timeline`, `warnings` | `timeline` is the intent ledger in insertion order. `warnings` lists each hop that degraded. |
| `narrative` | One paragraph: "This line exists because of the goal "…". <agent> took intent "…" because …. Decided: …. Rejected: …. Resolved a conflict with intent …: …. Verified by run … (success) on …. Landed by train … under policy auto (…). Session: …." |

**Ledger conventions the chain reads.** Other streams should write
these kinds:

- `decision`: the body is the choice.
- `alternative.rejected`: the body is the rejected option.
- `routed`, `review.*` or `landed`: the body is the policy line, and
  the actor is the reviewer.
- `tournament` or `race`: the body contains the tournament UUID, on
  the intent or the conflict subject.

**Blame.** `blameLine(repo, { ref, path, line, maxCommits?, maxBytes?,
maxEdits? }): Promise<BlameResult | BlameError>` works like this:

- **History walked.** It follows the first-parent history from
  `log({ ref, limit: 50 })`, at most 50 commits. The binding documents
  `log` as first-parent.
- **Tracking the line.** It tracks the line index through each parent
  with a bounded Myers diff, `diffLineMap`, using ≤2,000 edits (about
  16 MB worst case).
- **Size limits.** Files are capped at 256 KB. Binary files are
  refused.
- **Merges.** When a first-parent step loses the line at a merge, the
  walk dives into the merged side, where the agent commit and its
  trailers are, and records the trunk merge as `landedVia`.
- **Running out of budget.**
  - If the walk hits the commit cap, it stops and sets
    `truncated: true`.
  - If a diff goes over its edit budget, the result is flagged
    `approximate: true`.

Cost: at most 51 `readFile` calls, plus one `readCommit` per side-branch
commit.

### `apps/worker/src/session.ts`

Each intent fork carries `flare/session`, which holds two files:

- `plan.md`
- `log.jsonl`: append-only steps `{ ts, kind, text }`, where `kind` is
  one of `prompt | reason | tool | decision | note`.

Text is capped at 4,000 characters per step.

```ts
readSession(deps: { artifacts: SessionArtifacts }, forkRepo: string, opts?: { limit?: number /* 200, max 1000 */ })
  : Promise<SessionView | null>   // null = no repo or no session branch
  // SessionView { repo, branch, head: {sha, committedAt} | null, plan, planTruncated, steps, totalSteps,
  //               skippedLines, logTruncated }  — plan + log read from the same commit; bad lines counted, not fatal

forkSession(deps: { db: Db; artifacts: ForkSessionArtifacts /* env.ARTIFACTS fits */ }, input: { intentId: string; agent: string })
  : Promise<ForkSessionResult | ForgeError>
  // ForkSessionResult { forkRepo, remote, token, tokenExpiresAt, sourceRepo, branch: "flare/session", intentId }
  // errors: invalid-agent | not-found | no-session (intent never claimed) | fork-failed | token-failed
parseSessionLog(text, limit?) / formatSessionStep(step) / sessionForkName(intentId, agent, suffix)
```

`forkSession` does five things:

1. It forks the intent's fork (`i-<id>`) into
   `s-<intent12>-<agent>-<rand6>` with `defaultBranchOnly: false`, so
   the code, `flare/session` and the notes all come along.
2. It mints a 1-hour write token on the new repo. This follows
   invariant 1: the token is never for trunk.
3. It revokes the fork's own 24-hour creation token, best effort.
4. It appends `session.forked` to the intent ledger.
5. It **awaits** the fork, which takes 4–10 s (spike S3). That fits
   inside one MCP or REST call, so the caller gets a usable remote and
   doesn't have to poll.

### `packages/runner-sdk/src/provenance.ts` (agent side)

```ts
commitWithTrailers({ cwd, message, trailers?, all?, allowEmpty? }): Promise<{ sha; message }>
  // trailers default from FLARE_GOAL / FLARE_INTENT / FLARE_AGENT / FLARE_SESSION; explicit values win
appendSessionStep({ cwd, step: { kind, text, ts? }, push?: { remote? /* "origin" */ }, agent? }): Promise<{ sha; pushed }>
writeSessionPlan({ cwd, plan, push?, agent? }): Promise<{ sha; pushed }>
formatTrailers / appendTrailers / trailersFromEnv / formatSessionStep   // byte-identical to the Worker (parity test)
```

The session writers use only plumbing (`hash-object`, `mktree`,
`commit-tree`, and `update-ref` with compare-and-swap). The agent's
checkout, index and HEAD are never touched.

- **Where the session comes from.** With `push`, the writer first
  fetches the remote `flare/session`. That way a forked session
  continues from the remote copy.
- **Session writers.** Each fork has one session writer, its agent. A
  diverged remote fails the push loudly; it is never forced.
- **Git identity.** If no git identity is configured, commits fall back
  to `flare-agent <agent>`.

## Coordinator

> Provenance: agent-drafted 2026-10-10 (stream A). Behavior claims are
> covered by `coordinator-core.test.ts`, `feed-core.test.ts` and
> `forge-push.test.ts` (`npm test`, 2026-10-10). Benchmark numbers come
> from the command quoted with them.

One `RepoCoordinator` Durable Object per repo (`idFromName(repo)`,
SQLite storage, plain `DurableObject` + RPC) holds the **hot index** of
active intents: declared and actual footprints, overlap edges, leases,
counters. D1 stays the source of truth: every state change still goes
through `intents.ts` (`recordPush`, `heartbeatIntent`,
`transitionIntent`, `sendMessage`, `drainInbox`). The DO rebuilds itself
from D1 (`hydrate`) the first time it runs and every 15 minutes after
that, on its alarm. A separate `ForgeFeed` DO per repo fans live deltas
out to dashboards, so broadcasting never stalls lease traffic.

Files: `coordinator-core.ts` (pure logic over an injected `SqlStore`,
D1 `Db`, clock, embedder and publisher), `feed-core.ts` (delta
coalescing, flush schedule, wire frames), `coordinator.ts` (the two DO
classes plus the Worker-side helpers), `forge-push.ts` and
`forge-push-workflow.ts` (the push trigger). Bindings: `COORDINATOR`,
`FORGE_FEED` (DO, migration tag `forge-coordinator-v1`) and
`FORGE_PUSH` (Workflow `flare-forge-push`). The DO bindings are in both
the top-level and `previews` blocks of `wrangler.jsonc`.

Wiring: `forgeAdaptersFromEnv` (`forge-adapters.ts`) plugs the real
adapters into `forgeDepsFromEnv` for both REST and MCP — the
coordinator DO when `COORDINATOR` is bound, exact `why` and the train
port when `ARTIFACTS` is bound, the live feed when `FORGE_FEED` is
bound, and the Workers AI goal planner (`plan_goal` with `plan: true`,
`POST /v1/forge/goals?plan=1`, `flare forge goal --plan`) when `AI` is
bound. Each missing binding, and every failed adapter call, degrades to
the D1 fallback (`"source": "d1"` in snapshots) rather than a 5xx.

### RPC (`coordinatorFor(env, repo)`)

Stream B mounts these behind its auth. The facade binds `repo`, and
the DO refuses a repo other than the one it was first bound to. Every
mutating call re-arms the single alarm.

```ts
import { coordinatorFor, handleForgeFeedUpgrade } from "./coordinator";
const c = coordinatorFor(env, repo);

c.declare(intent: Intent)            // call right after intents.declareIntent (or any re-declare)
  -> { ok: true, intentId, state, overlaps: OverlapView[], truncated, similar: SimilarView[], inbox: InboxNote[] }
   | { ok: false, error: "wrong-repo", message }
c.sync(intentId)                      // after any D1 state change made elsewhere (claim, ready, trains, abandon)
  -> IntentState | null               // null = left the index (terminal / gone)
c.heartbeat(intentId, agent, ttlSeconds?)
  -> { ok: true, leaseExpiresAt, state, inbox: InboxNote[], drift: string[], overlaps: number }
   | { ok: false, error: "not-leased", message }
c.reportPush(intentId, { agent?, headSha, actualFootprint, policy?, source?: "agent" | "trigger" })
  -> { ok: true, duplicate, state, drift: string[], newOverlaps: OverlapView[], risk, riskTerms }
   | { ok: false, error: ForgeError code | "invalid-sha" | "wrong-repo", message }
c.release(intentId) -> boolean        // drop from the hot index (D1 already terminal)
c.similar(goalText, limit?) -> SimilarView[]        // [] when AI is missing or failing
c.whatsHappening(paths?: string[]) -> { items: HappeningItem[], invalid: string[], truncated }
c.snapshot({ maxIntents?, forFeed? }) -> CoordinatorSnapshot   // Live map
c.hydrate() -> { indexed, removed, edges, truncated }          // forced rebuild from D1
```

- **`OverlapView`** is `{ intentId, agent, title, reasoning (≤500
  chars), state, pairs: [{ mine, theirs }], viaActual, untrusted: true
  }`. Results are sorted by pair count and capped at 50. `title` and
  `reasoning` are another agent's words, so render them as data.
- **`InboxNote`** is `{ id, fromIntent, fromAgent, text, createdAt,
  untrusted: true }`. `text` is already framed by `labelUntrusted`.
  Draining is exactly-once (`drainInbox`).
- **Automatic notes.** When `declare` or `reportPush` creates a *new*
  overlap edge, the other intent's mailbox gets one note (at most 10
  per call), with `from_agent = "flare-coordinator"` and `from_intent`
  set to the intent that caused it. The causing agent's title is
  embedded through `labelUntrusted`.
- **`reportPush` dedupes on `(intent, sha)`.** A fork maps 1:1 to an
  intent, so this is the `(repo, after)` key. The agent's own
  `report_push` and the push trigger can both fire for the same
  commit, and the second one returns `duplicate: true` without writing.
  With no `agent`, the trigger uses the intent's owner.
- **Leases.** Only `claimed` and `working` carry a local lease. The
  alarm fires at the earliest one and re-reads D1 first, because a
  heartbeat may have gone straight to D1 through the fallback path. If
  the lease is still lapsed, it calls `transitionIntent(... "expired")`
  and re-syncs. Lease-only renewals are not published to the feed.
- **`similar`** embeds `title + reasoning` with
  `@cf/baai/bge-base-en-v1.5` (`env.AI`) at declare time. It ranks by
  cosine over the 5,000 most recent active embeddings, with a 0.6
  floor. Any failure degrades to `[]`.
- **Index mechanics.** There is one row per footprint entry, keyed by
  `globBase(entry)`. Two entries can overlap only if their literal bases
  are segment-prefix related. So a query entry with base `B` looks up
  the exact keys `"" ∪ ancestorPaths(B) ∪ {B}` (chunks of ≤90 params)
  plus the range `pathRange(B + "/")`, then confirms each candidate with
  `pathsOverlap`. There is no `LIKE`, and no statement binds more than
  100 params; the tests' SQLite adapter enforces both. A randomized
  test checks the index against a brute-force `pathsOverlap` scan.
  Scans stop at 5,000 candidates per entry and set `truncated`, and
  truncated scans never delete edges.

### Live feed (`handleForgeFeedUpgrade(request, env, repo)`)

Stream B mounts this at `GET /v1/forge/feed?repo=` after auth. It
returns 426 without `Upgrade: websocket` and 400 for an invalid repo.
Otherwise it hands the socket to the repo's `ForgeFeed` DO, which uses
hibernating sockets (`ctx.acceptWebSocket`, tag = repo), allows at most
1,000 sockets, and auto-answers `{"type":"ping"}` with `{"type":"pong"}`
without waking.

Server to client (JSON text frames):

```ts
{ v: 1, type: "snapshot", seq, snapshot: CoordinatorSnapshot }  // on connect + on resync
{ v: 1, type: "delta",    seq, ops: FeedOp[] }                  // batched, ≤10 Hz
{ v: 1, type: "error",    code, message }

FeedOp = { op: "upsert", kind: "intent",   id, ver, fields: LiveIntent }
       | { op: "remove", kind: "intent",   id, ver }
       | { op: "upsert", kind: "edge",     id: "a~b", ver, fields: LiveEdge }
       | { op: "remove", kind: "edge",     id, ver }
       | { op: "upsert", kind: "counters", id: "repo", ver, fields: LiveCounters }

LiveIntent   = { id, agent, title, state, goalId, forkRepo, headSha, paths, actual, leaseExpiresAt, risk }
LiveEdge     = { id, a, b, pairs: [{ a, b }], origin: "declared" | "actual", createdAt }
LiveCounters = { intents, agents, overlaps, overlapsCaught, pushOverlaps, driftAlerts, notesSent,
                 pushes, declared, expired, byState }
CoordinatorSnapshot = { v: 1, repo, at, ver, intents: LiveIntent[], edges: LiveEdge[], counters, truncated }
```

Client to server: `{"type":"resync"}` returns a fresh snapshot, and
`{"type":"ping"}` returns a pong.

Rules for clients:
- **`seq`** goes up by one per frame on that socket's feed. A gap means
  frames were lost, so send `resync`.
- **`ver`** is the coordinator's monotonic op version. Drop any op with
  `ver <= snapshot.ver`, and apply the rest last-writer-wins per
  `(kind, id)`.

How batching works:
- **Feed side.** The feed coalesces pending ops per `(kind, id)` in its
  own SQLite and flushes them from one alarm, at most once every 100 ms
  (no timers). Frames carry at most 500 ops. Snapshot frames are capped
  at 2,000 intents and halved until they fit in 900 KB, with
  `truncated: true` when anything was cut.
- **Coordinator side.** The coordinator publishes once per RPC call,
  through `ctx.waitUntil`. When a publish finds no listeners, it skips
  the feed for 2 s. A connecting client's snapshot request reopens it
  immediately.

### Push trigger (`ForgePushWorkflow`)

The namespace-wide `cf.artifacts.repo.pushed` event trigger
(`triggers.events` in `wrangler.jsonc`, namespace `flare-tournaments`)
targets the Workflow `flare-forge-push`. It is the **primary**
live-footprint signal, and the agent's `report_push` is the fast path
and fallback. Each event runs one durable step (3 retries, exponential
backoff):

1. **Parse** the envelope.
2. **Keep branch pushes only.** Skip `refs/notes/*`, tags, deletes and
   `refs/heads/flare/*` / `refs/heads/forge/*`.
3. **Map fork → intent** with `getIntentByFork`. Skip intents that are
   not pushable.
4. **Diff `after`** against the intent's `base_sha`, or against
   `before` (accumulated onto the known actual footprint) when there is
   no base. The tree diff is bounded: 400 tree reads and 2,000 files,
   unchanged subtrees are skipped by hash, and past the budget a
   directory path stands in for its files.
5. **Compact** the result to ≤200 entries by collapsing the deepest
   paths into their parents.
6. **Call `reportPush`** on the trunk repo's coordinator with
   `source: "trigger"`.

The trigger is configured only at the top level. Previews share the
`flare-tournaments` namespace, so a preview trigger would also consume
production pushes. Workflow names are also account-global.

### Benchmark: index at 100k intents

`coordinator-core.bench.test.ts` sends N synthetic intents through the
declare path (`indexUpsert` + `recomputeEdges`) into node:sqlite, using
the same SQL the DO runs. It then times fresh overlap queries. The
workload is 20 packages × 50 modules × 100 files. Each intent has 1–3
entries: 90% files, 5% module directories and 5% `*.ts` globs.

Measured with `FORGE_BENCH=1 npx vitest run
apps/worker/src/coordinator-core.bench.test.ts --silent=false` on
2026-10-10 (Apple M4, Node v24.12.0, one run). Size can be overridden
with `FORGE_BENCH_N=<n>`.

| Intents | Path rows | Overlap edges | Query p50 | Query p99 | Avg overlaps / query | Declare p50 | Declare p99 | Declares/s (incl. edges) |
|---|---|---|---|---|---|---|---|---|
| 10,000 | 20,147 | 40,123 | 0.065 ms | 0.229 ms | 7.7 | 0.156 ms | 0.856 ms | 4,842 |
| 20,000 | 40,210 | 159,567 | 0.075 ms | 0.258 ms | 15.8 | 0.156 ms | 1.163 ms | 4,391 |
| **100,000** | 199,784 | 3,963,315 | **0.192 ms** | **1.082 ms** | 76.7 | 0.836 ms | 20.9 ms | 402 |

How to read the table:
- **Queries cost about O(overlap).** Average candidates per query track
  average hits almost exactly (76.8 vs 76.7 at 100k), so the range
  index reads almost nothing that doesn't overlap.
- **Declares at 100k are dominated by edge writes, not lookups.** This
  workload packs 200 intents into each of 1,000 modules, and a
  directory or glob intent overlaps the whole module. That gives ~4M
  edges. The p99 of 21 ms and the worst single declare of 481 ms are
  directory intents that write ~200 edges at once. A 100k crowd in a
  100k-file repo is a stress case, and this is where `LeaseShard`
  pays off.
- **A full edge rebuild is the expensive path.** Building from empty
  took 249 s at 100k. That is more than a DO's CPU budget, so `hydrate`
  is incremental: it recomputes edges only for intents that are new or
  whose footprints changed. Only a wiped DO pays for a full rebuild,
  and at that scale it should run sharded.

These numbers are for the index alone: node:sqlite in-process on the
dev machine. They do not include the DO RPC hop or the D1 write that
`declare` and `reportPush` also make, which dominate end-to-end
latency. `npm test` runs a 5k-intent smoke version of the same test,
which fails if p50 query latency goes above 20 ms (an O(n) scan
regression).

### Scaling: `LeaseShard` (designed, not wired)

One coordinator per repo is the shipping design.

**When to shard.** Shard a repo when either of these holds:
- **Request rate.** Measured coordinator traffic stays above
  ~500 req/s per repo. A DO's soft limit is ~1k req/s, so 10k agents
  heartbeating every 10 s would need batching or a 60 s TTL even before
  sharding.
- **Index size.** The path index grows past ~1M rows. Rebuild
  (`hydrate`) cost grows linearly with it.

**Design.** `LeaseShard` DOs are named `${repo}#${bucket}`:
- **Routing.** `shardBucket(entry, K)` (in `coordinator-core.ts`,
  tested) hashes the first literal segment of the entry's glob base, so
  a top-level directory and every range query under it stay in one
  shard. Entries with no literal base (leading `**`/`*`) return `"all"`
  and fan out.
- **What moves to shards.** Each shard owns `fc_paths` rows, edges
  local to its buckets, and the leases of intents whose first entry
  routes to it, so heartbeats spread across shards.
- **What stays in the coordinator.** It becomes the router. It keeps
  intent rows, the mailbox and feed fan-out, and the cross-shard edge
  merge. Overlap queries fan out only to the shards their entries route
  to, which is usually one.
- **Shard RPC.** The surface is the `LeaseShardApi` interface: `index`,
  `remove`, `overlaps`, `heartbeat`, `dueLeases`.

**Moving between modes.** Hydrate the shards from D1 like the
coordinator does today. Then flip a per-repo `shards` meta key, which
the router reads on each call. Going back to one DO is a re-hydrate.

## Trains and conflicts

> Provenance: agent-drafted 2026-10-10 (trains stream). The behavior
> described here is covered by `train-core.test.ts`, `train.test.ts`
> and `replay.test.ts` (`npm test`, 2026-10-10). The end-to-end tests
> run isomorphic-git and MemoryFS against real bare repos, served
> in-process by `git http-backend` with no network. The timings were
> measured in those tests on a laptop, not against Artifacts.

### Model

- **One train group per repo at a time.**
  - `cutTrain` orders ready intents by priority, then by oldest ready,
    then by id.
  - It takes at most `lanes.max_per_train` of them.
  - It splits them into lanes whose footprints don't overlap: at most
    `min(lanes.max_parallel, 8)` lanes.
- **Stacked lanes.**
  - Lane *i* is built on lane *i−1*'s head.
  - Each lane head gets its own CI run on that exact SHA, so the runs
    happen in parallel.
  - If lane *i* is green, the whole prefix through *i* is green as one
    SHA.
  - The longest green prefix lands with one non-force push of `main`,
    a compare-and-swap against the cut's base.
  - The first red lane is bisected. Lanes stacked behind it go back to
    the queue without blame.
- **Bisect.**
  - The red lane splits into two child trains (`parent_train_id`), with
    the left half stacked under the right half.
  - Left red: recurse into the left half and requeue the right half.
  - Left green and right red: land the left half and recurse into the
    right half.
  - A red lane with a single intent is the culprit. That intent goes to
    `failed`, and a `culprit` ledger row records the evidence.
  - Bisection takes at most ⌈log₂ n⌉ rounds.
- **Lane refs.**
  - Lanes use the fixed refs `forge/lane-0..7` and force-update them for
    each train. Spike S5 found that pushing a *new* ref from
    isomorphic-git uploads the whole history.
  - Create the lane refs once, when the repo is bootstrapped.
  - `main` is never force-pushed.
- **CI dispatch.**
  - Lane runs use event `artifacts`, so seats check out the Artifacts
    remote.
  - They run as agent `forge-train` at priority 8.
  - The train claims the `(repo, sha)` delivery before it pushes, so the
    push trigger doesn't start a duplicate run.
- **Squashed commits.**
  - Each intent lands as one commit: its title, a summary of its
    reasoning, and `Flare-*` trailers.
  - Commit timestamps come from the train row, so a retried build
    reproduces the same SHAs.
- **Routing.**
  - `enqueueReady` re-scores the intent's risk and routes it.
  - Intents routed `human` stay out of trains until `approveLanding`
    is called.
  - On landing, a `routed` ledger row is written *before* the `landed`
    transition. Its body is the policy line, for example
    `risk 12 <= 30 → auto (...)`.
- **After landing.**
  - Why notes are written through `createWhyNotesWriter`
    (`provenance.writeWhyNotes`), and `recordNotesTip` records the tip.
  - Tokens on the landed intent's fork are revoked, which leaves a
    `tokens_revoked` ledger row.
- **Conflicts.**
  - A textual conflict drops the intent from the train
    (`in_train → conflicted`) and opens a Conflict.
  - `intent_a` is the dropped intent.
  - `intent_b` is the intent whose footprint covers the conflicting
    files, or `"trunk"` if none does.
- **Replay** (`replay.ts`).
  - Replay waits until the other side of the conflict lands. If the
    other side fails instead, the dropped intent goes back to the queue
    unchanged.
  - The owner is always notified through the mailbox.
  - What happens next depends on policy and on whether AI is available:
    - **`auto`:** diff3 merges the clean hunks and Workers AI resolves
      the conflicting ones. The result is committed on fork
      `r-<conflict>-<n>` and re-enters the queue as ready, with the
      `llm_replay` risk term.
    - **`race`** (`race_k > 1`): a tournament with
      `baseRef: forge/replay` and a pre-filed `promote-failed` stop row.
      `pollRaces` picks up the CI-verified winner.
    - **`notify`:** the owner replays the intent and calls
      `resolveConflictFor`.
  - Every path lands only through a train (invariant 4).

### TrainPort (`train.ts`; wiring in `train-workflow.ts`)

```ts
enqueueReady(deps, intentId, { cut? }): Promise<EnqueueResult | ForgeError>   // {risk, riskTerms, route, held, cut}
approveLanding(deps, intentId, approvedBy): Promise<boolean>                  // human route -> may ride trains
cutTrain(deps, repo): Promise<CutResult>         // cut | busy | idle | unavailable | no-pipeline | invalid-repo
listTrains(deps, repo, { state?, limit? }): Promise<Train[]>
getTrainDetail(deps, id): Promise<TrainDetail | null>  // lane intents (+squashed commit), CI run, bisect subtree, ledger
claimConflictFor(deps, conflictId, agent): Promise<{ conflict, intent } | ForgeError>
resolveConflictFor(deps, conflictId, agent, sha, { forkRepo?, llmReplay? })
  : Promise<{ conflict, enqueue } | ForgeError>
buildTrains / dispatchTrains / checkTrains / writeNotes / revokeLandedTokens / advanceRepo  // idempotent steps
runTrainTick(env)        // train-workflow.ts: cron fallback; also cuts and launches the Workflow
replayTick(deps, repo)   // replay.ts: start replays, finalize races
trainDepsFromEnv(env)    // production deps (isomorphic-git, MemoryFS, ARTIFACTS, AI, notes writer)
```

`TrainWorkflow` (binding `TRAIN_WORKFLOW`) runs these durable steps in
order:

1. policy
2. build
3. check, polling with a `step.sleep` backoff from 10 s up to 2 min, at
   most 40 polls
4. notes
5. revoke
6. replays
7. cut the next round

The number of rounds is capped at ⌈log₂ max_per_train⌉ + 5.

### Measured (tests, 2026-10-10)

- **3-lane build:** about 1.2 s. That covers one trunk fetch, 3 fork
  fetches, 3 merges and 3 lane pushes.
- **One lane:** 130–160 ms for the fork fetch plus the merge.
- **Lane with a conflict:** about 0.3 s for one merge plus detecting
  one conflict.
- Every number includes spawning a `git http-backend` process for each
  HTTP request.

## Spectator mode

> Provenance: agent-drafted 2026-10-10 (spectator stream). Verified by
> `npx vitest run apps/worker/src/forge-public.test.ts` (16 tests:
> off-by-default 404s, undesignated repos and out-of-scope ids 404, every
> write method on every write-shaped path 404/405 with the intents table
> unchanged, no token/email/credential shapes in any public response or
> MCP tool result, per-IP limits, feed header stripping, judge-token
> scope + expiry) and `npx vitest run apps/sim/src/demo/loop.test.ts`
> (9 tests, fakes for the API, git and Artifacts; every reference
> solution applied to the real Bookshelf tree). Not yet run against a
> deployed Worker or real Artifacts.

Judges will not clone, install, or log in. Spectator mode gives them one
public URL with the real live map, a swarm already moving, and a one-line
way for their own Claude Code to ask questions about it.

### Enable it

```sh
# 1. Designate the showcase repo (admin token or admin session).
curl -X POST "$FLARE_ACTIONS_URL/v1/admin/forge/public" \
  -H "Authorization: Bearer $FLARE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"repos":["bookshelf"]}'
# 2. Open the page. No login.
open "$FLARE_ACTIONS_URL/watch?repo=bookshelf"
```

The setting is D1 `app_settings.forge_public_repos` (a JSON list of
Artifacts repo names, at most 10). Empty or unset means off, and every
route below answers 404. `GET /v1/admin/forge/public` reads it back. An
invalid entry is dropped, so a typo can only hide a repo, never widen the
scope. Turning it off is `{"repos":[]}`.

### Endpoints (`apps/worker/src/forge-public.ts`)

| Route | What |
|---|---|
| `GET /watch?repo=` | The dashboard HTML with `<meta name="flare-public" content="<repo>">` and `<meta name="flare-public-api" content="/v1/public/forge">` injected after `<head>` |
| `GET /v1/public/forge` | Index: designated repos, endpoint list, join info |
| `GET /v1/public/forge/join` | Watch URLs, the read-only MCP one-liner, and how to get a write token |
| `GET /v1/public/forge/{snapshot,live,inbox,goals,intents,trains,conflicts,why,whats-happening}?repo=` | The same payloads as `/v1/forge/*`, sanitized |
| `GET /v1/public/forge/{goals,intents,trains,conflicts}/:id` | Detail views, sanitized (intent detail has no mailbox) |
| `GET /v1/public/forge/feed?repo=` | Live map WebSocket. Same frames as `/v1/forge/feed`. Only the handshake headers are forwarded, so cookies and `Authorization` never reach the feed DO |
| `GET\|POST /v1/public/forge/mcp` | Read-only MCP over Streamable HTTP: `forge_snapshot`, `whats_happening`, `why`, `read_inbox` (repo inbox only). No auth |
| `GET\|POST /v1/admin/forge/public` | Admin: read or set the designated repos |
| `POST /v1/admin/forge/judge-token` | Admin: mint a sandbox-only runner token (below) |

Every public read calls the shared forge-service op with a synthetic
principal: `canWrite: false`, `isAdmin: false`, `repos` = exactly the
designated `<namespace>/<repo>` keys (never `[]`, which would mean every
repo). Collection routes check the repo against the list first; detail
routes rely on the op's own scope check. Either way an undesignated repo
or id answers `404 forge_not_found`, never 403, so there is no existence
oracle.

Responses go through `publicView`:
- It drops `token`, `readToken`, `forkToken`, `remote`, `forkRemote`, every
  `*Command`, `commitTemplate`, `mailbox`, `messages`, `inbox`, and
  `nextSteps`.
- `planApprovedBy` becomes `"operator"`, and so does any `actor` that is
  not an agent slug (`email:…`, `github:…` and `token:…` all become
  `"operator"`).
- It redacts Artifacts tokens, 64-hex strings (Flare API tokens), emails,
  URL credentials, and `Bearer`/`Basic` values inside any text.
- It rewrites `links.self` deep links from `/v1/forge/` to
  `/v1/public/forge/`.

Headers: `Cache-Control: public, max-age=2, s-maxage=2,
stale-while-revalidate=10`, `Access-Control-Allow-Origin: *`, and
`X-Flare-Public: read-only`. Successful GETs also go through
`caches.default` for 2 s, keyed on the URL only. A burst of spectators
therefore collapses onto one D1 read per colo.

Rate limits are per hashed client IP, per minute: 120 reads, 60 MCP
calls, and 10 feed connects. They are counted in a bounded per-isolate
map, so they cost no D1 write per read. For limits that hold across
isolates, add a [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
binding named `FORGE_PUBLIC_RATE_LIMITER`. When it is bound, both limits
must allow the request. Over the limit, the answer is `429 rate_limited`.

### What the dashboard client must do (UX stream)

The server side is done. The dashboard files belong to the UX stream, so
these client hooks are not implemented yet:

1. **Detect public mode.** Read
   `document.querySelector('meta[name="flare-public"]')?.content`. A
   non-empty value is the repo, and the page is in public mode. Also read
   `meta[name="flare-public-api"]` (always `/v1/public/forge`).
2. **Skip auth entirely,** the way `?demo=1` does today. Do not call
   `/v1/admin/status`. Do not show the login screen. Use
   `fetch(..., { credentials: "omit" })`.
3. **Rewrite Forge reads** from `/v1/forge/<x>` to `/v1/public/forge/<x>`.
   That covers snapshot/live, inbox, goals (+ `:id`), intents (+ `:id`),
   trains (+ `:id`), conflicts (+ `:id`), why, whats-happening, and the
   `feed` WebSocket (`wss://<host>/v1/public/forge/feed?repo=`). Pin the
   repo picker to the meta repo.
4. **Hide every write affordance:** Composer / plan goal, approve plan,
   abandon, claim/resolve, Settings, Access, and the Runs and Agents tabs
   (they would 401). Also hide Bench unless `/v1/forge/bench` gets a
   public twin.
5. **Never fall back to fixtures in public mode.** A 404 means the repo
   was un-designated, so show "This demo is offline". A 429 means back
   off and retry with jitter.
6. **Add a banner:** "Watching `<repo>` live (read-only)". Add a "Ask
   your Claude Code" button that shows `mcp.claudeCode` from
   `GET /v1/public/forge/join` with a copy button.
7. **Expect missing fields.** Intent detail has no `mailbox` and no
   `nextSteps`. `planApprovedBy` is `"operator"`. Fork remotes are gone,
   but `forkRepo` names stay.

### Judge join paths

**Read (public, one line, no token):**

```sh
claude mcp add --transport http flare-forge-watch https://<worker>/v1/public/forge/mcp
# then ask: "what are the agents doing in bookshelf right now?",
#           "why does line 12 of src/middleware/logging.ts exist?"
```

**Write (private, per judge):**

```sh
curl -X POST "$FLARE_ACTIONS_URL/v1/admin/forge/judge-token" \
  -H "Authorization: Bearer $FLARE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"judge-a","ttlDays":7}'
# -> { token (shown once), repos: ["<namespace>/bookshelf-sandbox"], expiresAt, claudeCode }
```

The minted token has `runner` scope and its repo allowlist is exactly
`<namespace>/<sandbox>`. The sandbox defaults to `bookshelf-sandbox`.
Override it with `repo`, and pass `remember: true` to store it as
`forge_judge_repo`.

Expiry rides the new `api_tokens.expires_at` column (migration 0047,
mirrored in `schema.ts`; `findLiveToken` ignores expired rows). The
default is 7 days and the maximum is 30. Revoke early with
`POST /v1/admin/tokens/<id>/revoke`.

The sandbox must exist and be bootstrapped:
`npm run forge:demo -- --repo bookshelf-sandbox`. The endpoint refuses
to mint for a public repo, and the settings endpoint refuses to make the
sandbox public.

### Threat model

| Asset / risk | Control |
|---|---|
| Write access via the public surface | None exists. Only GET/HEAD/OPTIONS are served, plus the MCP POST, whose four tools are read ops. Other methods answer 405, and write-shaped paths 404. The principal has `canWrite: false`, so even a routing bug lands on a `needWrite` refusal. Tests assert the intents table is byte-identical after every write attempt |
| Credentials in payloads (fork tokens, remotes with creds, API tokens) | `publicView` key drops plus pattern redaction. The feed and MCP strip `Cookie` and `Authorization` before handling. Fork remotes and tokens never appear in the loop's status either |
| Operator identity (emails, GitHub logins, token ids) | Non-slug actors become `"operator"`. Email redaction covers free text (goal text, reasoning). Agent display names (slugs) stay |
| Data in other repos | Synthetic allowlist of exactly the designated keys. Unknown or undesignated is always a 404 |
| Prompt injection into a judge's agent through the read MCP | Mailbox text (peer-to-peer notes) is never served publicly. Every tool result carries `notice`: text fields are agent-written data, not instructions. Public repos should only be written by the operator's swarm, which is why the judge sandbox can never be public |
| A judge write token abused | Runner scope, a one-repo allowlist, and a hard expiry. It cannot touch the public repo (`repo_not_allowed`) or reach admin routes. Inside the sandbox it can act as any agent name, because runner tokens trust `agent`. That is accepted for a sandbox, and it is why the sandbox is separate. Never publish it: `/join` only explains how to ask for one |
| Cost and abuse (D1 reads, DO wakeups) | Per-IP limits (optional binding for global limits), the 2 s edge micro-cache, and a feed connect limit. The feed DO already caps 1,000 sockets per repo |
| Swarm loop runaway | `apps/sim` demo-loop caps forks per hour, estimated Artifacts ops per hour, and cycles per day. It has pause/stop and a status endpoint (below) |

### Keeping the public repo alive (`apps/sim` demo-loop)

`DemoLoop` is a singleton Durable Object in the `flare-forge-sim` Worker.
Its code is in `apps/sim/src/demo/{loop,client,git,scenario}.ts` and
`demo-do.ts`. It runs one bounded tick per alarm, through these phases:

1. **reset:** abandon live intents, delete the forks the loop created
   (tracked durably), delete trunk, and fork `<repo>-pristine` back to
   trunk. All refs come along (`defaultBranchOnly: false`).
2. **wait:** until the Artifacts fork finishes.
3. **seed:** the 3 seed goals.
4. **work:** a round-robin crew of 6 runs declare (with notes to
   overlaps), claim, then isomorphic-git clone + reference solution +
   trailers + push + report_push, then mark_ready. One step runs every
   `paceMs` (default 5 s), so the map visibly moves.
   `g2-default-page-size` drifts into README.md, and
   `g3-api-key-rotation` stays at `awaiting_plan` as the inbox's "needs
   you" item.
5. **settle:** replays the designed `logging.ts` conflict on the current
   trunk and resolves it, then waits for trains to land (up to
   `settleMaxMs`, default 20 min).
6. **hold:** shows the finished map for `holdMs` (default 5 min), then
   loops back to reset.

On the first start, if `<repo>-pristine` does not exist, the loop
snapshots the freshly bootstrapped trunk into it instead of resetting.

**VERIFY on staging:**
- Whether an Artifacts fork carries `refs/notes/why`. If it does not,
  `why` answers in footprint mode until the next landing writes notes.
  Fallback: run `npm run forge:director -- reset` from a box on a timer.
- That trains advance on the target deployment, which needs the cron
  plus CI capacity.

```sh
# one-time: bootstrap the public trunk, then configure the sim worker
npm run forge:demo -- --repo bookshelf
#  apps/sim/wrangler.jsonc: add { "binding": "DEMO_ARTIFACTS", "namespace": "<Forge ARTIFACTS_NAMESPACE>" }
printf %s "$RUNNER_TOKEN_PINNED_TO_BOOKSHELF" | npx wrangler secret put DEMO_FORGE_TOKEN -c apps/sim/wrangler.jsonc
#  (FORGE_URL var, SIM_ADMIN_TOKEN secret as in docs/FORGE-BENCH.md)
npx wrangler deploy -c apps/sim/wrangler.jsonc
curl -X POST "$SIM_URL/demo-loop/start" -H "Authorization: Bearer $SIM_ADMIN_TOKEN" \
  -d '{"repo":"bookshelf","paceMs":5000,"holdMs":300000,"maxForksPerHour":40}'
curl "$SIM_URL/demo-loop" -H "Authorization: Bearer $SIM_ADMIN_TOKEN"     # status
curl -X POST "$SIM_URL/demo-loop/pause"  -H "Authorization: Bearer $SIM_ADMIN_TOKEN"   # or resume | stop | reset
```

`GET /demo-loop` returns the phase, cycle, per-intent steps, counters,
budget use (`forksThisHour`, `artifactsOpsThisHour`, `cyclesToday`) and
the last 15 log lines. With `PUBLIC_RESULTS=true` it is readable without
the admin token, and it never contains fork credentials.

Mint `DEMO_FORGE_TOKEN` as a runner token with
`repos: ["<namespace>/bookshelf"]`, so the loop can only ever write the
public repo. The ops counter is an estimate per call (claim = 2, clone +
push = 2, replay = 4, reset ≈ 2 + forks). It is a guard rail, not
billing.
