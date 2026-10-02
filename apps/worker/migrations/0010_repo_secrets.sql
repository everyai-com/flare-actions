CREATE TABLE IF NOT EXISTS repo_secrets (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, name)
);
CREATE INDEX IF NOT EXISTS idx_repo_secrets_repo ON repo_secrets(repo);
