// Local-Docker dev mode for seats (Streamline pattern): a ContainerCtl
// backed by the local `docker` CLI, so seat execution logic can be
// exercised without deploying. Dev-only: nothing in the worker path
// imports this (no snapshots, no registry auth, env passes through
// --env-file except multiline values, which stay argv-visible).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerCtl, ContainerSnapshot, ContainerStartOptions, ExecHandle, ExecOptions } from "./seat";

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
