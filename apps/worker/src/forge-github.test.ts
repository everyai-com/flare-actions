/// <reference types="node" />
// Forge <-> GitHub bridge, end to end: one bare repo plays GitHub, the
// Artifacts fake imports it into a trunk, and isomorphic-git + MemoryFS
// sync both ways over the in-process `git http-backend` exactly as in
// the Worker. GitHub REST is a recording fake.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { Db } from "./db";
import {
  defaultTrunkName,
  deleteGithubLink,
  getGithubLink,
  importGithubRepo,
  listGithubLinks,
  parseGithubRepo,
  patchGithubLink,
  prBody,
  reconcileGithubLinks,
  syncFromGithub,
  syncToGithub,
  validSyncBranch,
  type BridgeArtifacts,
  type BridgeDeps,
  type GithubPort,
} from "./forge-github";
import { handleForgeRequest, type ForgeIdentity } from "./forge-routes";
import { forgeServiceDeps } from "./forge-service";
import { MemoryFS } from "./memory-fs";
import { gitFixture, sqliteDb, type GitFixture } from "./testing/forge-fixture";

const nfs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");

const GH = "acme/widgets";

interface FakeGithub extends GithubPort {
  prs: Array<{ number: number; head: string; base: string; title: string; body: string; open: boolean }>;
  installed: boolean;
  info: { defaultBranch: string; isPrivate: boolean } | null;
}

function fakeGithub(): FakeGithub {
  const gh: FakeGithub = {
    prs: [],
    installed: true,
    info: { defaultBranch: "main", isPrivate: false },
    async installationFor() {
      return gh.installed ? 7 : null;
    },
    async installationToken(id) {
      return id === 7 && gh.installed ? "ghs_testtoken" : null;
    },
    async repoInfo() {
      return gh.info;
    },
    async findOpenPr(_repo, _token, head, base) {
      const owner = GH.split("/")[0];
      return gh.prs.find((p) => p.open && `${owner}:${p.head}` === head && p.base === base)?.number ?? null;
    },
    async openPr(_repo, _token, pr) {
      const number = gh.prs.length + 1;
      gh.prs.push({ number, open: true, ...pr });
      return number;
    },
    async updatePr(_repo, _token, number, body) {
      const pr = gh.prs.find((p) => p.number === number);
      if (pr) pr.body = body;
      return Boolean(pr);
    },
  };
  return gh;
}

interface Harness {
  fx: GitFixture;
  db: Db;
  gh: FakeGithub;
  deps: BridgeDeps;
  imports: Array<{ url: string; branch?: string; name: string }>;
}

let h: Harness;

// GitHub repos live in the fixture as `github-<owner>-<name>`.
function ghBare(repo: string): string {
  return `github-${repo.replace("/", "-")}`;
}

function harness(): Harness {
  const fx = gitFixture();
  const db = sqliteDb();
  const gh = fakeGithub();
  const imports: Harness["imports"] = [];
  const artifacts: BridgeArtifacts = {
    async import({ source, target }) {
      imports.push({ url: source.url, branch: source.branch, name: target.name });
      const dst = path.join(fx.root, `${target.name}.git`);
      if (nfs.existsSync(dst)) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
      const src = path.join(fx.root, `${ghBare(GH)}.git`);
      fx.sh(["clone", "-q", "--bare", "--single-branch", "-b", source.branch ?? "main", src, dst]);
      return { remote: fx.remoteFor(target.name) };
    },
    get: (name) => fx.artifacts.get(name),
  };
  const deps: BridgeDeps = {
    db,
    artifacts,
    github: gh,
    git,
    http: fx.http,
    fs: () => new MemoryFS(),
    remoteFor: fx.remoteFor,
    githubRemote: (repo) => fx.remoteFor(ghBare(repo)),
  };
  return { fx, db, gh, deps, imports };
}

function seedGithub(branch = "main"): string {
  const bare = path.join(h.fx.root, `${ghBare(GH)}.git`);
  h.fx.sh(["init", "-q", "--bare", "-b", branch, bare]);
  return h.fx.commit(ghBare(GH), { "README.md": "widgets\n", "src/a.ts": "a1\n" }, "initial", branch);
}

