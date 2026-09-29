ALTER TABLE runs ADD COLUMN branch TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_runs_repo_branch ON runs(repo, branch);
ALTER TABLE jobs ADD COLUMN labels TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN started_at TEXT;
ALTER TABLE jobs ADD COLUMN finished_at TEXT;
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
