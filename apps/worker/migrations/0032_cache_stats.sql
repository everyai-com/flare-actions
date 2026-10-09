-- Shared-warm-cache stats: daily-aggregate hit/miss counters per cache
-- scope (the key prefix before the first "/" or "-"). One upsert per
-- cache GET keeps D1 writes bounded (no per-event rows); the trailing
-- 7-day rollup is the "one cache, ten agents" proof.
CREATE TABLE IF NOT EXISTS cache_stats (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);
CREATE INDEX IF NOT EXISTS idx_cache_stats_day ON cache_stats(day);
