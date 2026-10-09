// Focused tests for the remote-box core: registry transitions, input
// guards, Files-based sync/fetch, and snapshot round-trips — all
// against in-memory fakes (no containers, no D1).
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Db, DevBoxRow } from "../../worker/src/db";
import { SandboxFsError, type SeatDirEntry, type SeatFiles, type SeatFileStat } from "./sandbox-fs";
import type { ContainerSnapshot, ContainerStartOptions, ExecHandle, ExecOptions } from "./seat";
import {
  BOX_EXEC_MAX_BYTES,
  BOX_EXEC_TIMEOUT_MS,
  BOX_FETCH_MAX_BYTES,
  BOX_FILE_MAX_BYTES,
  BoxError,
  createBox,
  destroyBox,
  execBox,
  fetchBox,
  listBoxes,
  restoreBox,
  snapshotBox,
  syncBox,
  type BoxDeps,
} from "./box.ts";

class MemBoxDb implements Db {
  boxes = new Map<string, DevBoxRow>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: this.routeAll(norm, values) as T[] }),
        first: async <T,>() => (this.routeFirst(norm, values) as T | null) ?? null,
        run: async () => this.routeRun(norm, values),
      }),
    };
  }

  private routeFirst(norm: string, values: unknown[]): DevBoxRow | null {
    if (norm.startsWith("SELECT name, image, workdir, created_at, last_used_at, snapshots FROM devboxes WHERE name")) {
      return this.boxes.get(values[0] as string) ?? null;
    }
    throw new Error(`unrouted first: ${norm}`);
  }

  private routeAll(norm: string, values: unknown[]): DevBoxRow[] {
    if (norm.startsWith("SELECT name, image, workdir, created_at, last_used_at, snapshots FROM devboxes ORDER BY name")) {
      void values;
      return [...this.boxes.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    }
    throw new Error(`unrouted all: ${norm}`);
  }

  private routeRun(norm: string, values: unknown[]): unknown {
    if (norm.startsWith("INSERT INTO devboxes")) {
      const [name, image, workdir, created_at, last_used_at, snapshots] = values as string[];
      this.boxes.set(name, { name, image, workdir, created_at, last_used_at, snapshots });
      return {};
    }
    if (norm.startsWith("DELETE FROM devboxes WHERE name")) {
      return { meta: { changes: this.boxes.delete(values[0] as string) ? 1 : 0 } };
    }
    throw new Error(`unrouted run: ${norm}`);
  }
}

interface ExecAnswer {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class FakeBoxContainer {
  running = true;
  starts: (ContainerStartOptions | undefined)[] = [];
  destroys = 0;
  kills = 0;
  calls: { cmd: string[]; opts?: ExecOptions }[] = [];
  snapshots: (string | undefined)[] = [];
  // Served per exec call (shifted); HangScript hangs output forever.
  answers: ExecAnswer[] = [];
  hang = false;

  async start(opts?: ContainerStartOptions): Promise<void> {
    this.starts.push(opts);
    this.running = true;
  }

  destroy(): void {
    this.destroys += 1;
    this.running = false;
  }

  async exec(cmd: string[], opts?: ExecOptions): Promise<ExecHandle> {
    this.calls.push({ cmd, opts });
    const answer = this.answers.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    const enc = new TextEncoder();
    return {
      pid: 1,
      output: async () => {
        if (this.hang) await new Promise(() => undefined);
        return { exitCode: answer.exitCode, stdout: enc.encode(answer.stdout), stderr: enc.encode(answer.stderr) };
      },
      kill: () => {
        this.kills += 1;
      },
    };
  }

  async snapshot(name?: string): Promise<ContainerSnapshot> {
    this.snapshots.push(name);
    return { id: `snap-${this.snapshots.length}`, size: 1 };
  }

  monitor(): Promise<void> {
    return new Promise(() => undefined);
  }
}

class MemBoxFiles implements SeatFiles {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/work"]);

  async readFile(path: string, maxBytes = 4 * 1024 * 1024): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new SandboxFsError("NOT_FOUND", `readFile ${path}: missing`);
    if (bytes.byteLength > maxBytes) throw new SandboxFsError("TOO_LARGE", `readFile ${path} exceeds ${maxBytes} bytes`);
    return bytes;
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }

  async stat(path: string): Promise<SeatFileStat> {
    if (this.dirs.has(path)) return { type: "directory", size: 0, mode: 0o755 };
    const bytes = this.files.get(path);
    if (bytes) return { type: "file", size: bytes.byteLength, mode: 0o644 };
    throw new SandboxFsError("NOT_FOUND", `stat ${path}: missing`);
  }

  async lstat(path: string): Promise<SeatFileStat> {
    return this.stat(path);
  }

  async readDirectory(path: string): Promise<SeatDirEntry[]> {
    void path;
    return [];
  }

