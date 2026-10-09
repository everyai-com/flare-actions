import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import {
  buildFlareEnv,
  checkJobParity,
  envParityRows,
  FLARE_ENV_KEYS,
  hasSecretPlaceholders,
  matrixEnv,
  runJob,
  selectTests,
  specParityView,
  type EnvParityRow,
  type JobClient,
  type JobSpec,
  type ParityCacheSummary,
  type ParityFinding,
  type ParityImageSummary,
  type RunJobResult,
} from "flare-actions-runner-sdk";
import { collectWorkspaceFiles } from "../../../packages/runner-sdk/src/testselect-fs.ts";
import { parsePipeline, seatEligible, serializeDefinition, type PipelineJob } from "../../worker/src/pipeline.ts";
import { buildCompatJobs, type WorkflowFile } from "../../worker/src/actionsCompat.ts";

// `cli local`: run flare.yml in the current working tree, on this
// machine, with no server and no commit. This is the agent inner loop —
// zero dispatch latency, the working-tree code, and a warm local cache.
// Server dispatch (`cli run`) remains the parity check.
//
// The worker's pipeline parser is imported deliberately: it is the
// single source of truth for flare.yml validation (the CLI is a thin
// consumer, but re-implementing the parser here would fork the rules).

export interface LocalJobResult {
  name: string;
  status: "success" | "failure" | "skipped";
  durationMs: number;
  artifacts: string[];
}

export interface LocalResult {
  ok: boolean;
  jobs: LocalJobResult[];
}

export interface LocalOptions {
  cwd: string;
  // Pipeline file relative to cwd (default flare.yml).
  file?: string;
  // Run only this job (pre-matrix base name or exact expanded name).
  job?: string;
  env?: NodeJS.ProcessEnv;
  // Override the persistent cache directory (tests).
  cacheDir?: string;
  // Suppress per-job narration (tests).
  quiet?: boolean;
}

export interface ParityJobReport {
  name: string;
  lane: "seats" | "byo";
  image: ParityImageSummary;
  cache: ParityCacheSummary | null;
  env: EnvParityRow[];
  findings: ParityFinding[];
}

export interface ParityReport {
  // False when any job carries a warn-severity finding. Informational:
  // the report command still exits 0; gate on this field in --json.
  ok: boolean;
  jobs: ParityJobReport[];
  warnings: number;
  infos: number;
}

function hashKey(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

function slugify(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "job";
}

function toSpec(job: PipelineJob): JobSpec {
  const spec: JobSpec = { steps: job.steps.map((s) => ({ ...s })) };
  if (job.matrix) spec.matrix = job.matrix;
  if (job.env) spec.env = job.env;
  if (job.container) spec.container = job.container;
  if (job.services) spec.services = job.services;
  if (job.cache) {
    spec.cache = {
      key: job.cache.key,
      paths: job.cache.paths,
      ...(job.cache.restoreKeys ? { restoreKeys: job.cache.restoreKeys } : {}),
    };
  }
  if (job.outputs) spec.outputs = { ...job.outputs };
  if (job.artifacts) {
    spec.artifacts = {
      paths: job.artifacts.paths,
      ...(job.artifacts.name ? { name: job.artifacts.name } : {}),
    };
  }
  if (job.testReports) spec.testReports = { paths: job.testReports.paths };
  if (job.timeoutMinutes !== undefined) spec.timeoutMinutes = job.timeoutMinutes;
  if (job.testSelection) spec.testSelection = { ...job.testSelection };
  return spec;
}

// Local diff: uncommitted + staged changes against HEAD. Best-effort —
// outside a git tree (or when git is missing) this is empty, and
// selection falls back to the full suite.
function localChangedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Best-effort current branch for FLARE_REF: the cloud sets the run's
// branch, so mirroring the checkout's branch keeps branch-gated steps
// and Actions-compat `github.ref` mappings honest. Falls back to the
// historical "local" placeholder outside a git tree.
function localRef(cwd: string): string {
  try {
    const out = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || "local";
  } catch {
    return "local";
  }
}

// Warm, persistent cache across local runs; artifacts land in the tree
// so agents can pick them up without a download step.
interface LocalCacheIndex {
  [key: string]: { file: string; updatedAt: string };
}

function readLocalCacheIndex(cacheDir: string): LocalCacheIndex {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as LocalCacheIndex;
  } catch {
    // Missing or corrupt: exact restores still work (hashed files),
    // prefix scans just miss until the next save rebuilds it.
    return {};
  }
}

