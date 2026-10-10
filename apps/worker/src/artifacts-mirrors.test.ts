/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  ensureRepoMirror,
  mirrorNameFor,
  MIRROR_RETRY_MS,
  MIRROR_STALE_MS,
  type EnsureMirrorDeps,
  type MirrorArtifactsNamespace,
} from "./artifacts-mirrors";
import {
  claimMirrorTrunkSync,
  isMirrorRepo,
  recordMirrorTrunkSync,
  setMirrorDefaultBranch,
  setMirrorRow,
  type Db,
} from "./db";
import { SCHEMA_STATEMENTS } from "./schema";

interface Row {
  [k: string]: unknown;
}

// Routes the artifacts_mirrors SQL against an in-memory map.
class MirrorDb implements Db {
  mirrors = new Map<string, Row>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT repo, mirror, status, detail, updated_at, default_branch, trunk_sha, trunk_detail, trunk_at FROM artifacts_mirrors ORDER BY")) {
            return { results: [...this.mirrors.values()].sort((a, b) => ((a.repo as string) < (b.repo as string) ? -1 : 1)) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          if (norm.startsWith("SELECT repo, mirror, status, detail, updated_at FROM artifacts_mirrors WHERE")) {
            return (this.mirrors.get(values[0] as string) ?? null) as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO artifacts_mirrors")) {
            const [repo, mirror, status, detail, updated_at] = values as string[];
            this.mirrors.set(repo, { repo, mirror, status, detail: detail.slice(0, 300), updated_at });
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

interface FakeBindingOpts {
  onImport?: (url: string, name: string) => void;
  importThrows?: unknown;
  getThrows?: unknown;
  deleteThrows?: unknown;
}

function fakeBinding(opts: FakeBindingOpts = {}): MirrorArtifactsNamespace & { imports: string[]; deletes: string[] } {
  const imports: string[] = [];
  const deletes: string[] = [];
  return {
    imports,
    deletes,
    import: async (params: { source: { url: string }; target: { name: string } }) => {
      imports.push(`${params.source.url} -> ${params.target.name}`);
      opts.onImport?.(params.source.url, params.target.name);
      if (opts.importThrows !== undefined) throw opts.importThrows;
      return { remote: `https://x.artifacts.cloudflare.net/git/ns/${params.target.name}.git` };
    },
    get: async (name: string) => {
      if (opts.getThrows !== undefined) throw opts.getThrows;
      return { [Symbol.dispose]: () => undefined, name };
    },
    delete: async (name: string) => {
      deletes.push(name);
      if (opts.deleteThrows !== undefined) throw opts.deleteThrows;
      return true;
    },
  };
}

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const dbWith = (row?: Row): MirrorDb => {
  const db = new MirrorDb();
  if (row) db.mirrors.set(row.repo as string, row);
  return db;
};
const deps = (db: MirrorDb, artifacts: MirrorArtifactsNamespace | null, over: Partial<EnsureMirrorDeps> = {}): EnsureMirrorDeps => ({
  db,
  artifacts,
  repo: "o/r",
  isPrivate: false,
  nowMs: NOW,
  ...over,
});
const row = (db: MirrorDb, repo = "o/r"): Row | undefined => db.mirrors.get(repo);

describe("mirrorNameFor", () => {
  it("maps owner/name to the CLI-compatible mirror name", () => {
    expect(mirrorNameFor("o/r")).toBe("o-r");
    expect(mirrorNameFor("my-org/my.repo_x")).toBe("my-org-my.repo_x");
    expect(mirrorNameFor("nope")).toBeNull();
    expect(mirrorNameFor("a/b/c")).toBeNull();
    expect(mirrorNameFor("")).toBeNull();
    expect(mirrorNameFor(`o/${"r".repeat(100)}`)).toBeNull();
  });
});

describe("ensureRepoMirror", () => {
  it("skips without a binding and never writes", async () => {
    const db = dbWith();
    expect(await ensureRepoMirror(deps(db, null))).toEqual({ status: "skipped", reason: "no-binding" });
    expect(row(db)).toBeUndefined();
  });

  it("skips bad repo names without writing", async () => {
    const db = dbWith();
    expect(await ensureRepoMirror(deps(db, fakeBinding(), { repo: "nope" }))).toEqual({ status: "skipped", reason: "bad-name" });
    expect(row(db)).toBeUndefined();
  });

  it("imports public repos and marks them ready", async () => {
    const db = dbWith();
    const artifacts = fakeBinding();
    expect(await ensureRepoMirror(deps(db, artifacts))).toEqual({ status: "ready", mirror: "o-r" });
    expect(artifacts.imports).toEqual(["https://github.com/o/r.git -> o-r"]);
    expect(row(db)).toMatchObject({ repo: "o/r", mirror: "o-r", status: "ready" });
  });

  it("embeds the installation token for private repos", async () => {
    const db = dbWith();
    const artifacts = fakeBinding();
    const out = await ensureRepoMirror(deps(db, artifacts, { isPrivate: true, installationToken: "ghs_test" }));
    expect(out).toEqual({ status: "ready", mirror: "o-r" });
    expect(artifacts.imports).toEqual(["https://x-access-token:ghs_test@github.com/o/r.git -> o-r"]);
  });

  it("fails private repos without a token (retried next push)", async () => {
    const db = dbWith();
    const artifacts = fakeBinding();
    const out = await ensureRepoMirror(deps(db, artifacts, { isPrivate: true, installationToken: null }));
    expect(out.status).toBe("failed");
    expect(artifacts.imports).toEqual([]);
    expect(row(db)).toMatchObject({ status: "failed" });
  });

  it("adopts existing mirrors (manual CLI or earlier push)", async () => {
    const db = dbWith();
    const artifacts = fakeBinding({ importThrows: codedError("ALREADY_EXISTS") });
    expect(await ensureRepoMirror(deps(db, artifacts))).toEqual({ status: "ready", mirror: "o-r" });
    expect(row(db)).toMatchObject({ status: "ready" });
  });

  it("stays importing while another import runs", async () => {
    const db = dbWith();
    const artifacts = fakeBinding({ importThrows: codedError("ALREADY_EXISTS"), getThrows: codedError("IMPORT_IN_PROGRESS") });
    expect(await ensureRepoMirror(deps(db, artifacts))).toEqual({ status: "importing", mirror: "o-r" });
    expect(row(db)).toMatchObject({ status: "importing" });
  });

  it("fails unreadable mirrors and auth refusals with detail", async () => {
    const db = dbWith();
    const artifacts = fakeBinding({ importThrows: codedError("ALREADY_EXISTS"), getThrows: codedError("NOT_FOUND") });
    const out = await ensureRepoMirror(deps(db, artifacts));
    expect(out.status).toBe("failed");
    expect(row(db)).toMatchObject({ status: "failed" });

    const db2 = dbWith();
    const artifacts2 = fakeBinding({ importThrows: codedError("REMOTE_AUTH_REQUIRED") });
    const out2 = await ensureRepoMirror(deps(db2, artifacts2, { isPrivate: true, installationToken: "ghs_test" }));
    expect(out2.status).toBe("failed");
    expect(row(db2)?.detail as string).toContain("authentication refused");
  });

  it("fails generic import errors with the code (never the URL)", async () => {
    const db = dbWith();
    const artifacts = fakeBinding({ importThrows: codedError("MEMORY_LIMIT") });
    const out = await ensureRepoMirror(deps(db, artifacts));
    expect(out).toEqual({ status: "failed", mirror: "o-r", detail: "import MEMORY_LIMIT (retry on next push)" });
    expect(row(db)?.detail as string).not.toContain("github.com");
  });

  it("no-ops on ready rows without an RPC", async () => {
    const db = dbWith({ repo: "o/r", mirror: "o-r", status: "ready", detail: "", updated_at: new Date(NOW).toISOString() });
    const artifacts = fakeBinding();
    expect(await ensureRepoMirror(deps(db, artifacts))).toEqual({ status: "ready", mirror: "o-r" });
    expect(artifacts.imports).toEqual([]);
  });

  it("skips fresh importing rows and retries stale ones", async () => {
    const fresh = dbWith({
      repo: "o/r",
      mirror: "o-r",
      status: "importing",
      detail: "",
      updated_at: new Date(NOW - MIRROR_RETRY_MS + 1000).toISOString(),
    });
    const artifacts = fakeBinding();
    expect(await ensureRepoMirror(deps(fresh, artifacts))).toEqual({ status: "importing", mirror: "o-r" });
    expect(artifacts.imports).toEqual([]);

    const stale = dbWith({
      repo: "o/r",
      mirror: "o-r",
      status: "importing",
      detail: "",
      updated_at: new Date(NOW - MIRROR_STALE_MS - 1000).toISOString(),
    });
    const artifacts2 = fakeBinding();
    expect(await ensureRepoMirror(deps(stale, artifacts2))).toEqual({ status: "ready", mirror: "o-r" });
    expect(artifacts2.deletes).toEqual(["o-r"]);
    expect(artifacts2.imports).toHaveLength(1);
  });

  it("backs off fresh failed rows and retries aged ones", async () => {
    const fresh = dbWith({
      repo: "o/r",
      mirror: "o-r",
      status: "failed",
      detail: "import MEMORY_LIMIT (retry on next push)",
      updated_at: new Date(NOW - 1000).toISOString(),
    });
    const artifacts = fakeBinding();
    const out = await ensureRepoMirror(deps(fresh, artifacts));
    expect(out.status).toBe("failed");
    expect(artifacts.imports).toEqual([]);

    const aged = dbWith({
      repo: "o/r",
      mirror: "o-r",
      status: "failed",
      detail: "import MEMORY_LIMIT (retry on next push)",
      updated_at: new Date(NOW - MIRROR_RETRY_MS - 1000).toISOString(),
    });
    const artifacts2 = fakeBinding();
    expect(await ensureRepoMirror(deps(aged, artifacts2))).toEqual({ status: "ready", mirror: "o-r" });
    expect(artifacts2.imports).toHaveLength(1);
  });
});

// Trunk-sync bookkeeping against real SQLite (the claim's conditional
// UPDATE is the once-per-push guarantee, so test the actual SQL).
describe("mirror trunk sync rows", () => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  function sqlite(): Db {
    const raw = new DatabaseSync(":memory:");
    for (const stmt of SCHEMA_STATEMENTS) {
      if (/TABLE IF NOT EXISTS artifacts_mirrors\b/.test(stmt)) raw.exec(stmt);
    }
    return {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            const params = values as (string | number | null)[];
            return {
              all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
              first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
              run: async () => ({ meta: { changes: Number((raw.prepare(query).run(...params) as { changes?: unknown }).changes ?? 0) } }),
            };
          },
        };
      },
    } as unknown as Db;
  }

