-- Artifacts mirror registry: one row per GitHub repo with a
-- hands-free mirror. status is importing (import in flight or
-- pending retry), ready (seat checkouts use it), or failed (see
-- detail; the next push retries). GitHub stays the source of truth,
-- so a row is dropped and re-imported freely — checkouts fall back
-- to GitHub whenever the mirror is anything but ready.
CREATE TABLE IF NOT EXISTS artifacts_mirrors (
  repo TEXT PRIMARY KEY,
  mirror TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'importing',
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
