-- Per-repo egress allowlist (floor policy for every job fanned out
-- for the repo). Missing row = no policy (observe-only accounting).
-- Domains are a normalized JSON array (lowercase hostnames, <=32,
-- validated once on write by the shared pipeline.ts validator), so
-- enforcement-time reads never re-validate.
CREATE TABLE IF NOT EXISTS repo_egress_allow (
  repo TEXT PRIMARY KEY,
  domains TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
