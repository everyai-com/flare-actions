import { spawn } from "node:child_process";
import { unsafeTarMember } from "./spec.ts";

// Build cache over the server's R2 store: tar the cached paths, PUT the
// blob under the cache key; on later runs GET it back and extract.
// Failures are warnings — a broken cache must never fail a job.

export interface CacheClient {
  getCache(key: string): Promise<Uint8Array | null>;
  putCache(key: string, data: Uint8Array): Promise<void>;
}

export const MAX_TARBALL_BYTES = 512 * 1024 * 1024;

export function safeCachePaths(paths: string[]): string[] | null {
  const out: string[] = [];
  for (const p of paths) {
    if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;
    out.push(p.replace(/^\.\//, ""));
  }
  return out.length > 0 ? out : null;
}

function runTar(args: string[], cwd: string, input?: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_TARBALL_BYTES) {
        child.kill();
        reject(new Error("tarball exceeds 512MB"));
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
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 500)}`));
    });
    if (input) {
      child.stdin.write(input, (err) => {
        if (err) reject(err);
        else child.stdin.end();
      });
    } else {
      child.stdin.end();
    }
  });
}

export async function createTar(dir: string, paths: string[]): Promise<Uint8Array> {
  const safe = safeCachePaths(paths);
  if (!safe) throw new Error("unsafe cache paths");
  return runTar(["-czf", "-", ...safe], dir);
}

export async function extractTar(dir: string, data: Uint8Array): Promise<void> {
  await runTar(["-xzf", "-"], dir, data);
}

// Extraction guard for untrusted tarballs (source dispatch): list first,
// reject absolute paths and `..` traversal, then extract. The listing
// pass costs one read of the blob; the alternative (a hostile member
// escaping the workspace) costs much more.
export async function assertSafeTar(data: Uint8Array): Promise<void> {
  const listing = await runTar(["-tzf", "-"], process.cwd(), data);
  const names = new TextDecoder().decode(listing).split("\n");
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (unsafeTarMember(name)) {
      throw new Error(`unsafe tar member: ${name.slice(0, 120)}`);
    }
  }
}

export async function restoreCache(
  client: CacheClient,
  opts: { key: string; dir: string },
): Promise<{ hit: boolean; error?: string }> {
  try {
    const blob = await client.getCache(opts.key);
    if (!blob) return { hit: false };
    await extractTar(opts.dir, blob);
    return { hit: true };
  } catch (err) {
    return { hit: false, error: String(err) };
  }
}

export async function saveCache(
  client: CacheClient,
  opts: { key: string; dir: string; paths: string[] },
): Promise<{ saved: boolean; bytes?: number; error?: string }> {
  try {
    const blob = await createTar(opts.dir, opts.paths);
    await client.putCache(opts.key, blob);
    return { saved: true, bytes: blob.byteLength };
  } catch (err) {
    return { saved: false, error: String(err) };
  }
}
