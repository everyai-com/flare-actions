-- Mirror trunk sync: GitHub pushes to the repo's default branch
-- fast-forward the Artifacts mirror's same-named branch (best effort,
-- once per pushed sha), so Forge sees a current trunk.
--   default_branch  GitHub's default branch (webhook stamps it)
--   trunk_sha       last sha a seat claimed to sync (conditional claim:
--                   concurrent jobs of one push sync exactly once)
--   trunk_detail    outcome (syncing | pushed | up-to-date | diverged |
--                   error text, token-scrubbed)
--   trunk_at        when trunk_detail was written
ALTER TABLE artifacts_mirrors ADD COLUMN default_branch TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts_mirrors ADD COLUMN trunk_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts_mirrors ADD COLUMN trunk_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts_mirrors ADD COLUMN trunk_at TEXT NOT NULL DEFAULT '';
