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
