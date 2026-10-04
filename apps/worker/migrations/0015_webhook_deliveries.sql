-- Webhook delivery idempotency: GitHub retries (or manual redeliveries)
-- must not create duplicate runs. The X-GitHub-Delivery UUID is the key;
-- rows are pruned by the same sweep that prunes runs.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at);
