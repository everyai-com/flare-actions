import { describe, expect, it } from "vitest";
import type { DirectoryBackup, DirectoryBackupRecord, Files, S3Mount } from "@cloudflare/sandbox";
import {
  adaptDirBackup,
  adaptFiles,
  adaptMount,
  assertContainerPath,
  buildS3MountRequest,
  isSandboxFsError,
  SandboxFsError,
  toSandboxFsError,
} from "./sandbox-fs";

function sdkFileError(code: string): Error {
  return Object.assign(new Error(code), { name: "SandboxFileError", code, operation: "readFile", path: "/x", detail: "" });
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
}

describe("assertContainerPath", () => {
  it("accepts absolute paths", () => {
    expect(assertContainerPath("/work/junit.xml")).toBe("/work/junit.xml");
  });
  it.each(["", "rel/path", "/a/../b", "/x\0y", `/${"a".repeat(4096)}`])("rejects %j", (p) => {
    expect(() => assertContainerPath(p)).toThrowError(SandboxFsError);
  });
});

describe("toSandboxFsError", () => {
  it("maps file codes structurally", () => {
    expect(toSandboxFsError(sdkFileError("ENOENT"), "readFile").code).toBe("NOT_FOUND");
    expect(toSandboxFsError(sdkFileError("ENOTDIR"), "stat").code).toBe("NOT_DIR");
    expect(toSandboxFsError(sdkFileError("EACCES"), "readFile").code).toBe("DENIED");
    expect(toSandboxFsError(sdkFileError("EIO"), "readFile").code).toBe("IO");
  });
  it("maps gateway and protocol failures", () => {
    const backup = Object.assign(new Error("x"), { name: "SandboxBackupError" });
    const mount = Object.assign(new Error("x"), { name: "SandboxS3MountError" });
    const proto = Object.assign(new Error("x"), { name: "SandboxProtocolError" });
    expect(toSandboxFsError(backup, "backup").code).toBe("BACKUP");
    expect(toSandboxFsError(mount, "mount").code).toBe("MOUNT");
    expect(toSandboxFsError(proto, "readFile").code).toBe("PROTOCOL");
  });
  it("passes ours through and wraps the rest", () => {
    const ours = new SandboxFsError("NOT_FOUND", "gone");
    expect(toSandboxFsError(ours, "readFile")).toBe(ours);
    expect(toSandboxFsError(new Error("boom"), "stat").code).toBe("IO");
    expect(toSandboxFsError("strange", "stat").code).toBe("IO");
    expect(isSandboxFsError(ours)).toBe(true);
    expect(isSandboxFsError(new Error("x"))).toBe(false);
  });
});

