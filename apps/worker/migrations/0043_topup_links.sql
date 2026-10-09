-- Flare Cloud scaffold: single-use prepaid top-up links (hash-only
-- codes, pairing-style atomic consume; redeemed rows vanish).
CREATE TABLE IF NOT EXISTS topup_links (
  code_hash TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
