import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assertSafeTar, createTar, extractTar, restoreCache, safeCachePaths, saveCache } from "./cache";

// GNU tar strips leading `../` when creating archives, so traversal
// members cannot be produced with the tar binary on Linux. Handcraft the
// archive instead (this is what a hostile uploader would do).
function tarArchive(members: { name: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const m of members) {
    const header = new Uint8Array(512);
    header.set(enc.encode(m.name).slice(0, 100), 0);
    header.set(enc.encode("0000644"), 100);
    header.set(enc.encode("0000000"), 108);
    header.set(enc.encode("0000000"), 116);
    const data = enc.encode(m.content);
    header.set(enc.encode(data.length.toString(8).padStart(11, "0")), 124);
    header.set(enc.encode("00000000000"), 136);
    header.set(enc.encode("        "), 148);
    header.set(enc.encode("0"), 156);
    header.set(enc.encode("ustar"), 257);
    header.set(enc.encode("00"), 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

describe("assertSafeTar", () => {
  it("accepts normal archives and rejects traversal or absolute members", async () => {
    const safe = gzipSync(tarArchive([{ name: "src/ok.txt", content: "hi" }]));
    await expect(assertSafeTar(new Uint8Array(safe))).resolves.toBeUndefined();
    const traversal = gzipSync(tarArchive([{ name: "../outside.txt", content: "escape" }]));
    await expect(assertSafeTar(new Uint8Array(traversal))).rejects.toThrow("unsafe tar member");
    const absolute = gzipSync(tarArchive([{ name: "/etc/passwd", content: "x" }]));
    await expect(assertSafeTar(new Uint8Array(absolute))).rejects.toThrow("unsafe tar member");
    const junk = new Uint8Array([1, 2, 3]);
    await expect(assertSafeTar(junk)).rejects.toThrow();
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
      getCacheOrPrefix: async (k: string, restoreKeys: string[]) => {
        const exact = store.get(k);
        if (exact) return { data: exact, key: k };
        for (const p of restoreKeys) {
          const hit = [...store.keys()].find((sk) => sk.startsWith(p));
          if (hit) return { data: store.get(hit) as Uint8Array, key: hit };
        }
        return null;
      },
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
      expect(await restoreCache(client, { key: "k", dir })).toEqual({ hit: true, key: "k" });
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
      getCacheOrPrefix: async (): Promise<never> => {
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

  it("restores through restore-keys and names the matching prefix", async () => {
    const store = new Map<string, Uint8Array>([
      ["node-abc", new TextEncoder().encode("blob")],
      ["go-xyz", new TextEncoder().encode("blob")],
    ]);
    const client = {
      getCache: async (k: string) => store.get(k) ?? null,
      getCacheOrPrefix: async (k: string, restoreKeys: string[]) => {
        const exact = store.get(k);
        if (exact) return { data: exact, key: k };
        for (const p of restoreKeys) {
          const hit = [...store.keys()].find((sk) => sk.startsWith(p));
          if (hit) return { data: store.get(hit) as Uint8Array, key: hit };
        }
        return null;
      },
      putCache: async (k: string, v: Uint8Array) => {
        store.set(k, v);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "flare-cache-rk-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "f.txt"), "v");
      // Seed a real tarball under the prefix key, then restore it via
      // a missing exact key.
      const saved = await saveCache(client, { key: "node-abc", dir, paths: ["data"] });
      expect(saved.saved).toBe(true);
      rmSync(join(dir, "data"), { recursive: true, force: true });
      const hit = await restoreCache(client, { key: "node-missing", dir, restoreKeys: ["zzz-", "node-"] });
      expect(hit).toEqual({ hit: true, key: "node-abc", viaRestoreKey: "node-" });
      expect(readFileSync(join(dir, "data", "f.txt"), "utf8")).toBe("v");
      const miss = await restoreCache(client, { key: "node-missing", dir, restoreKeys: ["zzz-"] });
      expect(miss).toEqual({ hit: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
