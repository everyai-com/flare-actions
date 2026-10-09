import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlareClient } from "flare-actions-runner-sdk";
import { parsePipeline } from "../../worker/src/pipeline.ts";

// Source dispatch from the CLI: tar the working tree (no commit, no
// push), upload it, and dispatch against it. The pipeline comes from the
// local flare.yml and is validated here first, so a typo fails fast
// instead of after the upload.

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

const EXCLUDES = [
  "--exclude=.git",
  "--exclude=./.git",
  "--exclude=node_modules",
  "--exclude=./node_modules",
  "--exclude=.flare",
  "--exclude=./.flare",
];

export function createSourceTar(cwd: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", ...EXCLUDES, "-C", cwd, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_SOURCE_BYTES) {
        child.kill();
        reject(new Error("working tree exceeds the 50MB source cap — exclude more, or push a commit"));
        return;
      }
      chunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(new Error(`tar failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

export interface DispatchSourceOptions {
  repo: string;
  ref?: string;
  cwd: string;
  priority?: number;
  agent?: string;
  profile?: string;
}

export function readLocalPipeline(cwd: string): string {
  const file = join(cwd, "flare.yml");
  if (!existsSync(file)) throw new Error(`no pipeline file at ${file}`);
  const pipeline = readFileSync(file, "utf8");
  if (!parsePipeline(pipeline)) throw new Error(`${file} failed validation (see docs/PIPELINES.md)`);
  return pipeline;
}

export async function dispatchSource(
  client: Pick<FlareClient, "putSource" | "dispatch">,
  opts: DispatchSourceOptions,
): Promise<{ runId: string; jobIds: string[]; sourceId: string }> {
  const pipeline = readLocalPipeline(opts.cwd);
  const tar = await createSourceTar(opts.cwd);
  const sourceId = await client.putSource(tar);
  const out = await client.dispatch(opts.repo, "", {
    ref: opts.ref,
    pipeline,
    source: sourceId,
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
  });
  return { ...out, sourceId };
}
