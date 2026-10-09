# Agent merge queue

Agent fleets break the per-push model: ten agents landing on a moving
main collide, rebase over each other, and merge red. The merge queue
serializes agent PRs — enqueue, rebase onto the current head, verify
with real CI, land on green — with cross-agent collision detection
generalized from the tournament collision radar
(`docs/TOURNAMENTS.md`, `verdict.detectCollisions`).

```
PR ──▶ enqueue ──▶ update-branch ──▶ verify (real CI) ──▶ land on green
                        │                  │
                        │   base moved ────┘──▶ re-queue (never lands stale)
                        ▼
                   park visibly (note, retried next tick)
```

## State

One D1 table, `merge_queue` (migration `0036`): the PR, its head SHA,
the base branch + the base SHA it is verified against, the agent tag,
status (`queued` → `verifying` → `landed` | `failed` | `cancelled`),
the live verification run, the PR file list (radar input), and a
human-visible note. One active entry per PR (re-enqueue is a 409);
terminal rows stay as history.

## Processing

The per-minute scheduled tick runs `processMergeQueue`
(`apps/worker/src/mergequeue.ts`, runtime-free with injected deps):

- One live verification per repo. The oldest queued entry rebases onto
  the current base head (GitHub update-branch), records its file list,
  and dispatches a verification run (`event: "merge-queue"`).
- A green run lands only when the verified base is still the head —
  otherwise the entry re-queues for a fresh verify (including when the
  base moves mid-verify). Red runs fail with the run id in the note.
- Landing is a GitHub merge of the PR head; a rejection fails visibly
  with GitHub's reason, never silently.
- Every GitHub op is best-effort like every other GitHub call:
  unreadable base, failed rebase, or missing App installation parks
  the entry with a note and retries next tick — never a 500.

## Surface

- `POST /v1/merge-queue` (`repo`, `pr`, `headSha`, optional
  `baseBranch`/`agent`) — enqueue, run scope, audited.
- `GET /v1/merge-queue?repo=` — entries (newest first) plus the
  collision radar over live entries (shared files, bounded).
- `DELETE /v1/merge-queue/:id` — cancel a queued/verifying entry.
- `cli mergequeue enqueue <repo> <pr> <sha> [--base b] [--agent a]` /
  `status <repo>` / `cancel <entryId>` (all `--json`-able).
- Dashboard Merge queue tab: entries, collisions, enqueue, cancel.

Needs the GitHub App installed on the repo (base reads, update-branch,
merge); without it entries park with a visible note.
