-- Scheduled runs (cron, UTC). last_run_at dedupes trigger redeliveries
-- and shows in the dashboard whether a schedule is actually firing.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);
