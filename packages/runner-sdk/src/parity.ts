// Local/cloud execution parity: one shared code path for the three things
// that must agree between `cli local` and the cloud executors (BYO
// runners and managed seats) — step images, cache keys, and the FLARE_*
// step environment. Pure and Node-free (seats and the worker bundle it;
// the runner and CLI import it) so every executor resolves the same
// inputs to the same values instead of forking the rules.
//
// Plain types only (SDK type-stripping rule): no enums or namespaces.

import type { JobSpec } from "./spec.ts";
import { SELECTED_TESTS_ENV, SELECTION_MODE_ENV } from "./testselect.ts";

// Canonical cache-key shape: enforced at `flare.yml` parse time
// (worker pipeline.ts), at the cache API (worker cache.ts), and echoed
// by the parity report. `cli local` maps these keys onto files, the
// cloud maps them onto R2 objects — the key string is identical.
export const CACHE_KEY_RE = /^[\w][\w.\-/]{0,199}$/;

export function isValidCacheKey(key: string): boolean {
  return CACHE_KEY_RE.test(key);
}

// Canonical R2 object key for a cache entry. Seats read/write this
// path directly; BYO runners reach it through the cache API.
export function cacheObjectKey(key: string): string {
  return `cache/${key}`;
}

// Normalize an image ref for comparison: surrounding whitespace never
// changes what docker pulls, so it never counts as a divergence.
export function normalizeImageRef(ref: string): string | null {
  const trimmed = ref.trim();
  return trimmed ? trimmed : null;
}

// A tag that can resolve differently between two pulls: an implicit
// tag (`node`, i.e. `:latest`) or an explicit `:latest`. A digest
// (`image@sha256:...`) pins the pull, so it is never mutable.
export function isMutableImageTag(image: string): boolean {
  const at = image.indexOf("@");
  const ref = at === -1 ? image : image.slice(0, at);
  if (at !== -1) return false;
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon === -1 || colon < slash) return true;
  return ref.slice(colon + 1).toLowerCase() === "latest";
}

export type StepImage = { kind: "container"; image: string } | { kind: "host"; platform: string };

// Where a job's steps execute: inside `container:` when set (docker on
// BYO runners and `cli local`; seats release such jobs to BYO), else
// natively on the executor host. `hostPlatform` is `os/arch`
// (`process.platform/process.arch` on Node, `linux/amd64` on seats).
export function resolveStepImage(
  container: string | undefined,
  hostPlatform: string,
): StepImage {
  const image = container === undefined ? null : normalizeImageRef(container);
  if (image) return { kind: "container", image };
  return { kind: "host", platform: hostPlatform };
}

export function describeStepImage(image: StepImage): string {
  return image.kind === "container" ? `container:${image.image}` : `host:${image.platform}`;
}

// Inputs to the curated step environment. Every executor builds these
// same keys; only the values' provenance differs (run rows in the
// cloud, working-tree best-effort readings under `cli local`).
export interface FlareEnvInput {
  repo: string;
  sha: string;
  runId: string;
  jobId: string;
  ref: string;
  changedFiles: string;
  selectionMode: string;
  selectedTests: string;
}

// The curated step environment, in report order: run identity, then
// GitHub parity (`CI=true`; job `env` may still override it at the
// merge sites in runner-sdk job.ts and seats seat.ts), then the test
// selection contract. `FLARE_WORKFLOW` and `FLARE_MATRIX_*` /
// `FLARE_SHARD_*` ride the job's own env/matrix instead.
export function buildFlareEnv(input: FlareEnvInput): Record<string, string> {
  return {
    FLARE_REPO: input.repo,
    FLARE_SHA: input.sha,
    FLARE_RUN_ID: input.runId,
    FLARE_JOB_ID: input.jobId,
    FLARE_REF: input.ref,
    FLARE_CHANGED_FILES: input.changedFiles,
    CI: "true",
    [SELECTION_MODE_ENV]: input.selectionMode,
    [SELECTED_TESTS_ENV]: input.selectedTests,
  };
}

export const FLARE_ENV_KEYS = [
  "FLARE_REPO",
  "FLARE_SHA",
  "FLARE_RUN_ID",
  "FLARE_JOB_ID",
  "FLARE_REF",
  "FLARE_CHANGED_FILES",
  "CI",
  SELECTION_MODE_ENV,
  SELECTED_TESTS_ENV,
] as const;

export interface EnvParityRow {
  key: string;
  local: string;
  cloud: string;
  // `same` = byte-identical; `expected` = placeholder vs run value, the
  // documented local/cloud split; `diff` = a genuine divergence.
  status: "same" | "expected" | "diff";
}

// Identity keys always differ locally (there is no run row), so they
// compare as `expected`, never as failures. Everything else must match
// byte-for-byte — the executors share `buildFlareEnv`, so a `diff`
// here means a caller bypassed it.
const IDENTITY_KEYS = new Set(["FLARE_REPO", "FLARE_SHA", "FLARE_RUN_ID", "FLARE_JOB_ID"]);

export function envParityRows(local: Record<string, string>, cloud: Record<string, string>): EnvParityRow[] {
  return FLARE_ENV_KEYS.map((key) => {
    const l = local[key] ?? "";
    const c = cloud[key] ?? "";
    if (l === c) return { key, local: l, cloud: c, status: "same" as const };
    if (IDENTITY_KEYS.has(key)) return { key, local: l, cloud: c, status: "expected" as const };
    return { key, local: l, cloud: c, status: "diff" as const };
  });
}

