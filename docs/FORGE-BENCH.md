# Forge bench: simulator and live harness

> Provenance: agent-drafted on 2026-10-10 (stream G). Every number in
> the results section is **SIMULATED**: it is the output of
> `apps/sim/src/sim.ts` under the constants listed below, from
> `node --experimental-strip-types scripts/forge-bench.mjs --agents 1000,10000,100000 --seed 7 --json`
> on 2026-10-10 at commit `94bf9ae`. The raw output is in
> `docs/bench/forge-sim-seed7.json`. The sensitivity row comes from the
> same command with `--max-parallel 32 --agents 10000`, run the same
> day. No live (measured) run has been done yet. Section 3 says how to
> do one.

COMPETITION-PLAN §5 asks for the same workload to be run three ways,
with the results reported side by side. The bench has two layers, and
each is labelled everywhere it prints:

| Layer | What | Label |
|---|---|---|
| 1. Simulator | `apps/sim/src/sim.ts`: a deterministic discrete-event model of N agents. It is pure TypeScript and makes no network calls. | **SIMULATED** |
| 2. Live harness | The `apps/sim` Worker. `AgentPool` Durable Objects drive the real Forge REST API of a deployment. | **MEASURED** |

The simulator calls the shipped Forge logic from
`apps/worker/src/intents-core.ts`: `footprintsOverlap` for the
declare-time overlap query, `partitionLanes` for train lanes, `bisect`
for red trains, and `scoreRisk` plus `routeLanding` for review routing.
Change those functions and the bench changes with them. The simulator
adds only time and randomness.

## 1. Methodology (simulator)

### Workload (identical across the three modes)

- **Agents and declare times.** N agents, one intent each. Every agent
  declares at a uniform-random time inside a 10-minute window. This is
  the "10k agents in 10 min" burst from plan §4. The window stays fixed
  as N grows, so larger N means a denser burst on the same repo.
- **Repo.** 100,000 files in directories of 20. 2% of directories sit
  under the protected globs `src/auth/**` and `migrations/**`.
- **Footprint.** Each intent declares 1 file plus geometric extra files
  (mean 1.5 extra, capped at 12). Files are drawn **Zipf(s = 0.7)** by
  popularity, and the popularity ranks are shuffled across directories,
  so some hot files are protected and most are not.
- **Overlap.** The exponent is calibrated so that about 21% of intents
  overlap a live intent at 1k agents. The share rises to 50% at 10k and
  83% at 100k: that growing contention is what the bench measures.
- **Drift.** 10% of intents also touch one undeclared file. The
  declare-time query can't see that file.
- **Per-intent draws.** Each intent gets fixed draws for work time,
  defect (none / caught by its own CI / escaped), interaction defect
  (fails only on the combined SHA), weak CI evidence, reviewer
  disagreement, review latency and plan latency. All of them come from
  seeded PRNG streams (`mulberry32`, with a separate stream per
  concern). The same seed gives byte-identical results; the test
  `simulate › is deterministic for a seed` checks this.

### Modes

