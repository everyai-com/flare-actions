import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRANCH_HEADS_REFSPEC, gitFetchArgs, isValidFetchDepth, shellJoin } from "./gitfetch.ts";

describe("gitFetchArgs", () => {
  it("keeps the single-sha shallow fetch as the default", () => {
    expect(gitFetchArgs({ remote: "origin", sha: "abc", blobless: true })).toEqual(["fetch", "-q", "--depth", "1", "origin", "abc"]);
    expect(gitFetchArgs({ remote: "origin", sha: "abc", depth: 1, blobless: false })).toEqual([
      "fetch",
      "-q",
      "--depth",
      "1",
      "origin",
      "abc",
    ]);
  });

  it("fetches branch heads with bounded history, blobless when allowed", () => {
    expect(gitFetchArgs({ remote: "origin", sha: "abc", depth: 50, blobless: true })).toEqual([
      "fetch",
      "-q",
      "--depth",
      "50",
      "--filter=blob:none",
      "origin",
      "abc",
      BRANCH_HEADS_REFSPEC,
    ]);
    expect(gitFetchArgs({ remote: "origin", sha: "abc", depth: 50, blobless: false })).not.toContain("--filter=blob:none");
  });

  it("fetches all history and tags for depth 0", () => {
    expect(gitFetchArgs({ remote: "origin", sha: "abc", depth: 0, blobless: true })).toEqual([
      "fetch",
      "-q",
      "--filter=blob:none",
      "--tags",
      "origin",
      "abc",
      BRANCH_HEADS_REFSPEC,
    ]);
  });
});

describe("isValidFetchDepth", () => {
  it("accepts whole numbers 0-10000 only", () => {
    expect([0, 1, 50, 10000].every(isValidFetchDepth)).toBe(true);
    expect([-1, 1.5, 10001, "1", null].some(isValidFetchDepth)).toBe(false);
  });
});

describe("shellJoin", () => {
  it("quotes only what the shell would expand", () => {
    expect(shellJoin(["fetch", "--filter=blob:none", BRANCH_HEADS_REFSPEC, "it's"])).toBe(
      `fetch --filter=blob:none '+refs/heads/*:refs/remotes/origin/*' 'it'\\''s'`,
    );
  });
});

// Real git, local file:// remote: the plan must leave the requested sha
// first in FETCH_HEAD (seats check out FETCH_HEAD) and make origin/<branch>
// usable for merge-base, which is the point of asking for history.
describe("gitFetchArgs against real git", () => {
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

  it("checks out the sha and resolves merge-base across fetched heads", () => {
    const root = mkdtempSync(join(tmpdir(), "flare-gitfetch-"));
    try {
      const src = join(root, "src");
      mkdirSync(src);
      git(src, ["init", "-q", "-b", "main"]);
      git(src, ["commit", "-q", "--allow-empty", "-m", "one"]);
      git(src, ["commit", "-q", "--allow-empty", "-m", "two"]);
      git(src, ["checkout", "-q", "-b", "feat"]);
      git(src, ["commit", "-q", "--allow-empty", "-m", "three"]);
      git(src, ["config", "uploadpack.allowFilter", "true"]);
      git(src, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
      const sha = git(src, ["rev-parse", "feat"]);
      const dst = join(root, "dst");
      mkdirSync(dst);
      git(dst, ["init", "-q"]);
      git(dst, ["remote", "add", "origin", `file://${src}`]);
      git(dst, gitFetchArgs({ remote: "origin", sha, depth: 0, blobless: true }));
      expect(readFileSync(join(dst, ".git", "FETCH_HEAD"), "utf8").split("\n")[0]).toContain(sha);
      git(dst, ["checkout", "-q", "FETCH_HEAD"]);
      expect(git(dst, ["rev-parse", "HEAD"])).toBe(sha);
      expect(git(dst, ["merge-base", "origin/main", "HEAD"])).toBe(git(src, ["rev-parse", "main"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
