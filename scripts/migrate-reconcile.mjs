// Reconcile `wrangler d1 migrations apply` with databases the worker already
// self-healed.
//
// The worker runs ensureSchema() (apps/worker/src/schema.ts) on every
// request, creating the latest tables and best-effort ALTERing new columns
// onto pre-existing databases. That lets one-click deploys boot with no
// manual migration step — but it also means a live database can already
// contain a migration's effect (e.g. sessions.kind) while d1_migrations has
// no record of it. The tracked ALTER migrations are bare `ADD COLUMN` —
// SQLite has no `IF NOT EXISTS` for that — so a later `migrations apply`
// fails with "duplicate column name".
//
// applyMigrationsWithReconcile() automates the repair: when apply fails on a
// duplicate column, it marks the first pending migration applied if (and
// only if) that migration's own SQL adds the offending column, then retries.
// Anything else fails exactly as before. Each iteration marks one migration
// and the loop is bounded by the local file count, so it always terminates.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// `run` matches scripts/setup.mjs: (cmd, args, opts) => { stdout, stderr, status }.

// Extract the offending column from a failed apply's output, e.g.
// "duplicate column name: kind: SQLITE_ERROR". Null when the failure is
// anything else.
export function parseDuplicateColumn(output) {
  const m = /duplicate column name:\s*([A-Za-z_][\w$]*)/i.exec(output);
  return m ? m[1] : null;
}

// Applied migration filenames from `wrangler d1 execute --json` output,
// shaped [{ results: [{ name }], ... }]. Throws on unparseable input.
export function parseAppliedNames(d1JsonOutput) {
  const parsed = JSON.parse(d1JsonOutput);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const results = first?.results ?? [];
  return results.map((r) => r?.name).filter((n) => typeof n === "string");
}

// First local migration (sorted) with no applied record, or null when the
// database is fully migrated.
export function findFirstPending(localFiles, appliedNames) {
  const applied = new Set(appliedNames);
  return localFiles.filter((f) => f.endsWith(".sql")).sort().find((f) => !applied.has(f)) ?? null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True when the migration SQL adds the given column via ALTER TABLE.
export function migrationAddsColumn(migrationSql, column) {
  return new RegExp(`ADD\\s+COLUMN\\s+${escapeRegExp(column)}\\b`, "i").test(migrationSql);
}

// Plain filenames only: the pending name is interpolated into an INSERT, so
// anything outside migration-file charset refuses to reconcile.
export function isSafeMigrationName(name) {
  return /^[A-Za-z0-9_.-]+\.sql$/.test(name);
}

// Mark one already-effective migration applied. Returns true when apply
// should be retried, false when the failure is not a reconcilable
// self-heal race (caller fails with the original error).
export function tryReconcileOne({ run, dbName, config, migrationsDir, localFiles, output, log }) {
  const column = parseDuplicateColumn(output);
  if (!column) return false;
  const applied = run("npx", [
    "wrangler", "d1", "execute", dbName, "--remote",
    "--command", "SELECT name FROM d1_migrations",
    "--json", "--config", config,
  ]);
  if (applied.status !== 0) return false;
  let appliedNames;
  try {
    appliedNames = parseAppliedNames(applied.stdout);
  } catch {
    return false;
  }
  const pending = findFirstPending(localFiles, appliedNames);
  if (!pending || !isSafeMigrationName(pending)) return false;
  const sql = readFileSync(join(migrationsDir, pending), "utf8");
  if (!migrationAddsColumn(sql, column)) return false;
  const ins = run("npx", [
    "wrangler", "d1", "execute", dbName, "--remote",
    "--command", `INSERT INTO d1_migrations (name) VALUES ('${pending}')`,
    "--config", config,
  ]);
  if (ins.status !== 0) return false;
  log(`reconciled ${pending}: column ${column} already present (worker self-heal), marked applied`);
  return true;
}

// Apply pending migrations, reconciling self-healed databases. Throws with
// the wrangler output on any non-reconcilable failure.
export function applyMigrationsWithReconcile({ run, dbName, config, migrationsDir, log = console.log }) {
  const localFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (let attempt = 0; attempt <= localFiles.length; attempt++) {
    const r = run("npx", ["wrangler", "d1", "migrations", "apply", dbName, "--remote", "--config", config]);
    if (r.status === 0) return;
    const output = `${r.stdout}\n${r.stderr}`;
    if (!tryReconcileOne({ run, dbName, config, migrationsDir, localFiles, output, log })) {
      throw new Error(`migrations failed:\n${r.stdout}\n${r.stderr}`);
    }
  }
  throw new Error("migrations failed: reconcile loop exhausted without converging");
}
