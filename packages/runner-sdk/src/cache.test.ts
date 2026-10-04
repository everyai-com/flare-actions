import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeTar, createTar, extractTar, restoreCache, safeCachePaths, saveCache } from "./cache";

describe("assertSafeTar", () => {
  it("accepts normal archives and rejects traversal members", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-tar-"));
    try {
      writeFileSync(join(dir, "ok.txt"), "hi");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "outside.txt"), "escape");
      const safe = execFileSync("tar", ["-czf", "-", "-C", dir, "ok.txt"]);
      await expect(assertSafeTar(new Uint8Array(safe))).resolves.toBeUndefined();
      const evil = execFileSync("tar", ["-czf", "-", "-C", join(dir, "sub"), "../outside.txt"]);
      await expect(assertSafeTar(new Uint8Array(evil))).rejects.toThrow("unsafe tar member");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cache tar", () => {
  it("round-trips directories", async () => {
    const src = mkdtempSync(join(tmpdir(), "flare-cache-src-"));
    const dst = mkdtempSync(join(tmpdir(), "flare-cache-dst-"));
    try {
      mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(src, "node_modules", "pkg", "x.js"), "hello");
      const blob = await createTar(src, ["node_modules"]);
      expect(blob.byteLength).toBeGreaterThan(0);
      await extractTar(dst, blob);
      expect(readFileSync(join(dst, "node_modules", "pkg", "x.js"), "utf8")).toBe("hello");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  it("rejects unsafe paths", () => {
    expect(safeCachePaths(["/abs"])).toBeNull();
    expect(safeCachePaths(["../up"])).toBeNull();
    expect(safeCachePaths([])).toBeNull();
    expect(safeCachePaths(["./rel"])).toEqual(["rel"]);
    expect(safeCachePaths(["a/b"])).toEqual(["a/b"]);
  });

  it("restores on hit and reports miss without throwing", async () => {
    const store = new Map<string, Uint8Array>();
    const client = {
      getCache: async (k: string) => store.get(k) ?? null,
      putCache: async (k: string, v: Uint8Array) => {
        store.set(k, v);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "flare-cache-io-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "f.txt"), "v");
      expect(await restoreCache(client, { key: "k", dir })).toEqual({ hit: false });
      const saved = await saveCache(client, { key: "k", dir, paths: ["data"] });
      expect(saved.saved).toBe(true);
      rmSync(join(dir, "data"), { recursive: true, force: true });
      expect(await restoreCache(client, { key: "k", dir })).toEqual({ hit: true });
      expect(readFileSync(join(dir, "data", "f.txt"), "utf8")).toBe("v");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converts backend failures into miss/save-false", async () => {
    const failing = {
      getCache: async () => {
        throw new Error("down");
      },
      putCache: async () => {
        throw new Error("down");
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "flare-cache-fail-"));
    try {
      mkdirSync(join(dir, "d"), { recursive: true });
      const miss = await restoreCache(failing, { key: "k", dir });
      expect(miss.hit).toBe(false);
      expect(miss.error).toContain("down");
      const saved = await saveCache(failing, { key: "k", dir, paths: ["d"] });
      expect(saved.saved).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
