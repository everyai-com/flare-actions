-- Smart test selection: per-job skip reports (what ran, what was
-- skipped and why) plus the CI profile a run executed under (the
-- full-suite safety net keys off merge-candidate/nightly profiles).
ALTER TABLE runs ADD COLUMN profile TEXT;
CREATE TABLE IF NOT EXISTS test_selections (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  selected_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  selected_json TEXT NOT NULL DEFAULT '[]',
  skipped_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_selections_run ON test_selections(run_id);
