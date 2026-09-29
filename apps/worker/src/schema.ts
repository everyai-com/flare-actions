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
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    log TEXT NOT NULL DEFAULT '',
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
];

let schemaPromise: Promise<void> | null = null;

async function applySchema(db: Db): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) {
    await db.prepare(sql).bind().run();
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
