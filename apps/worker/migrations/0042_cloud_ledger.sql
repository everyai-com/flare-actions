-- Flare Cloud scaffold: prepaid credit ledger (grants + run spend).
-- Inert on self-hosted deploys (metering defaults off); the UNIQUE
-- ref makes run spend exactly-once across redelivered rollups.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_ref ON credit_ledger(ref);
