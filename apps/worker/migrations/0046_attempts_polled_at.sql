-- Tournament poller fairness: every visit stamps polled_at and the
-- scan orders by it (oldest first), so attempts whose head never moves
-- cannot pin the LIMIT window and starve the rest.
ALTER TABLE attempts ADD COLUMN polled_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_attempts_polled ON attempts(polled_at);
