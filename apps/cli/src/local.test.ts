import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatParityReport, runLocal, runLocalParity } from "./local";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-local-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-cache-"));
  dirs.push(dir);
  return dir;
}

describe("runLocal", () => {
  it("runs jobs in place, honoring needs order", async () => {
    const dir = workspace({
      "flare.yml":
        "jobs:\n  build:\n    steps:\n      - run: echo building > out.txt\n  test:\n    needs: build\n    steps:\n      - run: cat out.txt\n",
    });
    const res = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, quiet: true });
    expect(res.ok).toBe(true);
    expect(res.jobs.map((j) => `${j.name}:${j.status}`)).toEqual(["build:success", "test:success"]);
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
  });

  it("skips dependents when a needed job fails", async () => {
    const dir = workspace({
      "flare.yml":
        "jobs:\n  fail:\n    steps:\n      - run: exit 3\n  dependent:\n    needs: fail\n    steps:\n      - run: echo never\n",
    });
    const res = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, quiet: true });
    expect(res.ok).toBe(false);
    expect(res.jobs).toEqual([
      { name: "fail", status: "failure", durationMs: expect.any(Number), artifacts: [] },
      { name: "dependent", status: "skipped", durationMs: 0, artifacts: [] },
    ]);
    expect(existsSync(join(dir, "never"))).toBe(false);
  });

  it("runs always() cleanup steps and can filter to one job", async () => {
    const dir = workspace({
      "flare.yml":
        "jobs:\n  a:\n    steps:\n      - run: exit 1\n      - run: echo cleaned > cleaned.txt\n        if: always()\n  b:\n    steps:\n      - run: echo b > b.txt\n",
    });
    const only = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, job: "b", quiet: true });
    expect(only.ok).toBe(true);
    expect(only.jobs.map((j) => j.name)).toEqual(["b"]);
    expect(existsSync(join(dir, "b.txt"))).toBe(true);

    const all = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, quiet: true });
    expect(all.ok).toBe(false);
    expect(readFileSync(join(dir, "cleaned.txt"), "utf8").trim()).toBe("cleaned");
  });

  it("uploads artifacts into .flare/artifacts", async () => {
    const dir = workspace({
      "flare.yml": "jobs:\n  build:\n    artifacts:\n      paths: [out.txt]\n    steps:\n      - run: echo hi > out.txt\n",
    });
    const res = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, quiet: true });
    expect(res.ok).toBe(true);
    expect(res.jobs[0].artifacts).toEqual(["out.txt"]);
    expect(readFileSync(join(dir, ".flare", "artifacts", "build", "out.txt"), "utf8").trim()).toBe("hi");
  });

  it("honors continue-on-error through the runner orchestration", async () => {
    const dir = workspace({
      "flare.yml": "jobs:\n  a:\n    steps:\n      - run: exit 1\n        continue-on-error: true\n      - run: echo ok > ok.txt\n",
    });
    const res = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, quiet: true });
    expect(res.ok).toBe(true);
    expect(existsSync(join(dir, "ok.txt"))).toBe(true);
  });

  it("rejects a missing or invalid pipeline file", async () => {
    const empty = workspace({});
    await expect(runLocal({ cwd: empty, env: { ...process.env }, quiet: true })).rejects.toThrow(
      "no flare.yml or .github/workflows",
    );
    const invalid = workspace({ "flare.yml": "jobs: {}\n" });
    await expect(runLocal({ cwd: invalid, env: { ...process.env }, quiet: true })).rejects.toThrow("failed validation");
    const unknownJob = workspace({ "flare.yml": "jobs:\n  a:\n    steps:\n      - run: echo\n" });
    await expect(runLocal({ cwd: unknownJob, job: "ghost", env: { ...process.env }, quiet: true })).rejects.toThrow(
      'no job named "ghost"',
    );
  });

  it("falls back to .github/workflows when flare.yml is absent", async () => {
    const dir = workspace({});
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "${{ github.ref_name }}" > actions.txt\n',
    );
    const res = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, quiet: true });
    expect(res.ok).toBe(true);
    expect(res.jobs.map((j) => j.name)).toEqual(["build"]);
    expect(readFileSync(join(dir, "actions.txt"), "utf8").trim()).toBe("local");
  });

  it("forces CI=true and sets FLARE_CHANGED_FILES like the cloud", async () => {
    const dir = workspace({
      "flare.yml":
        "jobs:\n  env:\n    steps:\n      - run: echo \"$CI/$FLARE_REF\" > env.txt\n      - run: printenv FLARE_CHANGED_FILES > changed.txt\n",
    });
    // A dirty shell (CI=false) must not flip local steps: the cloud
    // always sees CI=true unless the job env overrides it.
    const res = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env, CI: "false" }, quiet: true });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dir, "env.txt"), "utf8").trim()).toMatch(/^true\//);
    // printenv exits 1 when the var is unset, so ok:true already proves
    // presence; outside a git tree the diff is empty like the cloud's "".
    expect(readFileSync(join(dir, "changed.txt"), "utf8").trim()).toBe("");
  });

  it("lets job env override CI like the cloud merge does", async () => {
    const dir = workspace({
      "flare.yml": "jobs:\n  env:\n    env: { CI: custom }\n    steps:\n      - run: echo \"$CI\" > ci.txt\n",
    });
    const res = await runLocal({ cwd: dir, cacheDir: cacheDir(), env: { ...process.env }, quiet: true });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dir, "ci.txt"), "utf8").trim()).toBe("custom");
  });
});

