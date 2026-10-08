-- Tailscale-style runner pairing: the admin mints a short single-use
-- code (dashboard Access tab), and a fresh machine exchanges it for a
-- runner-scoped API token with one pasted command. Codes live 10
-- minutes; only SHA-256 hashes rest here, and the exchange consumes
-- the row atomically so a code can never mint two tokens.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
