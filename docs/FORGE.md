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
