// Runner-side reader for jobs.definition JSON. Forward-tolerant: steps
// are required, every other field is validated lightly and dropped when
// malformed so old runners keep working against newer servers.

export interface JobServiceSpec {
  image: string;
  ports?: string[];
  env?: Record<string, string>;
}

export interface JobCacheSpec {
  key: string;
  paths: string[];
}

export interface JobArtifactsSpec {
  paths: string[];
  name?: string;
}

export interface JobSpec {
  steps: { run: string }[];
  base?: string;
  matrix?: Record<string, string>;
  env?: Record<string, string>;
  container?: string;
  services?: Record<string, JobServiceSpec>;
  cache?: JobCacheSpec;
  artifacts?: JobArtifactsSpec;
  timeoutMinutes?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strMap(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((s): s is string => typeof s === "string" && !!s)) return null;
  return v;
}

export function parseJobSpec(definition: string): JobSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  const steps: { run: string }[] = [];
  for (const s of parsed.steps) {
    if (!isRecord(s) || typeof s.run !== "string" || !s.run.trim()) return null;
    steps.push({ run: s.run });
  }
  const spec: JobSpec = { steps };
  if (typeof parsed.base === "string" && parsed.base) spec.base = parsed.base;
  const matrix = parsed.matrix === undefined ? null : strMap(parsed.matrix);
  if (parsed.matrix !== undefined && !matrix) return null;
  if (matrix) spec.matrix = matrix;
  const env = parsed.env === undefined ? null : strMap(parsed.env);
  if (parsed.env !== undefined && !env) return null;
  if (env) spec.env = env;
  if (parsed.container !== undefined) {
    if (typeof parsed.container !== "string" || !parsed.container.trim()) return null;
    spec.container = parsed.container;
  }
  if (parsed.services !== undefined) {
    if (!isRecord(parsed.services)) return null;
    const services: Record<string, JobServiceSpec> = {};
    for (const [name, def] of Object.entries(parsed.services)) {
      if (!isRecord(def) || typeof def.image !== "string" || !def.image.trim()) return null;
      const svc: JobServiceSpec = { image: def.image };
      if (def.ports !== undefined) {
        const ports = strList(def.ports);
        if (!ports) return null;
        svc.ports = ports;
      }
      if (def.env !== undefined) {
        const svcEnv = strMap(def.env);
        if (!svcEnv) return null;
        svc.env = svcEnv;
      }
      services[name] = svc;
    }
    spec.services = services;
  }
  if (parsed.cache !== undefined) {
    if (!isRecord(parsed.cache) || typeof parsed.cache.key !== "string" || !parsed.cache.key) return null;
    const paths = strList(parsed.cache.paths);
    if (!paths) return null;
    spec.cache = { key: parsed.cache.key, paths };
  }
  if (parsed.artifacts !== undefined) {
    if (!isRecord(parsed.artifacts)) return null;
    const paths = strList(parsed.artifacts.paths);
    if (!paths) return null;
    spec.artifacts = { paths };
    if (parsed.artifacts.name !== undefined) {
      if (typeof parsed.artifacts.name !== "string" || !parsed.artifacts.name.trim()) return null;
      spec.artifacts.name = parsed.artifacts.name;
    }
  }
  if (parsed.timeoutMinutes !== undefined) {
    if (typeof parsed.timeoutMinutes !== "number" || parsed.timeoutMinutes < 1) return null;
    spec.timeoutMinutes = Math.floor(parsed.timeoutMinutes);
  }
  return spec;
}

// Matrix values as step env: {node: '20'} -> {FLARE_MATRIX_NODE: '20'}.
export function matrixEnv(matrix: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(matrix ?? {})) {
    out[`FLARE_MATRIX_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
  }
  return out;
}
