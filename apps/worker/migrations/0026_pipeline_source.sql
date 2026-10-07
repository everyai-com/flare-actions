-- Which configuration produced a run's jobs: 'flare' (flare.yml),
-- 'actions' (.github/workflows drop-in), 'default' (echo fallback),
-- 'inline' (dispatched pipeline), 'source' (uploaded working tree).
-- Lets the dashboard explain what actually ran per run.
ALTER TABLE runs ADD COLUMN pipeline_source TEXT NOT NULL DEFAULT '';
