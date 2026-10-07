import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  hasSecretPlaceholders,
  runJob,
  type JobClient,
  type JobSpec,
  type RunJobResult,
} from "flare-actions-runner-sdk";
import { parsePipeline, type PipelineJob } from "../../worker/src/pipeline.ts";
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
  if (job.cache) spec.cache = { key: job.cache.key, paths: job.cache.paths };
  if (job.artifacts) {
    spec.artifacts = {
      paths: job.artifacts.paths,
      ...(job.artifacts.name ? { name: job.artifacts.name } : {}),
    };
  }
  if (job.testReports) spec.testReports = { paths: job.testReports.paths };
  if (job.timeoutMinutes !== undefined) spec.timeoutMinutes = job.timeoutMinutes;
  return spec;
}

// Warm, persistent cache across local runs; artifacts land in the tree
// so agents can pick them up without a download step.
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
    putCache: async (key, data) => {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, hashKey(key)), data);
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

export async function runLocal(opts: LocalOptions): Promise<LocalResult> {
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

  const env = opts.env ?? process.env;
  const secrets = collectSecrets(env);
  const usesSecrets = selected.some((j) => j.steps.some((s) => hasSecretPlaceholders(s.run)));
  if (usesSecrets && Object.keys(secrets).length === 0) {
    console.error("warning: ${{ secrets.* }} placeholders render empty — set FLARE_SECRET_<NAME> to provide values");
  }

  const quiet = opts.quiet === true;
  const cacheDir = opts.cacheDir ?? join(homedir(), ".flare", "cache", hashKey(opts.cwd).slice(0, 12));
  const artifactsDir = join(opts.cwd, ".flare", "artifacts");

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
    const outcome = await runJob(toSpec(job), {
      cwd: opts.cwd,
      env: {
        ...env,
        FLARE_REPO: "local",
        FLARE_SHA: "local",
        FLARE_RUN_ID: "local",
        FLARE_JOB_ID: slugify(job.name),
        FLARE_REF: "local",
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
