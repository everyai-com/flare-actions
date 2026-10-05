-- Self-healing runs (HealingAgent): one claim row per failed run so
-- concurrent failure callbacks cannot open duplicate heal PRs, plus
-- the surfaced heal branch/PR on the run row. See heal.ts.
CREATE TABLE IF NOT EXISTS heal_claims (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  branch TEXT,
  pr_url TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE runs ADD COLUMN heal_branch TEXT;
ALTER TABLE runs ADD COLUMN heal_pr_url TEXT;
