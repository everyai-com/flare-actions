# CI Analytics

Flare emits the same three lifecycle events to two sinks. Both are
best-effort: unconfigured or failing sinks skip silently and never
fail a request.

| Sink | Role | Retention | Delivery |
|------|------|-----------|----------|
| Analytics Engine (`flare-actions-ci`) | Hot metrics: dashboards, flaky rates, duration percentiles | Short (AE window) | At-least-once, sampled under load |
| Basin Pipeline stream (`flare-ci-events`) | Cold lake: Apache Iceberg rows in R2 for history, joins, audits | Long (your R2) | Exactly-once to R2 |

Events: `run.dispatched`, `run.terminal`, `job.terminal`.
Emitters: `apps/worker/src/analytics.ts` (AE, sync buffer) and
`apps/worker/src/basin.ts` (Basin, via `ctx.waitUntil`).
Both executors (BYO runners through `/v1/jobs/status`, seats inline)
emit on the same terminal transitions; `executor` distinguishes them.

## Analytics Engine

Dataset `flare-actions-ci` (prod) / `flare-actions-staging-ci`
(previews), bound as `ANALYTICS` in `wrangler.jsonc`. No provisioning
step: the dataset is created on first `writeDataPoint`.

### Schema v1 (slot positions are the contract)

`analytics.ts` documents the slots; the queries below depend on them.
Append-only: new fields take higher slots, never reuse one.

| Slot | Content |
|------|---------|
| `index1` | event (`run.dispatched` \| `run.terminal` \| `job.terminal`) |
| `blob1` | repo (`owner/name`) |
| `blob2` | run_id |
| `blob3` | job name (`job.terminal`) else `""` |
| `blob4` | status (`run.terminal`, `job.terminal`) else `""` |
| `blob5` | trigger (`run.*`: push, dispatch, schedule, …) else `""` |
| `blob6` | executor (`job.terminal`: `runner` \| `seat`) else `""` |
| `double1` | job count (`run.dispatched`) \| duration ms (terminal events) |
| `double2` | job count (`run.terminal`) \| attempts used (`job.terminal`) |

### Querying (SQL API)

Endpoint: `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/analytics_engine/sql`
with a Bearer [REDACTED] carrying Account Analytics Read. Request body is the
raw SQL. Counts always weight by `_sample_interval` (AE samples under
load); terminal queries dedupe by `run_id` (redelivered transitions
emit twice; durations derive from stamped timestamps so duplicates
agree).

```bash
AEQ() { curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" --data "$1"; }
```

Runs per day by status:

```sql
SELECT toDate(timestamp) AS day, blob4 AS status,
  COUNT(DISTINCT blob2) AS runs
FROM "flare-actions-ci"
WHERE index1 = 'run.terminal' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, status ORDER BY day, status
```

p50/p90 run duration by repo (deduped, weighted):

```sql
SELECT blob1 AS repo,
  quantileWeighted(0.5, double1, _sample_interval) AS p50_ms,
  quantileWeighted(0.9, double1, _sample_interval) AS p90_ms
FROM (
  SELECT blob1, blob2, MAX(double1) AS double1, MAX(_sample_interval) AS _sample_interval
  FROM "flare-actions-ci"
  WHERE index1 = 'run.terminal' AND timestamp > NOW() - INTERVAL '7' DAY
  GROUP BY blob1, blob2
)
GROUP BY repo ORDER BY p90_ms DESC
```

Flakiest jobs per repo (failure rate, min 5 runs):

```sql
SELECT blob1 AS repo, blob3 AS job,
  SUM(CASE WHEN blob4 IN ('failure', 'error') THEN _sample_interval ELSE 0 END)
    / SUM(_sample_interval) AS fail_rate,
  SUM(_sample_interval) AS runs
FROM "flare-actions-ci"
WHERE index1 = 'job.terminal' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY repo, job HAVING runs >= 5
ORDER BY fail_rate DESC, runs DESC LIMIT 50
```

