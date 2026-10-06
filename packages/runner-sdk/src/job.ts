import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { createTar, restoreCache, safeCachePaths, saveCache, type CacheClient } from "./cache.ts";
import { executeSteps } from "./execute.ts";
import { interpolateSecrets, maskSecrets } from "./secrets.ts";
import { dockerServicesCtl, type ServiceHandle, type ServicesCtl } from "./services.ts";
import { matrixEnv, type JobServiceSpec, type JobSpec } from "./spec.ts";

// Full per-job orchestration: services up -> cache restore -> steps ->
// cache save -> artifacts upload -> services down, inside a job timeout.

export interface TestReportSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  truncated: boolean;
}

export interface JobClient extends CacheClient {
  uploadArtifact(jobId: string, name: string, data: Uint8Array): Promise<void>;
  uploadTestReport(jobId: string, xml: string): Promise<TestReportSummary>;
}

export interface RunJobOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  client: JobClient;
  jobId: string;
  servicesCtl?: ServicesCtl;
  // Test hook; production uses spec.timeoutMinutes (default 30).
  timeoutMs?: number;
  // Decrypted repo secrets for ${{ secrets.NAME }}. Interpolated into
  // steps and env here, then masked out of every log and result.
  secrets?: Record<string, string>;
  // True when stored secrets failed to decrypt server-side: placeholders
  // render empty and the job log carries a warning.
  secretsError?: boolean;
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
export const MAX_TEST_REPORT_FILES = 10;
export const MAX_TEST_REPORT_BYTES = 1024 * 1024;
// Zero-config conventional locations, scanned when the job has no
// explicit test-reports paths (or in addition to them).
export const DEFAULT_TEST_REPORT_PATHS = [
  "junit.xml",
  "test-results.xml",
  "test-results/junit.xml",
  "test-results/test-results.xml",
  "reports/junit.xml",
  "reports/test-results.xml",
];
const DEFAULT_TIMEOUT_MINUTES = 30;

export function sanitizeArtifactName(raw: string): string {
  const clean = raw.replace(/[^\w.-]/g, "-").replace(/^\.+/, "").slice(0, 100);
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

// JUnit collection: explicit test-reports paths plus conventional
// filenames. Only *.xml files that smell like JUnit (a <testsuite
// tag in the first kilobyte) are sent; multiple files concatenate —
// the server parser scans sections, so joined documents parse as one.
export function collectTestReportXml(cwd: string, specPaths: string[] | undefined): { xml: string; files: string[] } {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const p of [...(specPaths ?? []), ...DEFAULT_TEST_REPORT_PATHS]) {
    const abs = resolveWithin(cwd, p);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    candidates.push(abs);
  }
  const parts: string[] = [];
  const files: string[] = [];
  let bytes = 0;
  for (const abs of candidates) {
    if (files.length >= MAX_TEST_REPORT_FILES || bytes >= MAX_TEST_REPORT_BYTES) break;
    let entries: string[] = [];
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        entries = readdirSync(abs)
          .filter((e) => e.endsWith(".xml"))
          .map((e) => join(abs, e));
      } else if (st.isFile() && abs.endsWith(".xml")) {
        entries = [abs];
      }
    } catch {
      continue;
    }
    for (const file of entries) {
      if (files.length >= MAX_TEST_REPORT_FILES || bytes >= MAX_TEST_REPORT_BYTES) break;
      let text: string;
      try {
        if (statSync(file).size > MAX_TEST_REPORT_BYTES) continue;
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!text.slice(0, 1024).includes("<testsuite")) continue;
      parts.push(text);
      bytes += text.length;
      files.push(relative(cwd, file).split(sep).join("/"));
    }
  }
  return { xml: parts.join("\n"), files };
}

