// Remote named warm dev boxes: the runtime-free core. Each box is one
// BOXES Durable Object (`box-<name>`) whose container sleeps between
// ops; this module implements create/exec/sync/fetch/snapshot/restore/
// destroy against the D1 registry, and the DO wrapper owns the runtime
// bindings (container, Files) plus HTTP/status translation.
import { deleteDevBox, getDevBox, listDevBoxes, upsertDevBox, type Db } from "../../worker/src/db";
import { isSandboxFsError, type SeatFileStat, type SeatFiles } from "./sandbox-fs";
import type { ContainerCtl } from "./seat";

export const BOX_WORKDIR = "/work";
export const BOX_IMAGE = "seat";
// Matches the local devbox exec cap (256 KiB per stream, truncation
// note appended) so local and remote outputs behave the same.
export const BOX_EXEC_MAX_BYTES = 256 * 1024;
// Local exec waits unbounded (docker); remote must cap the HTTP round
// trip — ten minutes covers builds, not hangs.
export const BOX_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
export const BOX_SYNC_MAX_FILES = 256;
export const BOX_SYNC_MAX_BYTES = 16 * 1024 * 1024;
export const BOX_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const BOX_FETCH_MAX_BYTES = 16 * 1024 * 1024;
export const BOX_EXEC_MAX_ARGS = 32;
export const BOX_ARG_MAX_BYTES = 4 * 1024;
export const BOX_ENV_MAX_VARS = 64;
export const BOX_PATH_MAX_BYTES = 512;

// Typed box errors carry their HTTP status so the DO wrapper maps
// without message matching; anything else is a 500.
export class BoxError extends Error {
  readonly status: 400 | 404 | 409 | 413;
  constructor(status: 400 | 404 | 409 | 413, message: string) {
    super(message);
    this.name = "BoxError";
    this.status = status;
  }
}

export interface BoxDeps {
  db: Db;
  container: ContainerCtl;
  fs: SeatFiles;
  // Digest-pinned seat image ref for fresh starts / snapshot restores.
  seatImage: string;
}

export interface RemoteBoxSnapshot {
  tag: string;
  snapshotId: string;
  createdAt: string;
}

export interface RemoteBoxSummary {
  name: string;
  container: string;
  image: string;
  workdir: string;
  createdAt: string;
  lastUsedAt: string;
  snapshots: RemoteBoxSnapshot[];
}

export interface BoxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

// Name/tag rules mirror the local devbox validators (apps/cli/src/
// devbox.ts) exactly, so one name is valid in both places.
export function validateBoxNameRemote(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    throw new BoxError(400, `invalid devbox name ${JSON.stringify(name.slice(0, 64))}: use 1-32 lowercase letters, digits, dashes`);
  }
}

export function validateSnapshotTagRemote(tag: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag)) {
    throw new BoxError(400, `invalid snapshot tag ${JSON.stringify(tag.slice(0, 64))}: use 1-64 [a-z0-9._-]`);
  }
}

export function boxDoName(name: string): string {
  return `box-${name}`;
}

export function snapshotTagNowRemote(when = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `snap-${when.getUTCFullYear()}${p(when.getUTCMonth() + 1)}${p(when.getUTCDate())}-${p(when.getUTCHours())}${p(when.getUTCMinutes())}${p(when.getUTCSeconds())}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Sync/fetch paths are workdir-relative and traversal-guarded (the
// box is the user's own sandbox, but an absolute or escaping path is
// always a client bug, never intent).
function boxRelPath(path: string, what: string): string {
  const bytes = new TextEncoder().encode(path).byteLength;
  if (bytes === 0 || bytes > BOX_PATH_MAX_BYTES || path.includes("\0")) {
    throw new BoxError(400, `invalid ${what} path: must be 1-${BOX_PATH_MAX_BYTES} bytes`);
  }
  if (path.startsWith("/") || path.split("/").some((seg) => seg === ".." || seg.includes("\\"))) {
    throw new BoxError(400, `invalid ${what} path ${JSON.stringify(path.slice(0, 64))}: must stay inside the box workdir`);
  }
  return `${BOX_WORKDIR}/${path}`.replace(/\/+/g, "/");
}

function b64ToBytes(b64: string, what: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new BoxError(400, `invalid ${what}: not base64`);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

function parseSnapshotsJson(raw: string, name: string): RemoteBoxSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`devbox ${JSON.stringify(name)} has corrupt snapshots JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`devbox ${JSON.stringify(name)} has corrupt snapshots JSON`);
  return parsed as RemoteBoxSnapshot[];
}

