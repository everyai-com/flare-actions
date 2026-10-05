-- Global log search: FTS5 index over bounded per-job log slices.
-- Only `line` is tokenized; the rest are carried columns for filters.
CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(
  line, job_id UNINDEXED, run_id UNINDEXED, repo UNINDEXED,
  branch UNINDEXED, level UNINDEXED, created_at UNINDEXED
);
