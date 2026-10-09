// Sandbox SDK 1.0 filesystem utilities for seats (runtime-free).
//
// Narrow interfaces over Files (stream files in/out), S3Mount (R2
// prefix mounts, Worker-signed so creds stay out of the sandbox),
// and DirectoryBackup (dir -> R2 -> restore into any sandbox).
// Adapters take constructed SDK instances, so this module imports
// types only and stays vitest-safe: seat-do.ts owns the runtime
// imports + gateway bindings, tests inject fakes.
import type {
  DirectoryBackup,
  DirectoryBackupRecord,
  Files,
  S3Mount,
  S3MountRequest,
} from "@cloudflare/sandbox";

// (S3MountSource isn't exported; derive it from the request shape.)
type S3Source = S3MountRequest["source"];

export type SandboxFsErrorCode =
  | "INVALID"
  | "NOT_FOUND"
  | "NOT_DIR"
  | "DENIED"
  | "TOO_LARGE"
  | "IO"
  | "PROTOCOL"
  | "BACKUP"
  | "MOUNT";

export class SandboxFsError extends Error {
  readonly code: SandboxFsErrorCode;
  constructor(code: SandboxFsErrorCode, message: string) {
    super(message);
    this.name = "SandboxFsError";
    this.code = code;
  }
}

export function isSandboxFsError(err: unknown): err is SandboxFsError {
  return err instanceof Error && err.name === "SandboxFsError" && "code" in err;
}

// Container paths are always absolute: a relative path is a caller bug,
// and `..` must never escape the intended root (the SDK resolves
// symlinks natively, so this guards the request, not the target).
export function assertContainerPath(path: string, what = "path"): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new SandboxFsError("INVALID", `${what} must be a non-empty NUL-free string`);
  }
  if (!path.startsWith("/")) throw new SandboxFsError("INVALID", `${what} must be absolute: ${path.slice(0, 128)}`);
  const parts = path.split("/");
  if (parts.includes("..")) throw new SandboxFsError("INVALID", `${what} must not contain '..': ${path.slice(0, 128)}`);
  if (path.length > 4096) throw new SandboxFsError("INVALID", `${what} exceeds 4096 chars`);
  return path;
}

export type SeatFileType = "file" | "directory" | "symlink" | "other";

export interface SeatFileStat {
  type: SeatFileType;
  size: number;
  mode: number;
}

export interface SeatDirEntry {
  name: string;
  type: SeatFileType;
}

function seatFileType(t: string): SeatFileType {
  return t === "file" || t === "directory" || t === "symlink" ? t : "other";
}

// Map SDK failures structurally (name + code): errors cross the
// container RPC boundary, so instanceof is unreliable — the SDK's
// own guards do exactly this.
export function toSandboxFsError(err: unknown, op: string): SandboxFsError {
  if (isSandboxFsError(err)) return err;
  if (err instanceof Error) {
    const rec = err as Error & { code?: unknown; detail?: unknown };
    const detail = typeof rec.detail === "string" && rec.detail ? `: ${rec.detail.slice(0, 200)}` : "";
    if (err.name === "SandboxFileError" && typeof rec.code === "string") {
      const code = rec.code;
      if (code === "ENOENT") return new SandboxFsError("NOT_FOUND", `${op} missing${detail}`);
      if (code === "ENOTDIR") return new SandboxFsError("NOT_DIR", `${op} not a directory${detail}`);
      if (code === "EACCES" || code === "EPERM") return new SandboxFsError("DENIED", `${op} denied${detail}`);
      return new SandboxFsError("IO", `${op} failed (${code})${detail}`);
    }
    if (err.name === "SandboxBackupError") return new SandboxFsError("BACKUP", `${op} backup failed${detail}`);
    if (err.name === "SandboxS3MountError") return new SandboxFsError("MOUNT", `${op} mount failed${detail}`);
    if (err.name === "SandboxProtocolError") {
      return new SandboxFsError("PROTOCOL", `${op} needs the sandbox-shim image${detail}`);
    }
    return new SandboxFsError("IO", `${op} failed: ${err.message.slice(0, 200)}`);
  }
  return new SandboxFsError("IO", `${op} failed: ${String(err).slice(0, 200)}`);
}

