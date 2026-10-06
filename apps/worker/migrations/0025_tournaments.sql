-- Agent tournaments: one task races N agents in isolated Artifacts forks.
-- attempts.verdict_rank and verdicts/ledger rows land in later steps;
-- winner_run_id/resolved_sha resolve the tournament (blessed pointer,
-- upgraded to a real fast-forward when available). See tournaments.ts.
CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  base_ref TEXT NOT NULL DEFAULT 'main',
  base_sha TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  winner_run_id TEXT,
  resolved_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  fork_repo TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'claimed',
  last_seen_sha TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  verdict_rank INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tournament_id, agent)
);
CREATE TABLE IF NOT EXISTS verdicts (
  tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  ranking TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_tournament ON attempts(tournament_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tournament ON ledger(tournament_id);