async function uploadTestReports(
  client: JobClient,
  jobId: string,
  cwd: string,
  specPaths: string[] | undefined,
  logParts: string[],
): Promise<void> {
  const { xml, files } = collectTestReportXml(cwd, specPaths);
  if (files.length === 0) return;
  const summary = await client.uploadTestReport(jobId, xml.slice(0, MAX_TEST_REPORT_BYTES));
  logParts.push(
    `[tests] uploaded ${files.length} report(s) (${files.join(", ")}): ` +
      `${summary.total} tests, ${summary.failed + summary.errors} failed${summary.truncated ? " (truncated)" : ""}`,
  );
}

export async function runJob(spec: JobSpec, opts: RunJobOptions): Promise<RunJobResult> {
  const ctl = opts.servicesCtl ?? dockerServicesCtl;
  const secrets = opts.secrets ?? {};
  const mask = (s: string): string => maskSecrets(s, secrets);
  const logParts: string[] = [];
  let handles: ServiceHandle[] = [];
  const fail = (msg: string): RunJobResult => ({
    success: false,
    log: mask([...logParts, msg].join("\n")),
    resultJson: mask(JSON.stringify({ steps: [], error: msg })),
    cacheHit: false,
    artifacts: [],
  });
  if (opts.secretsError) {
    logParts.push("[setup] warning: repo secrets unavailable (decrypt failed), placeholders render empty");
  }

  const serviceNames = Object.keys(spec.services ?? {});
  if (serviceNames.length > 0 || spec.container) {
    if (!(await ctl.available())) {
      return fail("[setup] docker is not available on this runner (needed for container/services)");
    }
  }
  // Seats-only: silently skipping browser checks would report green on
  // untested pages, so BYO runners fail closed with a pointer.
  if (spec.browserChecks && spec.browserChecks.length > 0) {
    return fail("[setup] browser-checks need managed seats (this runner cannot drive the BROWSER binding)");
  }
  // Seats-only: an unenforced allowlist is a lie about the security
  // boundary, so BYO runners fail closed with a pointer.
  if (spec.egress && spec.egress.allow.length > 0) {
    return fail("[setup] egress allowlists need managed seats (this runner cannot intercept outbound connections)");
  }
  if (serviceNames.length > 0) {
    const services: Record<string, JobServiceSpec> = {};
    for (const [name, svc] of Object.entries(spec.services ?? {})) {
      const out: JobServiceSpec = { image: svc.image };
      if (svc.ports) out.ports = svc.ports;
      if (svc.env) {
        out.env = {};
        for (const [k, v] of Object.entries(svc.env)) out.env[k] = interpolateSecrets(v, secrets);
      }
      services[name] = out;
    }
    try {
      handles = await ctl.start(opts.jobId, services);
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
      const jobEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(spec.env ?? {})) jobEnv[k] = interpolateSecrets(v, secrets);
      // GitHub parity: CI=true for every step (enables tool retries and
      // non-interactive modes); runner env or job env may override it.
      const stepEnv = { CI: "true", ...opts.env, ...jobEnv, ...matrix };
      const forwardKeys = spec.container
        ? [...new Set([...Object.keys(jobEnv), ...Object.keys(matrix), ...Object.keys(opts.env).filter((k) => k.startsWith("FLARE_"))])]
        : undefined;
      // Preserve per-step flags (continue-on-error, if) — dropping them
      // here would silently disable both on every executor that runs
      // through runJob (BYO runners and cli local).
      const steps = spec.steps.map((s) => ({ ...s, run: interpolateSecrets(s.run, secrets) }));
      const outcome = await executeSteps(steps, {
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
      // Test reports upload on pass and fail alike: a failing suite's
      // per-test breakdown is the whole point.
      try {
        await uploadTestReports(opts.client, opts.jobId, opts.cwd, spec.testReports?.paths, logParts);
      } catch (err) {
        logParts.push(`[tests] upload failed: ${String(err)}`);
      }
      return {
        success: outcome.success,
        log: mask(logParts.join("\n")),
        resultJson: mask(JSON.stringify({ steps: outcome.results, cacheHit, artifacts })),
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
        log: mask([...logParts, msg].join("\n")),
        resultJson: mask(JSON.stringify({ steps: [], timedOut: true })),
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
