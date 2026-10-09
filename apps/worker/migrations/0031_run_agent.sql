-- Per-agent identity: dispatchers tag runs with an agent slug so
-- one agent's burst can be capped without throttling humans or other
-- agents (fair_share_per_agent), and usage/audit can attribute work.
-- Empty string = untagged (humans, webhooks, legacy clients): untagged
-- runs bypass the per-agent cap.
ALTER TABLE runs ADD COLUMN agent TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent);
