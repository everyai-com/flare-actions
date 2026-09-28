export interface RunRow {
  id: string;
  repo: string;
  sha: string;
  event: string;
  installation_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  run_id: string;
  status: string;
  log: string;
  created_at: string;
  updated_at: string;
}

export type Db = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(column?: string): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export function nowIso(): string {
  return new Date().toISOString();
}

export async function createRun(
  db: Db,
  run: { id: string; repo: string; sha: string; event: string; installationId: number | null },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO runs (id, repo, sha, event, installation_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
    )
    .bind(run.id, run.repo, run.sha, run.event, run.installationId, now, now)
    .run();
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

export async function listRuns(db: Db, limit = 50): Promise<RunRow[]> {
  const res = await db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<RunRow>();
  return res.results;
}

export async function updateRunStatus(db: Db, id: string, status: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), id)
    .run();
}

export async function createJob(db: Db, id: string, runId: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO jobs (id, run_id, status, log, created_at, updated_at) VALUES (?, ?, 'queued', '', ?, ?)",
    )
    .bind(id, runId, now, now)
    .run();
}

export async function getJobsForRun(db: Db, runId: string): Promise<JobRow[]> {
  const res = await db.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).all<JobRow>();
  return res.results;
}

export async function nextQueuedJob(db: Db): Promise<(JobRow & { repo: string; sha: string }) | null> {
  const row = await db
    .prepare(
      `SELECT j.*, r.repo, r.sha FROM jobs j JOIN runs r ON r.id = j.run_id
       WHERE j.status = 'queued' ORDER BY j.created_at ASC LIMIT 1`,
    )
    .bind()
    .first<JobRow & { repo: string; sha: string }>();
  return row;
}

export interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

export interface TokenPublic {
  id: string;
  name: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

export async function createToken(
  db: Db,
  token: { id: string; name: string; tokenHash: string; scopes: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO api_tokens (id, name, token_hash, scopes, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .bind(token.id, token.name, token.tokenHash, token.scopes, nowIso())
    .run();
}

export async function listTokens(db: Db): Promise<TokenPublic[]> {
  const res = await db
    .prepare("SELECT id, name, scopes, created_at, revoked_at FROM api_tokens ORDER BY created_at DESC")
    .bind()
    .all<TokenPublic>();
  return res.results;
}

export async function findLiveToken(db: Db, tokenHash: string): Promise<TokenRow | null> {
  return db
    .prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(tokenHash)
    .first<TokenRow>();
}

export async function revokeToken(db: Db, id: string): Promise<boolean> {
  const current = await db.prepare("SELECT id FROM api_tokens WHERE id = ?").bind(id).first<{ id: string }>();
  if (!current) return false;
  await db
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(nowIso(), id)
    .run();
  return true;
}

export async function updateJob(
  db: Db,
  id: string,
  patch: { status?: string; log?: string },
): Promise<void> {
  const current = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!current) return;
  const status = patch.status ?? current.status;
  const log = patch.log ?? current.log;
  await db
    .prepare("UPDATE jobs SET status = ?, log = ?, updated_at = ? WHERE id = ?")
    .bind(status, log, nowIso(), id)
    .run();
}
