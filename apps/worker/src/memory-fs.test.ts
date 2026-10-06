import { describe, expect, it } from "vitest";
import { MemoryFS } from "./memory-fs";

// isomorphic-git binds exactly these 10 commands (it prefers `promises`
// when present); a missing one throws `undefined.bind` on first use.
const COMMANDS = [
  "readFile",
  "writeFile",
  "mkdir",
  "rmdir",
  "unlink",
  "stat",
  "lstat",
  "readdir",
  "readlink",
  "symlink",
] as const;

describe("MemoryFS isomorphic-git contract", () => {
  it("exposes all commands on both surfaces", () => {
    const fs = new MemoryFS();
    for (const cmd of COMMANDS) {
      expect(typeof (fs as unknown as Record<string, unknown>)[cmd], cmd).toBe("function");
      expect(typeof (fs.promises as unknown as Record<string, unknown>)[cmd], `promises.${cmd}`).toBe("function");
    }
  });

  it("throws coded errors (isomorphic-git branches on err.code)", async () => {
    const fs = new MemoryFS();
    const err = await fs.readFile("/nope").catch((e: unknown) => e);
    expect((err as { code?: unknown }).code).toBe("ENOENT");
    await fs.writeFile("/f", "x");
    const dirErr = await fs.readdir("/f").catch((e: unknown) => e);
    expect((dirErr as { code?: unknown }).code).toBe("ENOTDIR");
  });

  it("round-trips files, dirs, and symlinks", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a/b.txt", "hi");
    expect(await fs.readFile("/a/b.txt", "utf8")).toBe("hi");
    expect(await fs.readdir("/a")).toEqual(["b.txt"]);
    await fs.symlink("b.txt", "/a/link");
    expect(await fs.readlink("/a/link")).toBe("b.txt");
    expect((await fs.lstat("/a/link")).isSymbolicLink()).toBe(true);
    expect((await fs.stat("/a/link")).isFile()).toBe(true);
    await fs.unlink("/a/link");
    expect(await fs.readdir("/a")).toEqual(["b.txt"]);
  });
});
