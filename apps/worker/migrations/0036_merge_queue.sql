-- Agent merge queue: serialize agent PRs against a moving main —
-- enqueue, verify with real CI, land on green. One verifying entry
-- per repo at a time (see mergequeue.ts); changed_files feeds the
-- cross-agent collision radar generalized from the tournament radar.
CREATE TABLE IF NOT EXISTS merge_queue (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  head_sha TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  run_id TEXT,
  changed_files TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merge_queue_repo_status ON merge_queue(repo, status);
CREATE INDEX IF NOT EXISTS idx_merge_queue_repo_pr ON merge_queue(repo, pr_number);