beforeEach(() => {
  h = harness();
});

afterEach(() => {
  h.fx.cleanup();
});

describe("pure helpers", () => {
  it("parses every common way people paste a GitHub repo", () => {
    for (const input of [
      "acme/widgets",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "github.com/acme/widgets/tree/main/src",
      "git@github.com:acme/widgets.git",
      "  https://www.github.com/acme/widgets?tab=readme  ",
    ]) {
      expect(parseGithubRepo(input)).toBe("acme/widgets");
    }
    for (const bad of ["", "acme", "https://gitlab.com/acme/widgets", "-acme/widgets", "acme/..", 42, null]) {
      expect(parseGithubRepo(bad)).toBeNull();
    }
  });

  it("names trunks so they never collide with CI mirrors", () => {
    expect(defaultTrunkName("Acme/Widgets.js")).toBe("gh-acme-widgets.js");
    expect(defaultTrunkName(`a/${"x".repeat(120)}`).length).toBeLessThanOrEqual(100);
  });

  it("accepts only plain branch names for the sync branch", () => {
    expect(validSyncBranch("flare/trunk")).toBe(true);
    for (const bad of ["", "-x", "/x", "x/", "a..b", "a//b", "x.lock", "a b", "a~1"]) expect(validSyncBranch(bad)).toBe(false);
  });

  it("flattens agent-written titles in the PR body", () => {
    const body = prBody({
      trunk: "t",
      trunkSha: "a".repeat(40),
      intents: [{ id: "intent-1", title: "fix [link](http://x)\n# heading", agent: "claude", landedSha: "b".repeat(40) }],
    });
    expect(body).toContain("fix link(http://x) # heading — claude (`bbbbbbb`)");
    expect(body).not.toContain("[link]");
  });
});