function toSummary(row: {
  name: string;
  image: string;
  workdir: string;
  created_at: string;
  last_used_at: string;
  snapshots: string;
}): RemoteBoxSummary {
  return {
    name: row.name,
    container: boxDoName(row.name),
    image: row.image,
    workdir: row.workdir,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    snapshots: parseSnapshotsJson(row.snapshots, row.name),
  };
}

async function requireBox(deps: BoxDeps, name: string): Promise<RemoteBoxSummary> {
  const row = await getDevBox(deps.db, name);
  if (!row) throw new BoxError(404, `unknown devbox ${JSON.stringify(name)}`);
  return toSummary(row);
}

async function touchBox(deps: BoxDeps, summary: RemoteBoxSummary): Promise<RemoteBoxSummary> {
  const next: RemoteBoxSummary = { ...summary, lastUsedAt: nowIso() };
  await upsertDevBox(deps.db, {
    name: next.name,
    image: next.image,
    workdir: next.workdir,
    created_at: next.createdAt,
    last_used_at: next.lastUsedAt,
    snapshots: JSON.stringify(next.snapshots),
  });
  return next;
}

// Boxes sleep between ops; wake (or boot, after a restore that has
// not run yet) before anything touches the filesystem.
async function ensureRunning(deps: BoxDeps): Promise<void> {
  if (deps.container.running) return;
  await deps.container.start({ image: deps.seatImage, enableInternet: true, entrypoint: ["sleep", "infinity"] });
}

function truncateBox(text: string): { text: string; cut: number } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= BOX_EXEC_MAX_BYTES) return { text, cut: 0 };
  const cut = bytes.byteLength - BOX_EXEC_MAX_BYTES;
  return { text: new TextDecoder().decode(bytes.slice(0, BOX_EXEC_MAX_BYTES)) + `\n[truncated ${cut} bytes]`, cut };
}

function validateExecInput(cmd: string[], cwd: string | undefined, env: Record<string, string> | undefined): void {
  if (cmd.length === 0) throw new BoxError(400, "devbox exec needs a command");
  if (cmd.length > BOX_EXEC_MAX_ARGS) throw new BoxError(400, `devbox exec takes at most ${BOX_EXEC_MAX_ARGS} args`);
  const enc = new TextEncoder();
  for (const arg of cmd) {
    if (arg.includes("\0") || enc.encode(arg).byteLength > BOX_ARG_MAX_BYTES) {
      throw new BoxError(400, "devbox exec arg too long");
    }
  }
  if (cwd !== undefined && (cwd.includes("\0") || enc.encode(cwd).byteLength > BOX_PATH_MAX_BYTES || !cwd.startsWith("/"))) {
    throw new BoxError(400, "devbox exec cwd must be an absolute box path");
  }
  const keys = env ? Object.keys(env) : [];
  if (keys.length > BOX_ENV_MAX_VARS) throw new BoxError(400, `devbox exec takes at most ${BOX_ENV_MAX_VARS} env vars`);
  for (const key of keys) {
    if (key.length === 0 || key.length > 256 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new BoxError(400, `invalid devbox exec env name ${JSON.stringify(key.slice(0, 64))}`);
    }
  }
}

