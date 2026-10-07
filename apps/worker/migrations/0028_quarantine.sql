-- Flaky auto-quarantine: tests detected as flaky move out of the
-- blocking gate (failures that are entirely quarantined don't fail the
-- job), auto-reinstate after a green streak. Managed by the hourly
-- fleet tick and the dashboard/CLI/API.
CREATE TABLE IF NOT EXISTS quarantined_tests (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  reason TEXT NOT NULL DEFAULT '',
  green_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, name)
);
