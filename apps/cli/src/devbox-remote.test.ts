// Focused tests for the remote devbox manager: HTTP mapping, sync
// tree-walking, fetch extraction, and guards — all against a fake
// fetch and temp dirs (no seats worker, no docker).
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBoxManager } from "./devbox-remote.ts";

interface RecordedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeFetch(handler: (call: RecordedCall) => { ok: boolean; status: number; payload: unknown }): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const call = { url: String(url), init: (init ?? {}) as RecordedCall["init"] };
    calls.push(call);
    const { ok, status, payload } = handler(call);
    return { ok, status, json: async () => payload };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function boxJson(name = "demo", snapshots: { tag: string; snapshotId: string; createdAt: string }[] = []) {
  return {
    name,
    container: `box-${name}`,
    image: "seat",
    workdir: "/work",
    createdAt: "2026-10-09T00:00:00.000Z",
    lastUsedAt: "2026-10-09T00:00:01.000Z",
    snapshots,
  };
}

function managerFor(handler: (call: RecordedCall) => { ok: boolean; status: number; payload: unknown }, extra?: { untar?: (dir: string, data: Uint8Array) => Promise<void>; assertSafe?: (data: Uint8Array) => Promise<void> }) {
  const { fetchImpl, calls } = fakeFetch(handler);
  const mgr = new RemoteBoxManager({ baseUrl: "https://seats.example/", token: "tok", fetchImpl, ...extra });
  return { mgr, calls };
}

