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
    source TEXT,
    pipeline_source TEXT NOT NULL DEFAULT '',
    changed_files TEXT NOT NULL DEFAULT '',
    pr_number INTEGER,
    pr_comment_id INTEGER,
    heal_branch TEXT,
    heal_pr_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_repo_branch ON runs(repo, branch)`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at)`,
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
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
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
    repos TEXT NOT NULL DEFAULT '',
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
  `CREATE TABLE IF NOT EXISTS auth_attempts (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    window_started_at TEXT NOT NULL,
    blocked_until TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    ref TEXT NOT NULL,
    cron TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT '',
    job TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT '',
    consecutive INTEGER NOT NULL DEFAULT 1,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    log_pattern TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    muted_until TEXT,
    streak INTEGER NOT NULL DEFAULT 0,
    last_fired_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_monitors_repo ON monitors(repo)`,
  `CREATE TABLE IF NOT EXISTS monitor_fires (
    monitor_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    PRIMARY KEY (monitor_id, job_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_monitor_fires_fired ON monitor_fires(fired_at)`,
  `CREATE TABLE IF NOT EXISTS test_reports (
    job_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    passed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_test_reports_run ON test_reports(run_id)`,
  `CREATE TABLE IF NOT EXISTS quarantined_tests (
    repo TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    reason TEXT NOT NULL DEFAULT '',
    green_streak INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, name)
  )`,
  `CREATE TABLE IF NOT EXISTS test_results (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    suite TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    classname TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    duration_ms INTEGER,
    message TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_test_results_run_status ON test_results(run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_test_results_job ON test_results(job_id)`,
  `CREATE TABLE IF NOT EXISTS seat_snapshots (
    image TEXT NOT NULL,
    repo TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (image, repo)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seat_snapshots_used ON seat_snapshots(last_used_at)`,
  `CREATE TABLE IF NOT EXISTS job_egress (
    job_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    host TEXT NOT NULL,
    req_bytes INTEGER NOT NULL DEFAULT 0,
    resp_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, host)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_egress_run ON job_egress(run_id)`,
  `CREATE TABLE IF NOT EXISTS gh_runner_jobs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    installation_id INTEGER,
    run_id TEXT NOT NULL DEFAULT '',
    run_attempt INTEGER NOT NULL DEFAULT 1,
    job_name TEXT NOT NULL DEFAULT '',
    workflow_name TEXT NOT NULL DEFAULT '',
    head_sha TEXT NOT NULL DEFAULT '',
    labels TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    conclusion TEXT,
    runner_id INTEGER,
    runner_name TEXT NOT NULL DEFAULT '',
    claimed_at TEXT,
    claimed_by TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gh_runner_jobs_status_created ON gh_runner_jobs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_gh_runner_jobs_repo_created ON gh_runner_jobs(repo, created_at)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(
    line, job_id UNINDEXED, run_id UNINDEXED, repo UNINDEXED,
    branch UNINDEXED, level UNINDEXED, created_at UNINDEXED
  )`,
  `CREATE TABLE IF NOT EXISTS job_runtime_priors (
    repo TEXT NOT NULL,
    name TEXT NOT NULL,
    hour INTEGER NOT NULL,
    samples INTEGER NOT NULL DEFAULT 1,
    avg_ms INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, name, hour)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS heal_claims (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    branch TEXT,
    pr_url TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tournaments (
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
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
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
  )`,
  `CREATE TABLE IF NOT EXISTS verdicts (
    tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
    ranking TEXT NOT NULL DEFAULT '[]',
    rationale TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_tournament ON attempts(tournament_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_tournament ON ledger(tournament_id)`,
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
];

// Additive columns for databases created before the matching migration.
// Each runs best-effort: "duplicate column" on an already-migrated
// database is the expected outcome, not an error.
export const ALTER_STATEMENTS = [
  `ALTER TABLE runs ADD COLUMN branch TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE runs ADD COLUMN source TEXT`,
  `ALTER TABLE runs ADD COLUMN pr_number INTEGER`,
  `ALTER TABLE runs ADD COLUMN pr_comment_id INTEGER`,
  `ALTER TABLE jobs ADD COLUMN labels TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE api_tokens ADD COLUMN repos TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN started_at TEXT`,
  `ALTER TABLE jobs ADD COLUMN finished_at TEXT`,
  `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'github'`,
  `ALTER TABLE jobs ADD COLUMN retained_until TEXT`,
  `ALTER TABLE jobs ADD COLUMN prior_ms INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN heal_branch TEXT`,
  `ALTER TABLE runs ADD COLUMN heal_pr_url TEXT`,
  `ALTER TABLE runs ADD COLUMN pipeline_source TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE runs ADD COLUMN changed_files TEXT NOT NULL DEFAULT ''`,
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
