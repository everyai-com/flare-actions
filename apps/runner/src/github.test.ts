import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRunner, pollGithubOnce, resolveRunnerVersion, runnerTarballName } from "./github.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-gh-"));
  dirs.push(dir);
  return dir;
}

describe("runnerTarballName", () => {
  it("maps the supported matrix and rejects the rest", () => {
    expect(runnerTarballName("linux", "x64", "2.323.0")).toBe("actions-runner-linux-x64-2.323.0.tar.gz");
    expect(runnerTarballName("darwin", "arm64", "2.323.0")).toBe("actions-runner-osx-arm64-2.323.0.tar.gz");
    expect(runnerTarballName("win32", "x64", "2.323.0")).toBeNull();
    expect(runnerTarballName("linux", "ppc64", "2.323.0")).toBeNull();
  });
});

describe("resolveRunnerVersion", () => {
  const cache = (home: string) => join(home, ".flare", "actions-runner", ".version-cache.json");

  it("prefers the pinned env version and rejects garbage", async () => {
    const home = tempHome();
    expect(await resolveRunnerVersion({ env: { FLARE_GH_RUNNER_VERSION: "v2.320.0" }, cacheFile: cache(home) }))
      .toEqual({ version: "2.320.0", source: "env" });
    await expect(resolveRunnerVersion({ env: { FLARE_GH_RUNNER_VERSION: "latest" }, cacheFile: cache(home) }))
      .rejects.toThrow("invalid FLARE_GH_RUNNER_VERSION");
  });

  it("uses a fresh cache and refetches a stale one", async () => {
    const home = tempHome();
    mkdirSync(join(cache(home), ".."), { recursive: true });
    writeFileSync(cache(home), JSON.stringify({ version: "2.319.0", fetchedAt: Date.now() }));
    expect(await resolveRunnerVersion({ env: {}, cacheFile: cache(home) })).toEqual({ version: "2.319.0", source: "cache" });

    writeFileSync(cache(home), JSON.stringify({ version: "2.300.0", fetchedAt: Date.now() - 25 * 3600_000 }));
    let hits = 0;
    const out = await resolveRunnerVersion({
      env: {},
      cacheFile: cache(home),
      fetchFn: (async () => {
        hits += 1;
        return new Response(JSON.stringify({ tag_name: "v2.323.0" }));
      }) as typeof fetch,
    });
    expect(out).toEqual({ version: "2.323.0", source: "release" });
    expect(hits).toBe(1);
  });

  it("throws when the release lookup fails or returns a bad tag", async () => {
    const home = tempHome();
    const bad = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(resolveRunnerVersion({ env: {}, cacheFile: cache(home), fetchFn: bad })).rejects.toThrow("lookup failed");
    const badTag = (async () => new Response(JSON.stringify({ tag_name: "nightly" }))) as typeof fetch;
    await expect(resolveRunnerVersion({ env: {}, cacheFile: cache(home), fetchFn: badTag })).rejects.toThrow("bad tag");
  });
});

describe("ensureRunner", () => {
  it("reuses an extracted runner without downloading", async () => {
    const home = tempHome();
    const root = join(home, ".flare", "actions-runner", "2.323.0");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\n");
    const out = await ensureRunner("2.323.0", {
      labels: [],
      home,
      os: "linux",
      cpu: "x64",
      download: async () => { throw new Error("must not download"); },
    });
    expect(out).toBe(join(root, "run.sh"));
  });

  it("downloads and unpacks on first use", async () => {
    const home = tempHome();
    const seen: string[] = [];
    const out = await ensureRunner("2.323.0", {
      labels: [],
      home,
      os: "darwin",
      cpu: "arm64",
      log: () => undefined,
      download: async (url, dest) => {
        seen.push(url);
        writeFileSync(dest, "tarball");
      },
      untar: (file, dest) => {
        seen.push(`untar:${file}:${dest}`);
        writeFileSync(join(dest, "run.sh"), "#!/bin/sh\n");
      },
    });
    expect(seen[0]).toContain("actions-runner-osx-arm64-2.323.0.tar.gz");
    expect(out.endsWith("run.sh")).toBe(true);
  });

  it("fails fast on unsupported platforms", async () => {
    await expect(ensureRunner("2.323.0", { labels: [], home: tempHome(), os: "win32", cpu: "x64" }))
      .rejects.toThrow("Windows support is planned");
  });
});

describe("pollGithubOnce", () => {
  function claimJob(over = {}) {
    return {
      id: "101",
      repo: "o/r",
      runId: "9",
      runAttempt: 1,
      jobName: "test",
      workflowName: "ci",
      headSha: "abc",
      labels: ["flare"],
      status: "claimed",
      conclusion: null,
      runnerId: 77,
      runnerName: "flare-101-x",
      attempts: 1,
      startedAt: null,
      completedAt: null,
      ...over,
    };
  }

  it("runs one claimed job and cleans up the workdir", async () => {
    const home = tempHome();
    const spawns: { runSh: string; blob: string; cwd: string }[] = [];
    const logs: Record<string, unknown>[] = [];
    const client = {
      claimGithubJob: async () => ({ job: claimJob(), jitConfig: "SECRET-BLOB", runnerName: "flare-101-x" }),
    };
    const worked = await pollGithubOnce(client, "/root/run.sh", {
      labels: [],
      home,
      log: (o) => logs.push(o),
      spawnRunner: async (runSh, blob, cwd) => {
        spawns.push({ runSh, blob, cwd });
        writeFileSync(join(cwd, "out.txt"), "x");
        return 0;
      },
    });
    expect(worked).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].runSh).toBe("/root/run.sh");
    expect(spawns[0].blob).toBe("SECRET-BLOB");
    expect(spawns[0].cwd).toBe(join(home, ".flare", "gh-work", "101"));
    // The workdir is removed afterwards, and the secret blob never hits logs.
    expect(existsSync(join(home, ".flare", "gh-work", "101"))).toBe(false);
    expect(JSON.stringify(logs)).not.toContain("SECRET-BLOB");
  });

  it("returns false on an empty lane without spawning", async () => {
    let spawned = false;
    const worked = await pollGithubOnce(
      { claimGithubJob: async () => null },
      "/root/run.sh",
      {
        labels: ["gpu"],
        home: tempHome(),
        log: () => undefined,
        spawnRunner: async () => {
          spawned = true;
          return 0;
        },
      },
    );
    expect(worked).toBe(false);
    expect(spawned).toBe(false);
  });

  it("a spawn crash still cleans up and counts as work", async () => {
    const home = tempHome();
    const logs: Record<string, unknown>[] = [];
    const worked = await pollGithubOnce(
      { claimGithubJob: async () => ({ job: claimJob({ id: "7" }), jitConfig: "b", runnerName: "r" }) },
      "/root/run.sh",
      {
        labels: [],
        home,
        log: (o) => logs.push(o),
        spawnRunner: async () => { throw new Error("exec failed"); },
      },
    );
    expect(worked).toBe(true);
    expect(logs.some((l) => l["msg"] === "github job failed")).toBe(true);
  });
});