function localClient(cacheDir: string, artifactsDir: string, jobSlug: string): JobClient {
  return {
    getCache: async (key) => {
      const path = join(cacheDir, hashKey(key));
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        return null;
      }
    },
    getCacheOrPrefix: async (key, restoreKeys) => {
      const exact = join(cacheDir, hashKey(key));
      try {
        return { data: new Uint8Array(readFileSync(exact)), key };
      } catch {
        // Exact miss: fall through to the prefix scan.
      }
      const index = readLocalCacheIndex(cacheDir);
      for (const prefix of restoreKeys) {
        const candidates = Object.keys(index)
          .filter((k) => k.startsWith(prefix) && typeof index[k]?.updatedAt === "string")
          .sort((a, b) => ((index[a]?.updatedAt ?? "") < (index[b]?.updatedAt ?? "") ? 1 : -1));
        for (const candidate of candidates) {
          try {
            const data = new Uint8Array(readFileSync(join(cacheDir, index[candidate]?.file ?? "")));
            return { data, key: candidate };
          } catch {
            // Stale index entry (blob deleted outside the CLI): try
            // the next candidate instead of failing the restore.
          }
        }
      }
      return null;
    },
    putCache: async (key, data) => {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, hashKey(key)), data);
      // The index powers prefix scans (filenames are hashes); a failed
      // index write degrades future scans, never this save.
      try {
        const index = readLocalCacheIndex(cacheDir);
        index[key] = { file: hashKey(key), updatedAt: new Date().toISOString() };
        const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
        for (const k of Object.keys(index)) {
          if (Date.parse(index[k]?.updatedAt ?? "") < cutoff) delete index[k];
        }
        writeFileSync(join(cacheDir, "index.json"), JSON.stringify(index));
      } catch {
        // Index best-effort; the blob above is the source of truth.
      }
    },
    uploadArtifact: async (_jobId, name, data) => {
      const dir = join(artifactsDir, jobSlug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), data);
    },
    uploadTestReport: async (_jobId, xml) => {
      const dir = join(artifactsDir, jobSlug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "junit.xml"), xml);
      const total = (xml.match(/<testcase\b/g) ?? []).length;
      return { total, passed: total, failed: 0, errors: 0, skipped: 0, truncated: false };
    },
  };
}

function collectSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.startsWith("FLARE_SECRET_") && key.length > "FLARE_SECRET_".length) {
      out[key.slice("FLARE_SECRET_".length)] = value;
    }
  }
  return out;
}

function printOutcome(name: string, outcome: RunJobResult, artifactsDir: string): void {
  const mark = outcome.success ? "ok" : "FAIL";
  console.log(`[${mark}] ${name} (${outcome.cacheHit ? "cache hit, " : ""}${outcome.log.split("\n").length} log lines)`);
  if (!outcome.success) {
    const parsed = (() => {
      try {
        return JSON.parse(outcome.resultJson) as { steps?: { command?: string; exitCode?: number; output?: string }[] };
      } catch {
        return null;
      }
    })();
    const failing = parsed?.steps?.find((s) => typeof s.exitCode === "number" && s.exitCode !== 0);
    if (failing?.command) {
      console.log(`       $ ${failing.command} (exit ${failing.exitCode})`);
      const tail = (failing.output ?? "").trim();
      if (tail) console.log(tail.split("\n").slice(-12).map((l) => `       | ${l}`).join("\n"));
    }
  }
  for (const artifact of outcome.artifacts) {
    console.log(`       artifact: ${join(artifactsDir, slugify(name), artifact)}`);
  }
}

interface LoadedJobs {
  selected: PipelineJob[];
  sourceLabel: string;
}

