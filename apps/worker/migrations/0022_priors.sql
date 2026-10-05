-- Hourly per-job-name runtime priors (EMA of finished durations) and
-- the stamped prediction on each job row (0 = never seen).
CREATE TABLE IF NOT EXISTS job_runtime_priors (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  hour INTEGER NOT NULL,
  samples INTEGER NOT NULL DEFAULT 1,
  avg_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, name, hour)
);
ALTER TABLE jobs ADD COLUMN prior_ms INTEGER NOT NULL DEFAULT 0;
