import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceTar, dispatchSource } from "./source";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-source-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("createSourceTar", () => {
  it("tars the tree excluding .git, node_modules, and .flare", async () => {
    const dir = workspace({
      "keep.txt": "hi",
      ".git/HEAD": "ref",
      "node_modules/pkg/index.js": "x",
      ".flare/artifacts/job/a": "x",
    });
    const tar = await createSourceTar(dir);
    const out = mkdtempSync(join(tmpdir(), "flare-source-out-"));
    dirs.push(out);
    execFileSync("tar", ["-xzf", "-", "-C", out], { input: Buffer.from(tar) });
    expect(existsSync(join(out, "keep.txt"))).toBe(true);
    expect(existsSync(join(out, ".git"))).toBe(false);
    expect(existsSync(join(out, "node_modules"))).toBe(false);
    expect(existsSync(join(out, ".flare"))).toBe(false);
  });
});

describe("dispatchSource", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";

  function fakeClient(calls: unknown[]) {
    return {
      putSource: async (data: Uint8Array) => {
        calls.push({ kind: "put", size: data.byteLength });
        return id;
      },
      dispatch: async (repo: string, sha: string, opts?: unknown) => {
        calls.push({ kind: "dispatch", repo, sha, opts });
        return { runId: "run-1", jobIds: ["j1"] };
      },
    };
  }

  it("uploads the tree and dispatches with the inline pipeline", async () => {
    const dir = workspace({ "flare.yml": "jobs:\n  a:\n    steps:\n      - run: echo\n", "src.txt": "x" });
    const calls: unknown[] = [];
    const out = await dispatchSource(fakeClient(calls) as never, { repo: "o/r", cwd: dir, priority: 9 });
    expect(out).toEqual({ runId: "run-1", jobIds: ["j1"], sourceId: id });
    expect(calls[0]).toMatchObject({ kind: "put" });
    expect(calls[1]).toMatchObject({
      kind: "dispatch",
      repo: "o/r",
      sha: "",
      opts: {
        pipeline: expect.stringContaining("jobs:"),
        source: id,
        priority: 9,
      },
    });
  });

  it("fails fast on a missing or invalid pipeline before uploading", async () => {
    const empty = workspace({});
    const calls: unknown[] = [];
    await expect(dispatchSource(fakeClient(calls) as never, { repo: "o/r", cwd: empty })).rejects.toThrow("no pipeline file");
    const invalid = workspace({ "flare.yml": "jobs: {}\n" });
    await expect(dispatchSource(fakeClient(calls) as never, { repo: "o/r", cwd: invalid })).rejects.toThrow("failed validation");
    expect(calls).toEqual([]);
  });
});