describe("adaptFiles", () => {
  const text = new TextEncoder().encode("hello");
  const files = {
    readFile: async () => new Response(streamOf(text)),
    writeFile: async () => undefined,
    stat: async () => ({ type: "file", size: 5n, mode: 0o644, uid: 0, gid: 0, accessedAt: new Date(), modifiedAt: new Date(), changedAt: new Date() }),
    lstat: async () => ({ type: "symlink", size: 5n, mode: 0o777, uid: 0, gid: 0, accessedAt: new Date(), modifiedAt: new Date(), changedAt: new Date() }),
    readDirectory: async () => [{ name: "a.xml", type: "file" as const }, { name: "sub", type: "directory" as const }],
    mkdir: async () => undefined,
  } as unknown as Files;

  it("reads, stats, lists, writes, and makes dirs", async () => {
    const fs = adaptFiles(files);
    expect(await fs.readFile("/work/f")).toEqual(text);
    expect(await fs.stat("/work/f")).toEqual({ type: "file", size: 5, mode: 0o644 });
    expect(await fs.lstat("/work/l")).toEqual({ type: "symlink", size: 5, mode: 0o777 });
    expect(await fs.readDirectory("/work")).toEqual([
      { name: "a.xml", type: "file" },
      { name: "sub", type: "directory" },
    ]);
    await expect(fs.writeFile("/work/f", "x")).resolves.toBeUndefined();
    await expect(fs.mkdir("/work/d", true)).resolves.toBeUndefined();
  });
  it("caps reads and maps failures", async () => {
    const fs = adaptFiles(files);
    await expect(fs.readFile("/work/f", 2)).rejects.toMatchObject({ code: "TOO_LARGE" });
    const failing = adaptFiles({ ...files, readFile: async () => { throw sdkFileError("ENOENT"); } } as unknown as Files);
    await expect(failing.readFile("/work/missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fs.readFile("relative")).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("adaptDirBackup", () => {
  const record: DirectoryBackupRecord = {
    id: "b1",
    dir: "/work",
    size: 10,
    sha256: "abc",
    format: "tar+zstd/1",
  };
  const backup = {
    backup: async () => record,
    restore: async () => undefined,
    delete: async () => undefined,
  } as unknown as DirectoryBackup;

  it("backs up, restores, and deletes", async () => {
    const b = adaptDirBackup(backup);
    expect(await b.backup("/work", { name: "retain" })).toEqual({ id: "b1", dir: "/work", size: 10, sha256: "abc" });
    await expect(b.restore({ id: "b1", dir: "/work", size: 10, sha256: "abc" })).resolves.toBeUndefined();
    await expect(b.deleteRecord({ id: "b1", dir: "/work", size: 10, sha256: "abc" })).resolves.toBeUndefined();
    await expect(b.backup("relative")).rejects.toMatchObject({ code: "INVALID" });
  });
  it("maps backup failures", async () => {
    const failing = adaptDirBackup({
      ...backup,
      backup: async () => { throw Object.assign(new Error("x"), { name: "SandboxBackupError" }); },
    } as unknown as DirectoryBackup);
    await expect(failing.backup("/work")).rejects.toMatchObject({ code: "BACKUP" });
  });
});

describe("buildS3MountRequest", () => {
  const cfg = { endpoint: "https://x.r2.cloudflarestorage.com", region: "auto", bucket: "b", accessKeyId: "id", secretAccessKey: "s" };
  it("builds a slash-terminated prefix request", () => {
    const req = buildS3MountRequest(cfg, { mountPath: "/mnt/cache", keyPrefix: "cache", access: "read-write" });
    expect(req.mountPath).toBe("/mnt/cache");
    expect(req.keyPrefix).toBe("cache/");
    expect(req.access).toBe("read-write");
    expect(req.source).toMatchObject({ type: "s3", bucket: "b" });
  });
  it("rejects bad paths and prefixes", () => {
    expect(() => buildS3MountRequest(cfg, { mountPath: "rel", access: "read-only" })).toThrowError(SandboxFsError);
    expect(() => buildS3MountRequest(cfg, { mountPath: "/m", keyPrefix: "../x", access: "read-only" })).toThrowError(SandboxFsError);
    expect(() => buildS3MountRequest(cfg, { mountPath: "/m", keyPrefix: "/abs", access: "read-only" })).toThrowError(SandboxFsError);
  });
});

describe("adaptMount", () => {
  const cfg = { endpoint: "https://x.r2.cloudflarestorage.com", region: "auto", bucket: "b", accessKeyId: "id", secretAccessKey: "s" };
  const seen: unknown[] = [];
  const mount = {
    mount: async (req: unknown) => { seen.push(req); },
    inspect: async () => ({ mountPath: "/m", attachment: { status: "managed" } }),
    unmount: async () => undefined,
  } as unknown as S3Mount;

  it("mounts, inspects, and unmounts", async () => {
    const m = adaptMount(mount, cfg);
    await m.mount({ mountPath: "/m", keyPrefix: "cache", access: "read-write" });
    expect(seen).toHaveLength(1);
    expect(await m.inspect("/m")).toEqual({ attached: true, detail: "managed" });
    await m.unmount("/m");
  });
  it("reports detached mounts and maps failures", async () => {
    const gone = adaptMount({
      ...mount,
      inspect: async () => ({ mountPath: "/m", attachment: { status: "absent" } }),
    } as unknown as S3Mount, cfg);
    expect(await gone.inspect("/m")).toEqual({ attached: false, detail: "absent" });
    const failing = adaptMount({
      ...mount,
      mount: async () => { throw Object.assign(new Error("x"), { name: "SandboxS3MountError" }); },
    } as unknown as S3Mount, cfg);
    await expect(failing.mount({ mountPath: "/m", access: "read-only" })).rejects.toMatchObject({ code: "MOUNT" });
  });
});
