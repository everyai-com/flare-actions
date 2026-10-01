import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyMigrationsWithReconcile,
  findFirstPending,
  isSafeMigrationName,
  migrationAddsColumn,
  parseAppliedNames,
  parseDuplicateColumn,
  tryReconcileOne,
} from "./migrate-reconcile.mjs";

const DUPLICATE_ERROR = [
  "✘ [ERROR] A request to the Cloudflare API (/accounts/acct/d1/database/db/query) failed.",
  "",
  "  duplicate column name: kind: SQLITE_ERROR [code: 7500]",
].join("\n");

function appliedJson(names) {
  return JSON.stringify([{ results: names.map((name) => ({ name })), success: true }]);
}

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("parseDuplicateColumn", () => {
  it("extracts the column from wrangler's duplicate-column error", () => {
    expect(parseDuplicateColumn(DUPLICATE_ERROR)).toBe("kind");
  });
  it("returns null for unrelated failures", () => {
    expect(parseDuplicateColumn("✘ [ERROR] network timeout")).toBeNull();
    expect(parseDuplicateColumn("")).toBeNull();
  });
});

describe("parseAppliedNames", () => {
  it("reads names from d1 execute --json output", () => {
    expect(parseAppliedNames(appliedJson(["0001_init.sql", "0002_tokens.sql"]))).toEqual([
      "0001_init.sql",
      "0002_tokens.sql",
    ]);
  });
  it("returns an empty list for a fresh database", () => {
    expect(parseAppliedNames(appliedJson([]))).toEqual([]);
  });
});

describe("findFirstPending", () => {
  it("returns the first sorted file with no applied record", () => {
    expect(findFirstPending(["0002_tokens.sql", "0001_init.sql"], ["0001_init.sql"])).toBe("0002_tokens.sql");
  });
  it("returns null when everything is applied", () => {
    expect(findFirstPending(["0001_init.sql"], ["0001_init.sql"])).toBeNull();
  });
  it("ignores non-sql files", () => {
    expect(findFirstPending(["README.md"], [])).toBeNull();
  });
});

describe("migrationAddsColumn", () => {
  it("matches ADD COLUMN case-insensitively with varied spacing", () => {
    expect(migrationAddsColumn("ALTER TABLE sessions ADD COLUMN kind TEXT;", "kind")).toBe(true);
    expect(migrationAddsColumn("alter table s add  column  kind text;", "KIND")).toBe(true);
  });
  it("rejects other columns and prefix matches", () => {
    expect(migrationAddsColumn("ALTER TABLE sessions ADD COLUMN kind TEXT;", "email")).toBe(false);
    expect(migrationAddsColumn("ALTER TABLE sessions ADD COLUMN kindred TEXT;", "kind")).toBe(false);
    expect(migrationAddsColumn("CREATE TABLE IF NOT EXISTS users (email TEXT);", "email")).toBe(false);
  });
});

describe("isSafeMigrationName", () => {
  it("accepts plain migration filenames", () => {
    expect(isSafeMigrationName("0008_session_kind.sql")).toBe(true);
  });
  it("rejects anything quotable or traversable", () => {
    expect(isSafeMigrationName("0008'; DROP TABLE d1_migrations;--.sql")).toBe(false);
    expect(isSafeMigrationName("../evil.sql")).toBe(false);
  });
});