Seat vs runner duration split:

```sql
SELECT blob6 AS executor,
  quantileWeighted(0.5, double1, _sample_interval) AS p50_ms,
  SUM(_sample_interval) AS jobs
FROM "flare-actions-ci"
WHERE index1 = 'job.terminal' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY executor
```

Dispatch volume by trigger:

```sql
SELECT blob5 AS trigger, COUNT(DISTINCT blob2) AS runs
FROM "flare-actions-ci"
WHERE index1 = 'run.dispatched' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY trigger ORDER BY runs DESC
```

## Basin (cold path)

Basin Pipelines (GA Oct 2026) ingests the worker's events over a
`CI_EVENTS` stream binding and lands them as Iceberg rows in R2 for
Basin SQL. Basin is a paid-plan product, so the binding is never
committed: `basinSink()` reads it defensively off `env` and returns
`undefined` when absent.

### Provisioning

`npm run setup` creates the `flare-ci-events` stream (best-effort —
free-plan failures print and continue) and prints the stream id. The
generated seats config gets the binding automatically; the main
worker needs one line in `wrangler.jsonc` (setup leaves the committed
config untouched), then a redeploy:

```jsonc
{ "pipelines": [{ "binding": "CI_EVENTS", "stream": "<STREAM_ID>" }] }
```

Manual equivalent:

```bash
npx wrangler pipelines streams create flare-ci-events
npx wrangler pipelines streams get flare-ci-events   # copy the id
```

Attach a sink (Iceberg table via Basin Catalog) in the dashboard or
with `npx wrangler pipelines sinks`, then query with Basin SQL (or
DuckDB/Spark/Snowflake against the Iceberg table — no egress fees).

### Record schema v1

Flat JSON per event (`basin.ts`, append-only):

```jsonc
{ "v": 1, "event": "job.terminal", "repo": "o/r", "run_id": "…",
  "job": "test", "status": "success", "trigger": "", "executor": "seat",
  "duration_ms": 1234, "count": 0, "attempts": 1, "ts": "2026-10-05T…" }
```

Field use matches the AE slots: `count` = job count on run events,
`duration_ms` on terminal events, `attempts` on `job.terminal`.

### Basin SQL cookbook

(Table name depends on the sink; `ci_events` below is a placeholder.)

```sql
-- Monthly failure rate by repo (terminal runs, deduped)
SELECT repo, date_trunc('month', ts) AS month,
  COUNT(DISTINCT CASE WHEN status IN ('failure', 'error') THEN run_id END)
    * 1.0 / COUNT(DISTINCT run_id) AS fail_rate
FROM ci_events
WHERE event = 'run.terminal'
GROUP BY repo, month ORDER BY repo, month;

-- Jobs that only ever fail on one executor (runner vs seat skew)
SELECT repo, job,
  COUNT(DISTINCT CASE WHEN executor = 'runner' THEN run_id END) AS runner_runs,
  COUNT(DISTINCT CASE WHEN executor = 'seat' THEN run_id END) AS seat_runs,
  AVG(CASE WHEN status IN ('failure', 'error') THEN 1.0 ELSE 0.0 END) AS fail_rate
FROM ci_events
WHERE event = 'job.terminal'
GROUP BY repo, job HAVING runner_runs > 0 AND seat_runs > 0
ORDER BY fail_rate DESC LIMIT 50;
```

## AI Search: evaluated, not a sink

Cloudflare AI Search (GA Oct 2026, ex-AutoRAG) is a managed RAG
pipeline — Workers AI + Vectorize + R2 + Browser Run — for site and
document search, not a metrics sink; pointing CI events at it would
buy nothing over AE/Basin. The real future fit is retrieval over the
triage/log corpus ("which past failures look like this one") for
agents and the HealingAgent loop. That needs a curated corpus and a
provisioned instance (billing from Nov 2026), so it stays on the
roadmap until the corpus exists. See `ROADMAP.md`.
