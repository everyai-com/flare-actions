import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BoxManager,
  boxContainerName,
  boxSnapshotRef,
  validateBoxName,
  validateSnapshotTag,
  type DevboxDeps,
} from "./devbox";
import type { LocalBytesResult } from "../../seats/src/local-docker";

const enc = new TextEncoder();

interface Script {
  run?: { exitCode: number; stdout?: string; stderr?: string };
  commit?: { exitCode: number; stderr?: string };
  cp?: { exitCode: number; stdout?: Uint8Array; stderr?: string };
  inspect?: string;
  execs?: { exitCode: number; stdout?: string; stderr?: string }[];
}

function fakeDeps(script: Script, registryPath: string): DevboxDeps & { argv: string[][]; spawns: string[][]; untarred: { dir: string; bytes: number }[] } {
  const argv: string[][] = [];
  const spawns: string[][] = [];
  const untarred: { dir: string; bytes: number }[] = [];
  const execs = [...(script.execs ?? [])];
  return {
    argv,
    spawns,
    untarred,
    registryPath,
    tarball: async (_dir, paths) => enc.encode(`tar:${paths.join(",")}`),
    untar: async (dir, data) => {
      untarred.push({ dir, bytes: data.byteLength });
    },
    assertSafe: async () => undefined,
    runner: {
      run: async (cmd, args) => {
        argv.push([cmd, ...args]);
        if (args[0] === "wait") return new Promise(() => undefined);
        if (args[0] === "run") {
          const r = script.run ?? { exitCode: 0 };
          return { exitCode: r.exitCode, stdout: r.stdout ?? "id\n", stderr: r.stderr ?? "" };
        }
        if (args[0] === "inspect") return { exitCode: 0, stdout: script.inspect ?? "true\n", stderr: "" };
        if (args[0] === "commit") {
          const r = script.commit ?? { exitCode: 0 };
          return { exitCode: r.exitCode, stdout: "sha\n", stderr: r.stderr ?? "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (cmd, args, opts) => {
        spawns.push([cmd, ...args]);
        void opts;
        let res: LocalBytesResult;
        if (args[0] === "cp") {
          const cp = script.cp ?? { exitCode: 0, stdout: enc.encode("tar-bytes") };
          res = { exitCode: cp.exitCode, stdout: cp.stdout ?? new Uint8Array(), stderr: enc.encode(cp.stderr ?? "") };
        } else {
          const next = execs.shift() ?? { exitCode: 0 };
          res = { exitCode: next.exitCode, stdout: enc.encode(next.stdout ?? ""), stderr: enc.encode(next.stderr ?? "") };
        }
        return { pid: 1, done: Promise.resolve(res), kill: () => undefined };
      },
    },
  };
}

function tempRegistry(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "flare-devbox-"));
  return { path: join(dir, "devboxes.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedRegistry(path: string, boxes: Record<string, object>): void {
  writeFileSync(path, JSON.stringify({ boxes }));
}

describe("validators", () => {
  it("accepts lowercase-dash names and rejects the rest", () => {
    validateBoxName("api-1");
    expect(() => validateBoxName("API")).toThrow("invalid devbox name");
    expect(() => validateBoxName("../x")).toThrow("invalid devbox name");
    expect(() => validateBoxName("")).toThrow("invalid devbox name");
    validateSnapshotTag("snap-20261005-110200");
    expect(() => validateSnapshotTag("UPPER")).toThrow("invalid snapshot tag");
  });

  it("derives stable container names and snapshot refs", () => {
    expect(boxContainerName("api")).toBe("flare-devbox-api");
    expect(boxSnapshotRef("api", "s1")).toBe("flare-devbox-api:s1");
  });
});

describe("BoxManager", () => {
  it("create starts a fixed-name instance, ensures the workdir, and records it", async () => {
    const reg = tempRegistry();
    try {
      const deps = fakeDeps({ execs: [{ exitCode: 0 }] }, reg.path);
      const boxes = new BoxManager(deps);
      const created = await boxes.create("api", { image: "img:1" });
      expect(created.container).toBe("flare-devbox-api");
      expect(created.workdir).toBe("/work");
      const run = deps.argv.find((a) => a[1] === "run");
      expect(run).toContain("flare-devbox-api");
      expect(run).toContain("img:1");
      const mkdir = deps.spawns.find((a) => a.includes("mkdir"));
      expect(mkdir).toBeDefined();
      expect(boxes.list().map((b) => b.name)).toEqual(["api"]);
    } finally {
      reg.cleanup();
    }
  });

  it("create rejects duplicates and cleans up after a failed start", async () => {
    const reg = tempRegistry();
    try {
      seedRegistry(reg.path, { api: { container: "flare-devbox-api", image: "i", workdir: "/work", createdAt: "", snapshots: [] } });
      const deps = fakeDeps({}, reg.path);
      const boxes = new BoxManager(deps);
      await expect(boxes.create("api")).rejects.toThrow("already exists");
      await expect(boxes.create("Bad Name")).rejects.toThrow("invalid devbox name");

      const reg2 = tempRegistry();
      try {
        const deps2 = fakeDeps({ run: { exitCode: 125, stderr: "no such image" } }, reg2.path);
        await expect(new BoxManager(deps2).create("api")).rejects.toThrow("no such image");
        // Start failed before a container existed: nothing to remove,
        // and the registry stays empty.
        expect(deps2.argv.some((a) => a[1] === "rm")).toBe(false);
        expect(new BoxManager(deps2).list()).toEqual([]);
      } finally {
        reg2.cleanup();
      }
    } finally {
      reg.cleanup();
    }
  });

  it("exec attaches to the recorded container and truncates large output", async () => {
    const reg = tempRegistry();
    try {
      seedRegistry(reg.path, { api: { container: "flare-devbox-api", image: "i", workdir: "/work", createdAt: "", snapshots: [] } });
      const big = "x".repeat(300 * 1024);
      const deps = fakeDeps({ execs: [{ exitCode: 3, stdout: big, stderr: "e" }] }, reg.path);
      const res = await new BoxManager(deps).exec("api", ["make", "test"], { env: { A: "1" } });
      expect(res.exitCode).toBe(3);
      expect(res.truncated).toBe(true);
      expect(res.stdout).toContain("[truncated ");
      const exec = deps.spawns.find((a) => a[1] === "exec");
      expect(exec).toContain("flare-devbox-api");
      expect(exec?.slice(-2)).toEqual(["make", "test"]);
      await expect(new BoxManager(deps).exec("api", [])).rejects.toThrow("needs a command");
      await expect(new BoxManager(deps).exec("ghost", ["x"])).rejects.toThrow("unknown devbox");
    } finally {
      reg.cleanup();
    }
  });

  it("sync tars the tree and extracts it into the workdir", async () => {
    const reg = tempRegistry();
    try {
      seedRegistry(reg.path, { api: { container: "flare-devbox-api", image: "i", workdir: "/work", createdAt: "", snapshots: [] } });
      const deps = fakeDeps({ execs: [{ exitCode: 0 }] }, reg.path);
      const res = await new BoxManager(deps).sync("api", "/repo", ["src", "flare.yml"]);
      expect(res.paths).toEqual(["src", "flare.yml"]);
      expect(res.bytes).toBeGreaterThan(0);
      const exec = deps.spawns.find((a) => a[1] === "exec");
      expect(exec?.slice(-5)).toEqual(["tar", "-xzf", "-", "-C", "/work"]);

      const deps2 = fakeDeps({ execs: [{ exitCode: 2, stderr: "tar broke" }] }, reg.path);
      await expect(new BoxManager(deps2).sync("api", "/repo", ["src"])).rejects.toThrow("tar broke");
    } finally {
      reg.cleanup();
    }
  });

  it("fetch rejects traversal paths and extracts safe cp output", async () => {
    const reg = tempRegistry();
    try {
      seedRegistry(reg.path, { api: { container: "flare-devbox-api", image: "i", workdir: "/work", createdAt: "", snapshots: [] } });
      const deps = fakeDeps({}, reg.path);
      const boxes = new BoxManager(deps);
      await expect(boxes.fetch("api", "/etc/passwd", "/tmp")).rejects.toThrow("unsafe fetch path");
      await expect(boxes.fetch("api", "../escape", "/tmp")).rejects.toThrow("unsafe fetch path");
      expect(deps.spawns).toEqual([]);
      const res = await boxes.fetch("api", "dist/app.js", "/tmp/out");
      expect(res.bytes).toBe("tar-bytes".length);
      expect(deps.untarred).toEqual([{ dir: "/tmp/out", bytes: "tar-bytes".length }]);
      const cp = deps.spawns.find((a) => a[1] === "cp");
      expect(cp?.[2]).toBe("flare-devbox-api:/work/dist/app.js");
    } finally {
      reg.cleanup();
    }
  });

  it("snapshot commits with a default timestamp tag and rejects duplicates", async () => {
    const reg = tempRegistry();
    try {
      seedRegistry(reg.path, { api: { container: "flare-devbox-api", image: "i", workdir: "/work", createdAt: "", snapshots: [] } });
      const deps = fakeDeps({}, reg.path);
      const boxes = new BoxManager(deps);
      const snap = await boxes.snapshot("api");
      expect(snap.tag).toMatch(/^snap-\d{8}-\d{6}$/);
      const commit = deps.argv.find((a) => a[1] === "commit");
      expect(commit?.slice(-2)).toEqual(["flare-devbox-api", `flare-devbox-api:${snap.tag}`]);
      await expect(boxes.snapshot("api", snap.tag)).rejects.toThrow("already exists");
      await expect(boxes.snapshot("api", "Bad Tag")).rejects.toThrow("invalid snapshot tag");
    } finally {
      reg.cleanup();
    }
  });

  it("restore recreates the instance from the snapshot ref", async () => {
    const reg = tempRegistry();
    try {
      seedRegistry(reg.path, {
        api: {
          container: "flare-devbox-api",
          image: "img:1",
          workdir: "/work",
          createdAt: "",
          snapshots: [{ tag: "s1", createdAt: "" }],
        },
      });
      const deps = fakeDeps({ execs: [{ exitCode: 0 }] }, reg.path);
      const boxes = new BoxManager(deps);
      await expect(boxes.restore("api", "nope")).rejects.toThrow("unknown snapshot");
      const restored = await boxes.restore("api", "s1");
      expect(restored.image).toBe("flare-devbox-api:s1");
      expect(deps.argv.some((a) => a[1] === "rm")).toBe(true);
      const run = deps.argv.find((a) => a[1] === "run");
      expect(run).toContain("flare-devbox-api:s1");
    } finally {
      reg.cleanup();
    }
  });

  it("destroy removes the record and reports kept images", async () => {
    const reg = tempRegistry();
    try {
      seedRegistry(reg.path, {
        b: { container: "flare-devbox-b", image: "i", workdir: "/work", createdAt: "", snapshots: [{ tag: "s1", createdAt: "" }] },
        a: { container: "flare-devbox-a", image: "i", workdir: "/work", createdAt: "", snapshots: [] },
      });
      const deps = fakeDeps({}, reg.path);
      const boxes = new BoxManager(deps);
      expect(boxes.list().map((b) => b.name)).toEqual(["a", "b"]);
      const destroyed = await boxes.destroy("b");
      expect(destroyed.imagesKept).toEqual(["flare-devbox-b:s1"]);
      expect(boxes.list().map((b) => b.name)).toEqual(["a"]);
      await expect(boxes.destroy("b")).rejects.toThrow("unknown devbox");
    } finally {
      reg.cleanup();
    }
  });

  it("missing registry reads empty; corrupt registry fails loudly", () => {
    const reg = tempRegistry();
    try {
      expect(new BoxManager(fakeDeps({}, reg.path)).list()).toEqual([]);
      writeFileSync(reg.path, "not json{");
      expect(() => new BoxManager(fakeDeps({}, reg.path)).list()).toThrow("corrupt");
    } finally {
      reg.cleanup();
    }
  });
});
