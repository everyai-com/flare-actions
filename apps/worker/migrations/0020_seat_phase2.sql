-- Phase 2 seats: snapshot-backed caches, per-job egress, retain-on-failure.
-- seat_snapshots keys on (image, repo): snapshots are tied to the image
-- version they were taken from, so lineage (not repo alone) scopes reuse.
-- One row per key; a fresh snapshot after each successful seat job replaces
-- the last. Platform TTL is 30 days; rows idle past that are pruned.
CREATE TABLE IF NOT EXISTS seat_snapshots (
  image TEXT NOT NULL,
  repo TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (image, repo)
);
CREATE INDEX IF NOT EXISTS idx_seat_snapshots_used ON seat_snapshots(last_used_at);
-- Per-job egress accounting (V2 seats proxy outbound HTTP through the
-- seat DO and count bytes per host). Bounded: one row per (job, host).
CREATE TABLE IF NOT EXISTS job_egress (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  host TEXT NOT NULL,
  req_bytes INTEGER NOT NULL DEFAULT 0,
  resp_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, host)
);
CREATE INDEX IF NOT EXISTS idx_job_egress_run ON job_egress(run_id);
-- Retain-on-failure: failed seats kept alive for debugging stay listed
-- here with their destroy deadline (NULL = not retained).
ALTER TABLE jobs ADD COLUMN retained_until TEXT;
