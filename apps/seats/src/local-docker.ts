// Local-Docker dev mode for seats (Streamline pattern): a ContainerCtl
// backed by the local `docker` CLI, so seat execution logic can be
// exercised without deploying. Dev-only: nothing in the worker path
// imports this (no snapshots, no registry auth, env passes through
// --env-file except multiline values, which stay argv-visible).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerCtl, ContainerSnapshot, ContainerStartOptions, ExecHandle, ExecOptions, ExecOutput } from "./seat";
import {
  SandboxFsError,
  assertContainerPath,
  type SeatDirBackup,
  type SeatDirEntry,
  type SeatFiles,
  type SeatFileStat,
  type SeatFileType,
  type SeatMount,
} from "./sandbox-fs";

export interface LocalRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LocalBytesResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface LocalChild {
  pid: number;
  done: Promise<LocalBytesResult>;
  kill(signal?: number): void;
}

export interface LocalRunner {
  run(cmd: string, args: string[], opts?: { input?: string | Uint8Array; timeoutMs?: number }): Promise<LocalRunResult>;
  spawn(cmd: string, args: string[], opts?: { input?: string | Uint8Array }): LocalChild;
}

function collect(
  child: ReturnType<typeof spawn>,
  input: string | Uint8Array | undefined,
  timeoutMs: number | undefined,
): { done: Promise<LocalBytesResult>; kill: (signal?: number) => void } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (c: Buffer) => stdout.push(c));
  child.stderr?.on("data", (c: Buffer) => stderr.push(c));
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<LocalBytesResult>((resolve) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }, timeoutMs);
    }
    child.on("error", () =>
      resolve({ exitCode: 127, stdout: new Uint8Array(), stderr: new TextEncoder().encode("spawn failed") }),
    );
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 127, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
  return {
    done,
    kill: (signal?: number) => {
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
    },
  };
}

