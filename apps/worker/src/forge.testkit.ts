/// <reference types="node" />
// Test-only fakes for the forge surface: a node:sqlite D1 stand-in
// running the real schema.ts DDL, and an in-memory Artifacts namespace
// that models forks, commits, trees and fork-scoped tokens closely
// enough for verdict.changedFiles. Imported only by *.test.ts.
import type { Db } from "./db";
import type { ForgeArtifacts } from "./intents";
import type { TournamentRepoHandle, TournamentTreeEntry } from "./tournaments";
import { SCHEMA_STATEMENTS } from "./schema";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const TABLES = ["goals", "intents", "conflicts", "trains", "intent_messages", "forge_ledger", "audit_log"];

export function forgeSqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  for (const sql of SCHEMA_STATEMENTS) {
    const m = /(?:TABLE IF NOT EXISTS|ON) (\w+)/.exec(sql);
    if (m && TABLES.includes(m[1])) raw.exec(sql);
  }
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          if (values.length > 100) throw new Error("D1: too many SQL variables");
          const params = values.map((v) => (v === undefined ? null : v)) as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => ((raw.prepare(query).get(...params) ?? null) as T | null),
            run: async () => {
              const info = raw.prepare(query).run(...params);
              return { meta: { changes: Number(info.changes ?? 0) } };
            },
          };
        },
      };
    },
  };
}

export interface FakeRepo {
  commits: Map<string, Map<string, string>>; // sha -> path -> blob hash
  log: string[]; // newest first
  files: Map<string, string>; // path -> text at main (readFile)
}

export interface FakeArtifacts {
  artifacts: ForgeArtifacts;
  repos: Map<string, FakeRepo>;
  tokens: Array<{ repo: string; scope: string; ttl: number }>;
  commit(repo: string, sha: string, files: Record<string, string>, parent?: string): void;
}

export function sha(ch: string): string {
  return ch.repeat(40).slice(0, 40);
}

// One trunk `name` seeded with an initial commit.
export function fakeArtifacts(trunk = "demo", base = sha("0"), baseFiles: Record<string, string> = { "README.md": "r1", "src/api/a.ts": "a1" }): FakeArtifacts {
  const repos = new Map<string, FakeRepo>();
  const tokens: FakeArtifacts["tokens"] = [];
  const commit = (repo: string, s: string, files: Record<string, string>, parent?: string): void => {
    const r = repos.get(repo);
    if (!r) throw new Error(`no repo ${repo}`);
    const prev = parent ? r.commits.get(parent) : r.log[0] ? r.commits.get(r.log[0]) : undefined;
    const tree = new Map(prev ?? []);
    for (const [k, v] of Object.entries(files)) tree.set(k, v);
    r.commits.set(s, tree);
    r.log.unshift(s);
  };
  repos.set(trunk, { commits: new Map(), log: [], files: new Map() });
  commit(trunk, base, baseFiles);

  const handle = (name: string): TournamentRepoHandle => {
    const repo = (): FakeRepo => {
      const r = repos.get(name);
      if (!r) throw new Error(`no repo ${name}`);
      return r;
    };
    return {
      readFile: async ({ path }) => {
        const text = repo().files.get(path);
        return text === undefined ? null : { size: text.length, text: async () => text };
      },
      fork: async (forkName: string) => {
        if (repos.has(forkName)) {
          const err = new Error("exists") as Error & { code: string };
          err.code = "ALREADY_EXISTS";
          throw err;
        }
        const src = repo();
        repos.set(forkName, { commits: new Map(src.commits), log: [...src.log], files: new Map(src.files) });
        return { name: forkName, remote: `https://acct.artifacts.test/git/ns/${forkName}.git`, defaultBranch: "main" };
      },
      log: async () => repo().log.map((hash) => ({ hash })),
      readCommit: async (hash: string) => (repo().commits.has(hash) ? { treeHash: `tree:${hash}:` } : null),
      readTree: async (hash: string): Promise<TournamentTreeEntry[] | null> => {
        const m = /^tree:([0-9a-f]{40}):(.*)$/.exec(hash);
        if (!m) return null;
        const tree = repo().commits.get(m[1]);
        if (!tree) return null;
        const prefix = m[2];
        const out = new Map<string, TournamentTreeEntry>();
        for (const [path, blob] of tree) {
          if (prefix && !path.startsWith(`${prefix}/`)) continue;
          const rest = prefix ? path.slice(prefix.length + 1) : path;
          const [head, ...more] = rest.split("/");
          if (more.length) {
            const dir = prefix ? `${prefix}/${head}` : head;
            out.set(head, { name: head, mode: "40000", hash: `tree:${m[1]}:${dir}` });
          } else {
            out.set(head, { name: head, mode: "100644", hash: blob });
          }
        }
        return [...out.values()];
      },
      createToken: async (scope, ttl) => {
        repo();
        tokens.push({ repo: name, scope, ttl });
        return { plaintext: `tok-${scope}-${name}` };
      },
      [Symbol.dispose]: () => undefined,
    };
  };
  return { artifacts: { get: async (name: string) => handle(name) }, repos, tokens, commit };
}
