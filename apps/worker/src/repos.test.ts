import { describe, expect, it } from "vitest";
import {
  getRepoBlob,
  getRepoCommits,
  getRepoInfo,
  getRepoTree,
  listAllowedRepos,
  listRepos,
  normalizeRepoPath,
  validateRef,
  validateRepoName,
  type ReposArtifacts,
  type ReposCommit,
  type ReposRepoHandle,
} from "./repos";

const COMMIT_A: ReposCommit = {
  hash: "a".repeat(40),
  treeHash: "t".repeat(40),
  message: "first",
  author: { name: "Ada", email: "ada@x.dev" },
  committer: { name: "Ada", email: "ada@x.dev" },
  parents: [],
  authoredAt: 100,
  committedAt: 100,
};

const COMMIT_B: ReposCommit = {
  ...COMMIT_A,
  hash: "b".repeat(40),
  message: "second",
  parents: [COMMIT_A.hash],
  committedAt: 200,
};

function fakeArtifacts(over: {
  repos?: Array<{ name: string; defaultBranch?: string }>;
  log?: ReposCommit[];
  trees?: Record<string, Array<{ name: string; type: string; hash: string; mode: string }>>;
  files?: Record<string, string | null>;
  missing?: boolean;
} = {}): ReposArtifacts {
  const repos = (over.repos ?? [{ name: "demo" }]).map((r) => ({
    id: `id-${r.name}`,
    name: r.name,
    description: null,
    defaultBranch: r.defaultBranch ?? "main",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    lastPushAt: "2026-01-02T00:00:00Z",
    source: null,
    readOnly: false,
  }));
  const handle: ReposRepoHandle = {
    info: async () => ({ ...repos[0], remote: "https://example.invalid/x" }),
    log: async (opts) => (opts?.ref === "missing" ? [] : (over.log ?? [COMMIT_B, COMMIT_A]).slice(0, opts?.limit ?? 50)),
    readTree: async (hash) => over.trees?.[hash] ?? null,
    readCommit: async () => null,
    readFile: async ({ path }) => {
      const body = over.files?.[path];
      if (body === undefined || body === null) return null;
      return { size: body.length, text: async () => body };
    },
  };
  return {
    get: async (name) => {
      if (over.missing || !repos.some((r) => r.name === name)) {
        throw Object.assign(new Error("repo not found"), { code: "NOT_FOUND" });
      }
      return handle;
    },
    list: async () => ({ repos, total: repos.length }),
  };
}

describe("validators", () => {
  it("accepts artifact repo names and refs, rejects traversal", () => {
    expect(validateRepoName("demo-1.x")).toBe("demo-1.x");
    expect(validateRepoName("-bad")).toBeNull();
    expect(validateRepoName("")).toBeNull();
    expect(validateRef("main", "main")).toBe("main");
    expect(validateRef("", "main")).toBe("main");
    expect(validateRef("has space", "main")).toBeNull();
    expect(normalizeRepoPath("")).toBe("");
    expect(normalizeRepoPath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("/src//a.ts/")).toBe("src/a.ts");
    expect(normalizeRepoPath("../escape")).toBeNull();
    expect(normalizeRepoPath("a/./b")).toBeNull();
    expect(normalizeRepoPath("a//b")).toBe("a/b");
  });
});

describe("listRepos + getRepoInfo", () => {
  it("lists summaries and resolves the head commit", async () => {
    const artifacts = fakeArtifacts({ repos: [{ name: "demo" }, { name: "other" }] });
    const page = await listRepos(artifacts, 50);
    expect(page.repos.map((r) => r.name)).toEqual(["demo", "other"]);
    const info = await getRepoInfo(artifacts, "demo");
    expect(info?.head?.hash).toBe(COMMIT_B.hash);
  });

  it("returns null for missing repos and empty heads", async () => {
    expect(await getRepoInfo(fakeArtifacts({ missing: true }), "demo")).toBeNull();
    const empty = await getRepoInfo(fakeArtifacts({ log: [] }), "demo");
    expect(empty?.head).toBeNull();
  });
});