describe("import", () => {
  it("imports a public repo as a trunk and records the link", async () => {
    const head = seedGithub();
    const out = await importGithubRepo(h.deps, { github: `https://github.com/${GH}`, actor: "admin" });
    if ("error" in out) throw new Error(out.message);
    expect(out.status).toBe("ready");
    expect(out.trunk).toBe("gh-acme-widgets");
    expect(out.sync?.status).toBe("noop");
    expect(h.fx.head("gh-acme-widgets")).toBe(head);
    expect(h.imports[0]).toMatchObject({ branch: "main", name: "gh-acme-widgets" });
    const link = await getGithubLink(h.db, "gh-acme-widgets");
    expect(link).toMatchObject({ githubRepo: GH, syncMode: "pr", syncBranch: "flare/trunk", pullUpstream: true, status: "ready", installationId: 7, lastPulledSha: head });
    expect((await listGithubLinks(h.db)).map((l) => l.repo)).toEqual(["gh-acme-widgets"]);
  });

  it("re-importing is idempotent; another GitHub repo cannot take the name", async () => {
    seedGithub();
    const first = await importGithubRepo(h.deps, { github: GH, actor: "admin" });
    expect("error" in first).toBe(false);
    const again = await importGithubRepo(h.deps, { github: GH, actor: "admin" });
    expect(again).toMatchObject({ status: "exists" });
    expect(h.imports).toHaveLength(1);
    const clash = await importGithubRepo(h.deps, { github: "other/repo", name: "gh-acme-widgets", actor: "admin" });
    expect(clash).toMatchObject({ error: "github_link_exists" });
  });

  it("aliases a non-main default branch to trunk main", async () => {
    h.gh.info = { defaultBranch: "master", isPrivate: false };
    const head = seedGithub("master");
    const out = await importGithubRepo(h.deps, { github: GH, actor: "admin" });
    if ("error" in out) throw new Error(out.message);
    expect(out.sync?.status).toBe("seeded");
    expect(h.fx.head("gh-acme-widgets", "main")).toBe(head);
  });

  it("refuses private repos without the App, and bad input", async () => {
    seedGithub();
    h.gh.installed = false;
    h.gh.info = { defaultBranch: "main", isPrivate: true };
    expect(await importGithubRepo(h.deps, { github: GH, actor: "a" })).toMatchObject({ error: "github_repo_unavailable" });
    h.gh.info = null;
    expect(await importGithubRepo(h.deps, { github: GH, actor: "a" })).toMatchObject({ error: "github_repo_unavailable" });
    expect(await importGithubRepo(h.deps, { github: "nope", actor: "a" })).toMatchObject({ error: "invalid_request" });
    expect(await importGithubRepo(h.deps, { github: GH, name: "bad name", actor: "a" })).toMatchObject({ error: "invalid_request" });
    expect(await importGithubRepo(h.deps, { github: GH, syncMode: "yolo", actor: "a" })).toMatchObject({ error: "invalid_request" });
    expect(await importGithubRepo({ ...h.deps, artifacts: null }, { github: GH, actor: "a" })).toMatchObject({ error: "artifacts_unconfigured" });
  });

  it("warns when landed work cannot flow back yet (public repo, no App)", async () => {
    seedGithub();
    h.gh.installed = false;
    const out = await importGithubRepo(h.deps, { github: GH, actor: "a" });
    if ("error" in out) throw new Error(out.message);
    expect(out.warnings.join(" ")).toContain("install");
    const push = await syncToGithub(h.deps, out.trunk);
    expect(push.status).toBe("failed");
    expect(push.detail).toContain("install the Flare GitHub App");
  });

  it("marks failed imports and lets the cron reconcile settling ones", async () => {
    seedGithub();
    const failing: BridgeDeps = {
      ...h.deps,
      artifacts: {
        import: async () => {
          throw Object.assign(new Error("boom https://x-access-token:ghs_secret@github.com/acme/widgets.git"), { code: "UPSTREAM_UNAVAILABLE" });
        },
        get: h.deps.artifacts!.get,
      },
    };
    const out = await importGithubRepo(failing, { github: GH, actor: "a" });
    if ("error" in out) throw new Error(out.message);
    expect(out.status).toBe("failed");
    expect(out.link.detail).toContain("UPSTREAM_UNAVAILABLE");
    expect(out.link.detail).not.toContain("ghs_secret");

    // Settling import: the row stays importing until the cron finishes it.
    await deleteGithubLink(h.db, out.trunk);
    const settling: BridgeDeps = {
      ...h.deps,
      artifacts: {
        import: async (p) => {
          await h.deps.artifacts!.import(p);
          throw Object.assign(new Error("in progress"), { code: "IMPORT_IN_PROGRESS" });
        },
        get: h.deps.artifacts!.get,
      },
    };
    const pending = await importGithubRepo(settling, { github: GH, actor: "a" });
    expect(pending).toMatchObject({ status: "importing" });
    expect(await reconcileGithubLinks(h.deps)).toBe(1);
    expect((await getGithubLink(h.db, "gh-acme-widgets"))?.status).toBe("ready");
  });
});

