-- Monitors: rule-based alerts (Blacksmith monitors equivalent). A monitor
-- watches one repo (optionally one branch / job-name glob) and fires when
-- a terminal job result matches (with optional log substring + consecutive
-- streak), or while a job is still running past a duration threshold.
-- monitor_fires records one-shot duration alerts per job so the per-minute
-- cron never double-fires.
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  job TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  consecutive INTEGER NOT NULL DEFAULT 1,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  log_pattern TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  muted_until TEXT,
  streak INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitors_repo ON monitors(repo);
CREATE TABLE IF NOT EXISTS monitor_fires (
  monitor_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  PRIMARY KEY (monitor_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_monitor_fires_fired ON monitor_fires(fired_at);
