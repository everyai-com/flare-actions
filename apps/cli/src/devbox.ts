// Warm dev boxes: persistent local containers for the build/test
// loop, managed by one-shot CLI commands. Each box is a named
// `docker run -d` instance (stable `flare-devbox-<name>` container),
// reattached per command via LocalContainer.attach; "snapshots" are
// local committed images (`docker commit` lineage), and sync is a
// gzip tarball over `docker exec -i` — the same shape as the source
// dispatch path. Local-only: no worker, no tokens, no network.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertSafeTar, createTar, extractTar } from "flare-actions-runner-sdk";
import { LocalContainer, nodeRunner, type LocalRunner } from "../../seats/src/local-docker.ts";

export const DEVBOX_WORKDIR = "/work";
export const DEVBOX_IMAGE = "alpine:3.20";
export const MAX_EXEC_BYTES = 256 * 1024;

export interface BoxSnapshot {
  tag: string;
  createdAt: string;
}

export interface BoxRecord {
  container: string;
  image: string;
  workdir: string;
  createdAt: string;
  snapshots: BoxSnapshot[];
}

export interface BoxSummary extends BoxRecord {
  name: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SyncResult {
  bytes: number;
  paths: string[];
}

export interface FetchResult {
  bytes: number;
  path: string;
}

export interface DevboxDeps {
  runner: LocalRunner;
  registryPath: string;
  tarball: (dir: string, paths: string[]) => Promise<Uint8Array>;
  untar: (dir: string, data: Uint8Array) => Promise<void>;
  assertSafe: (data: Uint8Array) => Promise<void>;
}

export function defaultDevboxDeps(): DevboxDeps {
  return {
    runner: nodeRunner(),
    registryPath: join(homedir(), ".flare", "devboxes.json"),
    tarball: (dir, paths) => createTar(dir, paths),
    untar: (dir, data) => extractTar(dir, data),
    assertSafe: (data) => assertSafeTar(data),
  };
}

export function validateBoxName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error(`invalid devbox name ${JSON.stringify(name.slice(0, 64))}: use 1-32 lowercase letters, digits, dashes`);
  }
}

export function validateSnapshotTag(tag: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag)) {
    throw new Error(`invalid snapshot tag ${JSON.stringify(tag.slice(0, 64))}: use 1-64 [a-z0-9._-]`);
  }
}

export function boxContainerName(name: string): string {
  return `flare-devbox-${name}`;
}

export function boxSnapshotRef(name: string, tag: string): string {
  return `flare-devbox-${name}:${tag}`;
}

function snapshotTagNow(when = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `snap-${when.getUTCFullYear()}${p(when.getUTCMonth() + 1)}${p(when.getUTCDate())}-${p(when.getUTCHours())}${p(when.getUTCMinutes())}${p(when.getUTCSeconds())}`;
}

function truncateExec(text: string): { text: string; cut: number } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_EXEC_BYTES) return { text, cut: 0 };
  const cut = bytes.byteLength - MAX_EXEC_BYTES;
  return { text: new TextDecoder().decode(bytes.slice(0, MAX_EXEC_BYTES)) + `\n[truncated ${cut} bytes]`, cut };
}

// Narrow surface the MCP server drives; BoxManager implements it and
// tests fake it, so no casts cross the boundary.
export interface DevboxOps {
  list(): BoxSummary[];
  create(name: string, opts?: { image?: string }): Promise<BoxSummary>;
  exec(name: string, cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
  sync(name: string, dir: string, paths: string[]): Promise<SyncResult>;
  fetch(name: string, containerPath: string, dir: string): Promise<FetchResult>;
  snapshot(name: string, tag?: string): Promise<BoxSnapshot>;
  restore(name: string, tag: string): Promise<BoxSummary>;
  destroy(name: string): Promise<{ name: string; imagesKept: string[] }>;
}

export class BoxManager implements DevboxOps {
  private readonly runner: LocalRunner;
  private readonly registryPath: string;
  private readonly tarball: (dir: string, paths: string[]) => Promise<Uint8Array>;
  private readonly untar: (dir: string, data: Uint8Array) => Promise<void>;
  private readonly assertSafe: (data: Uint8Array) => Promise<void>;

  constructor(deps: DevboxDeps = defaultDevboxDeps()) {
    this.runner = deps.runner;
    this.registryPath = deps.registryPath;
    this.tarball = deps.tarball;
    this.untar = deps.untar;
    this.assertSafe = deps.assertSafe;
  }

  private load(): Record<string, BoxRecord> {
    let raw: string;
    try {
      raw = readFileSync(this.registryPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`devbox registry ${this.registryPath} is corrupt (invalid JSON); delete it or fix it by hand`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`devbox registry ${this.registryPath} is corrupt (expected an object of boxes)`);
    }
    const boxes = (parsed as { boxes?: unknown }).boxes ?? parsed;
    if (typeof boxes !== "object" || boxes === null || Array.isArray(boxes)) {
      throw new Error(`devbox registry ${this.registryPath} is corrupt (expected an object of boxes)`);
    }
    return boxes as Record<string, BoxRecord>;
  }