function loadLocalJobs(opts: LocalOptions): LoadedJobs {
  const filePath = resolve(opts.cwd, opts.file ?? "flare.yml");
  let jobs: PipelineJob[] | null = null;
  let sourceLabel = filePath;
  if (existsSync(filePath)) {
    jobs = parsePipeline(readFileSync(filePath, "utf8"));
    if (!jobs) throw new Error(`${filePath} failed validation (see docs/PIPELINES.md)`);
  } else if (!opts.file) {
    // No flare.yml: fall back to this tree's .github/workflows files —
    // the same compatibility path the server uses for repos without
    // flare.yml. Locally there is no event to match, so every file runs.
    const dir = join(opts.cwd, ".github", "workflows");
    const files: WorkflowFile[] = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).sort()) {
        if (!/\.ya?ml$/i.test(name)) continue;
        files.push({ name, text: readFileSync(join(dir, name), "utf8") });
      }
    }
    if (files.length > 0) {
      const compat = buildCompatJobs(files, null);
      if (!opts.quiet) {
        for (const warning of compat.warnings) console.error(`warning: ${warning}`);
      }
      if (compat.jobs) {
        jobs = compat.jobs;
        sourceLabel = dir;
      }
    }
  }
  if (!jobs) throw new Error(`no flare.yml or .github/workflows under ${opts.cwd}`);
  let selected = jobs;
  if (opts.job) {
    selected = jobs.filter((j) => j.base === opts.job || j.name === opts.job);
    if (selected.length === 0) throw new Error(`no job named "${opts.job}" in ${sourceLabel}`);
  }
  return { selected, sourceLabel };
}

export async function runLocal(opts: LocalOptions): Promise<LocalResult> {
  const { selected } = loadLocalJobs(opts);

  const env = opts.env ?? process.env;
  const secrets = collectSecrets(env);
  const usesSecrets = selected.some((j) => j.steps.some((s) => hasSecretPlaceholders(s.run)));
  if (usesSecrets && Object.keys(secrets).length === 0) {
    console.error("warning: ${{ secrets.* }} placeholders render empty — set FLARE_SECRET_<NAME> to provide values");
  }

  const quiet = opts.quiet === true;
  const cacheDir = opts.cacheDir ?? join(homedir(), ".flare", "cache", hashKey(opts.cwd).slice(0, 12));
  const artifactsDir = join(opts.cwd, ".flare", "artifacts");
  // Working-tree facts the cloud would derive from the run row: the
  // diff feeds FLARE_CHANGED_FILES (like the cloud's changed_files)
  // and test selection, and the branch feeds FLARE_REF.
  const changed = localChangedFiles(opts.cwd);
  const changedFiles = changed.join("\n");
  const ref = localRef(opts.cwd);
  // Cloud parity: the curated keys come from the shared builder, and
  // the host CI value is dropped — cloud steps always see CI=true
  // unless the job env overrides it, so a dirty shell must not flip
  // local runs (job `env:` still wins via the runJob merge).
  const baseEnv = { ...env };
  delete baseEnv.CI;

  const done = new Map<string, boolean>();
  const results: LocalJobResult[] = [];
  const pending = [...selected];
  while (pending.length > 0) {
    const index = pending.findIndex((j) => (j.needs ?? []).every((n) => done.has(n)));
    const job = index === -1 ? pending.shift() : pending.splice(index, 1)[0];
    if (!job) break;
    const base = job.base ?? job.name;
    if ((job.needs ?? []).some((n) => done.get(n) === false)) {
      if (!quiet) console.log(`[--] ${job.name} (skipped: needs failed)`);
      results.push({ name: job.name, status: "skipped", durationMs: 0, artifacts: [] });
      done.set(base, false);
      continue;
    }
    if (!quiet) console.log(`--- ${job.name} ---`);
    const started = Date.now();
    // Local test selection: same walker as the runners, over the working
    // tree, with the git diff as the change set (no failure history —
    // there is no server). Falls back to the full suite on any doubt.
    const spec = toSpec(job);
    let selectionMode = "off";
    let selectedTests = "";
    if (spec.testSelection) {
      try {
        const harvest = collectWorkspaceFiles(opts.cwd);
        const result = selectTests({
          allFiles: harvest.files,
          contents: harvest.contents,
          changed,
          failures: [],
          ...(spec.testSelection.tests ? { testPatterns: spec.testSelection.tests } : {}),
        });
        selectionMode = result.mode;
        if (result.mode === "select") {
          selectedTests = result.selected.join("\n");
          if (!quiet) console.log(`[select] ${result.reason}`);
        } else if (!quiet) {
          console.log(`[select] full suite — ${result.reason}`);
        }
      } catch {
        selectionMode = "full";
        if (!quiet) console.log("[select] selection failed, ran everything");
      }
    }
    const outcome = await runJob(spec, {
      cwd: opts.cwd,
      env: {
        ...baseEnv,
        ...buildFlareEnv({
          repo: "local",
          sha: "local",
          runId: "local",
          jobId: slugify(job.name),
          ref,
          changedFiles,
          selectionMode,
          selectedTests,
        }),
      },
      client: localClient(cacheDir, artifactsDir, slugify(job.name)),
      jobId: slugify(job.name),
      secrets,
    });
    if (!quiet) printOutcome(job.name, outcome, artifactsDir);
    results.push({
      name: job.name,
      status: outcome.success ? "success" : "failure",
      durationMs: Date.now() - started,
      artifacts: outcome.artifacts,
    });
    done.set(base, outcome.success);
  }
  return { ok: results.every((r) => r.status === "success"), jobs: results };
}