export interface ParityFinding {
  area: "image" | "cache" | "env";
  key: string;
  local: string;
  cloud: string;
  severity: "info" | "warn";
  note: string;
}

export interface ParityContext {
  // Predicted cloud lane (seats release container/service/labelled jobs
  // to BYO; see `seatEligible` in worker pipeline.ts).
  lane: "seats" | "byo";
  // Where `cli local` runs, `os/arch` (e.g. `darwin/arm64`).
  hostPlatform: string;
  // `buildFlareEnv` output used locally, and the cloud rule for the
  // same keys (identity placeholders, `CI=true`, claim-time selection).
  localFlare: Record<string, string>;
  cloudFlare: Record<string, string>;
  // Host env keys forwarded into local steps beyond the curated set
  // (sorted, caller-bounded). Seats provide none of these.
  extraHostKeys: string[];
}

export interface ParitySpec {
  container?: string;
  cache?: { key: string };
}

export function specParityView(spec: JobSpec): ParitySpec {
  const out: ParitySpec = {};
  if (spec.container !== undefined) out.container = spec.container;
  if (spec.cache !== undefined) out.cache = { key: spec.cache.key };
  return out;
}

// Where the cloud would run host-executed steps for a lane: the managed
// seat container, or a BYO runner host with the job's labels.
export function cloudImageForLane(lane: "seats" | "byo", localImage: StepImage): string {
  if (localImage.kind === "container") return describeStepImage(localImage);
  return lane === "seats" ? "seat:linux/amd64 managed" : "host:BYO runner";
}

export interface ParityImageSummary {
  local: string;
  cloud: string;
}

export interface ParityCacheSummary {
  key: string;
  local: string;
  cloud: string;
}

export interface ParityResult {
  image: ParityImageSummary;
  cache: ParityCacheSummary | null;
  findings: ParityFinding[];
}

// Compare one job's local execution against its predicted cloud lane.
// Pure: the caller supplies facts, this returns the image/cache
// summaries plus every divergence worth reporting. Identity
// placeholders (repo/sha/run/job) are `expected`, never findings —
// they are covered by `envParityRows`.
export function checkJobParity(spec: ParitySpec, ctx: ParityContext): ParityResult {
  const findings: ParityFinding[] = [];
  const image = resolveStepImage(spec.container, ctx.hostPlatform);
  const localImage = describeStepImage(image);
  const cloudImage = cloudImageForLane(ctx.lane, image);
  if (image.kind === "container") {
    // Container jobs always land on BYO (seats are ineligible), and
    // both sides pull the same ref through docker.
    findings.push({
      area: "image",
      key: "steps",
      local: localImage,
      cloud: cloudImage,
      severity: "info",
      note: "same image ref on docker locally and on BYO runners",
    });
    if (isMutableImageTag(image.image)) {
      findings.push({
        area: "image",
        key: "steps",
        local: localImage,
        cloud: cloudImage,
        severity: "warn",
        note: "mutable tag resolves at pull time — local and CI can pull different bytes; pin a digest or dated tag",
      });
    }
  } else if (ctx.lane === "seats") {
    findings.push({
      area: "image",
      key: "steps",
      local: localImage,
      cloud: cloudImage,
      severity: ctx.hostPlatform.startsWith("linux/") ? "info" : "warn",
      note: ctx.hostPlatform.startsWith("linux/")
        ? "both run natively on Linux; installed toolchains may still differ"
        : "steps run natively on both sides but on different kernels — add `container:` for exact parity",
    });
  } else {
    findings.push({
      area: "image",
      key: "steps",
      local: localImage,
      cloud: cloudImage,
      severity: "info",
      note: "both run natively on the host OS; keep the runner's toolchain close to this machine's",
    });
  }

  let cache: ParityCacheSummary | null = null;
  if (spec.cache) {
    const key = spec.cache.key;
    if (!isValidCacheKey(key)) {
      cache = { key, local: "local file", cloud: "rejected" };
      findings.push({
        area: "cache",
        key,
        local: cache.local,
        cloud: cache.cloud,
        severity: "warn",
        note: "key fails validation, so the cloud never stores it while local files accept anything",
      });
    } else {
      cache = { key, local: "local file (directory-scoped)", cloud: cacheObjectKey(key) };
      findings.push({
        area: "cache",
        key,
        local: cache.local,
        cloud: cache.cloud,
        severity: "info",
        note: "same key string; local cache is directory-scoped while the cloud shares one global keyspace, so the first cloud run after local-only work misses",
      });
    }
  }

  for (const row of envParityRows(ctx.localFlare, ctx.cloudFlare)) {
    if (row.status !== "diff") continue;
    findings.push({
      area: "env",
      key: row.key,
      local: row.local,
      cloud: row.cloud,
      severity: row.key === "CI" ? "warn" : "info",
      note:
        row.key === "CI"
          ? "CI differs — cloud steps always see CI=true unless the job env overrides it"
          : "same rule, working-tree value locally vs run value in the cloud",
    });
  }
  if (ctx.lane === "seats" && ctx.extraHostKeys.length > 0) {
    const shown = ctx.extraHostKeys.slice(0, 3).join(", ");
    findings.push({
      area: "env",
      key: "host environment",
      local: `${ctx.extraHostKeys.length} extra vars`,
      cloud: "curated only",
      severity: "info",
      note:
        `steps see ${ctx.extraHostKeys.length} host vars locally (e.g. ${shown}) that seats never provide — ` +
        "move anything a step needs into the job env",
    });
  }
  return { image: { local: localImage, cloud: cloudImage }, cache, findings };
}