describe("sync", () => {
  async function imported(syncMode: "pr" | "branch" | "direct" | "off" = "pr"): Promise<string> {
    seedGithub();
    const out = await importGithubRepo(h.deps, { github: GH, syncMode, actor: "admin" });
    if ("error" in out) throw new Error(out.message);
    return out.trunk;
  }

  it("fast-forwards human GitHub commits into trunk", async () => {
    const trunk = await imported();
    const human = h.fx.commit(ghBare(GH), { "src/b.ts": "b1\n" }, "human change");
    const out = await syncFromGithub(h.deps, trunk);
    expect(out.status).toBe("fast-forwarded");
    expect(h.fx.head(trunk)).toBe(human);
    expect((await syncFromGithub(h.deps, trunk)).status).toBe("noop");
  });

  it("opens one rolling PR for landed trunk work, then updates it", async () => {
    const trunk = await imported("pr");
    const landed = h.fx.commit(trunk, { "src/a.ts": "a2\n" }, "landed by a train");
    const first = await syncToGithub(h.deps, trunk);
    expect(first).toMatchObject({ status: "pr-opened", prNumber: 1, trunkSha: landed });
    expect(h.fx.head(ghBare(GH), "flare/trunk")).toBe(landed);
    expect(h.gh.prs[0]).toMatchObject({ head: "flare/trunk", base: "main", open: true });
    expect(h.gh.prs[0].body).toContain(landed.slice(0, 12));

    const landed2 = h.fx.commit(trunk, { "src/c.ts": "c1\n" }, "second landing");
    const second = await syncToGithub(h.deps, trunk);
    expect(second).toMatchObject({ status: "pr-updated", prNumber: 1 });
    expect(h.fx.head(ghBare(GH), "flare/trunk")).toBe(landed2);
    expect(h.gh.prs).toHaveLength(1);
    expect((await getGithubLink(h.db, trunk))?.lastPushedSha).toBe(landed2);
    // The default branch is never touched in pr mode.
    expect(h.fx.log(ghBare(GH), "main")).toHaveLength(1);
  });

  it("closes the loop: a merged sync PR fast-forwards back into trunk", async () => {
    const trunk = await imported("pr");
    h.fx.commit(trunk, { "src/a.ts": "a2\n" }, "landed");
    // Meanwhile a human commits on GitHub: histories diverge.
    h.fx.commit(ghBare(GH), { "docs/x.md": "x\n" }, "human docs");
    expect((await syncFromGithub(h.deps, trunk)).status).toBe("diverged");
    expect((await syncToGithub(h.deps, trunk)).status).toBe("pr-opened");
    // A human merges the PR on GitHub (merge commit).
    const work = path.join(h.fx.root, "merge-work");
    h.fx.sh(["clone", "-q", path.join(h.fx.root, `${ghBare(GH)}.git`), work]);
    h.fx.sh(["fetch", "-q", "origin", "flare/trunk"], work);
    h.fx.sh(["merge", "-q", "--no-ff", "-m", "Merge sync PR", "FETCH_HEAD"], work);
    h.fx.sh(["push", "-q", "origin", "HEAD:main"], work);
    const merged = h.fx.head(ghBare(GH), "main");
    const back = await syncFromGithub(h.deps, trunk);
    expect(back.status).toBe("fast-forwarded");
    expect(h.fx.head(trunk)).toBe(merged);
    // Nothing new for GitHub after the round trip.
    expect((await syncToGithub(h.deps, trunk)).status).toBe("noop");
  });

  it("direct mode fast-forwards the default branch and never forces", async () => {
    const trunk = await imported("direct");
    const landed = h.fx.commit(trunk, { "src/a.ts": "a2\n" }, "landed");
    expect((await syncToGithub(h.deps, trunk)).status).toBe("pushed");
    expect(h.fx.head(ghBare(GH), "main")).toBe(landed);
    const human = h.fx.commit(ghBare(GH), { "docs/y.md": "y\n" }, "human");
    h.fx.commit(trunk, { "src/c.ts": "c\n" }, "landed again");
    const out = await syncToGithub(h.deps, trunk);
    expect(out.status).toBe("diverged");
    expect(h.fx.head(ghBare(GH), "main")).toBe(human);
    expect((await getGithubLink(h.db, trunk))?.detail).toContain("never force");
  });

  it("branch mode only moves the sync branch; off mode does nothing", async () => {
    const trunk = await imported("branch");
    const landed = h.fx.commit(trunk, { "src/a.ts": "a2\n" }, "landed");
    expect((await syncToGithub(h.deps, trunk)).status).toBe("pushed");
    expect(h.fx.head(ghBare(GH), "flare/trunk")).toBe(landed);
    expect(h.gh.prs).toHaveLength(0);
    await patchGithubLink(h.db, trunk, { syncMode: "off", pullUpstream: false });
    expect((await syncToGithub(h.deps, trunk)).status).toBe("off");
    expect((await syncFromGithub(h.deps, trunk)).status).toBe("skipped");
  });

  it("reports unknown trunks without throwing", async () => {
    expect((await syncToGithub(h.deps, "nope")).status).toBe("failed");
    expect((await syncFromGithub(h.deps, "nope")).status).toBe("failed");
  });
});

