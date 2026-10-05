# Self-Healing Runs

When `heal on failure` is on (dashboard Settings, off by default), a
failed run gets an agent repair attempt: a model proposes full-file
fixes, Flare pushes them to a new `flare-heal/*` branch, opens a
**draft** pull request, and dispatches a verification run on that
branch. The source run stays failed; a human must merge. Triage is
step one (diagnosis); healing is step two (proposed fix).

## Flow

1. **Request** — both executors call `requestHeal()` next to
   `triageAndStore` on failure/error. Cheap D1 guards plus one atomic
   `INSERT OR IGNORE` into `heal_claims`, so concurrent failure
   callbacks cannot queue duplicate heals for a run.
2. **Drain** — the worker's every-minute scheduled tick runs
   `processHealClaims` (production only, max 2 claims per tick):
   - Re-checks guards (toggle still on, run still red — a retry may
     have fixed it since the claim).
   - Clef judge gate (`judge.ts`): p(flaky) ≥ 0.5 skips the heal —
     transient failures heal by retrying, not by patching. Fails
     open (proceeds) on judge errors.
   - Mints an installation token, fetches the repo tree (300 paths),
     and calls Workers AI with failing steps + log tail + triage.
   - Parses a strict JSON proposal (`{files: [{path, content}],
     summary}`, ≤3 files, existing paths only, ≤8KB each; anything
     else rejects the whole patch).
   - Commits via the Git Data API to `flare-heal/<run>`, opens a
     draft PR against the run branch (or the repo default), stores
     the branch + PR URL on the run row, and dispatches a
     verification run with `source: heal:<runId>`.
3. **Surface** — the run digest carries
   `heal: {branch, prUrl}`; every outcome is audited (`run.healed`,
   `run.heal_failed`, `run.heal_skipped`).

## Guards (all must hold)

- Toggle `heal_on_failure` is `"1"`.
- The run has a GitHub App installation (token source for tree,
  push, and PR calls).
- The run is still `failure`/`error` at drain time.
- The run is not itself a `flare-heal/*` branch or a `heal:*`
  verification run — heals never recurse.
- The App grants `contents:write` (heal pushes) and
  `pull_requests:write` (draft PRs). Apps connected before the heal
  release must reinstall/accept the widened `contents` scope; the
  Connect manifest requests it for new apps.

Heals never throw into request paths: every stage degrades to
skip/fail with an audit entry, and a failed verification dispatch
still leaves the draft PR up for review.

## Cost and limits

Each heal costs one model call (`max_tokens: 2048`, same
`triage_model` setting), ~10 GitHub API calls, and one CI run. The
per-tick bound (2) caps stampedes after mass failures. Model output
is untrusted input: paths are traversal-guarded and deduped, new
files are refused, and only the named files change — the base tree
provides everything else.

## Verifying locally

The full loop needs a GitHub App + Workers AI, but the trigger path
is checkable with `wrangler dev`: turn the toggle on, dispatch a run
with an inline pipeline, set an `installation_id` on the run row,
fail the job via the status callback, and confirm a `pending` row in
`heal_claims`. The scheduled tick (`/__scheduled` route via
`/cdn-cgi/local/scheduled`) must leave it pending without creds.