  it("claims once per sha, only for a ready mirror on its default branch", async () => {
    const db = sqlite();
    // No row yet: stamping the default branch and claiming are no-ops.
    await setMirrorDefaultBranch(db, "o/r", "main");
    expect(await claimMirrorTrunkSync(db, "o/r", "main", "s1")).toBe(false);
    await setMirrorRow(db, "o/r", "o-r", "ready", "");
    // Ready but no recorded default branch: no claim.
    expect(await claimMirrorTrunkSync(db, "o/r", "main", "s1")).toBe(false);
    await setMirrorDefaultBranch(db, "o/r", "main");
    expect(await claimMirrorTrunkSync(db, "o/r", "feat", "s1")).toBe(false);
    expect(await claimMirrorTrunkSync(db, "o/r", "main", "s1")).toBe(true);
    // Concurrent jobs/cells of the same push lose.
    expect(await claimMirrorTrunkSync(db, "o/r", "main", "s1")).toBe(false);
    await recordMirrorTrunkSync(db, "o/r", "s1", "pushed");
    const row = await db.prepare("SELECT trunk_sha, trunk_detail FROM artifacts_mirrors WHERE repo = ?").bind("o/r").first<Row>();
    expect(row).toEqual({ trunk_sha: "s1", trunk_detail: "pushed" });
    // A newer push claims; a stale outcome for s1 no longer overwrites.
    expect(await claimMirrorTrunkSync(db, "o/r", "main", "s2")).toBe(true);
    await recordMirrorTrunkSync(db, "o/r", "s1", "late");
    const after = await db.prepare("SELECT trunk_sha, trunk_detail FROM artifacts_mirrors WHERE repo = ?").bind("o/r").first<Row>();
    expect(after).toEqual({ trunk_sha: "s2", trunk_detail: "syncing" });
    // Re-importing keeps the trunk columns (upsert touches status only).
    await setMirrorRow(db, "o/r", "o-r", "failed", "x");
    expect(await claimMirrorTrunkSync(db, "o/r", "main", "s3")).toBe(false);
    expect(await isMirrorRepo(db, "o-r")).toBe(true);
    expect(await isMirrorRepo(db, "i-abc")).toBe(false);
  });
});
