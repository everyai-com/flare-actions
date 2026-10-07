---
name: flare-verify
description: >-
  Verify code changes with Flare Actions instead of waiting on a queue.
  Use when a repo's AGENTS.md mentions Flare, before claiming a change
  passes CI, or when asked to run, watch, or fix CI. Runs the pipeline
  locally or on the server and reports the run digest.
---

# Flare verify

Flare Actions is the CI this repo verifies with. Agents get a one-call
verify loop — never poll, never sleep.

## The loop

1. **Local first** (no server, no commit):
   - `npm run check` — changed-file lint + one type check + affected tests.
   - `npx flare local` — runs the repo's `flare.yml` (or the working
     tree's `.github/workflows`) on this machine with a warm cache.
2. **Server verify** (the real pipeline, same result CI posts):
   - `npx flare run <owner/repo> HEAD` — dispatches, **waits**, and prints
     the digest. For uncommitted work: `npx flare run <repo> --source`.
   - MCP `run_and_wait` does the same in one call when the MCP server is
     connected (`npx flare mcp-config` prints the config).
3. **Read the digest, not the logs.** It contains the failing step, the
   bounded output tail, per-step durations, and triage. Full logs only
   when the digest says so.

## Rules

- Never claim "CI passed" without a digest (or a local run's exit code).
- On failure, fix the failing step from the digest's tail; don't re-run
  blindly. `npx flare flaky <repo>` explains flaky history.
- Tests under quarantine don't block runs
  (`npx flare quarantine list <repo>`); failures that are entirely
  quarantined land as success with a log note.
- Budgets may refuse dispatch (`429` / skipped webhook): the repo is over
  its monthly cap — surface it, don't retry in a loop.
- Slow checks: `npx flare bottlenecks <repo>` shows p50/p95 and queue
  wait before you blame the machine.

## Reporting back

Quote the digest verdict (run id, status, failing step + one tail line).
Link `https://<worker>/dashboard` runs for humans. Keep run IDs in the
final message; they are the receipt.