describe("REST surface (/v1/forge/github/*)", () => {
  const ADMIN: ForgeIdentity = { scope: "admin", actor: "email:pat@example.com", repos: [] };
  const RUNNER: ForgeIdentity = { scope: "runner", actor: "token:runner", repos: [] };
  const SCOPED: ForgeIdentity = { scope: "runner", actor: "token:scoped", repos: ["ns/other"] };

  async function call(method: string, p: string, body: unknown, ident: ForgeIdentity, wired = true): Promise<{ status: number; body: Record<string, unknown> }> {
    const deps = forgeServiceDeps({ db: h.db, namespace: "ns", github: wired ? h.deps : null });
    const url = new URL(`http://x${p}`);
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleForgeRequest(new Request(url, init), url, deps, async () => ident);
    if (!res) throw new Error("fell through");
    return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
  }

  it("imports (admin only), lists, updates, syncs and unlinks", async () => {
    seedGithub();
    expect((await call("POST", "/v1/forge/github/links", { github: GH }, RUNNER)).body.code).toBe("admin_required");
    expect((await call("POST", "/v1/forge/github/links", { github: GH }, ADMIN, false)).status).toBe(501);
    const scopedAdmin: ForgeIdentity = { scope: "admin", actor: "token:scoped-admin", repos: ["ns/other"] };
    expect((await call("POST", "/v1/forge/github/links", { github: GH }, scopedAdmin)).body.code).toBe("repo_not_allowed");

    const created = await call("POST", "/v1/forge/github/links", { github: `https://github.com/${GH}`, syncMode: "branch" }, ADMIN);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "ready", repo: "gh-acme-widgets" });
    expect((created.body.nextSteps as Array<{ tool: string }>).map((s) => s.tool)).toContain("plan_goal");

    const list = await call("GET", "/v1/forge/github/links", undefined, RUNNER);
    expect((list.body.links as Array<{ repo: string; githubUrl: string }>)[0]).toMatchObject({ repo: "gh-acme-widgets", githubUrl: `https://github.com/${GH}` });
    // Repo-scoped tokens only see their trunks.
    expect((await call("GET", "/v1/forge/github/links", undefined, SCOPED)).body.links).toEqual([]);
    expect((await call("GET", "/v1/forge/github/links/gh-acme-widgets", undefined, SCOPED)).status).toBe(403);

    expect((await call("PATCH", "/v1/forge/github/links/gh-acme-widgets", { syncMode: "pr" }, RUNNER)).status).toBe(403);
    expect((await call("PATCH", "/v1/forge/github/links/gh-acme-widgets", { syncMode: "bogus" }, ADMIN)).status).toBe(400);
    const patched = await call("PATCH", "/v1/forge/github/links/gh-acme-widgets", { syncMode: "pr", pullUpstream: false }, ADMIN);
    expect(patched.body.link).toMatchObject({ syncMode: "pr", pullUpstream: false });

    const landed = h.fx.commit("gh-acme-widgets", { "src/a.ts": "a3\n" }, "landed");
    const synced = await call("POST", "/v1/forge/github/links/gh-acme-widgets/sync", { direction: "push" }, RUNNER);
    expect(synced.body.push).toMatchObject({ status: "pr-opened", trunkSha: landed });
    expect(synced.body.link).toMatchObject({ prUrl: `https://github.com/${GH}/pull/1` });
    expect((await call("POST", "/v1/forge/github/links/gh-acme-widgets/sync", { direction: "sideways" }, RUNNER)).status).toBe(400);

    expect((await call("DELETE", "/v1/forge/github/links/gh-acme-widgets", undefined, RUNNER)).status).toBe(403);
    expect((await call("DELETE", "/v1/forge/github/links/gh-acme-widgets", undefined, ADMIN)).body).toMatchObject({ unlinked: true });
    expect((await call("GET", "/v1/forge/github/links/gh-acme-widgets", undefined, ADMIN)).status).toBe(404);
    // Unlinking never deletes the trunk.
    expect(h.fx.head("gh-acme-widgets")).toBe(landed);
  });
});
