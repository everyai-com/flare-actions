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
