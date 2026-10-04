-- Agent priority lane: higher-priority queued jobs are claimed first
-- (0 default, 10 max). Lets an agent's verify loop jump the queue.
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
