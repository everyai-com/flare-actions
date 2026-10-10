# Demo goals and designed interactions

> Provenance: agent-drafted. Every interaction below was checked with
> `node scripts/verify-scenarios.mjs` (25/25 scenarios as designed,
> Node 24.12, macOS, 2026-10-10). The machine-readable source of truth is
> [`seed/goals.json`](seed/goals.json); this page explains it.

Three goals, 13 intents. Each intent has a title, reasoning, a declared
footprint, an accept check, and a scripted reference solution in
[`agents/solutions/<intent>.mjs`](agents/solutions). The footprint map is
designed so that **most intents run in parallel lanes**, and exactly four
things go "wrong" in specific, repeatable ways.

## Goals and intents

### g1: Make every request observable

| Intent | Footprint (besides its own test) | Lane |
|---|---|---|
| `g1-request-id`: tag requests with `x-request-id` and log it | `src/middleware/logging.ts` | **conflicts with `g3-log-latency`** |
| `g1-health-version`: version + uptime on `/health` | `src/routes/health.ts` | disjoint |
| `g1-metrics`: catalog gauges at `GET /metrics` | `src/routes/metrics.ts` (new), `src/index.ts` | **overlaps `g3-rate-limit`, merges clean** |
| `g1-error-codes`: stable `code` in error bodies | `src/lib/errors.ts` | disjoint |

### g2: Make the catalog nicer to browse

| Intent | Footprint (besides its own test) | Lane |
|---|---|---|
| `g2-author-books`: `GET /authors/:id/books` | `src/routes/authors.ts` | disjoint |
| `g2-default-page-size`: `/books` default page 20 → 30 | `src/routes/books.ts` | **semantic conflict with `g3-max-page-size`** |
| `g2-fuzzy-search`: case-insensitive substring `?q=` | `src/lib/store.ts` | disjoint |
| `g2-isbn-validation`: reject bad ISBN-13 checksums | `src/lib/validate.ts` | disjoint |

### g3: Harden the API for public launch

| Intent | Footprint (besides its own test) | Lane |
|---|---|---|
| `g3-api-key-rotation`: accept a comma-separated key list | `src/auth/apiKey.ts` | **protected: awaiting_plan** |
| `g3-max-page-size`: cap pages at 25 | `src/lib/pagination.ts` | **semantic conflict with `g2-default-page-size`** |
| `g3-rate-limit`: per-IP fixed-window limit, 429 | `src/middleware/rateLimit.ts` (new), `src/index.ts` | **overlaps `g1-metrics`, merges clean** |
| `g3-log-latency`: `durationMs` on access-log lines | `src/middleware/logging.ts` | **conflicts with `g1-request-id`** |
| `g3-cors-allowlist`: `CORS_ORIGINS` allowlist | `src/middleware/cors.ts` | disjoint |

Every intent also creates exactly one new test file
(`test/<intent-suffix>.test.ts`), which is its accept check. No intent
edits a baseline test, so test files never overlap.

## Designed interactions

### 1. Overlap that merges cleanly: `g1-metrics` + `g3-rate-limit` on `src/index.ts`

- **Declare time:** both footprints list `src/index.ts`, so each intent's
  `declare_intent` returns the other in `overlaps[]` before any code is
  written. This is the Q1 "awareness" beat ("agent 2 is changing
  `src/index.ts` because ...").
- **Edits:** `g1-metrics` adds an import *after the health import* and a
  `...metricsRoutes,` line in the **route table**. `g3-rate-limit` adds
  an import *after the logging import* and rewrites the single
  **middleware-chain** line. Three unchanged lines separate the two
  import insertions; the file's own header comment says to keep the
  regions apart.
- **Outcome:** `git merge` is clean in either order; the combined suite
  is green. Lanes may still serialize them (same file), but no conflict
  object is opened.

### 2. Real textual conflict: `g1-request-id` + `g3-log-latency` on `src/middleware/logging.ts`

- **Declare time:** both list `src/middleware/logging.ts`; overlap shown.
- **Edits:** both change `formatLogLine`'s signature, its
  `JSON.stringify(...)` line, and the body of `withLogging`. Same lines.
- **Outcome:** whichever lands second hits a git conflict in
  `src/middleware/logging.ts` (verified in both orders;
  every changed hunk overlaps). The stale diff also no longer applies:
  `agents/apply.mjs g3-log-latency` fails with "anchor not found" on a
  trunk that has `g1-request-id`.
- **Resolution (replay):** re-derive the second intent on the new trunk
  with both intents' reasoning in context.
  `node agents/apply.mjs g3-log-latency . --replay-on g1-request-id`
  produces the reference replay: log lines carry both `requestId` and
  `durationMs`, and the suite is green. This is the Q2 conflict beat.

### 3. Semantic conflict ("green alone, red together"): `g2-default-page-size` + `g3-max-page-size`

- **Declare time:** footprints are **disjoint**
  (`src/routes/books.ts` vs `src/lib/pagination.ts`). No overlap is
  reported, and that is the point: path locality cannot see it.
- **Edits:** `DEFAULT_PAGE_SIZE` 20 → 30 in `books.ts`;
  `MAX_PAGE_SIZE` 50 → 25 in `pagination.ts`. Each is green alone
  (30 ≤ 50; 20 ≤ 25).
- **Outcome:** `git merge` is clean, but on the combined SHA
  `parseLimit` clamps the default to 25, and exactly 3 tests fail:
  - `contract: the default page size is servable` (baseline, `test/pagination.test.ts`)
  - `GET /books without ?limit= returns exactly DEFAULT_PAGE_SIZE items` (baseline, `test/pagination.test.ts`)
  - `GET /books returns 30 books per page by default` (`g2-default-page-size`'s own accept check)
- **What catches it:** only train CI on the exact combined SHA. A train
  containing both goes red and bisect isolates the pair. This is the Q2
  "one lane fails CI on the combined SHA, so it bisects" beat.

### 4. Protected path: `g3-api-key-rotation`

- Its footprint matches `src/auth/**` in
  [`.flare/policy.yml`](.flare/policy.yml), the only intent that does.
  It stops at `awaiting_plan` until a human approves the plan (one
  click), then proceeds like any other intent and lands green. This is
  the "Goal → plan" beat.

## Designed trains

| Train | Intents | Expected |
|---|---|---|
| `green-train` | all except `g3-log-latency`, `g3-max-page-size` (11) | merges clean, suite green |
| `red-train` | all except `g3-log-latency` (12) | merges clean, suite **red** (semantic pair) |

## Determinism notes

- No randomness reaches a test assertion: request ids are asserted by
  shape or echoed from a fixed header; `durationMs` by type only.
- `node --test` runs each test file in its own process, so the
  isolate-scoped store, sessions and rate-limit windows never leak
  between files. Files that depend on data call `resetStore()`.
- Merge order does not change any outcome above: the clean overlap is
  clean both ways, the textual conflict conflicts both ways, and the
  semantic failure depends only on the final constants.
- `seed/goals.json` footprints are checked against the files each
  reference solution actually touches, so the declared and actual
  footprints cannot drift silently.