  private save(boxes: Record<string, BoxRecord>): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ boxes }, null, 2)}\n`);
    renameSync(tmp, this.registryPath);
  }

  private require(name: string): { record: BoxRecord; boxes: Record<string, BoxRecord> } {
    validateBoxName(name);
    const boxes = this.load();
    const record = boxes[name];
    if (!record) throw new Error(`unknown devbox ${JSON.stringify(name)} (see: cli devbox list)`);
    return { record, boxes };
  }

  private async attached(record: BoxRecord): Promise<LocalContainer> {
    const c = new LocalContainer(record.image, this.runner);
    try {
      await c.attach(record.container);
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} — container was removed outside the CLI (devbox restore or destroy to recover)`,
      );
    }
    return c;
  }

  list(): BoxSummary[] {
    const boxes = this.load();
    return Object.entries(boxes)
      .map(([name, record]) => ({ name, ...record }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async create(name: string, opts?: { image?: string }): Promise<BoxSummary> {
    validateBoxName(name);
    const boxes = this.load();
    if (boxes[name]) throw new Error(`devbox ${JSON.stringify(name)} already exists`);
    const image = opts?.image ?? DEVBOX_IMAGE;
    const container = boxContainerName(name);
    const c = new LocalContainer(image, this.runner);
    try {
      await c.start({}, container);
      const mkdir = await c.exec(["mkdir", "-p", DEVBOX_WORKDIR]);
      const out = await mkdir.output();
      if (out.exitCode !== 0) throw new Error(`mkdir ${DEVBOX_WORKDIR} failed: ${new TextDecoder().decode(out.stderr).slice(0, 200)}`);
    } catch (err) {
      c.destroy();
      throw err;
    }
    const record: BoxRecord = { container, image, workdir: DEVBOX_WORKDIR, createdAt: new Date().toISOString(), snapshots: [] };
    boxes[name] = record;
    this.save(boxes);
    return { name, ...record };
  }

  async exec(name: string, cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    if (cmd.length === 0) throw new Error("devbox exec needs a command");
    const { record } = this.require(name);
    const c = await this.attached(record);
    const handle = await c.exec(cmd, { cwd: opts?.cwd ?? record.workdir, env: opts?.env });
    const out = await handle.output();
    const dec = new TextDecoder();
    const stdout = truncateExec(dec.decode(out.stdout));
    const stderr = truncateExec(dec.decode(out.stderr));
    return { exitCode: out.exitCode, stdout: stdout.text, stderr: stderr.text, truncated: stdout.cut > 0 || stderr.cut > 0 };
  }

  async sync(name: string, dir: string, paths: string[]): Promise<SyncResult> {
    const { record } = this.require(name);
    const data = await this.tarball(dir, paths);
    const c = await this.attached(record);
    const handle = await c.exec(["tar", "-xzf", "-", "-C", record.workdir], { stdin: data });
    const out = await handle.output();
    if (out.exitCode !== 0) {
      throw new Error(`sync extract failed (exit ${out.exitCode}): ${new TextDecoder().decode(out.stderr).slice(0, 300)}`);
    }
    return { bytes: data.byteLength, paths };
  }

  async fetch(name: string, containerPath: string, dir: string): Promise<FetchResult> {
    if (!containerPath || containerPath.startsWith("/") || containerPath.split("/").includes("..")) {
      throw new Error(`unsafe fetch path ${JSON.stringify(containerPath.slice(0, 120))}: use a workdir-relative path`);
    }
    const { record } = this.require(name);
    const child = this.runner.spawn("docker", ["cp", `${record.container}:${record.workdir}/${containerPath}`, "-"]);
    const res = await child.done;
    if (res.exitCode !== 0) {
      throw new Error(`fetch failed (exit ${res.exitCode}): ${new TextDecoder().decode(res.stderr).slice(0, 300)}`);
    }
    await this.assertSafe(res.stdout);
    await this.untar(dir, res.stdout);
    return { bytes: res.stdout.byteLength, path: containerPath };
  }

  async snapshot(name: string, tag?: string): Promise<BoxSnapshot> {
    const { record, boxes } = this.require(name);
    const resolved = tag ?? snapshotTagNow();
    validateSnapshotTag(resolved);
    if (record.snapshots.some((s) => s.tag === resolved)) throw new Error(`snapshot ${JSON.stringify(resolved)} already exists`);
    const res = await this.runner.run("docker", ["commit", record.container, boxSnapshotRef(name, resolved)]);
    if (res.exitCode !== 0) throw new Error(`docker commit failed (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`);
    const snap: BoxSnapshot = { tag: resolved, createdAt: new Date().toISOString() };
    record.snapshots.push(snap);
    this.save(boxes);
    return snap;
  }

  async restore(name: string, tag: string): Promise<BoxSummary> {
    const { record, boxes } = this.require(name);
    if (!record.snapshots.some((s) => s.tag === tag)) {
      throw new Error(`unknown snapshot ${JSON.stringify(tag)} for devbox ${JSON.stringify(name)}`);
    }
    const ref = boxSnapshotRef(name, tag);
    // rm first: a stale same-name instance blocks run, and a missing
    // one must not block recovery — either way run decides loudly.
    await this.runner.run("docker", ["rm", "-f", record.container]);
    const c = new LocalContainer(ref, this.runner);
    try {
      await c.start({}, record.container);
      const mkdir = await c.exec(["mkdir", "-p", record.workdir]);
      const out = await mkdir.output();
      if (out.exitCode !== 0) throw new Error(`mkdir ${record.workdir} failed: ${new TextDecoder().decode(out.stderr).slice(0, 200)}`);
    } catch (err) {
      c.destroy();
      throw err;
    }
    record.image = ref;
    this.save(boxes);
    return { name, ...record };
  }

  async destroy(name: string): Promise<{ name: string; imagesKept: string[] }> {
    const { record, boxes } = this.require(name);
    await this.runner.run("docker", ["rm", "-f", record.container]);
    delete boxes[name];
    this.save(boxes);
    const imagesKept = record.snapshots.map((s) => boxSnapshotRef(name, s.tag));
    return { name, imagesKept };
  }
}