describe("getRepoTree", () => {
  const trees = {
    [COMMIT_B.treeHash]: [
      { name: "src", type: "tree", hash: "s".repeat(40), mode: "40000" },
      { name: "README.md", type: "blob", hash: "r".repeat(40), mode: "100644" },
    ],
    ["s".repeat(40)]: [{ name: "a.ts", type: "blob", hash: "f".repeat(40), mode: "100644" }],
  };

  it("lists the root with directories first", async () => {
    const tree = await getRepoTree(fakeArtifacts({ trees }), "demo", "main", "");
    expect(tree?.entries.map((e) => e.name)).toEqual(["src", "README.md"]);
  });

  it("descends into subdirectories and rejects files-as-dirs", async () => {
    const artifacts = fakeArtifacts({ trees });
    expect((await getRepoTree(artifacts, "demo", "main", "src"))?.entries.map((e) => e.name)).toEqual(["a.ts"]);
    expect(await getRepoTree(artifacts, "demo", "main", "README.md")).toBeNull();
    expect(await getRepoTree(artifacts, "demo", "main", "nope")).toBeNull();
  });

  it("returns null for bad refs and missing repos", async () => {
    const artifacts = fakeArtifacts({ trees });
    expect(await getRepoTree(artifacts, "demo", "missing", "")).toBeNull();
    expect(await getRepoTree(fakeArtifacts({ missing: true }), "demo", "main", "")).toBeNull();
  });
});

describe("getRepoBlob", () => {
  it("reads text files and flags binaries", async () => {
    const artifacts = fakeArtifacts({ files: { "a.ts": "export const x = 1;\n", "bin": "a\0b" } });
    expect((await getRepoBlob(artifacts, "demo", "main", "a.ts"))?.text).toBe("export const x = 1;\n");
    const bin = await getRepoBlob(artifacts, "demo", "main", "bin");
    expect(bin?.binary).toBe(true);
    expect(bin?.text).toBeNull();
    expect(await getRepoBlob(artifacts, "demo", "main", "gone")).toBeNull();
    expect(await getRepoBlob(artifacts, "demo", "main", "")).toBeNull();
  });

  it("truncates oversized files without loading them whole", async () => {
    const big = "x".repeat(300 * 1024);
    const blob = await getRepoBlob(fakeArtifacts({ files: { big } }), "demo", "main", "big");
    expect(blob?.truncated).toBe(true);
    expect(blob?.text?.length).toBe(256 * 1024);
  });
});

describe("getRepoCommits", () => {
  it("maps history newest-first and nulls on missing repos", async () => {
    const commits = await getRepoCommits(fakeArtifacts({}), "demo", "main", 10);
    expect(commits?.map((c) => c.hash)).toEqual([COMMIT_B.hash, COMMIT_A.hash]);
    expect(commits?.[0].authorName).toBe("Ada");
    expect(await getRepoCommits(fakeArtifacts({ missing: true }), "demo", "main", 10)).toBeNull();
  });
});

describe("listAllowedRepos", () => {
  // Paging fake: cursor is the next index; honors the requested limit.
  function pagedArtifacts(names: string[]): { artifacts: ReposArtifacts; limits: number[] } {
    const base = fakeArtifacts({ repos: names.map((name) => ({ name })) });
    const limits: number[] = [];
    const all = names.map((name) => ({
      id: `id-${name}`, name, description: null, defaultBranch: "main",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
      lastPushAt: null, source: null, readOnly: false,
    }));
    return {
      limits,
      artifacts: {
        get: base.get,
        list: async (opts) => {
          const start = opts?.cursor ? Number(opts.cursor) : 0;
          const limit = opts?.limit ?? 50;
          limits.push(limit);
          const end = start + limit;
          return { repos: all.slice(start, end), total: all.length, ...(end < all.length ? { cursor: String(end) } : {}) };
        },
      },
    };
  }

  it("passes through unscoped with the namespace total", async () => {
    const { artifacts } = pagedArtifacts(["a", "b", "c"]);
    const page = await listAllowedRepos(artifacts, 2, undefined, null);
    expect(page.repos.map((r) => r.name)).toEqual(["a", "b"]);
    expect(page.total).toBe(3);
    expect(page.cursor).toBe("2");
  });

  it("refills past filtered pages without skipping repos", async () => {
    const names = ["x1", "x2", "ok1", "x3", "ok2", "ok3", "x4"];
    const { artifacts, limits } = pagedArtifacts(names);
    const allow = (n: string) => n.startsWith("ok");
    const first = await listAllowedRepos(artifacts, 2, undefined, allow);
    expect(first.repos.map((r) => r.name)).toEqual(["ok1", "ok2"]);
    expect(limits.every((l) => l <= 2)).toBe(true);
    const second = await listAllowedRepos(artifacts, 2, first.cursor, allow);
    expect(second.repos.map((r) => r.name)).toEqual(["ok3"]);
    expect(second.cursor).toBeUndefined();
  });
});
