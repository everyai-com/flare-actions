import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRepoSlug, parseRepoFromRemote, runConnect, type ConnectOptions } from "./connect";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function workspace(files: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-connect-"));
  dirs.push(dir);
  for (const name of files) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
  }
  return dir;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Harness {
  opts: ConnectOptions;
  calls: { fetch: string[]; git: string[][] };
  lines: string[];
  errors: string[];
}

function harness(over: Partial<ConnectOptions> = {}): Harness {
  const calls = { fetch: [] as string[], git: [] as string[][] };
  const lines: string[] = [];
  const errors: string[] = [];
  const gitImpl = over.git;
  const fetchImpl = over.fetchFn;
  const opts: ConnectOptions = {
    cwd: workspace(),
    baseUrl: "https://flare.example",
    log: (l) => lines.push(l),
    err: (l) => errors.push(l),
    ...over,
    // Recording wrappers stay even when `over` carries git/fetchFn impls.
    git: (args) => {
      calls.git.push(args);
      if (gitImpl) return gitImpl(args);
      throw new Error("no git stub");
    },
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.fetch.push(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url);
      if (fetchImpl) return fetchImpl(url, init);
      throw new Error(`no fetch stub for ${String(url)}`);
    }) as typeof fetch,
  };
  return { opts, calls, lines, errors };
}

function statusFetch(status: unknown) {
  return async (url: string | URL | Request) => {
    if (String(url).endsWith("/v1/admin/status")) return jsonResponse(status);
    throw new Error(`unexpected ${String(url)}`);
  };
}