export interface SeatFiles {
  readFile(path: string, maxBytes?: number): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<SeatFileStat>;
  // stat without following the final symlink (link guards).
  lstat(path: string): Promise<SeatFileStat>;
  readDirectory(path: string): Promise<SeatDirEntry[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
}

export const DEFAULT_READ_CAP = 4 * 1024 * 1024;

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, what: string): Promise<Uint8Array> {
  if (!body) throw new SandboxFsError("IO", `${what}: empty response body`);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SandboxFsError("TOO_LARGE", `${what} exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function adaptFiles(files: Files): SeatFiles {
  return {
    async readFile(path, maxBytes = DEFAULT_READ_CAP) {
      assertContainerPath(path, "readFile");
      try {
        const res = await files.readFile(path);
        return await readCapped(res.body, maxBytes, `readFile ${path.slice(0, 128)}`);
      } catch (err) {
        throw toSandboxFsError(err, `readFile ${path.slice(0, 128)}`);
      }
    },
    async writeFile(path, content) {
      assertContainerPath(path, "writeFile");
      try {
        await files.writeFile(path, content);
      } catch (err) {
        throw toSandboxFsError(err, `writeFile ${path.slice(0, 128)}`);
      }
    },
    async stat(path) {
      assertContainerPath(path, "stat");
      try {
        const st = await files.stat(path);
        return { type: seatFileType(st.type), size: Number(st.size), mode: st.mode };
      } catch (err) {
        throw toSandboxFsError(err, `stat ${path.slice(0, 128)}`);
      }
    },
    async lstat(path) {
      assertContainerPath(path, "lstat");
      try {
        const st = await files.lstat(path);
        return { type: seatFileType(st.type), size: Number(st.size), mode: st.mode };
      } catch (err) {
        throw toSandboxFsError(err, `lstat ${path.slice(0, 128)}`);
      }
    },
    async readDirectory(path) {
      assertContainerPath(path, "readDirectory");
      try {
        const entries = await files.readDirectory(path);
        return entries.map((e) => ({ name: e.name, type: seatFileType(e.type) }));
      } catch (err) {
        throw toSandboxFsError(err, `readDirectory ${path.slice(0, 128)}`);
      }
    },
    async mkdir(path, recursive = false) {
      assertContainerPath(path, "mkdir");
      try {
        await files.mkdir(path, { recursive });
      } catch (err) {
        throw toSandboxFsError(err, `mkdir ${path.slice(0, 128)}`);
      }
    },
  };
}

export interface SeatBackupRecord {
  id: string;
  dir: string;
  size: number;
  sha256: string;
  name?: string;
}

export interface SeatDirBackup {
  backup(dir: string, opts?: { name?: string; exclude?: string[]; gitignore?: boolean }): Promise<SeatBackupRecord>;
  restore(record: SeatBackupRecord, dir?: string): Promise<void>;
  deleteRecord(record: SeatBackupRecord): Promise<void>;
}

function toSeatRecord(r: DirectoryBackupRecord): SeatBackupRecord {
  return { id: r.id, dir: r.dir, size: r.size, sha256: r.sha256, ...(r.name ? { name: r.name } : {}) };
}

function toSdkRecord(r: SeatBackupRecord): DirectoryBackupRecord {
  return { id: r.id, dir: r.dir, size: r.size, sha256: r.sha256, format: "tar+zstd/1", ...(r.name ? { name: r.name } : {}) };
}

export function adaptDirBackup(backup: DirectoryBackup): SeatDirBackup {
  return {
    async backup(dir, opts) {
      assertContainerPath(dir, "backup");
      try {
        const rec = await backup.backup({
          dir,
          ...(opts?.name ? { name: opts.name } : {}),
          ...(opts?.exclude ? { exclude: opts.exclude } : {}),
          ...(opts?.gitignore !== undefined ? { gitignore: opts.gitignore } : {}),
        });
        return toSeatRecord(rec);
      } catch (err) {
        throw toSandboxFsError(err, `backup ${dir.slice(0, 128)}`);
      }
    },
    async restore(record, dir) {
      if (dir !== undefined) assertContainerPath(dir, "restore");
      try {
        await backup.restore(toSdkRecord(record), dir === undefined ? undefined : { dir });
      } catch (err) {
        throw toSandboxFsError(err, `restore ${record.id}`);
      }
    },
    async deleteRecord(record) {
      try {
        await backup.delete(toSdkRecord(record));
      } catch (err) {
        throw toSandboxFsError(err, `delete backup ${record.id}`);
      }
    },
  };
}

export interface SeatMountRequest {
  mountPath: string;
  keyPrefix?: string;
  access: "read-only" | "read-write";
}

export interface SeatMountInspection {
  attached: boolean;
  detail: string;
}

export interface SeatMount {
  mount(req: SeatMountRequest): Promise<void>;
  inspect(mountPath: string): Promise<SeatMountInspection>;
  unmount(mountPath: string): Promise<void>;
}

export interface S3MountStaticConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Pure request builder (unit-tested): secrets enter here from env, never
// from call sites — seat flows pass mount path + prefix + access only.
export function buildS3MountRequest(cfg: S3MountStaticConfig, req: SeatMountRequest): S3MountRequest {
  assertContainerPath(req.mountPath, "mount");
  const prefix = req.keyPrefix ?? "";
  if (prefix.includes("..") || prefix.startsWith("/")) {
    throw new SandboxFsError("INVALID", `mount prefix must be relative without '..': ${prefix.slice(0, 128)}`);
  }
  const source: S3Source = {
    type: "s3",
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    credentials: { type: "static", accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  };
  return {
    mountPath: req.mountPath,
    source,
    ...(prefix ? { keyPrefix: prefix.endsWith("/") ? prefix : `${prefix}/` } : {}),
    access: req.access,
  };
}

export function adaptMount(mount: S3Mount, cfg: S3MountStaticConfig): SeatMount {
  return {
    async mount(req) {
      try {
        await mount.mount(buildS3MountRequest(cfg, req));
      } catch (err) {
        throw toSandboxFsError(err, `mount ${req.mountPath.slice(0, 128)}`);
      }
    },
    async inspect(mountPath) {
      assertContainerPath(mountPath, "inspect");
      try {
        const insp = await mount.inspect(mountPath);
        const attached = insp.attachment.status === "managed" || insp.attachment.status === "stale";
        return { attached, detail: insp.attachment.status };
      } catch (err) {
        throw toSandboxFsError(err, `inspect ${mountPath.slice(0, 128)}`);
      }
    },
    async unmount(mountPath) {
      assertContainerPath(mountPath, "unmount");
      try {
        await mount.unmount(mountPath);
      } catch (err) {
        throw toSandboxFsError(err, `unmount ${mountPath.slice(0, 128)}`);
      }
    },
  };
}