export function nodeRunner(): LocalRunner {
  const dec = new TextDecoder();
  return {
    run: async (cmd, args, opts) => {
      const child = spawn(cmd, args, { stdio: [opts?.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
      const res = await collect(child, opts?.input, opts?.timeoutMs).done;
      return { exitCode: res.exitCode, stdout: dec.decode(res.stdout), stderr: dec.decode(res.stderr) };
    },
    spawn: (cmd, args, opts) => {
      const child = spawn(cmd, args, { stdio: [opts?.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
      const h = collect(child, opts?.input, undefined);
      return { pid: child.pid ?? 0, done: h.done, kill: h.kill };
    },
  };
}

// Split env for docker: flat values ride a 0600 --env-file (never
// argv); multiline values (PEM keys) have no env-file encoding, so
// they fall back to -e (argv-visible — local dev only).
export function splitEnvForDocker(env: Record<string, string>): { file: [string, string][]; argv: [string, string][] } {
  const file: [string, string][] = [];
  const argv: [string, string][] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\r\n]/.test(v)) file.push([k, v]);
    else argv.push([k, v]);
  }
  return { file, argv };
}

export class LocalContainer implements ContainerCtl {
  private isRunning = false;
  private containerName: string | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopResolve: (() => void) | null = null;
  private pendingDestroy: Promise<void> | null = null;
  private readonly image: string;
  private readonly runner: LocalRunner;

  constructor(image: string, runner: LocalRunner = nodeRunner()) {
    this.image = image;
    this.runner = runner;
  }

  get running(): boolean {
    return this.isRunning;
  }

  get name(): string | null {
    return this.containerName;
  }

  async start(opts?: ContainerStartOptions, name?: string): Promise<void> {
    if (this.isRunning) return;
    if (opts?.snapshotId) throw new Error("snapshots are unsupported in local-docker dev mode");
    if (name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
      throw new Error(`invalid container name: ${name.slice(0, 64)}`);
    }
    name ??= `flare-seat-local-${Math.random().toString(36).slice(2, 10)}`;
    const args = ["run", "-d", "--rm", "--name", name];
    if (opts?.enableInternet === false) args.push("--network", "none");
    const env = opts?.env ?? {};
    const { file, argv } = splitEnvForDocker(env);
    let envDir: string | null = null;
    if (file.length > 0) {
      envDir = mkdtempSync(join(tmpdir(), "flare-env-"));
      writeFileSync(join(envDir, "env"), file.map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
      args.push("--env-file", join(envDir, "env"));
    }
    for (const [k, v] of argv) args.push("-e", `${k}=${v}`);
    const entrypoint = opts?.entrypoint;
    if (entrypoint && entrypoint.length > 0) args.push("--entrypoint", entrypoint[0]);
    args.push(opts?.image ?? this.image);
    if (entrypoint && entrypoint.length > 1) args.push(...entrypoint.slice(1));
    else args.push("sleep", "infinity");
    try {
      const res = await this.runner.run("docker", args, { timeoutMs: 120000 });
      if (res.exitCode !== 0) throw new Error(`docker run failed: ${res.stderr.slice(0, 300) || res.stdout.slice(0, 300)}`);
    } finally {
      if (envDir) rmSync(envDir, { recursive: true, force: true });
    }
    this.containerName = name;
    this.isRunning = true;
    this.armStop();
  }

  // Reattach to an instance started earlier (stable dev-box names
  // across one-shot CLI invocations). Rejects unless the instance
  // exists and is running right now.
  async attach(name: string): Promise<void> {
    if (this.isRunning) throw new Error("already attached to a running instance");
    const res = await this.runner.run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
    if (res.exitCode !== 0) {
      throw new Error(`container ${name} is not available: ${res.stderr.slice(0, 200) || "inspect failed"}`);
    }
    if (res.stdout.trim() !== "true") throw new Error(`container ${name} is not running`);
    this.containerName = name;
    this.isRunning = true;
    this.armStop();
  }

  private armStop(): void {
    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  private markStopped(): void {
    this.isRunning = false;
    this.stopResolve?.();
    this.stopResolve = null;
  }

  destroy(): void {
    const name = this.containerName;
    this.markStopped();
    this.containerName = null;
    if (!name) return;
    // Fire-and-forget held as state (never floating): teardown races
    // nothing, and a failed rm is just a stopped container to prune.
    this.pendingDestroy = this.runner
      .run("docker", ["rm", "-f", name])
      .then(
        () => undefined,
        () => undefined,
      );
  }

  async exec(cmd: string[], opts?: ExecOptions): Promise<ExecHandle> {
    const name = this.containerName;
    if (!name || !this.isRunning) throw new Error("local container is not running");
    const args = ["exec"];
    if (opts?.cwd) args.push("-w", opts.cwd);
    const env = opts?.env ?? {};
    const { file, argv } = splitEnvForDocker(env);
    let envDir: string | null = null;
    if (file.length > 0) {
      envDir = mkdtempSync(join(tmpdir(), "flare-env-"));
      writeFileSync(join(envDir, "env"), file.map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
      args.push("--env-file", join(envDir, "env"));
    }
    for (const [k, v] of argv) args.push("-e", `${k}=${v}`);
    if (opts?.stdin !== undefined) args.push("-i");
    args.push(name, ...cmd);
    const child = this.runner.spawn("docker", args, opts?.stdin !== undefined ? { input: opts.stdin } : undefined);
    return {
      pid: child.pid,
      output: async () => {
        try {
          const res = await child.done;
          return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
        } finally {
          if (envDir) rmSync(envDir, { recursive: true, force: true });
        }
      },
      kill: (signal?: number) => child.kill(signal),
    };
  }

  async snapshot(_name?: string): Promise<ContainerSnapshot> {
    throw new Error("snapshots are unsupported in local-docker dev mode");
  }

  // Sandbox SDK Files over `docker exec` (dev parity with the shim
  // path; no FUSE/R2 pieces exist locally).
  files(): SeatFiles {
    return new LocalFiles(this);
  }

  // S3Mount and DirectoryBackup need the Worker-side gateways + R2
  // bindings; local-docker dev mode has neither, like snapshots.
  mounts(): SeatMount {
    const unsupported = (): never => {
      throw new SandboxFsError("MOUNT", "S3 mounts are unsupported in local-docker dev mode");
    };
    return {
      mount: async () => unsupported(),
      inspect: async () => unsupported(),
      unmount: async () => unsupported(),
    };
  }

  backups(): SeatDirBackup {
    const unsupported = (): never => {
      throw new SandboxFsError("BACKUP", "directory backups are unsupported in local-docker dev mode");
    };
    return {
      backup: async () => unsupported(),
      restore: async () => unsupported(),
      deleteRecord: async () => unsupported(),
    };
  }

  async monitor(): Promise<void> {
    const name = this.containerName;
    // Never started (or already destroyed) reads as already stopped.
    // The `docker wait` child spawns lazily, only while someone
    // awaits: an eager waiter would hold one-shot CLI commands open
    // forever, and leak one process per command until destroy.
    if (!name || !this.isRunning) return;
    const stopped = this.stopPromise ?? Promise.resolve();
    const waited = this.runner
      .run("docker", ["wait", name])
      .then(
        () => this.markStopped(),
        () => this.markStopped(),
      );
    await Promise.race([stopped, waited]);
  }
}

function execOut(container: ContainerCtl, cmd: string[], stdin?: string | Uint8Array): Promise<ExecOutput> {
  return container.exec(cmd, stdin !== undefined ? { stdin } : undefined).then((h) => h.output());
}

function statType(kind: string): SeatFileType {
  if (kind === "regular file" || kind === "regular empty file") return "file";
  if (kind === "directory") return "directory";
  if (kind === "symbolic link") return "symlink";
  return "other";
}

// SeatFiles over container exec (dev parity): cat/tee for bytes,
// stat/test for metadata, find -printf for listings. Same guards as
// the shim path (absolute paths, symlink-safe); names containing
// newlines mangle listings (dev-only edge, documented).
export class LocalFiles implements SeatFiles {
  constructor(private readonly container: ContainerCtl) {}

  private async run(cmd: string[], stdin?: string | Uint8Array): Promise<ExecOutput> {
    try {
      return await execOut(this.container, cmd, stdin);
    } catch (err) {
      throw new SandboxFsError("IO", `local exec failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}`);
    }
  }

  private async exists(path: string): Promise<boolean> {
    return (await this.run(["test", "-e", path])).exitCode === 0;
  }

  async readFile(path: string, maxBytes = 4 * 1024 * 1024): Promise<Uint8Array> {
    assertContainerPath(path, "readFile");
    if (!(await this.exists(path))) throw new SandboxFsError("NOT_FOUND", `readFile missing: ${path.slice(0, 128)}`);
    const out = await this.run(["cat", path]);
    if (out.exitCode !== 0) throw new SandboxFsError("IO", `readFile failed: ${path.slice(0, 128)}`);
    if (out.stdout.byteLength > maxBytes) throw new SandboxFsError("TOO_LARGE", `readFile exceeds ${maxBytes} bytes`);
    return out.stdout;
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    assertContainerPath(path, "writeFile");
    const out = await this.run(["tee", path], content);
    if (out.exitCode !== 0) throw new SandboxFsError("IO", `writeFile failed: ${path.slice(0, 128)}`);
  }

  private parseStat(text: string, path: string, what: string): SeatFileStat {
    const m = /^(.+)\|(\d+)\|([0-7]+)$/.exec(text.trim());
    if (!m) throw new SandboxFsError("IO", `${what} unparseable for ${path.slice(0, 128)}`);
    return { type: statType(m[1]), size: Number(m[2]), mode: parseInt(m[3], 8) };
  }

  async stat(path: string): Promise<SeatFileStat> {
    assertContainerPath(path, "stat");
    if (!(await this.exists(path))) throw new SandboxFsError("NOT_FOUND", `stat missing: ${path.slice(0, 128)}`);
    const out = await this.run(["stat", "-c", "%F|%s|%a", path]);
    if (out.exitCode !== 0) throw new SandboxFsError("IO", `stat failed: ${path.slice(0, 128)}`);
    return this.parseStat(new TextDecoder().decode(out.stdout), path, "stat");
  }

  async lstat(path: string): Promise<SeatFileStat> {
    assertContainerPath(path, "lstat");
    if ((await this.run(["test", "-L", path])).exitCode === 0) return { type: "symlink", size: 0, mode: 0 };
    return this.stat(path);
  }

  async readDirectory(path: string): Promise<SeatDirEntry[]> {
    assertContainerPath(path, "readDirectory");
    if ((await this.run(["test", "-d", path])).exitCode !== 0) {
      if (!(await this.exists(path))) throw new SandboxFsError("NOT_FOUND", `readDirectory missing: ${path.slice(0, 128)}`);
      throw new SandboxFsError("NOT_DIR", `readDirectory not a directory: ${path.slice(0, 128)}`);
    }
    const out = await this.run(["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f|%y\\n"]);
    if (out.exitCode !== 0) throw new SandboxFsError("IO", `readDirectory failed: ${path.slice(0, 128)}`);
    const entries: SeatDirEntry[] = [];
    for (const line of new TextDecoder().decode(out.stdout).split("\n")) {
      if (!line) continue;
      const bar = line.lastIndexOf("|");
      if (bar <= 0) continue;
      const name = line.slice(0, bar);
      const kind = line.slice(bar + 1);
      const type: SeatFileType = kind === "f" ? "file" : kind === "d" ? "directory" : kind === "l" ? "symlink" : "other";
      entries.push({ name, type });
    }
    return entries;
  }

  async mkdir(path: string, recursive = false): Promise<void> {
    assertContainerPath(path, "mkdir");
    const out = await this.run(recursive ? ["mkdir", "-p", path] : ["mkdir", path]);
    if (out.exitCode !== 0) throw new SandboxFsError("IO", `mkdir failed: ${path.slice(0, 128)}`);
  }
}
