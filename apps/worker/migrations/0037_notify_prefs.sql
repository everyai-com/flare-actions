-- Per-user notification attention prefs (quiet hours + new-failure-only
-- dedup). Missing row = defaults (no quiet hours, notify every red),
-- so existing deployments behave exactly as before.
CREATE TABLE IF NOT EXISTS notify_prefs (
  email TEXT PRIMARY KEY,
  quiet_start TEXT NOT NULL DEFAULT '',
  quiet_end TEXT NOT NULL DEFAULT '',
  new_failures_only INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