describe("parseRepoFromRemote", () => {
  it("parses https, ssh, and git@ forms", () => {
    expect(parseRepoFromRemote("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseRepoFromRemote("https://github.com/owner/repo")).toBe("owner/repo");
    expect(parseRepoFromRemote("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseRepoFromRemote("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
  });
  it("rejects non-github and malformed remotes", () => {
    expect(parseRepoFromRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseRepoFromRemote("not-a-url")).toBeNull();
    expect(parseRepoFromRemote("")).toBeNull();
  });
  it("validates explicit slugs", () => {
    expect(isRepoSlug("o/r")).toBe(true);
    expect(isRepoSlug("o/r/r")).toBe(false);
    expect(isRepoSlug("o")).toBe(false);
  });
});

describe("runConnect", () => {
  it("--dry-run prints the plan and touches nothing", async () => {
    const h = harness({ repo: "o/r", dryRun: true, wire: true });
    const out = await runConnect(h.opts);
    expect(out).toEqual({ exitCode: 0, repo: "o/r" });
    expect(h.calls.fetch).toEqual([]);
    expect(h.calls.git).toEqual([]);
    expect(h.lines.join("\n")).toContain("plan for o/r");
    expect(h.lines.join("\n")).toContain("--wire");
  });

  it("resolves the repo from the origin remote", async () => {
    const h = harness({
      fetchFn: statusFetch({ claimed: true, githubConnected: true, installUrl: "https://inst" }),
      git: (args) => (args[0] === "remote" ? "git@github.com:o/r.git\n" : ""),
    });
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(0);
    expect(out.repo).toBe("o/r");
    expect(h.lines.join("\n")).toContain("install the app here: https://inst");
  });

  it("exits 2 when the repo cannot be resolved", async () => {
    const h = harness({ git: () => { throw new Error("no remote"); } });
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(2);
    expect(h.errors.join("\n")).toContain("owner/name");
  });

  it("exits 2 when the deployment is unreachable", async () => {
    const h = harness({
      repo: "o/r",
      fetchFn: async () => { throw new Error("boom"); },
    });
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(2);
    expect(h.errors.join("\n")).toContain("not reachable");
  });

  it("dispatches HEAD and reports success (exit 0)", async () => {
    const dir = workspace(["flare.yml"]);
    const seen: string[] = [];
    const h = harness({
      cwd: dir,
      repo: "o/r",
      fetchFn: statusFetch({ claimed: true, githubConnected: false, installUrl: null }),
      git: (args) => (args[0] === "rev-parse" ? "abc1234def" : ""),
      client: {
        dispatch: async (repo: string, sha: string) => {
          seen.push(`${repo}@${sha}`);
          return { runId: "run-1", jobIds: ["j1"] };
        },
        waitRun: async () => ({ run: {}, jobs: [], timedOut: false, waitedMs: 1 }) as never,
        getRunDigest: async () => ({ status: "success", repo: "o/r", sha: "abc1234def", branch: "main", failedJobs: 0, totalJobs: 1, jobs: [{ name: "a", status: "success" }] }) as never,
      },
    });
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(0);
    expect(seen).toEqual(["o/r@abc1234def"]);
    expect(h.lines.join("\n")).toContain("flare.yml runs as-is");
    expect(h.lines.join("\n")).toContain("dashboard → Connect GitHub");
  });

  it("reports a failed run with exit 1", async () => {
    const h = harness({
      repo: "o/r",
      fetchFn: statusFetch({ claimed: true, githubConnected: true, installUrl: null }),
      git: (args) => (args[0] === "rev-parse" ? "abc1234" : ""),
      client: {
        dispatch: async () => ({ runId: "run-9", jobIds: [] }),
        waitRun: async () => ({ run: {}, jobs: [], timedOut: false, waitedMs: 1 }) as never,
        getRunDigest: async () => ({ status: "failure", repo: "o/r", sha: "abc1234", branch: "", failedJobs: 1, totalJobs: 1, jobs: [{ name: "bad", status: "failure" }] }) as never,
      },
    });
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(1);
    expect(h.lines.join("\n")).toContain("FAIL bad");
  });

  it("prints the executor hint when the run is still queued after one wait", async () => {
    const h = harness({
      repo: "o/r",
      fetchFn: statusFetch({ claimed: true, githubConnected: true, installUrl: null }),
      git: (args) => (args[0] === "rev-parse" ? "abc1234" : ""),
      client: {
        dispatch: async () => ({ runId: "run-2", jobIds: [] }),
        waitRun: async () => ({ run: {}, jobs: [], timedOut: true, waitedMs: 60000 }) as never,
        getRunDigest: async () => { throw new Error("must not be called"); },
      },
    });
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(0);
    expect(h.lines.join("\n")).toContain("npm run runner");
  });

  it("--wire reuses an existing webhook and rotates the secret", async () => {
    const posts: string[] = [];
    const h = harness({
      repo: "o/r",
      wire: true,
      env: { GITHUB_TOKEN: "gh", FLARE_ADMIN_TOKEN: "adm" },
      newSecret: () => "s".repeat(32),
      fetchFn: statusFetch({ claimed: true, githubConnected: false, installUrl: null }),
    });
    h.opts.fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      h.calls.fetch.push(u);
      if (u.endsWith("/v1/admin/status")) return jsonResponse({ claimed: true, githubConnected: false });
      if (u.endsWith("/v1/admin/settings") && init?.method === "POST") {
        posts.push(`settings:${init.body as string}`);
        return jsonResponse({ ok: true });
      }
      if (u.endsWith("/repos/o/r/hooks") && init?.method !== "POST") {
        return jsonResponse([{ id: 7, config: { url: "https://flare.example/webhooks/github" } }]);
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("webhookSecret");
    expect(h.lines.join("\n")).toContain("already points at");
  });

  it("--wire creates the webhook when none matches", async () => {
    let created = false;
    const h = harness({
      repo: "o/r",
      wire: true,
      env: { GH_TOKEN: "gh", FLARE_ADMIN_TOKEN: "adm" },
      newSecret: () => "s".repeat(32),
    });
    h.opts.fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/admin/status")) return jsonResponse({ claimed: true, githubConnected: false });
      if (u.endsWith("/v1/admin/settings")) return jsonResponse({ ok: true });
      if (u.endsWith("/repos/o/r/hooks") && init?.method !== "POST") return jsonResponse([]);
      if (u.endsWith("/repos/o/r/hooks") && init?.method === "POST") {
        created = true;
        return jsonResponse({ id: 9 }, 201);
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(0);
    expect(created).toBe(true);
    expect(h.lines.join("\n")).toContain("webhook created");
  });

  it("--wire without tokens exits 2", async () => {
    const h = harness({ repo: "o/r", wire: true, env: {}, fetchFn: statusFetch({ claimed: true }) });
    const out = await runConnect(h.opts);
    expect(out.exitCode).toBe(2);
    expect(h.errors.join("\n")).toContain("FLARE_ADMIN_TOKEN");
  });
});
