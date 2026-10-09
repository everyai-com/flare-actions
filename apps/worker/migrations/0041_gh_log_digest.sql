-- Lane log digests: bounded failing tail for runner-mode jobs,
-- fetched from the GitHub logs API on non-success completion.
ALTER TABLE gh_runner_jobs ADD COLUMN log_digest TEXT;
