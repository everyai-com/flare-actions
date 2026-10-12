import { describe, expect, it } from "vitest";
import { compatForTrunk, listTrunkWorkflowNames, loadTrunkCi, type TrunkCiArtifacts, type TrunkCiHandle } from "./trunk-ci";

const SHA = "a".repeat(40);

const CI_YML = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`;

const DEPLOY_YML = `name: Deploy
on:
  release:
    types: [published]
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`;

// In-memory git: commit -> root tree -> .github -> workflows -> files.
function fakeRepo(files: Record<string, string>, opts: { trees?: boolean } = {}): { handle: TrunkCiHandle; disposed: () => boolean } {
  let disposed = false;
  const workflowEntries = Object.keys(files)
    .filter((p) => p.startsWith(".github/workflows/"))
    .map((p) => ({ name: p.slice(".github/workflows/".length), mode: "100644", hash: `blob-${p}` }));
  const trees: Record<string, Array<{ name: string; mode: string; hash: string }>> = {
    root: [
      { name: "README.md", mode: "100644", hash: "blob-readme" },
      ...(workflowEntries.length ? [{ name: ".github", mode: "40000", hash: "t-github" }] : []),
    ],
    "t-github": [{ name: "workflows", mode: "40000", hash: "t-workflows" }],
    "t-workflows": [...workflowEntries, { name: "nested", mode: "40000", hash: "t-nested" }],
  };
  const handle: TrunkCiHandle = {
    readFile: async ({ path }) => {
      const text = files[path];
      return text === undefined ? null : { size: text.length, text: async () => text };
    },
    [Symbol.dispose]: () => {
      disposed = true;
    },
  };
  if (opts.trees !== false) {
    handle.readCommit = async (hash) => (hash === SHA ? { treeHash: "root" } : null);
    handle.readTree = async (hash) => trees[hash] ?? null;
  }
  return { handle, disposed: () => disposed };
}

function ns(handle: TrunkCiHandle): TrunkCiArtifacts {
  return { get: async () => handle };
}

describe("loadTrunkCi", () => {
  it("prefers flare.yml when present", async () => {
    const repo = fakeRepo({ "flare.yml": "jobs:\n  t:\n    steps:\n      - run: echo hi\n", ".github/workflows/ci.yml": CI_YML });
    const ci = await loadTrunkCi(ns(repo.handle), "demo", SHA);
    expect(ci).toEqual({ kind: "flare", pipeline: expect.stringContaining("echo hi") });
    expect(repo.disposed()).toBe(true);
  });

  it("falls back to the repo's own GitHub Actions workflows", async () => {
    const repo = fakeRepo({ ".github/workflows/ci.yml": CI_YML, ".github/workflows/deploy.yml": DEPLOY_YML });
    const ci = await loadTrunkCi(ns(repo.handle), "demo", SHA);
    expect(ci?.kind).toBe("actions");
    if (ci?.kind !== "actions") return;
    // deploy.yml only fires on releases: never part of a trunk check.
    expect(ci.used).toEqual(["ci.yml"]);
    expect(ci.jobs.map((j) => j.name)).toEqual(["test"]);
    expect(ci.jobs[0].steps.map((s) => s.run).join("\n")).toContain("npm test");
  });

  it("returns null with nothing to verify (CI is the landing gate)", async () => {
    expect(await loadTrunkCi(ns(fakeRepo({}).handle), "demo", SHA)).toBeNull();
    expect(await loadTrunkCi(null, "demo", SHA)).toBeNull();
    // Release-only workflows verify nothing on trunk.
    expect(await loadTrunkCi(ns(fakeRepo({ ".github/workflows/deploy.yml": DEPLOY_YML }).handle), "demo", SHA)).toBeNull();
  });

  it("degrades to null when the binding throws", async () => {
    const broken: TrunkCiArtifacts = {
      get: async () => {
        throw new Error("NOT_FOUND");
      },
    };
    expect(await loadTrunkCi(broken, "demo", SHA)).toBeNull();
  });

  it("handles without tree reads list no workflows", async () => {
    const repo = fakeRepo({ ".github/workflows/ci.yml": CI_YML }, { trees: false });
    expect(await listTrunkWorkflowNames(repo.handle, SHA)).toEqual([]);
  });
});

describe("compatForTrunk", () => {
  it("matches workflows that run on pull requests into the trunk branch", () => {
    const prOnly = `on:
  pull_request:
    branches: [trunk]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;
    expect(compatForTrunk([{ name: "lint.yml", text: prOnly }], "trunk")?.kind).toBe("actions");
    expect(compatForTrunk([{ name: "lint.yml", text: prOnly }], "main")).toBeNull();
  });

  it("returns null for no files", () => {
    expect(compatForTrunk([], "main")).toBeNull();
  });
});