| Mode | Flow |
|---|---|
| **Baseline**: branch + PR + serial queue | 1. Work, then the PR's own CI on its branch, then **every PR is reviewed by a human**.<br>2. A **serial merge queue** lands one PR at a time, with CI on the exact merged SHA.<br>3. A textual conflict with anything that landed since the PR's base bounces it to the author, who rebases (redoing 50% of the work time), is re-approved, and rejoins the **back** of the queue.<br>4. The author gives up after 3 rebases or 3 fixes. |
| **Forge, trains only** | 1. The same PR, CI and review flow as the baseline.<br>2. Ready changes ride **trains**. Up to `max_parallel` (8) lanes run at once, each holding at most `max_per_train` (50) intents. Lanes are the connected components from `partitionLanes`, packed least-full-first.<br>3. Each lane merges its intents in order, and any that conflict drop out. CI runs **once per lane** on the combined SHA.<br>4. A red lane is split with `bisect` and the halves are retested in parallel. Green halves land in lane order.<br>5. An intent that overlaps a lane in flight waits for that lane to finish, because otherwise CI would verify one SHA and a different one would land (invariant 2).<br>6. Conflicts bounce to the author, as in the baseline.<br>7. There is no declare-time information. |
| **Forge, full** | 1. **Declare-time overlap.** For each declared file, the latest live intent on it becomes an `after:` predecessor (confirmed with `footprintsOverlap`).<br>2. **Stacking.** The new intent waits up to 15 minutes for each predecessor to push a head, then **stacks** on it (forks from it). A stacked intent rides the same lane right behind its predecessor, so the overlap between the two can't become a conflict. A predecessor that hasn't pushed within the 15 minutes is dropped, and the intent works in parallel.<br>3. **Restacks.** If a predecessor changes after the intent stacked on it (rework, replay, or a failure in the train), the intent is re-derived on the new head.<br>4. **Plan approval.** Intents on a protected path need a human plan approval first (`awaiting_plan`).<br>5. **Trains** run as in trains-only.<br>6. **Replay.** A conflict goes to an **LLM replay**: 2 attempts, each with a 0.6 success rate. A replayed intent passes CI again and **keeps its place in line**. When the replay budget is spent, the conflict escalates to a human and the author reworks it.<br>7. **Review routing.** `scoreRisk` scores every verified head. `routeLanding` then sends it to auto (no human), audit (a 5% sample, reviewed after the fact, never blocking), or human review before landing. |

Each mode runs its own seeded streams for CI duration, flakes, conflict
draws, routing rolls and replays.

### Metrics

Every metric is per mode, at a given N.

| Metric | Definition |
|---|---|
| Landed / Abandoned | Intents that reached trunk, and intents that gave up. Each intent ends in one of the two; a test checks this. |
| Changes/min | Landed ÷ (last land − first declare). This includes the long tail of stragglers. |
| 80% landed by | Minutes from the first declare until 80% of **all** N intents had landed. `n/a` means fewer than 80% ever landed. This is throughput without the straggler tail. |
| p50 / p95 declare→land | Over **landed** intents only. A mode that abandons its hardest intents looks faster here. Read this together with Abandoned. |
| Conflicts hit | Textual conflicts at merge time: a draw of p = 0.35 per shared file changed since the intent's base or merged earlier in the lane. A predecessor the intent is stacked on is excluded. |
| Conflicts avoided | Forge only. Predecessor overlaps that were stacked or sequenced, **and** for which the same per-file draw says a conflict would have happened had both worked from one base. This is a counterfactual inside the model. |
| Red-main min | The union of [land, land + 30 min] intervals for escaped defects (bugs that no CI catches). Every mode verifies the exact SHA it lands, so this number comes **only** from escapes. It scales with how many intents land, and is not a train-correctness signal. |
| Human min | review × 10 min + re-review × 3 + plan approval × 5 + audit × 5 + escalation × 10. The full breakdown is in the JSON. |
| CI runs | Branch/fork CI, plus queue or lane CI, plus bisection runs, plus flake reruns. |
| $ / 1k agents | Estimated Artifacts operations × $0.15 per 1k operations. The operation model is in the constants table. Not reported for the baseline (no Artifacts). |

### Constants (inputs, not measurements)

They are defined in `apps/sim/src/constants.ts` (`DEFAULT_CONSTANTS`,
`CONSTANT_SOURCES`). "Assumption" means nothing external backs the
number; it is a knob you can change.

