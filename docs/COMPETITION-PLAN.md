# Flare Forge: the plan to win "Build the next GitHub"

> Provenance: agent-drafted 2026-10-10, revision 2.
> - Rules are quoted from the official terms PDF
>   (`cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf`,
>   fetched 2026-10-10).
> - Platform limits come from the developers.cloudflare.com docs for
>   Artifacts, Durable Objects, Workers, Queues and Containers (fetched
>   2026-10-10).
> - Competitor repos were verified with `gh api repos/<r>` on 2026-10-10.
> - Code facts come from a read-only audit of this repo at `9354446`.
> - **VERIFY** marks undocumented behavior that must be spiked before we
>   build on it.
> - Every number we show judges must come from a measured run. No
>   projected numbers on screen without the word "projected".

---

## Status board (integration branch `feat/forge-intents`)

| Area | State | Notes |
|---|---|---|
| Day 0 spikes S1–S6 | ✅ | See §8.2. Extra finding: Artifacts can't resolve `refs/notes/*` by name, so the train records the notes tip sha |
| Audit bug fixes (6 + 5 extra scope leaks) | ✅ merged | |
| Foundation: schema 0045, `intents-core`, `intents` | ✅ merged | |
| Demo repo `examples/forge-demo` | ✅ merged | 25/25 designed scenarios verified |
| Provenance: blame, why chain, sessions, notes | ✅ merged | |
| Coordinator DO, live feed, push-trigger Workflow | ✅ merged | Index-only bench at 100k intents: query p50 0.19 ms, p99 1.1 ms |
| API: REST, MCP (14 tools), SDK, CLI, agent docs, skill | ✅ merged | |
| Trains (stacked lanes, exact-SHA CI, bisect), conflict replay, races | ✅ merged | |
| Simulator and load harness, benchmark doc | ✅ merged | Simulated: ~74× time-to-80% vs serial queue, −72% human minutes at 10k |
| Dashboard (Live, Inbox, Intent, Train, Conflict, Why, Composer, Bench, Agents) | ✅ merged | Fixture fallback; needs signed-in check against the real API |
| Everything above on `main` | ✅ PR #12, #13 | Includes adapter wiring and the AI planner (`e59a63c`, verified on `wrangler dev`: coordinator snapshot, feed returns 101) |
| Dogfood CI, seat sizing, Easy mode (guided Home, one-line runner) | ✅ PR #14–17 | Merged by parallel sessions |
| Wiring extras: index sync, train conflict ports, approve-landing, session routes, `/llms.txt`, audit dedupe, dashboard↔API contract | 🔄 in progress | Server-side only |
| Speculative stacked trains + honest benchmark rerun | 🔄 in progress | Fixes the throughput plateau the sim exposed at ≥10k agents |
| `forge:demo`, `forge:agents`, `forge:director`, DEMO.md | 🔄 in progress | |
| UX polish (demo-link redirect, judge CTA, master–detail lists, hot-cell sizing, agent rail, guided tour) | ✅ merged | From the integrator's hands-on review, 2026-10-10 |
| Adversarial review of the whole branch | 🔄 in progress | Findings will be fixed before staging |
| Demo tooling: `forge:demo`, `forge:agents`, `forge:director`, DEMO.md | ✅ merged | Dry-run verified. First live run happens on staging, never prod |
| Review fixes: 2 critical, 6 high, 8 medium, 4 low | 🔄 partly merged | Hardening set (#3, #4, #5, #10, #14, #15, #17, #19, #20) merged. Service (#1, #2, #7, #8, #9, #16) and train (#6, #11–#13) fixes in flight |
| **Judge instance**: public read-only spectator view, swarm loop, read-only public MCP | 🔄 in progress | From the strategic review: the single URL that serves all three criteria |
| **Forge-first identity**: README, fold Tournaments into "resolution races", retire old video scripts | ✅ merged | |
| Publishable CLI (`npx flare-forge`), `cli forge init` scaffolding (AGENTS.md + `.mcp.json`) | ✅ merged | **User** runs `npm login && npm publish --workspace apps/cli`. Note: npm `flare` is an unrelated package, so docs now say `npx flare-forge` |
| Staging deploy and live run with real Claude Code agents | ⏳ next | First measured number: the baseline-vs-Forge table at 1k |
| Cold-start check (8.6 s first hit observed on staging) | ⏳ | Measure after staging deploy |
| Dogfooding: mirror this repo into Artifacts and run `flare why` on a line of Forge itself | ⏳ after staging | |
| GitHub bridge: mirror a GitHub repo in, land back out as a PR or push | ⏳ post-submission adoption wedge | Mirror-in already exists (`artifacts-mirrors.ts`) |
| User actions | ⏳ | GitHub repo description to Forge-first (needs your OK), `npm publish`, MCP registry submission, eligibility email |
| README "start here", video, submission | ⏳ Mon Oct 13 | Varun to confirm eligibility (student status vs "legal resident") with git-competition@cloudflare.com |

**How work lands now.** Each stream works on its own branch, which merges into `feat/forge-intents`. That branch goes to `main` by PR, which is also how the parallel sessions on other accounts land their work. Every branch rebases on `origin/main` before its PR.

### Updated roadmap (from Fri Oct 10 evening)

| When (PDT) | Milestone | Exit criteria |
|---|---|---|
| Fri night | **Integration complete.** Wiring extras, speculative trains, demo tooling, UX polish, and review fixes are all merged to `main` | All gates green. Signed-in dashboard renders real data on `wrangler dev` with no fixture fallback |
| Sat AM | **Staging live.** `npm run setup` on staging, `forge:demo` bootstraps the Bookshelf trunk (lane refs + notes ref), and the namespace push trigger is subscribed | A scripted run lands all 13 intents: the conflict is replayed, the semantic red is bisected, and the protected intent waits for plan approval. Main never red |
| Sat PM | **Real agents.** 6 real Claude Code agents via `forge:agents --mode real` against staging | At least 1 goal landed end to end by real agents. Transcript and timings recorded |
| Sat night | **Live load numbers.** `apps/sim` harness: 100k coordination-only and 1k → 10k full-git | Measured table in `FORGE-BENCH.md` (provenance line). Artifacts ops and $ captured |
| Sun | **Hardening.** Fix everything Saturday surfaced. Measure seat CI wall time (S7). Director stages 1–6 are reliable, three clean rehearsals in a row | Every video beat reproducible within 60 s |
| Sun night | **Docs.** README "start here", `DEMO.md`, `FORGE.md`, `FORGE-AGENTS.md`, refreshed bench, and the ROADMAP non-goal reconciled | A fresh person goes from clone to a dashboard with demo data in under 5 min |
| Mon 14:00 | **Freeze.** Fresh-account dry run of the judge path | Passes untouched |
| Mon PM | **Video:** record, edit, caption (§9) | 8–9 min, numbers measured or labelled |
| Mon 23:00 | **Submit by hand**, screenshot the confirmation | ✅ |
| Oct 15–21 | **Finals prep.** Hosted demo hardened, Q&A drills, the stage fallback rehearsed offline | Ready for Moscone, Oct 21 |

---

## 0. The whole plan on one page

**Thesis.** When agents write the code, the code is cheap and can be
regenerated. The scarce things are **human attention**, **trunk
throughput**, and **trust**. So the durable unit of collaboration is no
longer the diff. It is the **Intent**: what an agent is about to change,
where, and why, plus the evidence that it worked.

**The one idea judges will remember:**

> **Intent is the unit.** One record answers all four of Cloudflare's
> questions:
> - **Who's doing what?** Query intents by footprint.
> - **Conflicts?** Merge *intents* by replaying them, not hunks.
> - **Human review?** Review intents and evidence, not diffs.
> - **Why?** The intent *is* the history.

**What we ship:** Flare Forge, an intent-native git platform on Workers
and Artifacts. Any agent can use it (Claude Code, Codex, Cursor or a
script) through plain `git` plus MCP. Changes integrate through
CI-verified **trains**, so `main` is never red. Humans spend their time
on about 2% of changes, chosen by risk, and every line can answer
`flare why`.

**Why we win:**
1. **We're the only entry with a real CI and execution engine.** Others
   "verify" with a model.
2. **We already have** fork-per-agent tournaments, a merge queue, an MCP
   server, a dashboard and container seats.
3. **One unifying primitive** instead of a feature list.
4. **A measured scale demo with a baseline comparison.** Nobody else
   shows numbers against a baseline.

**How we execute:**
- A **walking skeleton** (thin end to end) by Saturday noon, then deepen.
- **Feature freeze Monday 14:00.**
- **Submit Monday night.**
- From Oct 15 to 21, harden for the live finals.

---

## 1. Rules and scoring, read precisely

| | |
|---|---|
| Deadline | **Oct 14, 11:59 PM PDT.** Our internal deadline is **Mon Oct 13, 23:00 PDT**. |
| What to submit | A 5–10 min video, the repo with a LICENSE (MIT ✅, public ✅), and run instructions |
| Hard requirement | Use **Workers and Artifacts**, and enable **multiple agents working on changes concurrently** |
| Eligibility | **A legal US/Canada resident, 18+.** One submission per entrant, entered by hand. The winner must be **in person at Connect, Oct 21** |
| Finals | Three finalists, announced Oct 16. Each gets **10 minutes live on stage** at Moscone West |
| Content | No attacks on competitor products. GitHub is the respected incumbent, never the punchline |

**Scoring (each criterion scored 1–5, with weights):**

| Weight | Criterion (verbatim) | What a 5 looks like | Our evidence |
|---|---|---|---|
| **50%** | "originality and quality of the prototype for agent-oriented software collaboration" (also the **tie-breaker**) | A new mental model, not GitHub plus agents. Works end to end, and the code is clean. | "Intent is the unit", replay-merge, trains, tests, clean architecture |
| 25% | "effectiveness of multi-agent concurrency, coordination, context preservation, review, and conflict handling" | All five shown live, with numbers | A baseline benchmark, a live map, conflict replay, session forks, the inbox |
| 25% | "ease of use and product/user experience" | A judge tries it in 2 minutes | A hosted read-only instance, `npm run forge:demo`, any agent via MCP |

Every hour of work should move one of these three numbers. If a task
doesn't, cut it.

---

## 2. First principles: what changes when the writers are agents

GitHub's model rests on assumptions that were true for human teams. List
them, check each against agents, and see what the design has to become.

| # | Human-era assumption | Agent-era reality | Design consequence |
|---|---|---|---|
| A1 | Writers are scarce and slow (a few PRs per person per day) | Writers are abundant and fast: thousands of changes per hour | **Integration becomes the bottleneck**, not authoring. Trunk must absorb changes in batches with parallel lanes. |
| A2 | Code is expensive, so preserve the diff | Code is cheap and **regenerable from the intent** | The durable artifact is **intent plus evidence**. The diff is a derived cache, so conflicts can be resolved by *re-deriving* the change. |
| A3 | Writers remember their context | Agents are stateless between sessions | Context must be a **first-class, forkable object**: a session repo per intent. |
| A4 | Coordination happens socially (standups, Slack) | Each agent must be told explicitly. Broadcasting to everyone is O(n²) and floods context | Coordination must be **local**. An agent learns only about the few intents whose footprint overlaps its own, which costs O(overlap), not O(n). |
| A5 | Review is the quality gate, and attention is affordable | Human attention is the **scarcest resource** in the system | Review must be **routed by risk**, done at the **plan** stage, and **compressed** into stories. Everything else is gated by evidence and audited by sampling. |
| A6 | Trust comes from *who* wrote it | Authorship tells you little about an agent's quality | Trust comes from **verifiable evidence**: CI on the exact combined commit, provenance and attestations. |
| A7 | Conflicts are rare and the author fixes them | Conflicts are constant at scale, and the author may be gone | Conflicts are **first-class work items** that any agent can claim, resolved with both intents in context. |
| A8 | The "why" lives in heads and PR threads | Agents can't be asked later | The "why" is **captured at the moment of intent, machine-readable, attached to the commits**, and queryable per line. |

**Three conclusions.** These are the backbone of the pitch:

1. **Optimize for the two scarce resources:** trunk serialization (A1)
   and human attention (A5). Everything else is cheap.
2. **Make intent the primary key of the system** (A2, A3, A7, A8). Code
   hangs off intents, not the other way around.
3. **Locality scales coordination** (A4). You don't need to know what
   100k agents are doing, only the 3 whose work touches yours.

**What this rules out.** It also makes good Q&A answers:
- **Hard locks.** Cursor's 2026 experience: 20 agents behind locks
  produced the throughput of 2–3.
- **One shared repo with agents pushing branches.** Artifacts limits git
  traffic to 2,000 requests per 10 s *per repo*.
- **One-at-a-time merge queues.** A ref compare-and-swap serializes
  merges at about 1 per second, which is 3 hours for 10k changes.
- **LLM-only conflict resolution.** The best models resolve fewer than
  60% of real conflict hunks (Merge-Bench, ICPR 2026).
- **An AI reviewer as the gate.** Public benchmarks put recall at about
  40–70%.

---

## 3. The product, specified

### 3.1 The primitives

| Primitive | Replaces | What it is |
|---|---|---|
| **Goal** | Issue / epic | The human's request in their own words. Owns N intents. Every line traces back to one. |
| **Intent** | Branch + PR | A declared unit of change. Fields: goal, title, **reasoning**, **footprint** (paths, plus entities later), **acceptance check**, risk, and state. Owns one Artifacts **fork**, `i-<id>`, which contains the code *and* a `flare/session` branch holding the plan, step log and decisions. |
| **Lease** | (nothing) | The intent's advisory claim on its footprint. Has a TTL, is renewed by heartbeat, and is **never blocking**. |
| **Train** | Merge queue + rebase | A batch of ready intents, split into **lanes** of non-overlapping footprints. Merged onto trunk, verified by CI **as that exact combined SHA**, then fast-forwarded. A failing train is bisected. |
| **Conflict** | A blocked merge plus a "please rebase" comment | A claimable work item with both intents' goals, reasoning and diffs. Resolved by **replay**: the intent is re-derived on the new trunk, and it must pass CI. |
| **Story** | PR list | The review unit: a goal's intents with their evidence, risk-sorted, showing the policy decision on each. |
| **Why record** | Commit message + PR thread | Two layers: trailers on every agent commit (`Flare-Goal/Intent/Agent/Session`), and a `refs/notes/why` JSON on every trunk commit, written by the train. Readable per line with `flare why`. |

### 3.2 Intent lifecycle

```
draft ──(policy: protected path)──► awaiting_plan ──(human approves)──┐
  │                                                                   ▼
  └──────────────────────────────► claimed ──► working ──► ready ──► in_train ──► landed
                                     │            │          │          │
                                     │      (drift alert)    │     (conflict) ──► conflicted ──► replaying ──► ready
                                     │                       │     (train red) ──► bisected ──► ready | failed
                                     └── expired (lease TTL, no heartbeat) ──► open for re-claim
```

**Invariants.** Each must be tested.

1. **No agent ever holds a write token for trunk.** Only the train
   writes `main`. Agents get a write token scoped to their own fork with
   a 1-hour TTL, and it is revoked when the intent lands.
2. **`main` only moves to a SHA that CI verified green as that exact
   SHA.**
3. **Every trunk commit has a why note.** Every agent commit has
   trailers.
4. **A conflict resolution lands only through the same train-plus-CI
   path.** It is never pushed directly.
5. **Coordination messages are data, not instructions.** Mailbox text
   is shown to agents labelled as untrusted peer content. This blocks
   prompt injection between agents, and judges will ask about it.

### 3.3 Agent surface (MCP tools; same as REST and CLI)

| Tool | Tier | Returns |
|---|---|---|
| `plan_goal(text)` | write | Proposed intents with footprints. A human may edit them. |
| `declare_intent(goal, title, reasoning, footprint, accept)` | write | `{intent, fork_remote, token, overlaps[], similar[], inbox[]}`. **Overlaps come back before any code is written.** |
| `whats_happening(paths?)` | read | Live intents near these paths, with owner, reasoning and diff summary |
| `heartbeat(intent)` | write | Renews the lease. Returns inbox messages and drift alerts. |
| `report_push(intent, sha)` | write | Actual footprint compared with the declared one. Overlap updates. |
| `send_note(to_intent, text)` | write | Delivered on the recipient's next tool call |
| `mark_ready(intent)` | write | Queued for the next train. Returns its risk and policy outcome. |
| `claim_conflict(id)` / `resolve_conflict(id, sha)` | write | Replay workflow |
| `why(repo, path, line)` | read | Goal → intent → reasoning → alternatives → evidence → session link |
| `fork_session(intent)` | write | A new fork of the session, to continue someone else's work |

Agents push with **plain `git`**. `flare push` is a thin wrapper that
also calls `report_push`. This makes "any agent works" literally true.

### 3.4 Policy (`.flare/policy.yml` in trunk)

```yaml
protected: [ "src/auth/**", "migrations/**" ]   # intents here stop at awaiting_plan
auto_land_max_risk: 30                            # 0-100
audit_sample: 0.05                                # fraction of auto-landed routed to humans
lanes: { max_per_train: 50, max_parallel: 8 }
replay: { max_attempts: 2, race_k: 3 }            # race_k>1 = resolution tournament
```

`flare.yml`, `.flare/**` and `.github/workflows/**` are **always**
protected (`BUILTIN_PROTECTED` in `intents-core.ts`), merged into every
policy and not removable by it: they are the pipeline that produces the
green evidence and the policy itself, so an agent cannot lift its own
guardrails by editing them. The built-ins also feed the risk score's
protected-path term (declared or undeclared drift).

### 3.5 Risk score (deterministic and explainable; never a bare LLM number)

Risk runs from 0 to 100. It is the **sum** of these contributions (the
weights are capped and tuned on the simulator):

| Signal | Contribution |
|---|---|
| Footprint touches a protected path | +40 |
| Footprint size | log-scaled, up to +15 |
| Drift: undeclared files touched | +15 |
| Resolved by an LLM replay | +15 |
| CI evidence weak: no tests touched the footprint, or a flaky test was quarantined | +10 |
| The clean-context reviewer agent disagrees with the author | +15 |
| Actual footprint truncated (fail closed: unseen files may be protected) | +40 |

The inbox shows **which terms fired**. Explainability is the UX.

---

## 4. Architecture

```
               ┌──────────────────────── Worker (API, MCP, dashboard) ───────────────────────┐
 agents ─MCP/REST─►  routes ─RPC─► RepoCoordinator DO (1 per repo)                           │
 any git ─push──►   Artifacts       ├─ SQLite: intents, leases (range-indexed paths), mailbox │
                    trunk (agents   ├─ overlap query = O(overlap) via path ranges             │
                    read-only)      ├─ alarm: lease expiry sweep, train cut                   │
                    i-<id> forks    └─ ──► LeaseShard DOs (prefix buckets) when hot           │
                                                                                              │
 cf.artifacts.repo.pushed ─► Workflow trigger (namespace-wide) ─► reconcile + dedupe (repo,after)
                                                                                              │
 Train = Cloudflare Workflow (durable steps):                                                 │
   1 partition lanes  2 merge in MemoryFS (isomorphic-git) / seat `git merge-tree` if hard    │
   3 push train/<n>   4 dispatch Flare CI on exact SHA, wait (durable sleep)                  │
   5 green: CAS fast-forward main + write refs/notes/why + revoke fork tokens                  │
     red: bisect → requeue halves;  merge conflict → open Conflict                            │
                                                                                              │
 Feed DO (hibernating WebSockets, 4–10 Hz batched deltas) ─► dashboard live map + inbox       │
 AgentPool DOs ×100 (simulator; alarm-driven, separate `flare-sim` namespace)                 │
 Workers AI via AI Gateway: planner, replay resolver, reviewer, rationale                     │
 Flare executor (existing): seats/runners, checks, digests, triage, quarantine                │
               └──────────────────────────────────────────────────────────────────────────────┘
```

**Why each choice.** Have these ready for Q&A.

- **Fork per intent:** this is Artifacts' documented best practice
  ("10,000 agents → 10,000 repos"). Each fork gets its own git rate
  budget, and forks give isolation and a per-intent session record.
- **Train as a Cloudflare Workflow:** it waits on CI for minutes, must
  survive restarts and must not double-apply. Durable steps provide
  exactly that, and it shows off the platform. The DO **decides**; the
  Workflow **executes**.
- **Coordinator as a plain DO** with SQLite and hibernation:
  - Agents SDK `setState` rewrites and broadcasts the whole state, and
    `McpAgent` is deprecated.
  - Path ranges replace `LIKE`, because DO SQLite caps `LIKE` patterns
    at 50 bytes and allows 100 bound params per query.
- **Agents report pushes; a namespace-wide Workflow trigger
  reconciles.** Queue push subscriptions are per repo, and 10k forks
  can't each have one. Delivery is at-least-once, so we dedupe on
  `(repo, after)`.
- **isomorphic-git for the fast path, seat containers for hard merges.**
  isomorphic-git has diff3 merge, `mergeDriver` and full notes support,
  but no rebase, and it fails when there are multiple merge bases. Real
  git `merge-tree --write-tree` in our existing seats covers the rest.
- **The Feed is separate from the Coordinator,** so broadcasting never
  stalls lease traffic. A DO has a soft limit of about 1,000 req/s.

### Scale math (for the pitch; numbers marked *projected* until measured)

| Layer | Load at 10k agents in 10 min | Limit | Verdict |
|---|---|---|---|
| Fork creation | ~167 / 10 s | 2,000 / 10 s per namespace | ✅ (shard namespaces for bursts) |
| Agent git traffic | Own fork each | 2,000 / 10 s **per fork** | ✅ no contention |
| Trunk pushes | ~100 trains (batches of ~100) | CAS serial | ✅ instead of 10k serial merges taking ~3 h |
| Coordinator | ~1k heartbeats/s at a 10 s cadence | ~1k req/s per DO | ⚠️ 60 s TTL + batched heartbeats + LeaseShards |
| Cost | ~30–50k Artifacts ops | $0.15 / 1k | **~$3–6 per 10k-agent run** (*projected*) |

**Two separate scale claims, kept honest:**

- **Coordination scale:** 100k intents declared and overlap-queried
  against the Coordinator and its shards. These are DO operations only,
  cheap, and a measured 100k is feasible.
- **Git scale:** 1k–10k agents doing real forks, pushes, trains and
  lands, measured.

This lets us honestly say "hundreds of thousands" for coordination
without faking git numbers.

---

## 5. Proof: the benchmark that makes judges believe

Claims are cheap; a **baseline comparison** is what persuades. We run
the same synthetic workload (N agents, same goals, the same
overlap distribution) three ways, through the simulator:

| Mode | What it models |
|---|---|
| **Baseline: branch + PR + serial queue** | Today's workflow: each agent branches, merges one at a time, and the author rebases on conflict |
| **Forge without intents** (trains only) | Isolates the value of batching and lanes |
| **Forge, full** | Declare-time overlap, lanes, replay |

**Metrics, shown on one slide and in the README:**
- Changes landed per minute.
- Median time from declare to land.
- **Conflicts encountered** compared with **conflicts avoided at declare
  time**.
- Broken-`main` minutes. Target: 0.
- **Human review minutes required.** The model is plan approvals,
  stories, the audit sample and escalations, times a constant
  per-item cost.
- Artifacts ops and $ per 1k agents.

Without a baseline, "10k agents" is just a number. With one, it reads as
"N× throughput, zero red mains, 98% less human review".

---

## 6. The competitive field, and how we position against it

| Entry | Their headline | Our answer |
|---|---|---|
| locus | DO lease board, arenas, why-capsules | We treat leases as table stakes. Our trains are CI-verified on the exact SHA, and our "why" is the merge input, not a capsule. |
| gittub | AST symbol locks, notes, merge arenas | We don't use locks, per Cursor's evidence. Replay beats arenas for intent conflicts. |
| git-flare | Fencing leases, two-model review, single-writer CAS | Ours is evidence-based trust (real CI) plus risk routing, not model voting. |
| gitbots | Mandates, ledger branch, stats | Our policy file covers mandates. Our ledger is per line through `why`. |

**Positioning line:** "Others coordinate agents. **Forge integrates
them.** Intent in, verified trunk out, humans only where it matters."

Never name or knock other entries in the submission. Just be visibly
deeper on integration, evidence and measured scale.

---

## 7. Reuse map and pre-work bug fixes

| Need | Existing | Action |
|---|---|---|
| Fork per agent, atomic claim | `tournaments.ts:153` `claimAttempt` | Generalize into intent claim. **Return a 1 h write token** (today the harness shells out to wrangler). |
| Actual footprint | `verdict.ts:105` `changedFiles`, `:133` `detectCollisions` | Replace the full walk with a recursive tree-oid compare that skips identical subtrees. |
| Compare K alternatives | Tournaments + `composeVerdict` + ledger | Reuse for **resolution races** and **contested intents**. |
| Fast-forward | `promote.ts:133` + `memory-fs.ts` | Becomes the train's merge, push, CAS and notes steps. |
| Queue state machine | `mergequeue.ts` (GitHub only) | Becomes the design reference for trains. |
| Push events | `artifacts-push.ts` | Route intent forks to the Coordinator, with a shared delivery claim. |
| Browse | `repos.ts` | Feeds the `why` panel. Add a bounded blame (walk the file's `log`, at most 50 commits). |
| Agent surface | `mcp.ts` (risk tiers, audit, write-confirm) | Add the tools in §3.3. |
| CI evidence | The entire executor | The moat: put it on screen. |

**Fix before the feature work.** These are credibility issues, because
judges read code:

1. **Merge queue** verifies the pre-update SHA (`mergequeue.ts:322`). It
   merges with a stale head (`github.ts:464`). It treats a 422 "already
   up to date" as failure (`github.ts:448`).
2. **Poller starvation** past 50 live attempts (`tournaments.ts:241-247`).
3. **Duplicate dispatch:** the poller skips `claimWebhookDelivery`.
4. **Non-conditional resolve** produces duplicate ledger rows
   (`promote.ts:31`).
5. **Repo-scope leaks** in MCP `list_runs`, `get_run` and
   `tournament_why`, and in `GET /v1/tournaments` (`mcp.ts:316,324,420`,
   `index.ts:2743`).
6. **⌘K → Merge queue** opens an empty pane (`palGoTab`).

---

## 8. Execution plan

### 8.1 Operating principles
1. **Walking skeleton first.** The thinnest possible path from declare
   through fork, push, train, CI, land and `why` must work by **Sat
   12:00**. Everything after that deepens a path that already works, so
   we never end with 80% of five features.
2. **Parallel streams with disjoint files**, one worktree each. One
   integrator merges to the branch every 3 hours, and runs
   `npm run check` before each merge.
3. **Runtime-free cores.** Every new module follows the house pattern:
   pure logic plus injected dependencies plus colocated tests. Wire the
   DO and Workflow last.
4. **Measure, don't claim.** The simulator ships before the video.
5. **Freeze Mon 14:00.** After that, only bug fixes, docs and the video.

### 8.2 Day 0 spikes (Fri night, ~3 h; each one changes a design branch)

| # | Question | Fallback if no |
|---|---|---|
| S1 | Can isomorphic-git push and fetch `refs/notes/why` to Artifacts? | Store why as JSON on a `flare/why` branch (still git-native) |
| S2 | Are force push and ref delete allowed? | Trains use fresh `train/<n>` names and never force |
| S3 | Fork latency at a 5 MB baseline, and is storage copy-on-write? | A warm pre-forked pool, and a smaller demo repo |
| S4 | Does a namespace-wide `repo.pushed` Workflow trigger fire for brand-new forks? | `report_push` plus a slow reconcile poll |
| S5 | Time and memory of an isomorphic-git merge in a Worker on the demo repo | All merges go through seat `git merge-tree` |
| S6 | Does `fork()` return a usable write token? | `createToken('write', 3600)` at claim time |
| S7 | Seat CI wall time for the demo repo, warm | Pick a smaller test suite; pre-warm the seats |

**Results (measured 2026-10-10, throwaway namespace `flare-spike`, since deleted).** S1–S6 all came back YES.

| # | Result | Consequence |
|---|---|---|
| S1 | Notes push and fetch work with both the git CLI and isomorphic-git. Gotcha: isomorphic-git needs a `writeRef` after fetching notes. Forks copy notes. | Notes are the primary why store. |
| S2 | Force push and ref delete are allowed. | Trains may force-update refs. |
| S3 | A fork takes 4–10 s, is clonable immediately, and the time doesn't depend on repo size. 10 parallel forks finish in 5 s. Copy-on-write is unknowable. | Fork on demand, and delete forks after landing. |
| S4 | The namespace-wide `repo.pushed` **Workflow trigger** fires about 3 s after a push, including for new forks. It also fires for notes refs, so the handler must filter by ref. | It becomes the primary push signal. |
| S5 | isomorphic-git merges on memfs: a clean merge takes 62 ms, a conflict throws in 63 ms, and peak RSS stays under 270 MB. **Trap:** pushing a *new* ref uploads the full history (14 s), while pushing to an existing ref takes 2.2 s. | Trains force-update fixed lane refs `forge/lane-N`. |
| S6 | `fork()` returns a 24 h write token. `createToken` works. A read token gets a 403 on push. | Covered. |
| S7 | Not measured yet. | Still open. |

### 8.3 Streams (disjoint ownership)

| Stream | Owns | Done means |
|---|---|---|
| **F: fixes + schema** | bugs §7, `migrations/0045_*.sql` + `schema.ts` (goals, intents, conflicts, trains, ledger `subject_kind/id`) | Gates green; tests for each bug |
| **A: Coordinator** | `coordinator-core.ts` (pure) + `coordinator.ts` (DO), wrangler `durable_objects`+`migrations` (top level **and** `previews`) | declare→overlaps, lease TTL, drift, mailbox, feed; 100k-declare bench |
| **B: Agent surface** | `mcp.ts` tools, `/v1/goals|intents|conflicts`, SDK + CLI (`.ts` imports), openapi trio | Claude Code completes an intent via MCP only |
| **C: Provenance** | trailers helper, `why.ts` (blame + notes), session branch writer, `fork_session` | `flare why file:line` prints the full chain |
| **D: Trains + conflicts** | `train-core.ts` (lanes, bisect, pure) + `train-workflow.ts`, replay flow, resolution race via tournaments | Two overlapping intents → conflict → replay → green → landed with a note |
| **E: Dashboard** | Live map, Inbox/Stories, Why panel, plan approvals (`dashboard.ts` rules: no backticks, `textContent`) | A judge understands the screen with no narration |
| **G: Sim + bench + demo** | `AgentPool` DO, `scripts/forge-bench.mjs`, `npm run forge:demo`, hosted instance, demo repo | Baseline vs Forge table from a real run |

### 8.4 Calendar (PDT)

**Fri Oct 10 (tonight)**
- Spikes S1–S7 → write the results into §8.2.
- Stream F: all six bug fixes plus the schema.
- Pick and seed the **demo repo**. Requirements: a small TS Workers app,
  CI under 60 s, real tests, and obvious seams for 12 parallel intents
  (routes, middleware, auth, logging).

**Sat Oct 11: skeleton by 12:00, then Q1**
- 12:00 milestone: declare (D1 only) → fork + token → `git push` →
  `mark_ready` → a single-intent train (isomorphic-git ff) → CI on the
  exact SHA → land → trailers + note → `why` prints it. **Ugly is fine.**
- Afternoon:
  - A: Coordinator DO with leases, overlaps, drift, mailbox and Feed.
  - B: the MCP tools.
  - C: bounded blame and the session branch.
- 22:00 milestone: **3 real Claude Code agents** run a goal at the same
  time. Overlaps are visible, and all three land.

**Sun Oct 12: Q2 + scale**
- D: multi-intent trains with lanes, bisect, the conflict object, replay
  (owner notified, or the Workers AI resolver), and a resolution race
  with K=3.
- G: the AgentPool simulator. Runs at 1k and then 10k, plus the 100k
  declare bench. Baseline mode.
- B/E: plan approvals with the policy file.
- 22:00 milestone: **the full demo story runs unattended** from
  `npm run forge:demo`.

**Mon Oct 13: Q3 + UX + ship**
- E:
  - live map polish
  - inbox with stories, risk terms, the audit sample and the
    disagreement rate
  - the why panel
- G: final bench run. The numbers go into the README and the slides.
- **14:00 freeze.**
- 14:00–18:00: README "start here", a fresh-account test of
  `forge:demo`, and the hosted read-only instance.
- 18:00–22:00: **record the video** (§9). 22:00–23:00: **submit by
  hand**.

**Tue Oct 14:** buffer only. Re-submission isn't allowed, so the
submission must be final on Monday.

**Oct 15–21: finals hardening.** No new features unless the judges' brief
suggests one.
- Demo director (§10).
- Load test the hosted instance.
- Q&A drills.
- Second-attempt bench.
- Stage rehearsal: three full timed run-throughs, one with the network
  unplugged so the fallback gets exercised.

### 8.5 Cut order (if a milestone slips)

1. Entity-level merge driver (web-tree-sitter)
2. Seat `git merge-tree` (only fast-path merges)
3. Resolution race (single replay only)
4. AI planner (humans write intents)
5. LeaseShards (single Coordinator, 1k sim)
6. Semantic "similar intents" (path overlap only)

**Never cut:**
- declare-time overlap
- trains verified on the exact SHA
- conflict replay
- `flare why`
- inbox with policy auto-land
- live map
- the baseline benchmark
- one-command try-out

### 8.6 Quality gates (every merge to the branch)

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run deploy:dry`.
- Openapi trio on route changes.
- `npm run types` after wrangler edits.
- Smoke-run the CLI after import changes.
- Invariant tests for §3.2 items 1–5 are **required**, not optional.
- `git status` is clean of secrets and generated files before every push.

---

## 9. The submission video (8:30; recorded, edited, captioned)

**Rules:**
- Show, don't tell. Every claim appears on screen as it happens.
- Real numbers only.
- Cuts are fine; fakes are not.
- 1080p, large fonts, a dark dashboard, cursor highlighting.

| Time | Beat | On screen |
|---|---|---|
| 0:00 | **Hook** | "10,000 agents, one repo. Who's doing what? What happens when they collide? What does a human review? Why does this line exist?" Then the live map at full scale, dots flowing into `main`. |
| 0:35 | **First principles** | One slide: code is cheap now, attention and trunk are scarce, so **intent is the unit**. The four questions collapse into one primitive. |
| 1:15 | **Goal → plan** | A human types a goal. The planner proposes 12 intents with footprints. One touches `src/auth`, so it waits for plan approval, which takes one click. |
| 2:00 | **Q1, awareness** | 6 real Claude Code agents claim intents. Agent 4 declares and gets "agent 2 is changing `middleware.ts` because …" before writing code. It adjusts its plan and sends a note. A drift alert fires when agent 5 touches an undeclared file. |
| 3:15 | **Q2, conflicts** | A train with 3 lanes runs in parallel. One lane fails CI on the combined SHA, so it bisects, finds the culprit and lands the rest. A real merge conflict opens; replay runs with the other intent's why, CI goes green, it lands. |
| 4:45 | **Q3, review** | The inbox: 1 story, 12 intents. 10 auto-landed (risk terms shown), 1 audit sample, 1 needs a human. A side-by-side resolution race. The human spends about 90 s. |
| 5:45 | **Q4, why** | Click a line in the repo view. The chain: goal → intent → reasoning → rejected alternative → CI run → reviewer → **fork session** → a new agent continues from that exact context. |
| 6:45 | **Scale + proof** | Simulator: 10k agents, measured trains/min, 0 red-main minutes, the baseline table, $ per 1k agents. |
| 7:45 | **How it's built** | One diagram: Workers, Artifacts (forks, notes, events, tokens), Durable Objects, Workflows, Queues, Workers AI, Containers. "No agent ever holds a trunk token." |
| 8:10 | **Try it** | Hosted URL plus `npm run forge:demo`. "Plain git and MCP: bring any agent." |

---

## 10. Finals (Oct 21, 10 minutes live)

- **Demo director:** `forge demo --stage <n>` resets the hosted instance
  to a known state for each beat. Every beat can be re-run in 10 s, so a
  live hiccup never kills the pitch.
- **Belt and braces:** pre-recorded clips of every beat play from local
  disk, plus a hotspot. Decide on the spot: live if healthy, clips if
  not.
- **Structure (10:00):**
  - 1:00 thesis
  - 6:00 live (Q1–Q4)
  - 1:30 scale and proof
  - 1:00 what's next, framed as Artifacts making this possible
  - 0:30 close
- **Live-only moment:** invite the room to watch a judge's own Claude
  Code (or ours, on stage) join the swarm by pasting one MCP config,
  live.

**Q&A drill (the answers are in this doc):**

| Likely question | Answer |
|---|---|
| Why not GitHub merge queue plus agents? | It serializes. It assumes humans review diffs. It loses the why. A1, A5 and A8 in §2. |
| What if an agent lies about its footprint? | The actual footprint is computed from every push, and drift adds risk and alerts. |
| What about semantic conflicts? | Trains verify the *combined* SHA, and a red train is bisected. |
| What if the LLM resolution is wrong? | It can't land without green CI. Weak coverage escalates to a human. Merge-Bench (<60%) is why. |
| How does this get to 100k? | Locality (O(overlap)), fork per intent (a git budget each), trains (about 100 trunk pushes), sharded DOs. Show the measured 100k declare bench. |
| Cost? | The measured $ per 1k agents. |
| Prompt injection between agents? | Mailbox content is labelled untrusted data and never triggers tools. Fork-scoped tokens and no trunk tokens. |
| Why git at all? | Models already know it, every agent speaks it, and Artifacts makes a million repos cheap. |
| What do humans actually do? | Approve plans on protected paths, skim stories, audit a 5% sample, resolve escalations. Shown as minutes in the benchmark. |

---

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Notes refs unsupported (S1) | M | M | A `flare/why` branch fallback, decided Friday |
| isomorphic-git merge memory or CPU in the Worker (S5) | M | H | Small demo repo; seat `git merge-tree` path |
| Seat CI too slow for a live demo (S7) | M | H | Pre-warm, tiny test suite, demo-director stages |
| Artifacts beta flakiness or rate limits | M | H | Retries with backoff on `FORK_IN_PROGRESS` / `UPSTREAM_UNAVAILABLE`; namespace sharding; metrics dataset watched during runs |
| Scope creep | H | H | Walking skeleton, freeze, cut order |
| Eligibility (residency, travel) | ? | Fatal | **Confirm the submitter today** |
| Fresh-account setup breaks for judges | M | H | Monday fresh-account test, plus a hosted instance as a no-setup path |
| Cost overrun after Oct 14 billing | L | L | Delete forks after landing; the sim uses its own namespace; ~$10 budget |
| Leaked secrets in the repo or video | L | Fatal | Gates in §8.6; blur the terminal; demo tokens rotated after recording |
| Claims that can't be backed by measurements | M | H | Provenance rule: measured or labelled "projected" |

---

## 12. Submission checklist

- [ ] The submitter is confirmed as a US/Canada legal resident, 18+, and
  available in SF on Oct 21. A second team member is named for travel.
- [ ] README top section "Competition entry: start here": the hosted URL,
  `npm run forge:demo`, a 3-line concept, the diagram, the benchmark
  table.
- [ ] `docs/TOURNAMENTS.md` and `docs/TOURNAMENT-VIDEO.md` updated to the
  intents story.
- [ ] `docs/ROADMAP.md:282` reconciled. Framing: Forge is the
  agent-integration layer on Artifacts, and Flare is its verification
  engine.
- [ ] A fresh-account run of `forge:demo` passes, timed.
- [ ] The video is 5–10 min, captioned, with no disparagement and real
  numbers.
- [ ] All gates green. The repo is public with its MIT LICENSE. No
  secrets.
- [ ] Submitted once, by hand, by Mon 23:00 PDT. Screenshot the
  confirmation.

---

## 13. Sources

- Rules: https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf
- Brief: https://blog.cloudflare.com/next-git-platform-on-cloudflare/
- Artifacts launch: https://blog.cloudflare.com/artifacts-git-for-agents-beta/
- Artifacts docs (binding, git protocol, limits, pricing, events, best practices, isomorphic-git, sandbox): https://developers.cloudflare.com/artifacts/llms.txt
- DO limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Agents SDK state: https://developers.cloudflare.com/agents/runtime/lifecycle/state/
- isomorphic-git merge / notes: https://isomorphic-git.org/docs/en/merge, https://isomorphic-git.org/docs/en/addNote
- Cursor, scaling long-running agents: https://cursor.com/blog/scaling-agents
- Cognition: https://cognition.com/blog/dont-build-multi-agents
- Anthropic multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Uber SubmitQueue: https://www.uber.com/blog/slashing-ci-costs-at-uber/
- Zuul gating: https://zuul-ci.org/docs/zuul/9.4.0/gating.html
- Graphite batching and bisection: https://graphite.com/blog/merge-queue-batching
- Merge-Bench: https://homes.cs.washington.edu/~mernst/pubs/merge-bench-icpr2026-abstract.html
- Agent Trace: https://www.infoq.com/news/2026/02/agent-trace-cursor
- git-ai: https://usegitai.com/docs/how-git-ai-works
