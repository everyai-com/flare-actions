-- GitHub runner mode (`runs-on: flare`): GitHub keeps orchestrating and
-- Flare registers one ephemeral JIT self-hosted runner per job, so
-- existing workflows keep GitHub's checks/logs/UI while the machine
-- comes from Flare capacity. Rows mirror the workflow_job webhook
-- lifecycle; a claim mints the JIT config at claim time (1h TTL) and
-- stores the runner id so a stale claim can delete the orphaned runner
-- before requeueing. Off by default (github_runner_mode).
CREATE TABLE IF NOT EXISTS gh_runner_jobs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  installation_id INTEGER,
  run_id TEXT NOT NULL DEFAULT '',
  run_attempt INTEGER NOT NULL DEFAULT 1,
  job_name TEXT NOT NULL DEFAULT '',
  workflow_name TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  conclusion TEXT,
  runner_id INTEGER,
  runner_name TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  claimed_by TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gh_runner_jobs_status_created ON gh_runner_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_gh_runner_jobs_repo_created ON gh_runner_jobs(repo, created_at);
