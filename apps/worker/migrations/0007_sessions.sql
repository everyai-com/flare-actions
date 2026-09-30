CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  github_user TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