describe("RemoteBoxManager", () => {
  it("fromEnv needs SEATS_URL and SEATS_TOKEN", () => {
    expect(() => RemoteBoxManager.fromEnv({})).toThrow("SEATS_URL");
    expect(() => RemoteBoxManager.fromEnv({ SEATS_URL: "https://x" })).toThrow("SEATS_TOKEN");
    expect(RemoteBoxManager.fromEnv({ SEATS_URL: "https://x", SEATS_TOKEN: "t" })).toBeInstanceOf(RemoteBoxManager);
  });

  it("create posts the name and maps the summary", async () => {
    const { mgr, calls } = managerFor(() => ({ ok: true, status: 200, payload: { ok: true, box: boxJson() } }));
    const box = await mgr.create("demo");
    expect(box).toMatchObject({ name: "demo", container: "box-demo", image: "seat", workdir: "/work", snapshots: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://seats.example/v1/box/create");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({ name: "demo" });
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("surfaces server errors and connection failures", async () => {
    const { mgr } = managerFor(() => ({ ok: false, status: 409, payload: { error: "already exists" } }));
    await expect(mgr.create("demo")).rejects.toThrow("remote devbox create failed: already exists");
    const down = new RemoteBoxManager({
      baseUrl: "https://seats.example",
      token: "tok",
      fetchImpl: (async () => {
        throw new Error("socket hangup");
      }) as unknown as typeof fetch,
    });
    await expect(down.list()).rejects.toThrow("remote devbox list failed: socket hangup");
  });

  it("validates box names before any HTTP", async () => {
    const { mgr, calls } = managerFor(() => ({ ok: true, status: 200, payload: {} }));
    await expect(mgr.exec("Bad!", ["true"])).rejects.toThrow("invalid devbox name");
    await expect(mgr.exec("demo", [])).rejects.toThrow("needs a command");
    expect(calls).toHaveLength(0);
  });

  it("exec maps results and notes timeouts", async () => {
    const { mgr, calls } = managerFor(() => ({
      ok: true,
      status: 200,
      payload: { ok: true, stdout: "out", stderr: "", exitCode: 124, timedOut: true, truncated: false },
    }));
    const res = await mgr.exec("demo", ["make"], { cwd: "/work/sub", env: { CI: "1" } });
    expect(res.exitCode).toBe(124);
    expect(res.stderr).toContain("[exec timed out after 10 minutes]");
    expect(res.truncated).toBe(false);
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({ name: "demo", command: ["make"], cwd: "/work/sub", env: { CI: "1" } });
  });

  it("sync walks nested files in sorted order and skips symlinks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-sync-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "b.txt"), "bee");
    writeFileSync(join(dir, "sub", "a.txt"), "aye");
    try {
      symlinkSync(join(dir, "b.txt"), join(dir, "link.txt"));
    } catch {
      // Filesystems without symlink rights still test the walk.
    }
    const { mgr, calls } = managerFor((call) => {
      const body = JSON.parse(call.init.body ?? "{}") as { files: { path: string }[] };
      return { ok: true, status: 200, payload: { ok: true, bytes: 6, paths: body.files.map((f) => f.path) } };
    });
    const res = await mgr.sync("demo", dir, ["."]);
    expect(res.paths).toEqual(["b.txt", "sub/a.txt"]);
    const sent = JSON.parse(calls[0]?.init.body ?? "{}") as { files: { path: string; content_b64: string }[] };
    expect(sent.files.map((f) => f.path)).toEqual(["b.txt", "sub/a.txt"]);
    expect(Buffer.from(sent.files[0]?.content_b64 ?? "", "base64").toString()).toBe("bee");
  });

  it("sync refuses escapes and floods before any HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-sync-"));
    writeFileSync(join(dir, "a.txt"), "x");
    const { mgr, calls } = managerFor(() => ({ ok: true, status: 200, payload: {} }));
    await expect(mgr.sync("demo", dir, ["../evil"])).rejects.toThrow("must stay inside");
    const flood = mkdtempSync(join(tmpdir(), "flare-flood-"));
    for (let i = 0; i < 257; i++) writeFileSync(join(flood, `f${i}.txt`), "x");
    await expect(mgr.sync("demo", flood, ["."])).rejects.toThrow("257 > 256");
    expect(calls).toHaveLength(0);
  });

  it("fetch writes files with parents and refuses escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-fetch-"));
    const { mgr, calls } = managerFor(() => ({
      ok: true,
      status: 200,
      payload: { ok: true, kind: "file", content_b64: Buffer.from("log-line").toString("base64"), bytes: 8 },
    }));
    const res = await mgr.fetch("demo", "sub/out.log", dir);
    expect(res).toEqual({ bytes: 8, path: "sub/out.log" });
    expect(readFileSync(join(dir, "sub", "out.log"), "utf8")).toBe("log-line");
    await expect(mgr.fetch("demo", "../evil", dir)).rejects.toThrow("must stay inside");
    await expect(mgr.fetch("demo", "/etc/passwd", dir)).rejects.toThrow("must stay inside");
    expect(calls).toHaveLength(1);
  });

  it("fetch checks and extracts tarballs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-tar-"));
    const seen: { safe: Uint8Array[]; extracted: string[] } = { safe: [], extracted: [] };
    const { mgr } = managerFor(
      () => ({ ok: true, status: 200, payload: { ok: true, kind: "tarball", content_b64: Buffer.from("tar").toString("base64"), bytes: 3 } }),
      {
        assertSafe: async (data) => {
          seen.safe.push(data);
        },
        untar: async (into) => {
          seen.extracted.push(into);
        },
      },
    );
    const res = await mgr.fetch("demo", "dist", dir);
    expect(res).toEqual({ bytes: 3, path: "dist" });
    expect(seen.safe).toHaveLength(1);
    expect(seen.extracted).toEqual([dir]);
  });

  it("snapshot, restore, destroy, and list map cleanly", async () => {
    const snaps = [{ tag: "v1", snapshotId: "snap-1", createdAt: "2026-10-09T00:00:00.000Z" }];
    const { mgr } = managerFor((call) => {
      if (call.url.endsWith("/v1/box/snapshot")) return { ok: true, status: 200, payload: { ok: true, snapshot: snaps[0] } };
      if (call.url.endsWith("/v1/box/restore")) return { ok: true, status: 200, payload: { ok: true, box: boxJson("demo", snaps) } };
      if (call.url.endsWith("/v1/box/destroy")) return { ok: true, status: 200, payload: { ok: true, name: "demo", snapshots: ["v1"] } };
      return { ok: true, status: 200, payload: { ok: true, boxes: [boxJson("b-box"), boxJson("a-box")] } };
    });
    expect(await mgr.snapshot("demo")).toEqual({ tag: "v1", createdAt: "2026-10-09T00:00:00.000Z" });
    const restored = await mgr.restore("demo", "v1");
    expect(restored.snapshots).toEqual([{ tag: "v1", createdAt: "2026-10-09T00:00:00.000Z" }]);
    expect(await mgr.destroy("demo")).toEqual({ name: "demo", imagesKept: ["v1"] });
    expect((await mgr.list()).map((b) => b.name)).toEqual(["b-box", "a-box"]);
  });
});
