-- Remote named warm dev boxes: one row per box. The box's
-- container lives in the BOXES Durable Object (`box-<name>`); this
-- row is the registry (listable) plus snapshot pointers
-- (snapshots is JSON: [{tag, snapshotId, createdAt}]).
-- Destroying a box deletes the row and the container.
CREATE TABLE IF NOT EXISTS devboxes (
  name TEXT PRIMARY KEY,
  image TEXT NOT NULL,
  workdir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  snapshots TEXT NOT NULL DEFAULT '[]'
);
