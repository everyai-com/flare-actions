-- Attestation: content-addressed verdict receipts. A terminal run
-- files (repo, state-hash) -> verdict; a later dispatch of the
-- identical tree + suite + environment short-circuits to the recorded
-- verdict instead of running. UNIQUE(repo, hash) keeps reuse inside
-- one repo; runs.attested_by points a short-circuited run at its
-- receipt for the digest note.
CREATE TABLE IF NOT EXISTS attestation_receipts (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  verdict TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  jobs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (repo, hash)
);
CREATE INDEX IF NOT EXISTS idx_attestation_receipts_repo ON attestation_receipts(repo);
ALTER TABLE runs ADD COLUMN attested_by TEXT;
