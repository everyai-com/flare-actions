import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { ensureSchema } from "./schema";

// A database from before the agent/profile columns: CREATE INDEX on
// a missing column throws (like real SQLite), ALTERs add columns.
// Regression test: indexes must apply AFTER the backfill ALTERs, or
// every request 500s with no path to self-heal (staging Oct 9).
class OldDb implements Db {
  runsColumns = new Set(["id", "repo", "sha", "event", "status", "created_at", "updated_at"]);
  createdTables = new Set<string>();
  createdIndexes = new Set<string>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (..._values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => ({ results: [] }),
        first: async <T,>(): Promise<T | null> => null,
        run: async (): Promise<unknown> => {
          const table = norm.match(/^CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/)?.[1];
          if (table) {
            this.createdTables.add(table);
            return {};
          }
          const index = norm.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)\(([^)]+)\)/);
          if (index) {
            const [, name, onTable, cols] = index;
            if (onTable === "runs") {
              for (const col of cols.split(",").map((c) => c.trim())) {
                if (!this.runsColumns.has(col)) throw new Error(`no such column: ${col}`);
              }
            }
            this.createdIndexes.add(name);
            return {};
          }
          const alter = norm.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/)?.slice(1);
          if (alter && alter[0] === "runs") {
            if (this.runsColumns.has(alter[1])) throw new Error("duplicate column");
            this.runsColumns.add(alter[1]);
            return {};
          }
          if (alter) return {};
          throw new Error(`unrouted run: ${norm.slice(0, 80)}`);
        },
      }),
    };
  }
}

describe("ensureSchema", () => {
  it("self-heals an old database: tables, backfill columns, then indexes", async () => {
    const db = new OldDb();
    await ensureSchema(db);
    // Backfilled columns exist and their indexes built.
    expect(db.runsColumns.has("agent")).toBe(true);
    expect(db.createdIndexes.has("idx_runs_agent")).toBe(true);
    // Late tables (past the old failure point) were created.
    for (const table of ["cache_stats", "devboxes", "credit_ledger", "topup_links"]) {
      expect(db.createdTables.has(table)).toBe(true);
    }
    expect(db.createdIndexes.has("idx_credit_ledger_ref")).toBe(true);
  });
});
