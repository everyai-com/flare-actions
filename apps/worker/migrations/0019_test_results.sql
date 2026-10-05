-- Test analytics: per-job JUnit summaries plus bounded per-case rows.
-- Raw XML lives in R2 under test-reports/<job_id>.xml; D1 holds the
-- parsed summary (one row per job, replaced on re-upload) and the
-- individual cases (deleted with the job's report on re-upload or when
-- the retention sweep prunes the run).
CREATE TABLE IF NOT EXISTS test_reports (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_reports_run ON test_reports(run_id);
CREATE TABLE IF NOT EXISTS test_results (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  suite TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  classname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  duration_ms INTEGER,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_test_results_run_status ON test_results(run_id, status);
CREATE INDEX IF NOT EXISTS idx_test_results_job ON test_results(job_id);
