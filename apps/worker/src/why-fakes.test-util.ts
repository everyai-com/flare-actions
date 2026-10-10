/// <reference types="node" />
// Test-only fakes for why/session tests: a node:sqlite D1 stand-in with
// the shipped schema.ts DDL, and an in-memory Artifacts repo (commits
// with files, first-parent log, readFile by ref or sha).
import type { Db } from "./db";
import type { ReposCommit } from "./repos";
import { SCHEMA_STATEMENTS } from "./schema";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

export const WHY_TABLES = [
  "goals",
  "intents",
  "conflicts",
  "trains",
  "intent_messages",
  "forge_ledger",
  "runs",
  "tournaments",
  "attempts",
  "verdicts",
  "ledger",
];

export function sqliteDb(tables: readonly string[] = WHY_TABLES): { db: Db; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const sql of SCHEMA_STATEMENTS) {
    const m = /(?:TABLE IF NOT EXISTS|ON) (\w+)/.exec(sql);
    if (m && tables.includes(m[1])) {
      try {
        raw.exec(sql);
      } catch {
        // Indexes over columns added by later ALTERs: irrelevant here.
      }
    }
  }
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
            run: async () => {
              const info = raw.prepare(query).run(...params) as { changes?: unknown };
              return { meta: { changes: Number(info.changes ?? 0) } };
            },
          };
        },
      };
    },
  } as unknown as Db;
  return { db, raw };
}

export interface FakeCommitSpec {
  hash: string;
  parents: string[];
  files: Record<string, string>;
  message?: string;
  author?: string;
}

export interface FakeRepo {
  refs: Map<string, string>;
  // ref-or-sha -> path -> text (extra blobs, e.g. notes/why branch).
  extraFiles: Map<string, Map<string, string>>;
  calls: { readFile: number; readCommit: number; log: number };
  log(opts?: { ref?: string; limit?: number }): Promise<ReposCommit[]>;
  readCommit(hash: string): Promise<ReposCommit | null>;
  readFile(args: { ref: string; path: string }): Promise<{ size: number; text(): Promise<string> } | null>;
}

export function fakeRepo(specs: FakeCommitSpec[], refs: Record<string, string>): FakeRepo {
  const byHash = new Map<string, FakeCommitSpec>(specs.map((s) => [s.hash, s]));
  const refMap = new Map(Object.entries(refs));
  const extraFiles = new Map<string, Map<string, string>>();
  const calls = { readFile: 0, readCommit: 0, log: 0 };
  const toCommit = (s: FakeCommitSpec, i: number): ReposCommit => ({
    hash: s.hash,
    treeHash: `t${s.hash}`.slice(0, 40),
    message: s.message ?? `commit ${s.hash.slice(0, 6)}`,
    author: { name: s.author ?? "human", email: `${s.author ?? "human"}@example.com` },
    committer: { name: "c", email: "c@example.com" },
    parents: s.parents,
    authoredAt: 1700000000 + i,
    committedAt: 1700000000 + i,
  });
  const resolve = (ref: string): string | null => refMap.get(ref) ?? (byHash.has(ref) ? ref : null);
  return {
    refs: refMap,
    extraFiles,
    calls,
    async log(opts = {}) {
      calls.log++;
      let h = resolve(opts.ref ?? "main");
      const out: ReposCommit[] = [];
      while (h && out.length < (opts.limit ?? 50)) {
        const s = byHash.get(h);
        if (!s) break;
        out.push(toCommit(s, specs.indexOf(s)));
        h = s.parents[0] ?? null;
      }
      return out;
    },
    async readCommit(hash) {
      calls.readCommit++;
      const s = byHash.get(hash);
      return s ? toCommit(s, specs.indexOf(s)) : null;
    },
    async readFile({ ref, path }) {
      calls.readFile++;
      const extra = extraFiles.get(ref)?.get(path);
      if (extra !== undefined) return { size: extra.length, text: async () => extra };
      const h = resolve(ref);
      const s = h ? byHash.get(h) : undefined;
      const text = s?.files[path];
      return text === undefined ? null : { size: text.length, text: async () => text };
    },
  };
}

// 40-hex sha from a short label (deterministic, distinct per label).
export function sha(label: string): string {
  let h = "";
  for (const ch of label) h += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return h.padEnd(40, "0").slice(0, 40);
}
