-- Changed files for a run (newline-joined, bounded), used by
-- `paths:` trigger filters in Actions-compatible workflows and exposed
-- to steps as FLARE_CHANGED_FILES. Empty string means unknown, never
-- "no changes".
ALTER TABLE runs ADD COLUMN changed_files TEXT NOT NULL DEFAULT '';