| Constant | Value | Source |
|---|---|---|
| Arrival window | 10 min | COMPETITION-PLAN §4 scale math |
| Repo files / per dir | 100,000 / 20 | Assumption (a large monorepo) |
| Zipf exponent | 0.7 | Assumption. Calibrated to about 21% overlap at 1k agents |
| Footprint size | 1 + Geom(mean 1.5), ≤ 12 | Assumption |
| Protected dirs | 2% (`src/auth/**`, `migrations/**`) | Assumption |
| Drift | 10% of intents touch 1 undeclared file | Assumption |
| Work time | Lognormal, median 8 min, σ 0.6 | Assumption |
| CI run | Lognormal, median 10 min, σ 0.3. One suite per run, any batch size | Assumption |
| Review latency / re-review | Median 30 / 15 min, σ 0.8. Reviewers are unlimited, which favors the baselines | Assumption |
| Plan approval latency | Median 30 min | Assumption |
| LLM replay | Median 3 min. Success rate 0.6 per attempt, 2 attempts (`replay.max_attempts`) | Merge-Bench (plan §13) for 0.6; `DEFAULT_POLICY` for attempts |
| Rework (rebase or fix) | 50% of the original work time | Assumption |
| Conflict probability | 0.35 per shared changed file | Assumption. Overlap is necessary for a conflict, not sufficient |
| Defect | 5% of intents. 90% are caught by their own CI; the rest escape | Assumption |
| Interaction defect | 2%. Caught only by CI on the combined SHA | Assumption |
| Flake | 5% per CI run | Assumption. Google reported about 1.5% of test runs flaky (2016 testing blog), and a run has many tests |
| Weak evidence / reviewer disagrees | 15% / 6% | Assumption (risk terms) |
| Escaped defect MTTR | 30 min | Assumption |
| Planner wait budget | 15 min | Assumption |
| Policy | `DEFAULT_POLICY`: auto-land risk ≤ 30, 5% audit sample, lanes 50 × 8, replay 2 | `intents-core.ts` |
| Human minutes per item | Review 10, re-review 3, plan 5, audit 5, escalation 10 | Assumption |
| Give-up limits | 3 rebases, 3 fixes, 8 conflicts in total | Assumption |
| Artifacts ops | 7 per intent (fork, token, clone 2, push 2, revoke) + 2 per extra push + 2 per lane item + 6 per lane landing | Assumption |
| Artifacts price | $0.15 per 1k ops | COMPETITION-PLAN §4. Check against current pricing |

## 2. Results (SIMULATED)

All rows below are simulated, from seed 7, generated on 2026-10-10 at
commit `94bf9ae` with this command:

```bash
node --experimental-strip-types scripts/forge-bench.mjs --agents 1000,10000,100000 --seed 7 --json
```

**1,000 agents.** 21.0% overlap at declare.

| Mode | Landed | Abandoned | Changes/min | 80% landed by | p50 declare->land | p95 | Conflicts hit / avoided | Red-main min | Human min | CI runs | $ / 1k agents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline: branch + PR + serial queue | 988 | 12 | 0.09 | 6d 13h | 3d 23h | 7d 15h | 205 / 0 | 120 | 10,636 | 2,392 | n/a |
| Forge, trains only | 987 | 13 | 1.32 | 2h 40m | 1h 30m | 3h 31m | 209 / 0 | 81 | 10,645 | 1,568 | $1.64 |
| Forge, full | 1,000 | 0 | 2.63 | 2h 22m | 1h 45m | 3h 18m | 167 / 52 | 94 | 1,797 | 1,611 | $1.65 |

**10,000 agents.** 50.4% overlap at declare.

| Mode | Landed | Abandoned | Changes/min | 80% landed by | p50 declare->land | p95 | Conflicts hit / avoided | Red-main min | Human min | CI runs | $ / 1k agents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline: branch + PR + serial queue | 8,860 | 1,140 | 0.08 | 66d 23h | 36d 22h | 70d 17h | 7,818 / 0 | 1,590 | 120,580 | 27,801 | n/a |
| Forge, trains only | 8,862 | 1,138 | 5.60 | 21h 41m | 11h 39m | 23h 17m | 7,773 / 0 | 879 | 120,448 | 20,289 | $1.87 |
| Forge, full | 9,810 | 190 | 4.85 | 21h 51m | 11h 23m | 24h 50m | 7,099 / 944 | 979 | 34,210 | 21,503 | $1.93 |

**100,000 agents.** 83.0% overlap at declare. This is a stress case:
100k agents declaring within 10 minutes on a single repo.