export async function createBox(deps: BoxDeps, name: string, image?: string): Promise<RemoteBoxSummary> {
  validateBoxNameRemote(name);
  // Remotely exactly one image exists (the seat image in the durable-
  // object policy); anything else fails loud, never silently ignored.
  if (image !== undefined && image !== BOX_IMAGE) {
    throw new BoxError(400, `unknown remote image ${JSON.stringify(image.slice(0, 64))}: only ${JSON.stringify(BOX_IMAGE)} exists remotely`);
  }
  if (await getDevBox(deps.db, name)) throw new BoxError(409, `devbox ${JSON.stringify(name)} already exists`);
  // Destroy-then-start: a container lingering from a crashed destroy
  // must never serve a fresh box.
  deps.container.destroy();
  await deps.container.start({ image: deps.seatImage, enableInternet: true, entrypoint: ["sleep", "infinity"] });
  await deps.fs.mkdir(BOX_WORKDIR, true);
  const stamped = nowIso();
  await upsertDevBox(deps.db, {
    name,
    image: BOX_IMAGE,
    workdir: BOX_WORKDIR,
    created_at: stamped,
    last_used_at: stamped,
    snapshots: "[]",
  });
  return { name, container: boxDoName(name), image: BOX_IMAGE, workdir: BOX_WORKDIR, createdAt: stamped, lastUsedAt: stamped, snapshots: [] };
}

