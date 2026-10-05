# D1 Free-Tier Audit

Phase 1d platform hygiene: every D1 touchpoint measured against the Workers
Free limits (5M rows read/day, 100K rows written/day, 50 queries per
invocation, 2MB max row, 100 bound params/query, 100KB max statement).
Sources: [limits](https://developers.cloudflare.com/d1/platform/limits/),
[pricing](https://developers.cloudflare.com/d1/platform/pricing/) (both
checked Oct 2026).

Verdict: comfortably inside Free at any realistic self-hosted scale. Two
real issues found and fixed during this audit (seat report caps, egress
chunk size); the rest is headroom analysis.

## Per-invocation query budget (Free: 50)

Busiest paths, counted by hand from the code:

| Path | Queries | Notes |
|---|---|---|
| Poll (`GET /v1/jobs/next`), idle | 2–3 | fair-share setting + 1 empty scan page (+1 GROUP BY when capped) |
| Poll, deep backlog | ≤ 11 | 8 scan pages (25 rows × 8 = 200-scan budget) + claim + rollup reads |
| Status report (terminal) | ~12 | report + rollup (1 select + 1 update) + promote + triage (2 settings + 1 update) + monitors + checks bookkeeping |
| Webhook dispatch (32-job matrix) | ~40 | delivery claim + run + 32 job inserts + settings/reads; sweeps run in `waitUntil` (separate budget) |
| Seat job (whole execution) | ~30 spread over minutes | claim, log mirrors (1 per note), terminal update, rollup, promote, snapshot/egress rows |

`MAX_JOBS = 32` is what keeps the dispatch fan-out under 50. Raising it
past ~40 would risk Free-plan dispatch failures — the matrix cap is a
billing guard, not just a UX choice.

## Daily row budget (Free: 5M read / 100K written)

Idle cost per BYO runner: one ~0-row poll every 2s (≈43K reads/day) plus
one heartbeat write per minute (1.4K writes/day). Ten idle runners burn
<10% of the read budget and <15% of the write budget. Active CI is
cheaper per unit of work than it looks: a 10-job run costs roughly 150
reads and 60 writes end to end, so 1K runs/day (≈10K jobs) still leaves
80%+ headroom on both meters.

Sweeps are event-driven, not cron-driven: `pruneOldRuns` (1 select, then
4 deletes per stale run, 500-run cap) and `requeueStaleJobs` (1 select
over `running` rows) ride webhook/status `waitUntil`s, so an idle deploy
pays nothing for them. The retention sweep only reads rows it will
delete; steady state is one empty select per webhook.

## Hard limits (plan-independent)

- **2MB rows**: BYO reports were already capped (256KB log, 64KB result
  in the `/status` route). Seats were not: 100 steps × 32KB tails could
  reach 3.2MB. Fixed — `SEAT_LOG_CAP`/`SEAT_RESULT_CAP` in
  `apps/seats/src/seat.ts` mirror the BYO caps exactly, so both
  executors degrade identically (digest/checks/triage parsers all
  tolerate truncated JSON).
- **100 bound params**: multi-row inserts stay chunked with margin —
  test cases 10×8=80, egress 10×5=50 (egress shipped at 20×5=100 during
  Phase 2 and was pulled back in this audit; exact-limit queries are a
  regression away from failing).
- **100KB statements**: biggest generated SQL is a 10-row insert
  (<4KB). Static schema statements are all <2KB.
- **50-byte LIKE patterns**: the only LIKE in query code is a static
  14-byte prefix match (`email_invite_%` in `email.ts`). Client-supplied
  prefixes (cache/queue filters) use equality and `startsWith`, never
  LIKE, so user input cannot approach the cap.
- **Indexes on hot filters**: `jobs(run_id, status)`, `jobs(status)`-via
  claim scan ordering, `test_results(run_id, status)`, `job_egress(run_id)`,
  `seat_snapshots(last_used_at)`, `audit(created_at)` — every sweep/scan
  predicate is indexed, so "rows read" tracks rows returned, not table
  size. The claim scan's `ORDER BY priority DESC, created_at` walks the
  queued slice only.

## Watch items (not problems today)

1. **Monitors fan-out**: `evaluateResultMonitors` loads all monitors per
   terminal result. Fine under hundreds of monitors; past that, scope the
   select by repo.
2. **Audit log growth**: every dispatch/token/settings/MCP-write call
   appends. Reads are capped (last 100); add a retention bound if the
   table ever dominates storage (500MB Free DB cap).
3. **Log mirrors**: seats append one row-rewrite per `note()` line.
   Notes are small and few per job (~15); step output goes to the
   terminal write only, never to mirrors.
4. **Dashboard polling**: run detail re-fetches on each navigation, not
   on a timer — no background meter burn from open tabs.