  async mkdir(path: string, _recursive?: boolean): Promise<void> {
    void _recursive;
    this.dirs.add(path);
  }
}

function deps(): { deps: BoxDeps; db: MemBoxDb; container: FakeBoxContainer; fs: MemBoxFiles } {
  const db = new MemBoxDb();
  const container = new FakeBoxContainer();
  const fs = new MemBoxFiles();
  return { deps: { db, container, fs, seatImage: "seat@sha256:abc" }, db, container, fs };
}

function b64(text: string): string {
  return btoa(text);
}

async function boxError(promise: Promise<unknown>): Promise<BoxError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BoxError);
    return err as BoxError;
  }
  throw new Error("expected a BoxError");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createBox", () => {
  it("creates a fresh box with the seat image and workdir", async () => {
    const { deps: d, db, container, fs } = deps();
    const box = await createBox(d, "demo");
    expect(box).toMatchObject({ name: "demo", container: "box-demo", image: "seat", workdir: "/work", snapshots: [] });
    expect(box.createdAt).toBeTruthy();
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0]).toMatchObject({ image: "seat@sha256:abc", enableInternet: true });
    expect(fs.dirs.has("/work")).toBe(true);
    expect(db.boxes.has("demo")).toBe(true);
  });

  it("rejects duplicate names with 409", async () => {
    const { deps: d } = deps();
    await createBox(d, "demo");
    expect((await boxError(createBox(d, "demo"))).status).toBe(409);
  });

  it("rejects bad names and non-seat images with 400", async () => {
    const { deps: d } = deps();
    expect((await boxError(createBox(d, "Demo!"))).status).toBe(400);
    expect((await boxError(createBox(d, "demo", "alpine:3.20"))).status).toBe(400);
  });
});

describe("execBox", () => {
  it("runs in the workdir and passes output through", async () => {
    const { deps: d, container } = deps();
    await createBox(d, "demo");
    container.answers.push({ exitCode: 3, stdout: "out", stderr: "err" });
    const res = await execBox(d, "demo", ["make", "test"], { env: { CI: "1" } });
    expect(res).toMatchObject({ stdout: "out", stderr: "err", exitCode: 3, timedOut: false });
    expect(container.calls[0]).toMatchObject({ cmd: ["make", "test"], opts: { cwd: "/work", env: { CI: "1" } } });
  });

  it("wakes a sleeping container before exec", async () => {
    const { deps: d, container } = deps();
    await createBox(d, "demo");
    container.running = false;
    container.starts.length = 0;
    await execBox(d, "demo", ["true"]);
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0]).toMatchObject({ image: "seat@sha256:abc", enableInternet: true });
  });

  it("times out hung execs, kills the handle, and reports 124", async () => {
    vi.useFakeTimers();
    const { deps: d, container } = deps();
    await createBox(d, "demo");
    container.hang = true;
    const pending = execBox(d, "demo", ["sleep", "9999"]);
    await vi.advanceTimersByTimeAsync(BOX_EXEC_TIMEOUT_MS + 1000);
    const res = await pending;
    expect(res).toMatchObject({ exitCode: 124, timedOut: true });
    expect(container.kills).toBe(1);
  });

  it("truncates oversized streams with a note", async () => {
    const { deps: d, container } = deps();
    await createBox(d, "demo");
    container.answers.push({ exitCode: 0, stdout: "x".repeat(BOX_EXEC_MAX_BYTES + 10), stderr: "" });
    const res = await execBox(d, "demo", ["cat", "big"]);
    expect(res.stdout).toContain("[truncated 10 bytes]");
  });

  it("rejects empty commands, arg floods, bad env names, and relative cwds", async () => {
    const { deps: d } = deps();
    await createBox(d, "demo");
    expect((await boxError(execBox(d, "demo", []))).status).toBe(400);
    expect((await boxError(execBox(d, "demo", Array.from({ length: 33 }, () => "a")))).status).toBe(400);
    expect((await boxError(execBox(d, "demo", ["true"], { env: { "NOPE!": "1" } }))).status).toBe(400);
    expect((await boxError(execBox(d, "demo", ["true"], { cwd: "rel" }))).status).toBe(400);
    expect((await boxError(execBox(d, "missing", ["true"]))).status).toBe(404);
  });
});