export async function execBox(
  deps: BoxDeps,
  name: string,
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<BoxExecResult> {
  validateBoxNameRemote(name);
  validateExecInput(cmd, opts?.cwd, opts?.env);
  const box = await requireBox(deps, name);
  await ensureRunning(deps);
  // Wedged-container race mirrors the seat's execBounded: the exec
  // call itself is raced, and the handle is killed on timeout so no
  // orphan keeps the box awake.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BOX_EXEC_TIMEOUT_MS);
  });
  try {
    const call = deps.container.exec(cmd, { cwd: opts?.cwd ?? box.workdir, ...(opts?.env ? { env: opts.env } : {}) });
    const proc = await Promise.race([call, timeout]);
    if (proc === null) {
      call.then(
        (h) => {
          try {
            h.kill();
          } catch {
            // Already exited.
          }
        },
        () => undefined,
      );
      await touchBox(deps, box);
      return { stdout: "", stderr: "", exitCode: 124, timedOut: true, truncated: false };
    }
    const out = await Promise.race([proc.output(), timeout]);
    if (out === null) {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      await touchBox(deps, box);
      return { stdout: "", stderr: "", exitCode: 124, timedOut: true, truncated: false };
    }
    await touchBox(deps, box);
    const dec = new TextDecoder();
    const stdout = truncateBox(dec.decode(out.stdout));
    const stderr = truncateBox(dec.decode(out.stderr));
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: out.exitCode,
      timedOut: false,
      truncated: stdout.cut > 0 || stderr.cut > 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface BoxSyncFile {
  path: string;
  content_b64: string;
}

export async function syncBox(deps: BoxDeps, name: string, files: BoxSyncFile[]): Promise<{ paths: string[]; bytes: number }> {
  validateBoxNameRemote(name);
  if (files.length === 0) throw new BoxError(400, "devbox sync needs at least one file");
  if (files.length > BOX_SYNC_MAX_FILES) throw new BoxError(400, `devbox sync takes at most ${BOX_SYNC_MAX_FILES} files per call`);
  const box = await requireBox(deps, name);
  // Decode + bound everything before writing anything: a rejected
  // batch leaves the box untouched.
  const decoded = files.map((f) => {
    const abs = boxRelPath(f.path, "sync");
    const bytes = b64ToBytes(f.content_b64, `sync file ${JSON.stringify(f.path.slice(0, 64))}`);
    if (bytes.byteLength > BOX_FILE_MAX_BYTES) {
      throw new BoxError(413, `sync file ${JSON.stringify(f.path.slice(0, 64))} exceeds ${BOX_FILE_MAX_BYTES} bytes`);
    }
    return { rel: f.path, abs, bytes };
  });
  const total = decoded.reduce((n, d) => n + d.bytes.byteLength, 0);
  if (total > BOX_SYNC_MAX_BYTES) throw new BoxError(413, `sync batch exceeds ${BOX_SYNC_MAX_BYTES} bytes`);
  await ensureRunning(deps);
  // Files-based writes (Sandbox SDK), not tar-over-exec: one typed
  // write per file over the SDK's file channel.
  for (const d of decoded) {
    const slash = d.abs.lastIndexOf("/");
    if (slash > 0) await deps.fs.mkdir(d.abs.slice(0, slash), true);
    await deps.fs.writeFile(d.abs, d.bytes);
  }
  await touchBox(deps, box);
  return { paths: decoded.map((d) => d.rel), bytes: total };
}

export type BoxFetchResult =
  | { kind: "file"; content_b64: string; bytes: number }
  | { kind: "tarball"; content_b64: string; bytes: number };

export async function fetchBox(deps: BoxDeps, name: string, path: string): Promise<BoxFetchResult> {
  validateBoxNameRemote(name);
  const abs = boxRelPath(path, "fetch");
  const box = await requireBox(deps, name);
  await ensureRunning(deps);
  let st: SeatFileStat;
  try {
    st = await deps.fs.stat(abs);
  } catch {
    throw new BoxError(404, `no such path ${JSON.stringify(path.slice(0, 64))} in devbox ${JSON.stringify(name)}`);
  }
  if (st.type === "directory") {
    const proc = await deps.container.exec(["tar", "-czf", "-", "-C", BOX_WORKDIR, path], { cwd: BOX_WORKDIR });
    const out = await proc.output();
    if (out.exitCode !== 0) throw new Error(`fetch tar failed (exit ${out.exitCode})`);
    if (out.stdout.byteLength > BOX_FETCH_MAX_BYTES) {
      throw new BoxError(413, `fetch of ${JSON.stringify(path.slice(0, 64))} exceeds ${BOX_FETCH_MAX_BYTES} bytes`);
    }
    await touchBox(deps, box);
    return { kind: "tarball", content_b64: bytesToB64(out.stdout), bytes: out.stdout.byteLength };
  }
  // readFile throws TOO_LARGE past the cap — translate to 413 so a
  // big fetch is a client error, not a 500.
  let bytes: Uint8Array;
  try {
    bytes = await deps.fs.readFile(abs, BOX_FETCH_MAX_BYTES);
  } catch (err) {
    if (isSandboxFsError(err) && err.code === "TOO_LARGE") {
      throw new BoxError(413, `fetch of ${JSON.stringify(path.slice(0, 64))} exceeds ${BOX_FETCH_MAX_BYTES} bytes`);
    }
    throw err;
  }
  await touchBox(deps, box);
  return { kind: "file", content_b64: bytesToB64(bytes), bytes: bytes.byteLength };
}

export async function snapshotBox(deps: BoxDeps, name: string, tag?: string): Promise<RemoteBoxSnapshot> {
  validateBoxNameRemote(name);
  const resolved = tag ?? snapshotTagNowRemote();
  validateSnapshotTagRemote(resolved);
  const box = await requireBox(deps, name);
  if (box.snapshots.some((s) => s.tag === resolved)) {
    throw new BoxError(409, `snapshot ${JSON.stringify(resolved)} already exists`);
  }
  const snap = await deps.container.snapshot(`${boxDoName(name)}-${resolved}`);
  const created = nowIso();
  const next: RemoteBoxSnapshot = { tag: resolved, snapshotId: snap.id, createdAt: created };
  await touchBox(deps, { ...box, snapshots: [...box.snapshots, next] });
  return next;
}

export async function restoreBox(deps: BoxDeps, name: string, tag: string): Promise<RemoteBoxSummary> {
  validateBoxNameRemote(name);
  const box = await requireBox(deps, name);
  const snap = box.snapshots.find((s) => s.tag === tag);
  if (!snap) throw new BoxError(404, `unknown snapshot ${JSON.stringify(tag)} for devbox ${JSON.stringify(name)}`);
  deps.container.destroy();
  await deps.container.start({ snapshotId: snap.snapshotId, enableInternet: true, entrypoint: ["sleep", "infinity"] });
  return await touchBox(deps, box);
}

export async function destroyBox(deps: BoxDeps, name: string): Promise<{ name: string; snapshots: string[] }> {
  validateBoxNameRemote(name);
  const box = await requireBox(deps, name);
  deps.container.destroy();
  await deleteDevBox(deps.db, name);
  // The container API exposes no snapshot delete: tags are returned
  // so the CLI can say what stays behind per platform retention.
  return { name, snapshots: box.snapshots.map((s) => s.tag) };
}

export async function listBoxes(deps: Pick<BoxDeps, "db">): Promise<RemoteBoxSummary[]> {
  return (await listDevBoxes(deps.db)).map(toSummary);
}