// Parity report: compare each job's local execution against its
// predicted cloud lane (image, cache key + scope, curated env) without
// running anything. Pure reads — no steps, no cache writes.
export function runLocalParity(opts: LocalOptions): ParityReport {
  const { selected } = loadLocalJobs(opts);
  const env = opts.env ?? process.env;
  const changedFiles = localChangedFiles(opts.cwd).join("\n");
  const ref = localRef(opts.cwd);
  const hostPlatform = `${platform()}/${arch()}`;
  // Selection is computed at run time on both sides by the same
  // walker, so the report compares the rule, not a prediction.
  const atRunTime = "<computed at run time>";
  const jobs: ParityJobReport[] = selected.map((job) => {
    const spec = toSpec(job);
    const base = job.base ?? job.name;
    const lane = seatEligible(serializeDefinition(job, base)) ? "seats" : "byo";
    const localFlare = buildFlareEnv({
      repo: "local",
      sha: "local",
      runId: "local",
      jobId: slugify(job.name),
      ref,
      changedFiles,
      selectionMode: atRunTime,
      selectedTests: atRunTime,
    });
    const cloudFlare = buildFlareEnv({
      repo: "<run repo>",
      sha: "<run sha>",
      runId: "<run id>",
      jobId: "<job id>",
      ref: "<branch>",
      changedFiles: "<diff at sha>",
      selectionMode: atRunTime,
      selectedTests: atRunTime,
    });
    // Host keys forwarded into local steps beyond the curated set and
    // the job's own env/matrix keys (bounded, sorted).
    const curated = new Set([
      ...FLARE_ENV_KEYS,
      ...Object.keys(spec.env ?? {}),
      ...Object.keys(matrixEnv(spec.matrix)),
      "CI",
    ]);
    const extraHostKeys = Object.keys(env)
      .filter((k) => env[k] !== undefined && !curated.has(k))
      .sort()
      .slice(0, 200);
    const result = checkJobParity(specParityView(spec), {
      lane,
      hostPlatform,
      localFlare,
      cloudFlare,
      extraHostKeys,
    });
    return {
      name: job.name,
      lane,
      image: result.image,
      cache: result.cache,
      env: envParityRows(localFlare, cloudFlare),
      findings: result.findings,
    };
  });
  const warnings = jobs.reduce((n, j) => n + j.findings.filter((f) => f.severity === "warn").length, 0);
  const infos = jobs.reduce((n, j) => n + j.findings.filter((f) => f.severity === "info").length, 0);
  return { ok: warnings === 0, jobs, warnings, infos };
}

function shortValue(value: string, limit = 80): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty)";
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  for (const job of report.jobs) {
    lines.push(`== ${job.name} (cloud lane: ${job.lane}) ==`);
    lines.push(`  image: ${job.image.local} -> ${job.image.cloud}`);
    lines.push(
      job.cache ? `  cache ${job.cache.key}: ${job.cache.local} -> ${job.cache.cloud}` : "  cache: none",
    );
    for (const row of job.env) {
      const mark = row.status === "same" ? "=" : row.status === "expected" ? "~" : "!";
      lines.push(`  env ${mark} ${row.key}: ${shortValue(row.local)} -> ${shortValue(row.cloud)}`);
    }
    for (const finding of job.findings) {
      lines.push(`  [${finding.severity}] ${finding.area}/${finding.key}: ${finding.note}`);
    }
  }
  lines.push(`${report.jobs.length} job(s), ${report.warnings} warning(s), ${report.infos} note(s)`);
  return lines.join("\n");
}
