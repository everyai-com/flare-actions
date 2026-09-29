import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { createTar, restoreCache, safeCachePaths, saveCache, type CacheClient } from "./cache.ts";
import { executeSteps } from "./execute.ts";
import { dockerServicesCtl, type ServiceHandle, type ServicesCtl } from "./services.ts";
import { matrixEnv, type JobSpec } from "./spec.ts";

// Full per-job orchestration: services up -> cache restore -> steps ->
// cache save -> artifacts upload -> services down, inside a job timeout.

export interface JobClient extends CacheClient {
  uploadArtifact(jobId: string, name: string, data: Uint8Array): Promise<void>;
}

export interface RunJobOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  client: JobClient;
  jobId: string;
  servicesCtl?: ServicesCtl;
  // Test hook; production uses spec.timeoutMinutes (default 30).
  timeoutMs?: number;
}

export interface RunJobResult {
  success: boolean;
  log: string;
  resultJson: string;
  cacheHit: boolean;
  artifacts: string[];
}

export const MAX_ARTIFACT_FILES = 1000;
export const MAX_ARTIFACT_BYTES = 400 * 1024 * 1024;
const DEFAULT_TIMEOUT_MINUTES = 30;

export function sanitizeArtifactName(raw: string): string {
  const clean = raw.replace(/[^\w.\-]/g, "-").replace(/^\.+/, "").slice(0, 100);
  return clean || "artifact";
}

function resolveWithin(cwd: string, p: string): string | null {
  if (!p || p.includes("\0")) return null;
  const abs = join(cwd, p);
  if (abs !== cwd && !abs.startsWith(cwd + sep)) return null;
  return abs;
}

interface CollectedFile {
  abs: string;
  rel: string;
  size: number;
}

export function collectArtifactFiles(cwd: string, paths: string[]): { files: CollectedFile[]; truncated: boolean } {
  const files: CollectedFile[] = [];
  let bytes = 0;
  let truncated = false;
  const visit = (abs: string, rel: string): void => {
    if (files.length >= MAX_ARTIFACT_FILES || bytes >= MAX_ARTIFACT_BYTES) {
      truncated = true;
      return;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        visit(join(abs, entry), rel ? `${rel}/${entry}` : entry);
        if (truncated) return;
      }
      return;
    }
    if (st.isFile()) {
      bytes += st.size;
      files.push({ abs, rel, size: st.size });
    }
  };
  for (const p of paths) {
    const abs = resolveWithin(cwd, p);
    if (!abs) continue;
    visit(abs, relative(cwd, abs).split(sep).join("/"));
  }
  return { files, truncated };
}

async function uploadArtifacts(
  client: JobClient,
  jobId: string,
  cwd: string,
  spec: NonNullable<JobSpec["artifacts"]>,
  logParts: string[],
): Promise<string[]> {
  const uploaded: string[] = [];
  const { files, truncated } = collectArtifactFiles(cwd, spec.paths);
  if (truncated) logParts.push("[artifacts] file list truncated at caps");
  if (files.length === 0) {
    logParts.push("[artifacts] no files matched, nothing uploaded");
    return uploaded;
  }
  if (files.length === 1 && !spec.name) {
    const name = sanitizeArtifactName(basename(files[0].rel));
    await client.uploadArtifact(jobId, name, readFileSync(files[0].abs));
    logParts.push(`[artifacts] uploaded ${files[0].rel} as ${name} (${files[0].size}b)`);
    uploaded.push(name);
    return uploaded;
  }
  const safe = safeCachePaths(spec.paths);
  if (!safe) {
    logParts.push("[artifacts] unsafe paths, skipped");
    return uploaded;
  }
  const name = `${sanitizeArtifactName(spec.name ?? "artifacts")}.tar.gz`;
  const blob = await createTar(cwd, safe);
  await client.uploadArtifact(jobId, name, blob);
  logParts.push(`[artifacts] uploaded ${files.length} file(s) as ${name} (${blob.byteLength}b)`);
  uploaded.push(name);
  return uploaded;
}

export async function runJob(spec: JobSpec, opts: RunJobOptions): Promise<RunJobResult> {
  const ctl = opts.servicesCtl ?? dockerServicesCtl;
  const logParts: string[] = [];
  let handles: ServiceHandle[] = [];
  const fail = (msg: string): RunJobResult => ({
    success: false,
    log: [...logParts, msg].join("\n"),
    resultJson: JSON.stringify({ steps: [], error: msg }),
    cacheHit: false,
    artifacts: [],
  });

  const serviceNames = Object.keys(spec.services ?? {});
  if (serviceNames.length > 0 || spec.container) {
    if (!(await ctl.available())) {
      return fail("[setup] docker is not available on this runner (needed for container/services)");
    }
  }
  if (serviceNames.length > 0) {
    try {
      handles = await ctl.start(opts.jobId, spec.services ?? {});
      logParts.push(`[services] started: ${handles.map((h) => `${h.name} (${h.containerName})`).join(", ")}`);
    } catch (err) {
      return fail(`[services] ${String(err)}`);
    }
  }

  const stop = () => ctl.stop(handles).catch(() => undefined);
  const timeoutMs = opts.timeoutMs ?? (spec.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const work = (async (): Promise<RunJobResult> => {
      let cacheHit = false;
      if (spec.cache) {
        const r = await restoreCache(opts.client, { key: spec.cache.key, dir: opts.cwd });
        cacheHit = r.hit;
        logParts.push(r.hit ? `[cache] hit: ${spec.cache.key}` : `[cache] miss: ${spec.cache.key}${r.error ? ` (${r.error})` : ""}`);
      }
      const matrix = matrixEnv(spec.matrix);
      const stepEnv = { ...opts.env, ...spec.env, ...matrix };
      const forwardKeys = spec.container
        ? [...new Set([...Object.keys(spec.env ?? {}), ...Object.keys(matrix), ...Object.keys(opts.env).filter((k) => k.startsWith("FLARE_"))])]
        : undefined;
      const outcome = await executeSteps(spec.steps, {
        cwd: opts.cwd,
        env: stepEnv,
        container: spec.container,
        containerEnv: forwardKeys,
      });
      logParts.push(outcome.log);
      if (spec.cache && outcome.success) {
        const s = await saveCache(opts.client, { key: spec.cache.key, dir: opts.cwd, paths: spec.cache.paths });
        logParts.push(s.saved ? `[cache] saved ${spec.cache.key} (${s.bytes}b)` : `[cache] save skipped${s.error ? `: ${s.error}` : ""}`);
      }
      let artifacts: string[] = [];
      if (spec.artifacts) {
        try {
          artifacts = await uploadArtifacts(opts.client, opts.jobId, opts.cwd, spec.artifacts, logParts);
        } catch (err) {
          logParts.push(`[artifacts] upload failed: ${String(err)}`);
        }
      }
      return {
        success: outcome.success,
        log: logParts.join("\n"),
        resultJson: JSON.stringify({ steps: outcome.results, cacheHit, artifacts }),
        cacheHit,
        artifacts,
      };
    })();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([work, timeout]);
    if (result === null) {
      const msg = `[timeout] job exceeded ${Math.round(timeoutMs / 1000)}s`;
      return {
        success: false,
        log: [...logParts, msg].join("\n"),
        resultJson: JSON.stringify({ steps: [], timedOut: true }),
        cacheHit: false,
        artifacts: [],
      };
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    await stop();
  }
}
