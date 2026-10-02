import type { Db } from "./db";

// Canonical schema, mirrored in migrations/*.sql for tracked history.
// ensureSchema lets one-click deploys boot a fresh, empty database with
// no manual migration step. The memoized promise is isolate-level cache,
// not request state.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    sha TEXT NOT NULL,
    event TEXT NOT NULL,
    installation_id INTEGER,
    branch TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_repo_branch ON runs(repo, branch)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    log TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    definition TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    triage TEXT NOT NULL DEFAULT '',
    labels TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_run_status ON jobs(run_id, status)`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT 'runner',
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(token_hash)`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    github_user TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'github',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS repo_secrets (
    repo TEXT NOT NULL,
    name TEXT NOT NULL,
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_repo_secrets_repo ON repo_secrets(repo)`,
];

// Additive columns for databases created before the matching migration.
// Each runs best-effort: "duplicate column" on an already-migrated
// database is the expected outcome, not an error.
export const ALTER_STATEMENTS = [
  `ALTER TABLE runs ADD COLUMN branch TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE jobs ADD COLUMN labels TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE jobs ADD COLUMN started_at TEXT`,
  `ALTER TABLE jobs ADD COLUMN finished_at TEXT`,
  `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'github'`,
];

let schemaPromise: Promise<void> | null = null;

async function applySchema(db: Db): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) {
    await db.prepare(sql).bind().run();
  }
  for (const sql of ALTER_STATEMENTS) {
    try {
      await db.prepare(sql).bind().run();
    } catch {
      // Column already exists on migrated databases.
    }
  }
}

export function ensureSchema(db: Db): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = applySchema(db).catch((err: unknown) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}
