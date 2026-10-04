-- Auth endpoint rate limiting: failure counters per key (email,
-- hashed client IP). Rows are pruned by the writer once their window
-- closes without a live block.
CREATE TABLE IF NOT EXISTS auth_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT
);
