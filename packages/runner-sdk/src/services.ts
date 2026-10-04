import { execFile } from "node:child_process";
import type { JobServiceSpec } from "./spec.ts";

// Docker execution: per-job service containers plus running every step
// inside a `container:` image. Runners without docker fail such jobs
// with a clear message instead of hanging or silently skipping.

export interface ServiceHandle {
  name: string;
  containerName: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const raw = (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code;
      const code = error ? (typeof raw === "number" ? raw : 124) : 0;
      resolve({ code, out: String(stdout ?? stderr ?? "") });
    });
  });
}

export async function dockerAvailable(): Promise<boolean> {
  const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 15000);
  return r.code === 0;
}

// docker run -d --name <containerName> [-p ...] [-e K=V ...] <image>
export function dockerArgsForService(containerName: string, svc: JobServiceSpec): string[] {
  const args = ["run", "-d", "--name", containerName];
  for (const p of svc.ports ?? []) args.push("-p", p);
  for (const [k, v] of Object.entries(svc.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(svc.image);
  return args;
}

// Steps run as: docker run --rm -v <cwd>:/work -w /work [-e K=V ...]
// <image> <shell> -c <command>. Only the listed env keys cross the
// boundary; the container keeps its own PATH and toolchain.
export function dockerArgsForStep(
  image: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  forwardKeys: string[],
  command: string,
  shell = "sh",
): string[] {
  const args = ["run", "--rm", "-v", `${cwd}:/work`, "-w", "/work"];
  for (const k of forwardKeys) {
    const v = env[k];
    if (v !== undefined) args.push("-e", `${k}=${v}`);
  }
  args.push(image, shell, "-c", command);
  return args;
}

export interface ServicesCtl {
  available(): Promise<boolean>;
  start(jobId: string, services: Record<string, JobServiceSpec>): Promise<ServiceHandle[]>;
  stop(handles: ServiceHandle[]): Promise<void>;
}

export const dockerServicesCtl: ServicesCtl = {
  available: dockerAvailable,
  async start(jobId, services) {
    const handles: ServiceHandle[] = [];
    const short = jobId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    for (const [name, svc] of Object.entries(services)) {
      const containerName = `flare-${short}-${name}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
      const r = await run("docker", dockerArgsForService(containerName, svc), 120000);
      if (r.code !== 0) {
        await dockerServicesCtl.stop(handles);
        throw new Error(`service ${name} failed to start: ${r.out.slice(0, 500)}`);
      }
      handles.push({ name, containerName });
    }
    return handles;
  },
  async stop(handles) {
    for (const h of handles) {
      await run("docker", ["rm", "-f", h.containerName], 30000);
    }
  },
};
