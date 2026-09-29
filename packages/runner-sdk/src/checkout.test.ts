import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutRepo } from "./checkout";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fixtureRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "flare-src-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "hello.txt"), "hi");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: dir });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, sha };
}

describe("checkoutRepo", () => {
  it("checks out a repo at a sha", async () => {
    const src = fixtureRepo();
    const dst = mkdtempSync(join(tmpdir(), "flare-dst-"));
    dirs.push(dst);
    await checkoutRepo({ repo: "local/fixture", sha: src.sha, dir: dst }, src.dir);
    expect(readFileSync(join(dst, "hello.txt"), "utf8")).toBe("hi");
  });

  it("rejects bad repo/sha without touching the network", async () => {
    await expect(checkoutRepo({ repo: "nope", sha: "abc", dir: "/tmp/x" })).rejects.toThrow("invalid repo");
    await expect(checkoutRepo({ repo: "a/b", sha: "not a sha!", dir: "/tmp/x" })).rejects.toThrow("invalid sha");
  });
});
