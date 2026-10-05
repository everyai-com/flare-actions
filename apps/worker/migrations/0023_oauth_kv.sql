-- Key-value store backing the MCP OAuth provider (clients, grants,
-- tokens, transactions). A D1 table instead of a KV namespace so one-click
-- deploys need no extra provisioning; see oauth-kv.ts. expires_at is
-- seconds-since-epoch or NULL for no expiry.
CREATE TABLE IF NOT EXISTS oauth_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