describe("syncBox", () => {
  it("writes files via the Files channel and makes parent dirs", async () => {
    const { deps: d, fs } = deps();
    await createBox(d, "demo");
    const res = await syncBox(d, "demo", [
      { path: "a.txt", content_b64: b64("hello") },
      { path: "sub/b.txt", content_b64: b64("world") },
    ]);
    expect(res).toEqual({ paths: ["a.txt", "sub/b.txt"], bytes: 10 });
    expect(new TextDecoder().decode(fs.files.get("/work/a.txt") ?? new Uint8Array())).toBe("hello");
    expect(new TextDecoder().decode(fs.files.get("/work/sub/b.txt") ?? new Uint8Array())).toBe("world");
    expect(fs.dirs.has("/work/sub")).toBe(true);
  });

  it("rejects escaping and absolute paths without writing anything", async () => {
    const { deps: d, fs } = deps();
    await createBox(d, "demo");
    expect((await boxError(syncBox(d, "demo", [{ path: "../evil", content_b64: b64("x") }]))).status).toBe(400);
    expect((await boxError(syncBox(d, "demo", [{ path: "/etc/passwd", content_b64: b64("x") }]))).status).toBe(400);
    expect(fs.files.size).toBe(0);
  });

  it("rejects oversize files and batches before writing anything", async () => {
    const { deps: d, fs } = deps();
    await createBox(d, "demo");
    const big = "z".repeat(BOX_FILE_MAX_BYTES + 1);
    // btoa on multi-MB strings is slow; encode a big buffer instead.
    const bigB64 = Buffer.from(big).toString("base64");
    expect((await boxError(syncBox(d, "demo", [{ path: "ok.txt", content_b64: b64("x") }, { path: "big.bin", content_b64: bigB64 }]))).status).toBe(413);
    expect(fs.files.size).toBe(0);
    expect((await boxError(syncBox(d, "demo", []))).status).toBe(400);
    const flood = Array.from({ length: 257 }, () => ({ path: "a", content_b64: b64("x") }));
    expect((await boxError(syncBox(d, "demo", flood))).status).toBe(400);
  });
});

describe("fetchBox", () => {
  it("round-trips a file as base64", async () => {
    const { deps: d, fs } = deps();
    await createBox(d, "demo");
    fs.files.set("/work/out.log", new TextEncoder().encode("log-line"));
    const res = await fetchBox(d, "demo", "out.log");
    expect(res.kind).toBe("file");
    if (res.kind === "file") {
      expect(res.bytes).toBe(8);
      expect(atob(res.content_b64)).toBe("log-line");
    }
  });

  it("tars directories through exec", async () => {
    const { deps: d, fs, container } = deps();
    await createBox(d, "demo");
    fs.dirs.add("/work/dist");
    container.answers.push({ exitCode: 0, stdout: "tar-bytes", stderr: "" });
    const res = await fetchBox(d, "demo", "dist");
    expect(res.kind).toBe("tarball");
    expect(container.calls[0]?.cmd).toEqual(["tar", "-czf", "-", "-C", "/work", "dist"]);
  });

  it("404s missing paths and 413s oversize files", async () => {
    const { deps: d, fs } = deps();
    await createBox(d, "demo");
    expect((await boxError(fetchBox(d, "demo", "nope.txt"))).status).toBe(404);
    fs.files.set("/work/huge.bin", new Uint8Array(BOX_FETCH_MAX_BYTES + 1));
    expect((await boxError(fetchBox(d, "demo", "huge.bin"))).status).toBe(413);
  });
});

describe("snapshots", () => {
  it("snapshots with a default timestamp tag and restores by tag", async () => {
    const { deps: d, container } = deps();
    await createBox(d, "demo");
    const snap = await snapshotBox(d, "demo");
    expect(snap.tag).toMatch(/^snap-\d{8}-\d{6}$/);
    expect(snap.snapshotId).toBe("snap-1");
    expect(container.snapshots).toEqual(["box-demo-" + snap.tag]);
    expect((await boxError(snapshotBox(d, "demo", snap.tag))).status).toBe(409);
    expect((await boxError(snapshotBox(d, "demo", "Bad!"))).status).toBe(400);

    const before = container.starts.length;
    const restored = await restoreBox(d, "demo", snap.tag);
    expect(restored.name).toBe("demo");
    expect(container.starts.length).toBe(before + 1);
    expect(container.starts[container.starts.length - 1]).toMatchObject({ snapshotId: "snap-1", enableInternet: true });
    expect((await boxError(restoreBox(d, "demo", "missing"))).status).toBe(404);
  });
});

describe("destroyBox / listBoxes", () => {
  it("destroys the container and drops the row, keeping snapshot tags", async () => {
    const { deps: d, db, container } = deps();
    await createBox(d, "demo");
    await snapshotBox(d, "demo", "v1");
    const res = await destroyBox(d, "demo");
    expect(res).toEqual({ name: "demo", snapshots: ["v1"] });
    expect(container.destroys).toBeGreaterThan(0);
    expect(db.boxes.has("demo")).toBe(false);
    expect(await listBoxes(d)).toEqual([]);
    expect((await boxError(destroyBox(d, "demo"))).status).toBe(404);
  });

  it("lists boxes in name order", async () => {
    const { deps: d } = deps();
    await createBox(d, "b-box");
    await createBox(d, "a-box");
    expect((await listBoxes(d)).map((b) => b.name)).toEqual(["a-box", "b-box"]);
  });
});
