// Global log search over a D1 FTS5 index. Each terminal job contributes a
// bounded head+tail slice of its log (level-classified); the Lucene-like
// query language compiles to a parameterized FTS5 MATCH plus equality
// filters, so user input never reaches SQLite unescaped.
import { repoAllowSql, type Db } from "./db";

export interface LogHit {
  job_id: string;
  run_id: string;
  repo: string;
  branch: string;
  level: string;
  line: string;
  created_at: string;
}

export interface CompiledLogQuery {
  match: string;
  repo?: string;
  branch?: string;
  level?: string;
  runId?: string;
  jobId?: string;
}

// Index budget per job: head lines catch setup failures, tail lines
// catch the actual error. Full logs stay on the job row; the index is
// a search accelerator, not an archive.
export const LOG_INDEX_MAX_LINES = 500;
const LOG_INDEX_HEAD_LINES = 150;
export const LOG_INDEX_LINE_CHARS = 280;

export function detectLogLevel(line: string): "error" | "warn" | "info" {
  if (/\b(error|failed|failure|panic|traceback|exception|fatal)\b/i.test(line)) return "error";
  if (/\b(warn|warning|deprecated)\b/i.test(line)) return "warn";
  return "info";
}

export function selectIndexLines(log: string): string[] {
  const lines = log
    .split("\n")
    // Control chars are the point here (strip them before FTS indexing).
    // eslint-disable-next-line no-control-regex
    .map((l) => l.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > LOG_INDEX_LINE_CHARS ? l.slice(0, LOG_INDEX_LINE_CHARS) : l));
  if (lines.length <= LOG_INDEX_MAX_LINES) return lines;
  return [...lines.slice(0, LOG_INDEX_HEAD_LINES), ...lines.slice(lines.length - (LOG_INDEX_MAX_LINES - LOG_INDEX_HEAD_LINES))];
}

const INSERT_CHUNK_ROWS = 25;

export async function indexJobLog(
  db: Db,
  input: { jobId: string; runId: string; repo: string; branch: string; log: string; createdAt?: string },
): Promise<number> {
  await db.prepare("DELETE FROM log_fts WHERE job_id = ?").bind(input.jobId).run();
  const lines = selectIndexLines(input.log);
  if (lines.length === 0) return 0;
  const createdAt = input.createdAt ?? new Date().toISOString();
  for (let i = 0; i < lines.length; i += INSERT_CHUNK_ROWS) {
    const chunk = lines.slice(i, i + INSERT_CHUNK_ROWS);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values: unknown[] = [];
    for (const line of chunk) {
      values.push(line, input.jobId, input.runId, input.repo, input.branch, detectLogLevel(line), createdAt);
    }
    await db
      .prepare(`INSERT INTO log_fts (line, job_id, run_id, repo, branch, level, created_at) VALUES ${placeholders}`)
      .bind(...values)
      .run();
  }
  return lines.length;
}

export async function deleteJobLogIndex(db: Db, jobId: string): Promise<void> {
  await db.prepare("DELETE FROM log_fts WHERE job_id = ?").bind(jobId).run();
}

type Token =
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "or" }
  | { kind: "and" }
  | { kind: "not" }
  | { kind: "word"; text: string }
  | { kind: "phrase"; text: string };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const pushWord = (text: string): void => {
    const upper = text.toUpperCase();
    if (upper === "OR") tokens.push({ kind: "or" });
    else if (upper === "AND") tokens.push({ kind: "and" });
    else if (upper === "NOT") tokens.push({ kind: "not" });
    else tokens.push({ kind: "word", text });
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === "-") {
      tokens.push({ kind: "not" });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < input.length && input[j] !== '"') {
        text += input[j];
        j++;
      }
      if (j >= input.length) return null; // unterminated phrase
      tokens.push({ kind: "phrase", text });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < input.length && !/[\s()"]/.test(input[j])) j++;
    if (j === i) return null;
    pushWord(input.slice(i, j));
    i = j;
  }
  return tokens;
}

const FIELD_NAMES = ["repo", "branch", "level", "run", "job"] as const;

function sanitizeTerm(text: string): string | null {
  // Control chars are the point here (strip them from search terms).
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f"“”]/g, "").trim();
  if (!cleaned) return null;
  return `"${cleaned.replace(/"/g, '""')}"`;
}

