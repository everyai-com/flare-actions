import { describe, expect, it } from "vitest";
import {
  compileLogQuery,
  deleteJobLogIndex,
  detectLogLevel,
  indexJobLog,
  searchLogs,
  selectIndexLines,
  type LogHit,
} from "./search";
import type { Db } from "./db";

class MemDb implements Db {
  rows: LogHit[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT job_id, run_id, repo, branch, level, line, created_at FROM log_fts WHERE")) {
            return { results: this.match(norm, values) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("DELETE FROM log_fts WHERE job_id")) {
            this.rows = this.rows.filter((r) => r.job_id !== (values[0] as string));
            return {};
          }
          if (norm.startsWith("DELETE FROM log_fts WHERE run_id")) {
            this.rows = this.rows.filter((r) => r.run_id !== (values[0] as string));
            return {};
          }
          if (norm.startsWith("INSERT INTO log_fts")) {
            for (let i = 0; i < values.length; i += 7) {
              const [line, job_id, run_id, repo, branch, level, created_at] = values.slice(i, i + 7) as string[];
              this.rows.push({ line, job_id, run_id, repo, branch, level, created_at });
            }
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }

  // Naive MATCH evaluator for single terms, phrases, AND/OR/NOT, and
  // one level of parens — enough to verify plumbing; FTS5 itself is
  // covered by the staging smoke test.
  private match(norm: string, values: unknown[]): LogHit[] {
    const where = norm.slice(norm.indexOf("WHERE") + 5, norm.lastIndexOf("ORDER BY"));
    let vi = 1; // values[0] is the MATCH expression
    let out = this.rows.filter((r) => this.matchExpr(values[0] as string, r.line));
    const eat = (): string => values[vi++] as string;
    for (const clause of where.split(" AND ")) {
      const c = clause.trim();
      if (c === "log_fts MATCH ?") continue;
      if (c === "repo = ?") {
        const v = eat();
        out = out.filter((r) => r.repo === v);
      } else if (c === "branch = ?") {
        const v = eat();
        out = out.filter((r) => r.branch === v);
      } else if (c === "level = ?") {
        const v = eat();
        out = out.filter((r) => r.level === v);
      } else if (c === "run_id = ?") {
        const v = eat();
        out = out.filter((r) => r.run_id === v);
      } else if (c === "job_id = ?") {
        const v = eat();
        out = out.filter((r) => r.job_id === v);
      } else if (c.startsWith("(lower(repo)")) {
        const inM = /IN \(([^)]*)\)/.exec(c);
        const nExact = inM ? ((inM[1].match(/\?/g) ?? []).length) : 0;
        const nLike = (c.match(/LIKE \?/g) ?? []).length;
        const exact = new Set((values.slice(vi, vi + nExact) as string[]).map((s) => s.toLowerCase()));
        const patterns = values.slice(vi + nExact, vi + nExact + nLike) as string[];
        vi += nExact + nLike;
        out = out.filter((r) => {
          const low = r.repo.toLowerCase();
          if (exact.has(low)) return true;
          return patterns.some((p) => low.startsWith(p.replace(/\\(.)/g, "$1").replace(/%$/, "")));
        });
      }
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  private matchExpr(expr: string, line: string): boolean {
    const lower = line.toLowerCase();
    const lit = (t: string): boolean => lower.includes(t.replace(/^"|"$/g, "").toLowerCase());
    for (const orPart of this.splitTop(expr, " OR ")) {
      const andParts = this.splitTop(orPart, " AND ");
      let ok = true;
      for (let part of andParts) {
        part = part.trim();
        let neg = false;
        if (part.startsWith("NOT ")) {
          neg = true;
          part = part.slice(4).trim();
        }
        let hit: boolean;
        if (part.startsWith("(") && part.endsWith(")")) hit = this.matchExpr(part.slice(1, -1), line);
        else hit = lit(part);
        if (neg ? hit : !hit) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  private splitTop(expr: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (let i = 0; i < expr.length; ) {
      if (expr[i] === "(") {
        depth++;
        cur += expr[i++];
      } else if (expr[i] === ")") {
        depth--;
        cur += expr[i++];
      } else if (depth === 0 && expr.startsWith(sep, i)) {
        parts.push(cur);
        cur = "";
        i += sep.length;
      } else {
        cur += expr[i++];
      }
    }
    parts.push(cur);
    return parts;
  }
}

function mustCompile(q: string) {
  const c = compileLogQuery(q);
  if ("error" in c) throw new Error(`compile failed: ${c.error}`);
  return c.query;
}

describe("detectLogLevel", () => {
  it("classifies error/warn/info lines", () => {
    expect(detectLogLevel("Error: boom")).toBe("error");
    expect(detectLogLevel("test FAILED")).toBe("error");
    expect(detectLogLevel("panic: nil deref")).toBe("error");
    expect(detectLogLevel("warning: slow")).toBe("warn");
    expect(detectLogLevel("deprecated flag")).toBe("warn");
    expect(detectLogLevel("all good")).toBe("info");
    expect(detectLogLevel("--- step 1 ---")).toBe("info");
  });
});

describe("selectIndexLines", () => {
  it("keeps short logs whole and truncates long lines", () => {
    expect(selectIndexLines("a\n\nb")).toEqual(["a", "b"]);
    expect(selectIndexLines("x".repeat(500))).toEqual(["x".repeat(280)]);
  });
  it("keeps head and tail of oversized logs", () => {
    const log = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join("\n");
    const sel = selectIndexLines(log);
    expect(sel).toHaveLength(500);
    expect(sel[0]).toBe("line-0");
    expect(sel[149]).toBe("line-149");
    expect(sel[150]).toBe("line-650");
    expect(sel[499]).toBe("line-999");
  });
});

describe("compileLogQuery", () => {
  it("compiles bare terms to AND", () => {
    expect(mustCompile("failure panic").match).toBe('"failure" AND "panic"');
  });
  it("supports phrases, OR, parens, and negation", () => {
    expect(mustCompile('"econn refused"').match).toBe('"econn refused"');
    expect(mustCompile("(failure OR panic) -flaky").match).toBe('("failure" OR "panic") AND NOT "flaky"');
  });
  it("extracts field filters", () => {
    const q = mustCompile("branch:main level:error boom");
    expect(q.match).toBe('"boom"');
    expect(q.branch).toBe("main");
    expect(q.level).toBe("error");
  });
  it("rejects bad level values and empty queries", () => {
    expect(compileLogQuery("level:banana x")).toHaveProperty("error");
    expect(compileLogQuery("   ")).toHaveProperty("error");
    expect(compileLogQuery("repo:x")).toHaveProperty("error");
    expect(compileLogQuery("(a OR")).toHaveProperty("error");
    expect(compileLogQuery('"unterminated')).toHaveProperty("error");
  });
  it("treats unknown fields as literals and escapes quotes", () => {
    const q = mustCompile("weird:thing");
    expect(q.match).toBe('"weird:thing"');
    expect(q.repo).toBeUndefined();
  });
});

describe("index + search round trip", () => {
  const job = { jobId: "job-1", runId: "run-1", repo: "o/r", branch: "main", createdAt: "2026-10-05T00:00:00.000Z" };

  it("indexes and finds lines with filters", async () => {
    const db = new MemDb();
    const n = await indexJobLog(db, { ...job, log: "starting up\nError: boom failed\nwarning: slow\nall done" });
    expect(n).toBe(4);
    expect((await searchLogs(db, mustCompile("boom"), [], 50)).map((h) => h.line)).toEqual(["Error: boom failed"]);
    expect(await searchLogs(db, mustCompile("level:error boom"), [], 50)).toHaveLength(1);
    expect(await searchLogs(db, mustCompile("level:warn boom"), [], 50)).toHaveLength(0);
    expect(await searchLogs(db, mustCompile("branch:main (boom OR slow)"), [], 50)).toHaveLength(2);
    expect(await searchLogs(db, mustCompile("branch:other boom"), [], 50)).toHaveLength(0);
  });
  it("re-indexing replaces and delete clears", async () => {
    const db = new MemDb();
    await indexJobLog(db, { ...job, log: "first version" });
    await indexJobLog(db, { ...job, log: "second version" });
    expect(await searchLogs(db, mustCompile("first"), [], 50)).toHaveLength(0);
    expect(await searchLogs(db, mustCompile("second"), [], 50)).toHaveLength(1);
    await deleteJobLogIndex(db, "job-1");
    expect(await searchLogs(db, mustCompile("second"), [], 50)).toHaveLength(0);
  });
  it("enforces token repo scopes", async () => {
    const db = new MemDb();
    await indexJobLog(db, { ...job, log: "boom here" });
    await indexJobLog(db, { ...job, jobId: "job-2", repo: "o/other", log: "boom there" });
    expect(await searchLogs(db, mustCompile("boom"), ["o/r"], 50)).toHaveLength(1);
    expect(await searchLogs(db, mustCompile("boom"), [], 50)).toHaveLength(2);
    expect(await searchLogs(db, mustCompile("boom"), ["o/*"], 50)).toHaveLength(2);
    expect(await searchLogs(db, mustCompile("boom"), ["other/*"], 50)).toHaveLength(0);
  });
});