| Mode | Landed | Abandoned | Changes/min | 80% landed by | p50 declare->land | p95 | Conflicts hit / avoided | Red-main min | Human min | CI runs | $ / 1k agents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline: branch + PR + serial queue | 68,153 | 31,847 | 0.08 | n/a | 293d 21h | 581d 3h | 171,932 / 0 | 11,535 | 1,424,611 | 331,879 | n/a |
| Forge, trains only | 68,330 | 31,670 | 4.73 | n/a | 4d 3h | 9d 7h | 171,054 / 0 | 7,543 | 1,422,505 | 274,845 | $2.29 |
| Forge, full | 97,678 | 2,322 | 5.47 | 9d 8h | 5d 12h | 11d 1h | 109,929 / 10,285 | 9,722 | 478,333 | 256,690 | $2.17 |

**Sensitivity.** The same seed at 10k agents with
`--max-parallel 32` (32 lanes in parallel instead of 8):

| Mode | Landed | Abandoned | Changes/min | 80% landed by | p50 declare->land | p95 | Conflicts hit / avoided | Red-main min | Human min | CI runs | $ / 1k agents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline: branch + PR + serial queue | 8,860 | 1,140 | 0.08 | 66d 23h | 36d 22h | 70d 17h | 7,818 / 0 | 1,590 | 120,580 | 27,801 | n/a |
| Forge, trains only | 8,998 | 1,002 | 12.14 | 5h 59m | 3h 16m | 6h 45m | 7,575 / 0 | 414 | 120,283 | 20,591 | $1.89 |
| Forge, full | 9,718 | 282 | 8.33 | 5h 25m | 3h 3m | 8h 5m | 8,770 / 943 | 449 | 37,557 | 23,611 | $2.07 |

### What the simulated numbers say, and what they don't

- **Trains against the serial queue.** The serial queue pays one CI run
  per change, so it lands about 0.08–0.09 changes/min at every N. At
  1k agents, trains reach 80% landed in 2h 40m, against 6d 13h for the
  queue: about 59× faster. At 10k agents it is 21h 41m against 66d 23h,
  about 74× faster.
- **Human review is where full Forge differs from trains-only.** Risk
  routing sends most verified heads to auto-land. Human minutes fall
  against the baseline by 83% at 1k, 72% at 10k and 66% at 100k. At 10k
  and above, the remaining human minutes are mostly escalations: replay
  failures caused by the conflict storm.
- **Declare-time overlap avoids some conflicts, not most.** At 1k, full
  Forge hits 167 conflicts and avoids 52, against 209 for trains-only,
  and it abandons nothing. At 10k it avoids 944 and abandons 190,
  against 1,138 for trains-only. Most remaining conflicts come from
  three sources:
  - intents that waited longer than the 15-minute stack budget and so
    worked in parallel;
  - drift, which the declare-time query can't see;
  - long ready queues: the base goes stale while an intent waits.
- **Full Forge lands more, at the cost of a longer tail.** At 10k and
  100k it lands far more intents (2,322 abandoned at 100k against
  31,670 for trains-only), because replay keeps resolving conflicts
  where an author would give up. Those late landings stretch the
  makespan, which is why its Changes/min and p50 can look worse than
  trains-only. Compare "80% landed by" and Abandoned instead.
- **The train ceiling is lane parallelism.** With the default 8 lanes,
  both train modes top out around 5–6 changes/min at 10k agents or
  more. A lane holds back every ready intent that overlaps it until its
  bisection finishes. Raising `max_parallel` to 32 more than doubles
  trains-only throughput at 10k (12.14 changes/min, 80% landed in
  5h 59m). Possible next steps for stream D:
  - speculative or stacked trains (testing lane N+1 on top of lane N);
  - batching more aggressively when the queue is deep.
- **Red-main minutes are similar across modes.** The model has no
  invariant-2 violations: every mode verifies the exact SHA it lands.
  What remains is escaped bugs, and those scale with how many intents
  land. The model does **not** include semantic interaction between
  two disjoint lanes that land back to back. That is a real risk for
  parallel lanes, and live runs should watch for it.

### Limitations

- Reviewers are unlimited and review effort is a constant. This favors
  both baselines.
