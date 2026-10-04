-- Source dispatch (run a working tree, no commit) and PR summaries:
-- runs.source holds the uploaded tarball id; pr_number/pr_comment_id
-- drive the single, updated PR comment per run.
ALTER TABLE runs ADD COLUMN source TEXT;
ALTER TABLE runs ADD COLUMN pr_number INTEGER;
ALTER TABLE runs ADD COLUMN pr_comment_id INTEGER;
