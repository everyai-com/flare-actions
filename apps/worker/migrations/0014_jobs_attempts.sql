-- Per-job retries: `retry: N` in a job definition requeues failed jobs
-- while attempts remain (attempts counts retries already used).
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