- Stacking is the modeled meaning of an `after:` edge (fork from the
  predecessor's pushed head). The planner in stream A/B may differ.
- "Keeps its place in line" after a replay is a modeled Forge train
  policy. It is not specified yet in FORGE.md.
- Hot-file contention, CI duration and defect rates are assumptions.
  Change them in `constants.ts` and re-run; the same seed gives the
  same output.

## 3. Live harness (MEASURED; `apps/sim` Worker)

### Shape

```
forge-bench.mjs live start ──► flare-forge-sim Worker (POST /runs, admin token)
                                 ├─ SimRegistry DO (run list)
                                 └─ AgentPool DO × P  (alarm-driven; ≤6 requests in flight,
                                      ≤400 requests / 20 s per alarm, then the next alarm)
                                        └─► target Forge REST API (/v1/forge/*), FORGE_TOKEN
                                              └─► Artifacts forks in namespace flare-sim
```

- **Pools.** full-git: up to 100 agents per pool, so 10k agents is 100
  pools. coordination-only: up to 1,000 agents per pool, so 100k
  agents is 100 pools. Starts are spread over `ramp_seconds`
  (default 60).
- **coordination-only.** Each agent runs declare, then
  `whats_happening`, then N heartbeats. No forks are created. This is
  the cheap path to a measured 100k-intent run against the Coordinator.
- **full-git.** Each agent runs:
  1. declare;
  2. claim (fork remote + a fork-scoped token);
  3. a real `git push` of one tiny commit, using isomorphic-git over
     `MemoryFS`. The commit message carries `Flare-Intent`,
     `Flare-Agent` and `Flare-Goal` trailers from the shipped
     `appendTrailers`;
  4. report push;
  5. ready.
- **Rate limits.**
  - A 429 or an Artifacts `rateLimited`-style error code backs the
    agent off, honoring `Retry-After` if present, otherwise exponential
    with jitter. It is counted in `rateLimited` and never fails the
    run, up to 30 retries per agent.
  - A 5xx or network error retries 4 times.
  - A non-retryable 4xx on an optional step (heartbeat,
    `whats_happening`) is skipped. On any other step it fails that
    agent, and the error code is counted.
- **Budget guard.** full-git above `MAX_FULL_GIT_AGENTS` (default
  1,000) is refused with 409 `confirm_required` unless the request
  carries `"confirm": true` (CLI: `--confirm`). full-git is capped at
  10,000 agents. The CLI checks the same limit before it sends.
- **Tokens.**
  - Fork tokens live in pool storage only until that agent finishes.
    They are never exported, never logged, and are redacted from git
    errors.
  - The Worker's admin token is compared digest-then-compare, which is
    constant-time.
- **Endpoints.**

  | Endpoint | Purpose | Auth |
  |---|---|---|
  | `POST /runs` | Start a run | Admin |
  | `GET /runs` | List runs | Read |
  | `GET /runs/:id/results` | Aggregate JSON: per-op requests, ok, errors, p50/p95 (log-bucket upper bounds, ±12.5%), intents/s, rate-limit count, done/failed/pending | Read |
  | `GET /runs/:id` | The same as an HTML page that refreshes itself | Read |
  | `POST /runs/:id/stop` | Stop the run | Admin |
  | `POST /runs/:id/cleanup` | Delete every fork the run created, through the Worker's `ARTIFACTS` binding (namespace `flare-sim`) | Admin |

  Admin endpoints take `Authorization: Bearer $SIM_ADMIN_TOKEN`. Read
  endpoints need the same token unless `PUBLIC_RESULTS="true"`.

The API contract is coded in `apps/sim/src/harness/api.ts`
(`FORGE_ROUTES`). It mirrors plan §3.3 and stream B:

| Op | Request | Fields read from the response |
|---|---|---|
| Goal | `POST /v1/forge/goals {repo, text}` | `goal.id` or `id` |
| Declare | `POST /v1/forge/intents {repo, goal_id, agent, title, reasoning, accept, footprint:{paths}}` | `intent.id` or `id`; `overlaps[]` |
| Claim | `POST /v1/forge/intents/:id/claim {agent}` | `fork_repo`, `fork_remote` or `remote`, `token` |
| Heartbeat | `POST /v1/forge/intents/:id/heartbeat {agent}` | `inbox[]` |
| Push | `POST /v1/forge/intents/:id/push {agent, sha, files}` | `drift[]` |
| Ready | `POST /v1/forge/intents/:id/ready {agent}` | `risk` |
| What's happening | `GET /v1/forge/whats-happening?repo=&paths=a,b` | `intents[]` |

When stream B's routes are merged, adjust `FORGE_ROUTES` and the `pick`
paths there. Nothing else needs to change.

### Running it (integrator)

Nothing in this stream was deployed, and no cloud resources were
created.

1. **Pick a target.** Use a **preview** Forge deployment whose
   `ARTIFACTS` binding points at namespace `flare-sim` (never
   production for full-git). Create the namespace if it is missing,
   with the same Artifacts REST call `scripts/artifacts-admin.mjs` uses.
   Then create the trunk repo (`SIM_REPO`, default `flare-sim-trunk`)
   with a tiny seed commit.
2. **Configure and deploy the harness.** Secrets go in through stdin
   and never appear in argv:

   ```bash
   printf %s "$FORGE_API_TOKEN" | npx wrangler secret put FORGE_TOKEN -c apps/sim/wrangler.jsonc
   printf %s "$SIM_ADMIN_TOKEN" | npx wrangler secret put SIM_ADMIN_TOKEN -c apps/sim/wrangler.jsonc
   # set vars.FORGE_URL in apps/sim/wrangler.jsonc (or --var FORGE_URL:https://...)
   npx wrangler deploy -c apps/sim/wrangler.jsonc --dry-run   # validate
   npx wrangler deploy -c apps/sim/wrangler.jsonc
   ```

3. **Run.** `SIM_ADMIN_TOKEN` comes from the environment.

   ```bash
   export FORGE_SIM_URL=https://flare-forge-sim.<sub>.workers.dev
   npm run forge:bench -- live start --mode coordination-only --agents 100000 --ramp 300
   npm run forge:bench -- live start --mode full-git --agents 1000
   npm run forge:bench -- live start --mode full-git --agents 10000 --confirm --ramp 600
   npm run forge:bench -- live results --run <id>           # or open $FORGE_SIM_URL/runs/<id>
   npm run forge:bench -- live results --run <id> --json > docs/bench/forge-live-<id>.json
   npm run forge:bench -- live cleanup --run <id>           # deletes the run's forks
   ```

4. **Report.** Record the measured rows in this file with the run ID,
   date and the Forge SHA, labelled **measured**, next to the
   simulated tables. Plan §4 estimates about 30–50k Artifacts ops for
   a 10k full-git run; measure it before you quote any dollar figure.

### Bench panel

`GET /v1/forge/bench` (FORGE-UX §5.8 and §8) has the shape
`{ run, measured_at, sha, modes: [{ mode, metrics, projected }] }`.
Each `runs[]` entry in `docs/bench/forge-sim-seed7.json` already has
that shape. It also carries `simulated: true` and `kind: "simulated"`
on the document and on every row, so the panel can label it. Metric
keys are snake_case: `changes_per_min`, `median_declare_to_land_min`,
`time_to_80pct_landed_min`, `conflicts_hit`, `conflicts_avoided`,
`red_main_min`, `human_min`, `dollars_per_1k_agents`, and so on.

## 4. Files

| Path | Role |
|---|---|
| `apps/sim/src/{prng,constants,workload,sim,report}.ts` | Simulator. Pure, and runs under Node strip-types and vitest |
| `apps/sim/src/harness/{api,pool,plan,git}.ts` | Harness logic. Runtime-free, with an injectable HTTP layer and git |
| `apps/sim/src/{pool-do,index,env}.ts` | The Worker and its Durable Objects |
| `apps/sim/src/sim.test.ts`, `apps/sim/src/harness/pool.test.ts` | Tests. Pool logic runs against a fake Forge API |
| `scripts/forge-bench.mjs` | CLI for both layers (`npm run forge:bench`) |
| `docs/bench/forge-sim-seed7.json` | Committed simulated output |