describe("tryReconcileOne", () => {
  const dir = () =>
    fixtureDir({
      "0001_init.sql": "CREATE TABLE IF NOT EXISTS t (a TEXT);",
      "0002_add_kind.sql": "ALTER TABLE t ADD COLUMN kind TEXT NOT NULL DEFAULT '';",
    });
  function stubRun(handlers) {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args.join(" "));
      for (const h of handlers) {
        const r = h(args);
        if (r) return r;
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    };
    return { run, calls };
  }

  it("marks the pending migration applied when its SQL adds the duplicate column", () => {
    const logs = [];
    const { run, calls } = stubRun([
      (args) =>
        args.includes("SELECT name FROM d1_migrations")
          ? { stdout: appliedJson(["0001_init.sql"]), stderr: "", status: 0 }
          : null,
      (args) =>
        args.some((a) => a.includes("INSERT INTO d1_migrations"))
          ? { stdout: "", stderr: "", status: 0 }
          : null,
    ]);
    const ok = tryReconcileOne({
      run,
      dbName: "db",
      config: "wrangler.jsonc",
      migrationsDir: dir(),
      localFiles: ["0001_init.sql", "0002_add_kind.sql"],
      output: DUPLICATE_ERROR,
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.includes("VALUES ('0002_add_kind.sql')"))).toBe(true);
    expect(logs.join("\n")).toContain("0002_add_kind.sql");
  });

  it("refuses when the failure is not a duplicate column", () => {
    const { run, calls } = stubRun([]);
    expect(
      tryReconcileOne({
        run,
        dbName: "db",
        config: "wrangler.jsonc",
        migrationsDir: dir(),
        localFiles: ["0001_init.sql", "0002_add_kind.sql"],
        output: "✘ [ERROR] network timeout",
        log: () => {},
      }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses when the pending migration does not add that column", () => {
    const { run, calls } = stubRun([
      (args) =>
        args.includes("SELECT name FROM d1_migrations")
          ? { stdout: appliedJson(["0001_init.sql", "0002_add_kind.sql"]), stderr: "", status: 0 }
          : null,
    ]);
    const migrationsDir = fixtureDir({
      "0001_init.sql": "CREATE TABLE IF NOT EXISTS t (a TEXT);",
      "0002_add_kind.sql": "ALTER TABLE t ADD COLUMN kind TEXT;",
      "0003_users.sql": "CREATE TABLE IF NOT EXISTS users (email TEXT);",
    });
    expect(
      tryReconcileOne({
        run,
        dbName: "db",
        config: "wrangler.jsonc",
        migrationsDir,
        localFiles: ["0001_init.sql", "0002_add_kind.sql", "0003_users.sql"],
        output: DUPLICATE_ERROR,
        log: () => {},
      }),
    ).toBe(false);
    expect(calls.some((c) => c.includes("INSERT INTO d1_migrations"))).toBe(false);
  });

  it("refuses when the applied-names query fails", () => {
    const { run } = stubRun([
      (args) =>
        args.includes("SELECT name FROM d1_migrations") ? { stdout: "", stderr: "no such table", status: 1 } : null,
    ]);
    expect(
      tryReconcileOne({
        run,
        dbName: "db",
        config: "wrangler.jsonc",
        migrationsDir: dir(),
        localFiles: ["0001_init.sql", "0002_add_kind.sql"],
        output: DUPLICATE_ERROR,
        log: () => {},
      }),
    ).toBe(false);
  });
});

describe("applyMigrationsWithReconcile", () => {
  it("returns after a clean apply", () => {
    const dir = fixtureDir({ "0001_init.sql": "CREATE TABLE IF NOT EXISTS t (a TEXT);" });
    let applies = 0;
    applyMigrationsWithReconcile({
      run: () => {
        applies++;
        return { stdout: "", stderr: "", status: 0 };
      },
      dbName: "db",
      config: "wrangler.jsonc",
      migrationsDir: dir,
      log: () => {},
    });
    expect(applies).toBe(1);
  });

  it("reconciles once then succeeds on retry", () => {
    const dir = fixtureDir({ "0001_add_kind.sql": "ALTER TABLE t ADD COLUMN kind TEXT;" });
    const calls = [];
    applyMigrationsWithReconcile({
      run: (_cmd, args) => {
        const line = args.join(" ");
        calls.push(line);
        if (line.includes("migrations apply")) {
          const attempts = calls.filter((c) => c.includes("migrations apply")).length;
          return attempts === 1
            ? { stdout: "", stderr: DUPLICATE_ERROR, status: 1 }
            : { stdout: "", stderr: "", status: 0 };
        }
        if (line.includes("SELECT name FROM d1_migrations")) return { stdout: appliedJson([]), stderr: "", status: 0 };
        if (line.includes("INSERT INTO d1_migrations")) return { stdout: "", stderr: "", status: 0 };
        throw new Error(`unexpected call: ${line}`);
      },
      dbName: "db",
      config: "wrangler.jsonc",
      migrationsDir: dir,
      log: () => {},
    });
    expect(calls.filter((c) => c.includes("migrations apply")).length).toBe(2);
    expect(calls.some((c) => c.includes("VALUES ('0001_add_kind.sql')"))).toBe(true);
  });

  it("throws the wrangler output on non-reconcilable failures", () => {
    const dir = fixtureDir({ "0001_init.sql": "CREATE TABLE IF NOT EXISTS t (a TEXT);" });
    expect(() =>
      applyMigrationsWithReconcile({
        run: () => ({ stdout: "", stderr: "✘ [ERROR] network timeout", status: 1 }),
        dbName: "db",
        config: "wrangler.jsonc",
        migrationsDir: dir,
        log: () => {},
      }),
    ).toThrow("network timeout");
  });
});

describe("real tracked migrations", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const migrationsDir = join(root, "apps/worker/migrations");
  // Durable guard: the real 0008 self-heal race this module exists to repair.
  it("pairs 0008 with the sessions.kind duplicate-column error", () => {
    const localFiles = readdirSync(migrationsDir);
    expect(localFiles).toContain("0008_session_kind.sql");
    const applied = localFiles.filter((f) => f !== "0008_session_kind.sql");
    expect(findFirstPending(localFiles, applied)).toBe("0008_session_kind.sql");
    const sql = readFileSync(join(migrationsDir, "0008_session_kind.sql"), "utf8");
    expect(migrationAddsColumn(sql, parseDuplicateColumn(DUPLICATE_ERROR))).toBe(true);
  });

  it("every migration file in the directory is a safe name", () => {
    mkdirSync(migrationsDir, { recursive: true });
    for (const f of readdirSync(migrationsDir)) {
      if (f.endsWith(".sql")) expect(isSafeMigrationName(f)).toBe(true);
    }
  });
});