// Recursive descent: or := and (OR and)* ; and := unary (AND? unary)* ;
// unary := NOT unary | primary ; primary := term | phrase | field | (or).
export function compileLogQuery(input: string): { query: CompiledLogQuery } | { error: string } {
  const tokens = tokenize(input.trim());
  if (!tokens || tokens.length === 0) return { error: "query must not be empty" };
  const compiled: CompiledLogQuery = { match: "" };
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  const parsePrimary = (): string | null => {
    const t = peek();
    if (!t) return null;
    if (t.kind === "lparen") {
      pos++;
      const inner = parseOr();
      if (inner === null || peek()?.kind !== "rparen") return null;
      pos++;
      return `(${inner})`;
    }
    if (t.kind === "word" || t.kind === "phrase") {
      pos++;
      const fieldMatch = t.kind === "word" ? /^([A-Za-z]+):(.*)$/.exec(t.text) : null;
      if (fieldMatch && (FIELD_NAMES as readonly string[]).includes(fieldMatch[1].toLowerCase())) {
        const value = fieldMatch[2].trim();
        if (!value) return null;
        const field = fieldMatch[1].toLowerCase();
        if (field === "repo") compiled.repo = value;
        else if (field === "branch") compiled.branch = value;
        else if (field === "level") {
          if (!["error", "warn", "info"].includes(value.toLowerCase())) return null;
          compiled.level = value.toLowerCase();
        } else if (field === "run") compiled.runId = value;
        else compiled.jobId = value;
        return "";
      }
      if (fieldMatch && t.text.includes(":")) {
        // Unknown field: treat the whole token as a literal term rather
        // than guessing (colons are common in log output).
      }
      return sanitizeTerm(t.text);
    }
    return null;
  };
  const parseUnary = (): string | null => {
    if (peek()?.kind === "not") {
      pos++;
      const inner = parseUnary();
      if (inner === null || inner === "") return null;
      return `NOT ${inner}`;
    }
    if (peek()?.kind === "and" || peek()?.kind === "or") return null;
    return parsePrimary();
  };
  const parseAnd = (): string | null => {
    const parts: string[] = [];
    for (;;) {
      const t = peek();
      if (!t || t.kind === "rparen" || t.kind === "or") break;
      if (t.kind === "and") {
        pos++;
        continue;
      }
      const unary = parseUnary();
      if (unary === null) return null;
      if (unary !== "") parts.push(unary);
    }
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return parts.map((p) => (p.includes(" OR ") && !(p.startsWith("(") && p.endsWith(")")) ? `(${p})` : p)).join(" AND ");
  };
  const parseOr = (): string | null => {
    const first = parseAnd();
    if (first === null) return null;
    const parts = [first];
    while (peek()?.kind === "or") {
      pos++;
      const next = parseAnd();
      if (next === null || next === "") return null;
      parts.push(next);
    }
    const nonEmpty = parts.filter((p) => p !== "");
    if (nonEmpty.length === 0) return "";
    return nonEmpty.join(" OR ");
  };

  const match = parseOr();
  if (match === null || pos !== tokens.length) return { error: "could not parse query (check quotes and parentheses)" };
  if (match === "") return { error: "query needs at least one search term outside field filters" };
  compiled.match = match;
  return { query: compiled };
}

export async function searchLogs(db: Db, compiled: CompiledLogQuery, allowedRepos: string[], limit: number): Promise<LogHit[]> {
  const clauses = ["log_fts MATCH ?"];
  const values: unknown[] = [compiled.match];
  if (compiled.repo) {
    clauses.push("repo = ?");
    values.push(compiled.repo);
  }
  if (compiled.branch) {
    clauses.push("branch = ?");
    values.push(compiled.branch);
  }
  if (compiled.level) {
    clauses.push("level = ?");
    values.push(compiled.level);
  }
  if (compiled.runId) {
    clauses.push("run_id = ?");
    values.push(compiled.runId);
  }
  if (compiled.jobId) {
    clauses.push("job_id = ?");
    values.push(compiled.jobId);
  }
  const scope = repoAllowSql(allowedRepos, "repo");
  if (scope.clause) {
    clauses.push(scope.clause);
    values.push(...scope.binds);
  }
  const res = await db
    .prepare(
      `SELECT job_id, run_id, repo, branch, level, line, created_at FROM log_fts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...values, Math.min(Math.max(limit, 1), 200))
    .all<LogHit>();
  return res.results;
}
