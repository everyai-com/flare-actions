-- Flare Forge (intent-native git): goals own intents; intents own one
-- Artifacts fork each (`i-<shortid>`); trains batch ready intents into
-- lanes and land them on trunk after CI on the exact combined SHA;
-- conflicts are claimable work items; intent_messages is the per-intent
-- mailbox (untrusted peer data, never instructions). forge_ledger is a
-- subject-generic audit trail: the tournament `ledger` table keeps its
-- NOT NULL tournament FK (SQLite cannot relax NOT NULL without a table
-- rebuild), so Forge writes here instead. States mirror intents-core.ts
-- (docs/COMPETITION-PLAN.md §3.2); update BOTH plus schema.ts together.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  text TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_repo_state ON goals(repo, state);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  repo TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  accept_check TEXT NOT NULL DEFAULT '',
  footprint_json TEXT NOT NULL DEFAULT '{"paths":[]}',
  actual_footprint_json TEXT,
  fork_repo TEXT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN (
    'draft', 'awaiting_plan', 'claimed', 'working', 'ready', 'in_train',
    'landed', 'conflicted', 'replaying', 'bisected', 'failed', 'expired',
    'abandoned')),
  risk INTEGER NOT NULL DEFAULT 0 CHECK (risk BETWEEN 0 AND 100),
  risk_terms_json TEXT NOT NULL DEFAULT '[]',
  base_sha TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  train_id TEXT,
  landed_sha TEXT,
  plan_approved_by TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_repo_state ON intents(repo, state);
CREATE INDEX IF NOT EXISTS idx_intents_goal ON intents(goal_id);
CREATE INDEX IF NOT EXISTS idx_intents_fork ON intents(fork_repo);
CREATE INDEX IF NOT EXISTS idx_intents_lease ON intents(state, lease_expires_at);
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  intent_a TEXT NOT NULL,
  intent_b TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'resolved', 'failed', 'abandoned')),
  resolver_agent TEXT,
  resolution_sha TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_repo_state ON conflicts(repo, state);
CREATE INDEX IF NOT EXISTS idx_conflicts_intent_a ON conflicts(intent_a);
CREATE INDEX IF NOT EXISTS idx_conflicts_intent_b ON conflicts(intent_b);
CREATE TABLE IF NOT EXISTS trains (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  lane INTEGER NOT NULL DEFAULT 0,
  base_sha TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  intents_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  state TEXT NOT NULL DEFAULT 'forming' CHECK (state IN (
    'forming', 'merging', 'verifying', 'landed', 'failed', 'bisected', 'aborted')),
  parent_train_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trains_repo_state ON trains(repo, state);
CREATE INDEX IF NOT EXISTS idx_trains_run ON trains(run_id);
CREATE TABLE IF NOT EXISTS intent_messages (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  to_intent TEXT NOT NULL,
  from_intent TEXT,
  from_agent TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_intent_messages_inbox ON intent_messages(to_intent, delivered_at, created_at);
CREATE TABLE IF NOT EXISTS forge_ledger (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('goal', 'intent', 'conflict', 'train')),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forge_ledger_subject ON forge_ledger(subject_kind, subject_id, created_at);
CREATE INDEX IF NOT EXISTS idx_forge_ledger_repo ON forge_ledger(repo, created_at);