describe("runLocalParity", () => {
  it("reports image/cache/env parity without running steps", () => {
    const dir = workspace({
      "flare.yml":
        "jobs:\n  build:\n    cache:\n      key: node-abc\n      paths: [node_modules]\n    steps:\n      - run: echo should-not-run > ran.txt\n",
    });
    const report = runLocalParity({
      cwd: dir,
      cacheDir: cacheDir(),
      env: { ...process.env, CUSTOM_LEAK: "1" },
      quiet: true,
    });
    expect(report.jobs).toHaveLength(1);
    const job = report.jobs[0];
    expect(job.lane).toBe("seats");
    expect(job.cache).toEqual({
      key: "node-abc",
      local: "local file (directory-scoped)",
      cloud: "cache/node-abc",
    });
    expect(job.env.find((r) => r.key === "CI")).toMatchObject({ local: "true", cloud: "true", status: "same" });
    expect(job.env.find((r) => r.key === "FLARE_REPO")?.status).toBe("expected");
    expect(existsSync(join(dir, "ran.txt"))).toBe(false);
    expect(existsSync(join(dir, ".flare"))).toBe(false);
    const text = formatParityReport(report);
    expect(text).toContain("build");
    expect(text).toContain("cache/node-abc");
    expect(text).toContain("FLARE_CHANGED_FILES");
  });

  it("predicts the BYO lane for container jobs with a matching image", () => {
    const dir = workspace({
      "flare.yml": "jobs:\n  build:\n    container: node:20\n    steps:\n      - run: echo hi\n",
    });
    const report = runLocalParity({ cwd: dir, env: { ...process.env }, quiet: true });
    expect(report.jobs[0].lane).toBe("byo");
    expect(report.jobs[0].image).toEqual({ local: "container:node:20", cloud: "container:node:20" });
    expect(report.ok).toBe(true);
  });

  it("filters parity to one job and rejects unknown names", () => {
    const dir = workspace({
      "flare.yml": "jobs:\n  a:\n    steps:\n      - run: echo a\n  b:\n    steps:\n      - run: echo b\n",
    });
    expect(runLocalParity({ cwd: dir, job: "b", env: { ...process.env }, quiet: true }).jobs.map((j) => j.name)).toEqual([
      "b",
    ]);
    expect(() => runLocalParity({ cwd: dir, job: "ghost", env: { ...process.env }, quiet: true })).toThrow(
      'no job named "ghost"',
    );
  });
});
