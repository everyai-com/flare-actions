import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLocal } from "./local";

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
    await expect(runLocal({ cwd: empty, env: { ...process.env }, quiet: true })).rejects.toThrow("no pipeline file");
    const invalid = workspace({ "flare.yml": "jobs: {}\n" });
    await expect(runLocal({ cwd: invalid, env: { ...process.env }, quiet: true })).rejects.toThrow("failed validation");
    const unknownJob = workspace({ "flare.yml": "jobs:\n  a:\n    steps:\n      - run: echo\n" });
    await expect(runLocal({ cwd: unknownJob, job: "ghost", env: { ...process.env }, quiet: true })).rejects.toThrow(
      'no job named "ghost"',
    );
  });
});
