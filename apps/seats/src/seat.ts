import {
  appendJobLog,
  claimJob,
  deleteSeatSnapshot,
  getJob,
  getJobsForRun,
  getRun,
  getSeatSnapshot,
  isTerminal,
  markJobRetained,
  quarantineDowngrade,
  readNeedsContext,
  recentlyFailedTests,
  releaseJob,
  rollupRunStatus,
  saveJobEgress,
  saveSeatSnapshot,
  saveTestReport,
  saveTestSelection,
  SEAT_SNAPSHOT_MAX_AGE_MS,
  touchSeatSnapshot,
  updateRunningJob,
  type Db,
} from "../../worker/src/db";
import {
  maybeRetryJob,
  promoteBlockedJobs,
  reportGitHubStatus,
  triageAndStore,
  type QueueSender,
} from "../../worker/src/finish";
import { emitJobTerminal } from "../../worker/src/analytics";
import { basinJobTerminal, sendBasin, type BasinSink } from "../../worker/src/basin";
import { requestHeal } from "../../worker/src/heal";
import { bytesEqual, getInstallationToken, mintAppJwt } from "../../worker/src/github";
import { reportJobCheck } from "../../worker/src/checks";
import { notifyRunCompleted, type NotifyMailEnv } from "../../worker/src/notify";
import { EGRESS_LOG_PATH, EGRESS_SHIM_PATH, countBlockedConnects, parseEgressLog } from "./egress";
import { isSandboxFsError, type SeatDirBackup, type SeatFiles, type SeatMount } from "./sandbox-fs";
import { evaluateResultMonitors } from "../../worker/src/monitors";
import { indexJobLog } from "../../worker/src/search";
import { recordRuntimePrior } from "../../worker/src/priors";
import { jobDurationMs } from "../../worker/src/cost";
import { MAX_JUNIT_BYTES, parseJUnit } from "../../worker/src/junit";
import { readJobSpec, seatEligible } from "../../worker/src/pipeline";
import { decideSelectionMode, DEFAULT_HISTORY_DAYS } from "../../worker/src/testselect";
import { pickNewestCacheHit, recordCacheOutcome } from "../../worker/src/cache";
import { ARTIFACTS_EVENT } from "../../worker/src/artifacts-push";
import { annotateSpan } from "../../worker/src/trace";
import { getDecryptedRepoSecrets } from "../../worker/src/secrets";
import type { AiBinding } from "../../worker/src/triage";
import { interpolateSecrets, maskSecrets } from "../../../packages/runner-sdk/src/secrets";
import { buildNeedsEnv, formatOutputsLine, parseStepOutputs, resolveJobOutputs } from "../../../packages/runner-sdk/src/outputs";
import { resolveCheckUrl } from "../../../packages/runner-sdk/src/browser";
import { matrixEnv, parseJobSpec, stepRuns, unsafeTarMember } from "../../../packages/runner-sdk/src/spec";
import type { JobBrowserActionSpec } from "../../../packages/runner-sdk/src/spec";
import {
  groupGrepLines,
  selectTests,
} from "../../../packages/runner-sdk/src/testselect";
import { buildFlareEnv, cacheObjectKey } from "../../../packages/runner-sdk/src/parity";

// Managed-seat job execution: the seat Durable Object drives a Linux
// container purely through exec calls while writing D1/R2 directly.
// No tokens, no polling, no affinity problem — the atomic claim decides
// exactly one executor per job. Anything a seat cannot do (private repo
// without App credentials, container never starts) releases the job back
// to `queued` so BYO runners stay the backstop.

export interface ExecOutput {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ExecHandle {
  pid: number;
  output(): Promise<ExecOutput>;
  kill(signal?: number): void;
}

export interface ExecOptions {
  stdin?: string | Uint8Array;
  env?: Record<string, string>;
  cwd?: string;
}

// Minimal surface of ctx.container used by seats; the DO wrapper adapts
// the real API, tests inject fakes.
// MicroVM sizes accepted by container start (mirrors the platform
// union; custom vcpu/memoryMib resources stay a Phase 2 addition).
export type ContainerInstanceSize = "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";

export interface ContainerStartOptions {
  enableInternet?: boolean;
  // Durable-object-policy start config (V2 seats only; the V1 adapter
  // drops everything but enableInternet). image is the digest-pinned
  // ref from ctx.container.images; snapshotId restores a saved
  // filesystem instead of the image; instance sizes the microVM.
  image?: string;
  entrypoint?: string[];
  env?: Record<string, string>;
  instance?: ContainerInstanceSize;
  snapshotId?: string;
}

export interface ContainerSnapshot {
  id: string;
  size: number;
  name?: string;
}

export interface ContainerCtl {
  readonly running: boolean;
  start(opts?: ContainerStartOptions): Promise<void>;
  destroy(): void;
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecHandle>;
  // Filesystem snapshot of the running instance (V2 only). The caller
  // stores the returned id (D1/DO storage, 30-day expiry) and passes
  // it back as snapshotId on a later start.
  snapshot(name?: string): Promise<ContainerSnapshot>;
  // Resolves when the instance stops (any cause). Awaiting it counts
  // as pending I/O, which keeps the DO alive without a connected
  // client on compat 2026-10-01+; seats also race it against every
  // exec so a dead container fails fast instead of hanging to timeout.
  monitor(): Promise<void>;
}

export interface SeatBlobStore {
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, data: Uint8Array): Promise<unknown>;
  // Prefix listing for restore-keys (full object keys in and out;
  // the seat slices via pickNewestCacheHit). R2Bucket satisfies this
  // structurally, which is why seat-do.ts passes env.CACHE directly.
  list(options: { prefix: string; limit: number }): Promise<{ objects: { key: string; uploaded: Date }[] }>;
}

export interface SeatTiming {
  startWaitMs: number;
  startAttempts: number;
  startPollMs: number;
  stepMs: number;
  blobMs: number;
  checkoutMs?: number;
  snapshotMs?: number;
}

export const DEFAULT_TIMING: SeatTiming = {
  // Cold provisions observed at 45-100s under load; the window must
  // cover a slow pull, not just a warm start.
  startWaitMs: 120000,
  startAttempts: 3,
  startPollMs: 2000,
  stepMs: 600000,
  blobMs: 120000,
  checkoutMs: 180000,
};

export interface SeatWakeSender {
  send(msg: { jobId: string }, opts?: { delaySeconds?: number }): Promise<unknown>;
}

export interface SeatDeps {
  db: Db;
  cache: SeatBlobStore | undefined;
  queue: QueueSender;
  // Seats queue producer for capacity re-wakes; absent in unit contexts
  // that never release for capacity.
  seatQueue?: SeatWakeSender;
  ai: AiBinding | undefined;
  appId?: string;
  appKey?: string;
  // Artifacts mirror checkout: remote template holding `{repo}` plus,
  // optionally, a shared repo token. Template alone = GitHub only unless
  // the mirror lives in the binding namespace (see artifactsNamespace):
  // then seats mint a per-job read token instead of sharing one env
  // token. Present = mirror first with GitHub fallback (see
  // renderMirrorRemote).
  mirrorRemote?: string;
  mirrorToken?: string;
  // ARTIFACTS binding for seat-minted checkout tokens. Tournament forks
  // are dynamic and tokens are repo-scoped, so seats mint a short-lived
  // read token per checkout (memory-only, never stored) instead of
  // sharing one env token. Absent = artifacts runs release.
  artifacts?: SeatArtifactsNamespace | null;
  // Namespace of the ARTIFACTS binding (env ARTIFACTS_NAMESPACE). When
  // the mirror template points into this namespace, mirror checkouts
  // mint per-job read tokens too; otherwise they use mirrorToken.
  artifactsNamespace?: string;
  // Browser-check driver (BROWSER binding). Absent = the seats worker
  // has no Browser Rendering binding; jobs with browserChecks fail
  // closed rather than skipping.
  browser?: BrowserDriver;
  // Analytics Engine dataset for CI lifecycle events. Absent = the
  // seats worker has no dataset binding; emission skips silently.
  analytics?: AnalyticsEngineDataset | undefined;
  // Basin Pipeline sink for the same events (cold storage). Absent =
  // no CI_EVENTS stream binding; emission skips silently.
  basin?: BasinSink | undefined;
  container: ContainerCtl;
  // Sandbox SDK 1.0 file utilities (seat-do adapters). Absent on
  // pre-shim images and in unit contexts — flows fall back to exec.
  fs?: SeatFiles;
  // DirectoryBackup (V2 only): dir -> R2 -> restore. No job-flow
  // consumer yet; warm boxes save/restore workspaces through it.
  dirBackup?: SeatDirBackup;
  // S3Mount (R2 S3 creds configured): R2 prefix mounts. Latent until
  // a flow mounts; the cache-bucket mount rides warm boxes.
  mount?: SeatMount;
  timing?: SeatTiming;
  sleep?: (ms: number) => Promise<void>;
  spawn?: (jobId: string) => Promise<void>;
  // Run-email sender; absent in unit contexts that never notify.
  mail?: NotifyMailEnv;
  // Flare Cloud hosted bit (env FLARE_CLOUD=1, threaded by seat-do);
  // absent = self-hosted, and run-terminal metering stays off.
  hosted?: boolean;
  // Raw SECRETS_KEY env passthrough; absent means D1-held data key.
  secretsKey?: string;
  // V2 start config (image/entrypoint/instance/snapshot), merged into
  // the boot start call. Absent on V1 (image comes from config).
  containerStart?: ContainerStartOptions;
  // AI Gateway id fronting triage inference (env-provided; D1 fills the
  // gap inside triageAndStore). Unset = direct inference.
  gatewayId?: string;
  // Triage model override (env-provided; D1 triage_model fills the gap
  // inside triageAndStore). Unset = default model.
  triageModel?: string;
  // Forces Web Search grounding for triage on (D1 decides when unset).
  webSearch?: boolean;
}

export type SeatOutcome =
  | { status: "completed"; jobId: string }
  | { status: "released"; jobId: string; detail: string }
  | { status: "skipped"; jobId: string; detail: string }
  | { status: "failed"; jobId: string; detail: string }
  | { status: "retained"; jobId: string; retainedUntil: string }
  | { status: "retrying"; jobId: string; detail: string };

export const SEAT_BLOB_CAP = 50 * 1024 * 1024;
// Terminal report caps, mirroring the BYO /status route (index.ts):
// D1 rows top out at 2MB, so both executors bound what they store.
export const SEAT_LOG_CAP = 262144;
export const SEAT_RESULT_CAP = 65536;
const STEP_OUTPUT_CAP = 32768;
export const WORKDIR = "/work";
// Zero-config conventional report locations, scanned alongside any
// explicit test-reports paths (mirrors runner-sdk DEFAULT_TEST_REPORT_PATHS).
const SEAT_TEST_DEFAULTS = ["junit.xml", "test-results.xml", "test-results/junit.xml", "reports/junit.xml"];
const SEAT_TEST_MAX_FILES = 10;
// Restore horizon shared with the worker (db.ts): idle past this, the
// platform TTL has reclaimed the snapshot server-side.
const SNAPSHOT_MAX_AGE_MS = SEAT_SNAPSHOT_MAX_AGE_MS;
// Retain-on-failure debug window: the seat DO alarm destroys the kept
// container at this deadline (grace while a session is active is a
// documented Phase 2 follow-up, not this change).
const RETAIN_TTL_MS = 30 * 60000;
// Smart test selection harvest: seat files live in the container, so the
// import graph is harvested through two bounded execs (a listing plus a
// candidate-line grep — the SDK parser does the real extraction). Vendor
// and build dirs are excluded on both sides of the pipe.
const SELECTION_FIND =
  "find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -not -path './build/*' -not -path './.flare/*' -not -path './coverage/*' | head -n 6000";
const SELECTION_INCLUDES =
  "--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.mjs' --include='*.cjs' --include='*.mts' --include='*.cts'";
const SELECTION_GREP =
  `grep -rE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.flare --exclude-dir=coverage ${SELECTION_INCLUDES} -e 'import|require\\(' . | head -c 1000000`;

// Per-job egress accounting. Three namespaces, all measured (never
// estimated): `r2:<area>` rows for the transfers the seat performs on
// the job's behalf (cache/artifacts/sources/test-reports), one
// `(interface)` row for the container NIC delta across the job, and
// bare-domain rows from the LD_PRELOAD shim when the image carries
// it (statically linked binaries bypass the shim, so the domain rows
// are a lower bound and the NIC row stays the cross-check total).
export interface EgressTally {
  host: string;
  reqBytes: number;
  respBytes: number;
}

export function egressHostForKey(key: string): string {
  const area = key.split("/")[0];
  return area === "cache" || area === "artifacts" || area === "sources" || area === "test-reports" ? `r2:${area}` : "r2:other";
}

// Minimal structural surface of the ARTIFACTS binding (runtime-free:
// tests inject fakes; seat-do.ts passes env.ARTIFACTS, which satisfies
// this shape structurally).
export interface SeatArtifactsRepoHandle {
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<{ plaintext: string } | string>;
  readonly [Symbol.dispose]?: () => void;
}

export interface SeatArtifactsNamespace {
  get(name: string): Promise<SeatArtifactsRepoHandle>;
}

// Artifacts mirror remote: the operator configures a template holding
// `{repo}` (e.g. `https://<acct>.artifacts.cloudflare.net/git/mirrors/{repo}.git`)
// and seats render it per job. Fail-closed: anything that is not
// exactly that shape (or a template without the placeholder) renders
// null and the job checks out from GitHub. The token is embedded as
// the password exactly like the GitHub App token below, and scrubbed
// from every error the same way.
export function renderMirrorRemote(template: string, repo: string, verbatim = false): string | null {
  if (!template.includes("{repo}")) return null;
  // GitHub repos collapse to one mirror segment (owner-name); Artifacts
  // runs keep namespace/name verbatim so the template
  // `.../git/{repo}.git` renders the real remote.
  const name = verbatim
    ? (() => {
        const parts = repo.split("/");
        if (parts.length !== 2 || !parts.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")) return null;
        return `${parts[0]}/${parts[1]}`;
      })()
    : repo.replace(/\//g, "-");
  if (name === null || !/^[\w./-]+$/.test(name)) return null;
  const url = template.split("{repo}").join(name);
  if (!/^https:\/\/[a-f0-9]{32}\.artifacts\.cloudflare\.net\/git\/[\w.-]+\/[\w.-]+\.git$/.test(url)) return null;
  return url;
}

// Direct Artifacts remote for tournament runs: derives the account host
// from the operator's mirror template (no second secret) and renders
// namespace/name verbatim. Reuses renderMirrorRemote's strict shape.
export function renderArtifactsRemote(mirrorTemplate: string, namespace: string, repo: string): string | null {
  const host = /^(https:\/\/[a-f0-9]{32}\.artifacts\.cloudflare\.net)\/git\//.exec(mirrorTemplate)?.[1];
  if (!host) return null;
  return renderMirrorRemote(`${host}/git/{repo}.git`, `${namespace}/${repo}`, true);
}

// Mirror template namespace (`.../git/{ns}/{repo}.git`), for the
// per-job token decision: only mirrors inside the binding namespace
// can use binding-minted tokens (tokens are repo-scoped and the
// binding is namespace-scoped).
export function mirrorNamespaceFor(template: string): string | null {
  const m = /^https:\/\/[a-f0-9]{32}\.artifacts\.cloudflare\.net\/git\/([\w.-]+)\/\{repo\}\.git$/.exec(template);
  return m?.[1] ?? null;
}

// Repo segment of a rendered mirror remote (already shape-checked by
// renderMirrorRemote): the name to mint the per-job token against.
export function mirrorRepoFor(rendered: string): string | null {
  const m = /\/git\/[\w.-]+\/([\w.-]+)\.git$/.exec(rendered);
  return m?.[1] ?? null;
}

// One-hour token for a single checkout (read) or mirror sync (write).
// Null on any failure.
async function mintCheckoutToken(
  artifacts: SeatArtifactsNamespace,
  repo: string,
  scope: "read" | "write" = "read",
): Promise<string | null> {
  let handle: SeatArtifactsRepoHandle | null = null;
  try {
    handle = await artifacts.get(repo);
    const out = await handle.createToken(scope, 3600);
    const plaintext = typeof out === "string" ? out : out.plaintext;
    return plaintext || null;
  } catch {
    return null;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail the checkout.
    }
  }
}

// Basic-auth password slot takes the token secret, not the full
// `secret?expires=` form (git would misparse the URL).
function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

// /proc/net/dev: `iface: rxBytes ... txBytes ...` (tx is the 9th field).
// Loopback excluded; unparseable input yields zeros, never throws.
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n")) {
    const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!m || m[1].trim() === "lo") continue;
    const fields = m[2].trim().split(/\s+/).map(Number);
    if (fields.length >= 9 && fields.every((n) => Number.isFinite(n))) {
      rx += fields[0];
      tx += fields[8];
    }
  }
  return { rx, tx };
}

// Constant-time seat token gate, shared by the seats worker fetch route.
// Digest-then-compare so the check never leaks prefix length.
export async function seatTokenAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ") || !token) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  return bytesEqual(new Uint8Array(a), new Uint8Array(b));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function safeRelPaths(paths: string[]): string[] | null {
  const out: string[] = [];
  for (const p of paths) {
    if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;
    out.push(p.replace(/^\.\//, ""));
  }
  return out.length > 0 ? out : null;
}

function sanitizeName(raw: string): string {
  const clean = raw
    .replace(/[^\w.-]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return clean || "artifact";
}

interface StepRecord {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

// Worker-side browser checks (BROWSER binding, Browser Rendering).
// Injected so unit tests never touch puppeteer; seat-do adapts the
// real binding. The driver returns the page title, visible text (the
// adapter caps it), and a PNG screenshot when asked.
export interface BrowserPageResult {
  title: string;
  text: string;
  screenshot: Uint8Array | null;
}

export interface BrowserDriver {
  check(
    url: string,
    opts: { screenshot: boolean; timeoutMs: number; actions: JobBrowserActionSpec[] },
  ): Promise<BrowserPageResult>;
}

export const BROWSER_CHECK_TIMEOUT_MS = 30000;

export async function runSeatJob(deps: SeatDeps, jobId: string): Promise<SeatOutcome> {
  const timing = deps.timing ?? DEFAULT_TIMING;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const job = await getJob(deps.db, jobId);
  if (!job) return { status: "skipped", jobId, detail: "job not found" };
  const run = await getRun(deps.db, job.run_id);
  if (!run) return { status: "skipped", jobId, detail: "run not found" };
  if (job.status !== "queued") return { status: "skipped", jobId, detail: `job ${job.status}` };
  if (!seatEligible(job.definition)) {
    return { status: "skipped", jobId, detail: "ineligible for seats" };
  }
  if (!(await claimJob(deps.db, jobId))) {
    return { status: "skipped", jobId, detail: "claim lost" };
  }
  // Corrupt or newer-format definition: fail closed. An echo-substitute
  // "success" would be a false green; claiming first means exactly one
  // executor records the error.
  const spec = parseJobSpec(job.definition);
  if (!spec) {
    await updateRunningJob(deps.db, jobId, {
      status: "error",
      log: "[seat] refusing to execute: job definition could not be parsed (corrupt or from a newer version)",
    });
    await rollupRunStatus(deps.db, job.run_id, deps.analytics, deps.basin, { hosted: deps.hosted === true });
    emitJobTerminal(deps.analytics, {
      repo: run.repo,
      runId: job.run_id,
      jobName: job.name,
      status: "error",
      durationMs: 0,
      executor: "seat",
      attempts: job.attempts,
    });
    if (deps.basin) {
      sendBasin(deps.basin, basinJobTerminal({
        repo: run.repo,
        runId: job.run_id,
        jobName: job.name,
        status: "error",
        durationMs: 0,
        executor: "seat",
        attempts: job.attempts,
      }));
    }
    return { status: "failed", jobId, detail: "unparseable job definition" };
  }
  // Repo secrets decrypt here (same key ladder as the main worker) and
  // interpolate executor-side, exactly like BYO runners.
  let secrets: Record<string, string> = {};
  let secretsError = false;
  try {
    secrets = await getDecryptedRepoSecrets(deps.db, deps.secretsKey, run.repo);
  } catch {
    secretsError = true;
  }
  const mask = (s: string): string => maskSecrets(s, secrets);
  const deadline = Date.now() + (spec.timeoutMinutes ?? 30) * 60000;
  const logParts: string[] = [`[seat] claimed ${job.name || jobId} (${run.repo}@${run.sha.slice(0, 7)})`];
  if (secretsError) {
    logParts.push("[seat] warning: repo secrets unavailable (decrypt failed), placeholders render empty");
  }
  const records: StepRecord[] = [];

  // Egress tally: every R2 transfer on the job's behalf is measured here
  // (uploads count as req bytes, downloads as resp bytes). The wrapper
  // delegates to the real store; a missing store means no transfers.
  const egress: EgressTally[] = [];
  const tally = (host: string, req: number, resp: number): void => {
    const row = egress.find((e) => e.host === host);
    if (row) {
      row.reqBytes += req;
      row.respBytes += resp;
    } else {
      egress.push({ host, reqBytes: req, respBytes: resp });
    }
  };
  const blob = deps.cache;
  const cache: SeatBlobStore | undefined = blob
    ? {
        get: async (key: string) => {
          const entry = await blob.get(key);
          if (entry) tally(egressHostForKey(key), 0, entry.size);
          return entry;
        },
        put: async (key: string, data: Uint8Array) => {
          tally(egressHostForKey(key), data.byteLength, 0);
          return blob.put(key, data);
        },
        // Listings are metadata-only and untallied (single bounded
        // call); the blob GET of the picked entry tallies above.
        list: (options: { prefix: string; limit: number }) => blob.list(options),
      }
    : undefined;

  // Mirror a line to the job row immediately (the terminal updateRunningJob later
  // replaces the log with the full story, so nothing duplicates).
  // Progress logging never breaks execution: a seat that cannot write
  // its log must still run the job. Every mirrored line is masked so
  // the live log never carries a secret, even briefly.
  const note = async (line: string): Promise<void> => {
    const masked = mask(line);
    logParts.push(masked);
    try {
      await appendJobLog(deps.db, jobId, `${masked}\n`);
    } catch {
      // Best effort.
    }
  };
  try {
    await appendJobLog(deps.db, jobId, `${logParts[0]}\n`);
  } catch {
    // Best effort.
  }
  // Seat invocations are warm boxes: tag the root span so a job's
  // container lifecycle is replayable from its run/job ids.
  await annotateSpan({ "flare.run.id": run.id, "flare.job.id": jobId, "flare.executor": "seat", repo: run.repo });

  // Release back to queued. Capacity releases (container never booted)
  // additionally re-queue a delayed wake so saturation never strands a
  // job with no BYO runners around; the run-age horizon bounds the loop.
  // Checkout/crash releases stay plain: a BYO runner may succeed where
  // the seat cannot, and blind retries would only churn.
  const release = async (detail: string, rewake = false): Promise<SeatOutcome> => {
    try {
      deps.container.destroy();
    } catch {
      // Never started or already gone.
    }
    if (rewake && deps.seatQueue) {
      const ageMs = Date.now() - Date.parse(run.created_at);
      if (Number.isFinite(ageMs) && ageMs < 30 * 60000) {
        await deps.seatQueue.send({ jobId }, { delaySeconds: 60 });
        detail = `${detail} (re-wake in 60s)`;
      }
    }
    // The reason lands in the job log (checkout details are already
    // token-scrubbed) so releases are self-diagnosing via the API.
    await note(`[seat] released: ${detail}`);
    await annotateSpan({ "seat.released": detail.slice(0, 120) });
    await releaseJob(deps.db, jobId);
    await rollupRunStatus(deps.db, job.run_id, deps.analytics, deps.basin, { hosted: deps.hosted === true });
    return { status: "released", jobId, detail };
  };

  // Armed once boot confirms the instance is up; every exec below
  // races it so an unexpected stop fails fast (exit 125) instead of
  // hanging to the step timeout. Never rejects (both arms resolve).
  let stopSignal: Promise<true> | null = null;
  const STOPPED = Symbol("container-stopped");

  async function execBounded(
    cmd: string[],
    opts: ExecOptions,
    timeoutMs: number,
  ): Promise<{ timedOut: boolean; exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      // The exec call itself is raced too: a wedged container must not
      // hang the seat past the timeout with no handle to kill.
      const call = deps.container.exec(cmd, opts);
      const proc = await Promise.race([call, timeout]);
      if (proc === null) {
        call.then(
          (h) => {
            try {
              h.kill();
            } catch {
              // Already exited.
            }
          },
          () => undefined,
        );
        return { timedOut: true, exitCode: 124, stdout: new Uint8Array(), stderr: new Uint8Array() };
      }
      const racers: Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array } | null | typeof STOPPED>[] = [
        proc.output(),
        timeout,
      ];
      if (stopSignal) racers.push(stopSignal.then(() => STOPPED, () => STOPPED));
      const out = await Promise.race(racers);
      if (out === STOPPED) {
        try {
          proc.kill();
        } catch {
          // Already exited.
        }
        return {
          timedOut: false,
          exitCode: 125,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("container stopped unexpectedly"),
        };
      }
      if (out === null) {
        try {
          proc.kill();
        } catch {
          // Already exited.
        }
        return { timedOut: true, exitCode: 124, stdout: new Uint8Array(), stderr: new Uint8Array() };
      }
      return { timedOut: false, ...out };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Small-file reads prefer Sandbox SDK Files (structured errors, no
  // shell quoting) with an exec-cat fallback for pre-shim images and
  // unit contexts without fs. Null when unreadable by either path.
  async function readContainerFile(path: string, maxBytes: number): Promise<Uint8Array | null> {
    if (deps.fs) {
      try {
        return await deps.fs.readFile(path, maxBytes);
      } catch {
        // Fall through to exec (PROTOCOL on old images, etc).
      }
    }
    const blob = await execBounded(["cat", path], {}, 30000);
    if (blob.timedOut || blob.exitCode !== 0) return null;
    return blob.stdout;
  }

  // JUnit discovery over Files: same guards as the exec scan (no
  // symlinks, *.xml only, (0, MAX_JUNIT_BYTES] bytes, WORKDIR-rooted,
  // SEAT_TEST_MAX_FILES cap) without a shell round-trip per path.
  // Missing paths skip; a PROTOCOL failure (pre-shim image) aborts so
  // the caller falls back to the exec scan wholesale.
  async function findJUnitViaFs(fs: SeatFiles, safe: string[]): Promise<string[]> {
    const rethrowProtocol = (err: unknown): void => {
      if (isSandboxFsError(err) && err.code === "PROTOCOL") throw err;
    };
    const found: string[] = [];
    for (const rel of [...new Set(safe)]) {
      if (found.length >= SEAT_TEST_MAX_FILES) break;
      const abs = `${WORKDIR}/${rel}`;
      let st;
      try {
        st = await fs.lstat(abs);
      } catch (err) {
        rethrowProtocol(err);
        continue;
      }
      if (st.type === "symlink") continue;
      if (st.type === "directory") {
        let entries;
        try {
          entries = await fs.readDirectory(abs);
        } catch (err) {
          rethrowProtocol(err);
          continue;
        }
        for (const e of entries) {
          if (found.length >= SEAT_TEST_MAX_FILES) break;
          if (e.type === "symlink" || !e.name.endsWith(".xml") || e.name.includes("/")) continue;
          const fp = `${abs}/${e.name}`;
          try {
            const fst = await fs.lstat(fp);
            if (fst.type !== "file" || fst.size <= 0 || fst.size > MAX_JUNIT_BYTES) continue;
          } catch (err) {
            rethrowProtocol(err);
            continue;
          }
          found.push(fp);
        }
      } else if (st.type === "file" && abs.endsWith(".xml") && st.size > 0 && st.size <= MAX_JUNIT_BYTES) {
        found.push(abs);
      }
    }
    return found;
  }

  // Bounded snapshot: a hung snapshotContainer must not hold the seat
  // past its usefulness. Errors propagate (the caller logs); a timeout
  // resolves null.
  async function snapshotBounded(name: string, timeoutMs: number): Promise<ContainerSnapshot | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([deps.container.snapshot(name), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Container NIC counters for the (interface) egress row. Null when the
  // container hides /proc — the R2 rows still stand on their own.
  async function sampleIface(): Promise<{ rx: number; tx: number } | null> {
    try {
      const r = await execBounded(["cat", "/proc/net/dev"], {}, 15000);
      if (!r.timedOut && r.exitCode === 0) return parseNetDev(decode(r.stdout));
    } catch {
      // Best effort.
    }
    return null;
  }

  // Snapshot restore pre-pass (V2 only — the image ref comes from the
  // DO adapter, and V1's policy cannot create snapshots). Keyed by image
  // lineage, so a changed seat image never restores a stale filesystem.
  // One attempt only: a degraded snapshot must never cost more than one
  // boot window (a miss beats a ten-minute fetch). Restored state is warm
  // deps/toolchains only — checkout below still resets the workdir to the
  // job's sha, so a restore can never run the wrong code.
  const v2Image = deps.containerStart?.image;
  let started = false;
  let restored = false;
  if (v2Image && !deps.containerStart?.snapshotId && !run.source) {
    try {
      const row = await getSeatSnapshot(deps.db, v2Image, run.repo);
      if (row && Date.now() - Date.parse(row.last_used_at) < SNAPSHOT_MAX_AGE_MS && !deps.container.running) {
        try {
          await deps.container.start({ enableInternet: true, snapshotId: row.snapshot_id });
        } catch (err) {
          await note(`[seat] snapshot start error: ${String(err).slice(0, 200)}`);
        }
        const restoreUntil = Date.now() + timing.startWaitMs;
        while (Date.now() < restoreUntil && !started) {
          try {
            started = deps.container.running;
          } catch {
            started = false;
          }
          if (!started) await sleep(timing.startPollMs);
        }
        if (started) {
          restored = true;
          try {
            await touchSeatSnapshot(deps.db, v2Image, run.repo);
          } catch {
            // Best effort.
          }
          await note(`[seat] snapshot restored (${row.snapshot_id.slice(0, 12)}…)`);
          await annotateSpan({ "seat.snapshot.restored": true });
        } else {
          try {
            await deleteSeatSnapshot(deps.db, v2Image, run.repo);
          } catch {
            // Best effort.
          }
          await note("[seat] snapshot degraded, deleted; fresh boot");
          await annotateSpan({ "seat.snapshot.degraded": true });
        }
      }
    } catch {
      // Snapshot lookup never blocks a boot.
    }
  }

  // Boot (bounded retries for cold starts and capacity). Both start()
  // and the running probe are throw-tolerant: a transient control-plane
  // error must not abort the window while the container may still boot.
  let startAttempt = 0;
  for (let attempt = 1; attempt <= timing.startAttempts && !started; attempt++) {
    startAttempt = attempt;
    try {
      // Seats must reach github.com (checkout) and pypi/npm mirrors;
      // containers boot offline unless internet is enabled.
      if (!deps.container.running) await deps.container.start({ enableInternet: true, ...deps.containerStart });
    } catch (err) {
      await note(`[seat] start attempt ${attempt} error: ${String(err).slice(0, 200)}`);
    }
    const bootUntil = Date.now() + timing.startWaitMs;
    while (Date.now() < bootUntil) {
      let up = false;
      try {
        up = deps.container.running;
      } catch {
        // Getter threw — the container is still down.
      }
      if (up) {
        started = true;
        break;
      }
      await sleep(timing.startPollMs);
    }
    if (!started) await note(`[seat] start attempt ${attempt} timed out`);
  }
  if (!started) return release("container did not start", true);
  if (!restored) await note(`[seat] container running (attempt ${startAttempt})`);
  // Pending-I/O keep-alive + unexpected-stop detection (see ContainerCtl.monitor).
  try {
    stopSignal = deps.container.monitor().then(
      () => true as const,
      () => true as const,
    );
  } catch {
    // A monitor that throws synchronously degrades to no watcher;
    // exec timeouts still bound every call.
    stopSignal = null;
  }
  const ifaceStart = await sampleIface();

  try {
    if (run.source) {
      // Source dispatch: unpack the uploaded working tree (guarded —
      // list first, reject absolute/.. members, then extract).
      const entry = cache ? await cache.get(`sources/${run.source}`) : null;
      if (!entry) return release("source tarball missing (expired, or artifact storage not configured)");
      if (entry.size > SEAT_BLOB_CAP) return release(`source tarball too large (>${SEAT_BLOB_CAP}b)`);
      const blob = new Uint8Array(await entry.arrayBuffer());
      const reset = await execBounded(["sh", "-c", `rm -rf ${WORKDIR} && mkdir -p ${WORKDIR}`], {}, 30000);
      if (reset.timedOut || reset.exitCode !== 0) return release("workspace reset failed");
      const listing = await execBounded(["tar", "-tzf", "-"], { stdin: blob }, timing.blobMs);
      if (listing.timedOut) return release("source listing timed out");
      const bad = decode(listing.stdout)
        .split("\n")
        .map((n) => n.trim())
        .find((n) => n && unsafeTarMember(n));
      if (bad) return release(`unsafe source member: ${bad.slice(0, 120)}`);
      const extracted = await execBounded(["tar", "-xzf", "-", "-C", WORKDIR], { stdin: blob }, timing.blobMs);
      if (extracted.timedOut || extracted.exitCode !== 0) return release("source extract failed");
      await note("[seat] source unpacked");
    } else {
      // Checkout (script over stdin so the token never appears in argv).
      if (!/^[\w.-]+\/[\w.-]+$/.test(run.repo) || !/^[\w.-]+$/.test(run.sha)) {
        return release("invalid repo or sha");
      }
      const isArtifactsRun = run.event === ARTIFACTS_EVENT;
      // Tournament forks are dynamic and tokens repo-scoped: mint a
      // one-hour read token for this checkout only (memory-only).
      let artifactsToken: string | null = null;
      if (isArtifactsRun && deps.artifacts) {
        artifactsToken = await mintCheckoutToken(deps.artifacts, run.repo.slice(run.repo.indexOf("/") + 1));
      }
      // Per-job mirror tokens (assigned in the mirror branch below;
      // declared here so the scrubber closes over them).
      let mirrorMinted: string | null = null;
      let mirrorWriteMinted: string | null = null;
      let appToken: string | null = null;
      if (run.installation_id && deps.appId && deps.appKey) {
        try {
          const jwt = await mintAppJwt(deps.appId, deps.appKey);
          appToken = await getInstallationToken(jwt, run.installation_id);
        } catch {
          appToken = null;
        }
      }
      const scrubTokens = (s: string): string => {
        let out = s;
        // Mirror tokens carry `?expires=` and are URL-encoded in the
        // remote, so scrub both the raw and encoded forms — git echoes
        // the URL as embedded.
        const artSecret = artifactsToken ? tokenSecret(artifactsToken) : null;
        const mirrorSecret = mirrorMinted ? tokenSecret(mirrorMinted) : null;
        const mirrorWriteSecret = mirrorWriteMinted ? tokenSecret(mirrorWriteMinted) : null;
        const forms = [
          appToken,
          deps.mirrorToken,
          deps.mirrorToken ? encodeURIComponent(deps.mirrorToken) : null,
          artifactsToken,
          artSecret,
          artSecret ? encodeURIComponent(artSecret) : null,
          mirrorMinted,
          mirrorSecret,
          mirrorSecret ? encodeURIComponent(mirrorSecret) : null,
          mirrorWriteMinted,
          mirrorWriteSecret,
          mirrorWriteSecret ? encodeURIComponent(mirrorWriteSecret) : null,
        ];
        for (const t of forms) {
          if (t) out = out.split(t).join("[redacted]");
        }
        return out;
      };
      const checkoutVia = async (remote: string): Promise<string | null> => {
        const script = `set -e\nrm -rf ${WORKDIR}\nmkdir -p ${WORKDIR}\ncd ${WORKDIR}\ngit init -q\ngit remote add origin ${remote}\ngit fetch -q --depth 1 origin ${run.sha}\ngit checkout -q FETCH_HEAD\n`;
        const co = await execBounded(["sh", "-s"], { stdin: script }, timing.checkoutMs ?? 180000);
        if (!co.timedOut && co.exitCode === 0) return null;
        const raw = decode(co.timedOut ? co.stderr : new Uint8Array([...co.stdout, ...co.stderr])).slice(0, 300);
        // git errors can echo the remote URL — scrub every token (the
        // release detail lands in the job log, so this must be total).
        return scrubTokens(raw) || "unknown";
      };
      // Artifacts runs check out from the fork directly and fail closed:
      // there is no GitHub repo to fall back to.
      if (isArtifactsRun) {
        const slash = run.repo.indexOf("/");
        const remote =
          deps.mirrorRemote && slash > 0
            ? renderArtifactsRemote(deps.mirrorRemote, run.repo.slice(0, slash), run.repo.slice(slash + 1))
            : null;
        if (!remote) return release("artifacts checkout unavailable (no remote template)");
        if (!artifactsToken) return release("artifacts checkout unavailable (token mint failed)");
        const err = await checkoutVia(
          `https://x:${encodeURIComponent(tokenSecret(artifactsToken))}@${remote.slice("https://".length)}`,
        );
        if (err !== null) return release(`checkout failed (artifacts: ${err})`.slice(0, 400));
        await note("[seat] checkout ok (artifacts)");
      }
      if (!isArtifactsRun) {
        // Mirror first when configured: the mirror failing (stale,
        // missing repo, expired token) must never fail a checkout
        // GitHub could serve, so any mirror error falls through.
        const mirrorTemplate = deps.mirrorRemote;
        const mirror = mirrorTemplate ? renderMirrorRemote(mirrorTemplate, run.repo) : null;
        // Per-job token when the mirror lives in the binding
        // namespace; otherwise the shared operator token. A failed
        // mint falls back to the shared token (or GitHub-only).
        let mirrorToken: string | null = deps.mirrorToken ?? null;
        // Set when the mirror lives in the binding namespace: read AND
        // write mints both need it.
        let mirrorRepoName: string | null = null;
        if (mirror && mirrorTemplate && deps.artifacts && deps.artifactsNamespace) {
          if (mirrorNamespaceFor(mirrorTemplate) === deps.artifactsNamespace) {
            mirrorRepoName = mirrorRepoFor(mirror);
            if (mirrorRepoName) {
              mirrorMinted = await mintCheckoutToken(deps.artifacts, mirrorRepoName);
              if (mirrorMinted) mirrorToken = tokenSecret(mirrorMinted);
            }
          }
        }
        // Lazy mirror sync: the mirror is a cache and this sha missed
        // it — fetch the sha from GitHub and push it to the mirror's
        // rolling branch so the NEXT checkout hits. Same-namespace
        // only (write mints need the binding), one attempt, and every
        // failure falls through to GitHub: sync must never fail a
        // checkout. The force-push is safe (Flare owns the mirror) and
        // a lost push race just means the loser uses GitHub this time.
        const syncMirrorSha = async (): Promise<string | null> => {
          if (!mirror || !mirrorRepoName || !deps.artifacts) return "no same-namespace mirror";
          mirrorWriteMinted = await mintCheckoutToken(deps.artifacts, mirrorRepoName, "write");
          if (!mirrorWriteMinted) return "write token mint failed";
          const ghRemote = appToken
            ? `https://x-access-token:${appToken}@github.com/${run.repo}.git`
            : `https://github.com/${run.repo}.git`;
          const pushRemote = `https://x-access-token:${encodeURIComponent(tokenSecret(mirrorWriteMinted))}@${mirror.slice("https://".length)}`;
          const script =
            `set -e\ncd ${WORKDIR}\n` +
            `git remote add github-sync ${ghRemote} 2>/dev/null || git remote set-url github-sync ${ghRemote}\n` +
            `git fetch -q --depth 1 github-sync ${run.sha}\n` +
            `git push -q ${pushRemote} +FETCH_HEAD:refs/heads/flare-mirror\n`;
          const res = await execBounded(["sh", "-s"], { stdin: script }, timing.checkoutMs ?? 180000);
          if (!res.timedOut && res.exitCode === 0) return null;
          const raw = decode(res.timedOut ? res.stderr : new Uint8Array([...res.stdout, ...res.stderr])).slice(0, 200);
          return scrubTokens(raw) || "unknown";
        };
        if (mirror && mirrorToken) {
          const mirrorRemoteUrl = `https://x-access-token:${encodeURIComponent(mirrorToken)}@${mirror.slice("https://".length)}`;
          const mirrorErr = await checkoutVia(mirrorRemoteUrl);
          if (mirrorErr === null) {
            await note("[seat] checkout ok (mirror)");
          } else {
            const syncErr = await syncMirrorSha();
            const retryErr = syncErr === null ? await checkoutVia(mirrorRemoteUrl) : null;
            if (syncErr === null && retryErr === null) {
              await note("[seat] checkout ok (mirror, synced)");
            } else {
              if (syncErr === null) await note("[seat] mirror sync pushed but checkout still missed, trying github");
              else if (mirrorRepoName) await note(`[seat] mirror sync failed (${syncErr}), trying github`);
              else await note("[seat] mirror unavailable, trying github");
              const remote = appToken
                ? `https://x-access-token:${appToken}@github.com/${run.repo}.git`
                : `https://github.com/${run.repo}.git`;
              const err = await checkoutVia(remote);
              if (err !== null) return release(`checkout failed (mirror: ${mirrorErr}; github: ${err})`.slice(0, 400));
              await note("[seat] checkout ok");
            }
          }
        } else {
          const remote = appToken
            ? `https://x-access-token:${appToken}@github.com/${run.repo}.git`
            : `https://github.com/${run.repo}.git`;
          const err = await checkoutVia(remote);
          if (err !== null) return release(`checkout failed: ${err}`);
          await note("[seat] checkout ok");
        }
      }
    }

    // Smart test selection: same contract as BYO runners — the seat
    // owns the safety-net call and the failure history (worker modules),
    // harvests the import graph through container execs, sets
    // FLARE_SELECTED_TESTS for the steps, and saves the skip report.
    // Every failure mode runs the full suite, never a partial guess.
    let selectionMode = "off";
    let selectedTests = "";
    if (spec.testSelection) {
      const changedFiles = (run.changed_files ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const decision = decideSelectionMode(
        spec.testSelection,
        { event: run.event, branch: run.branch ?? "", profile: run.profile ?? null, changedFiles },
      );
      if (decision.mode !== "select") {
        selectionMode = "full";
        await saveTestSelection(deps.db, {
          jobId,
          runId: run.id,
          mode: "full",
          reason: decision.reason,
          selected: [],
          skipped: [],
        }).catch(() => undefined);
        await note(`[seat] test selection: full suite — ${decision.reason}`.slice(0, 500));
      } else {
        try {
          const listing = await execBounded(["sh", "-c", SELECTION_FIND], { cwd: WORKDIR }, 30000);
          const allFiles = listing.timedOut
            ? []
            : decode(listing.stdout)
              .split("\n")
              .map((n) => n.trim().replace(/^\.\//, ""))
              .filter(Boolean)
              .slice(0, 5000);
          const grepped = await execBounded(["sh", "-c", SELECTION_GREP], { cwd: WORKDIR }, 60000);
          const contents = grepped.timedOut ? new Map<string, string>() : groupGrepLines(decode(grepped.stdout));
          const failures = await recentlyFailedTests(
            deps.db,
            run.repo,
            spec.testSelection.historyDays ?? DEFAULT_HISTORY_DAYS,
          ).catch(() => []);
          const result = selectTests({
            allFiles,
            contents,
            changed: changedFiles,
            failures,
            ...(spec.testSelection.tests ? { testPatterns: spec.testSelection.tests } : {}),
          });
          selectionMode = result.mode;
          if (result.mode === "select") {
            selectedTests = result.selected.join("\n");
            await saveTestSelection(deps.db, {
              jobId,
              runId: run.id,
              mode: "select",
              reason: result.reason,
              selected: result.selected,
              skipped: result.skipped,
            }).catch(() => undefined);
            await note(`[seat] test selection: ${result.reason}`.slice(0, 500));
          } else {
            await saveTestSelection(deps.db, {
              jobId,
              runId: run.id,
              mode: "full",
              reason: result.reason,
              selected: [],
              skipped: [],
            }).catch(() => undefined);
            await note(`[seat] test selection: full suite — ${result.reason}`.slice(0, 500));
          }
        } catch {
          selectionMode = "full";
          await saveTestSelection(deps.db, {
            jobId,
            runId: run.id,
            mode: "full",
            reason: "selection failed, ran everything",
            selected: [],
            skipped: [],
          }).catch(() => undefined);
          await note("[seat] test selection failed, ran everything");
        }
      }
    }

    // Cache restore.
    let cacheHit = false;
    if (spec.cache) {
      let matched = spec.cache.key;
      let viaRestoreKey: string | undefined;
      let entry = cache ? await cache.get(cacheObjectKey(spec.cache.key)) : null;
      // Exact miss: same prefix walk as the /v1/cache lane, newest
      // entry under each prefix. The listing runs on the raw bucket
      // (metadata only, untallied); the blob GET below still tallies.
      if (!entry && deps.cache) {
        for (const prefix of spec.cache.restoreKeys ?? []) {
          const listed = await deps.cache.list({ prefix: cacheObjectKey(prefix), limit: 1000 });
          const hit = pickNewestCacheHit(listed.objects);
          if (hit && cache) {
            matched = hit;
            viaRestoreKey = prefix;
            entry = await cache.get(cacheObjectKey(hit));
            if (entry) break;
            matched = spec.cache.key;
            viaRestoreKey = undefined;
          }
        }
      }
      // Same daily-aggregate counters the /v1/cache lane feeds (a found
      // blob is a hit even when the extract later fails); best-effort
      // so a stats write never fails a job.
      await recordCacheOutcome(deps.db, spec.cache.key, entry !== null).catch(() => undefined);
      if (!entry) {
        logParts.push(`[seat] cache miss: ${spec.cache.key}`);
      } else if (entry.size > SEAT_BLOB_CAP) {
        logParts.push(`[seat] cache skipped (>${SEAT_BLOB_CAP}b)`);
      } else {
        const blob = new Uint8Array(await entry.arrayBuffer());
        const r = await execBounded(["tar", "-xzf", "-", "-C", WORKDIR], { stdin: blob }, timing.blobMs);
        cacheHit = !r.timedOut && r.exitCode === 0;
        if (!cacheHit) logParts.push("[seat] cache extract failed");
        else if (viaRestoreKey) logParts.push(`[seat] cache hit: ${matched} (restore-key ${viaRestoreKey})`);
        else logParts.push(`[seat] cache hit: ${matched}`);
      }
    }

    // Steps (each writes to a file; only a bounded tail crosses).
    const jobEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env ?? {})) jobEnv[k] = interpolateSecrets(v, secrets);
    // Settled needs: same builder the BYO claim uses (one D1 read),
    // curated into step env plus `if:` context. A failed read fails
    // open to empty (refs resolve "" — same as missing needs).
    const needsCtx = await readNeedsContext(deps.db, job.run_id, readJobSpec(job.definition, job.name).needs).catch(() => ({
      needs: {},
      truncated: false,
      warnings: [] as string[],
    }));
    const builtNeeds = buildNeedsEnv(needsCtx.needs);
    for (const w of needsCtx.warnings) logParts.push(`[needs] ${w}`);
    if (needsCtx.truncated) logParts.push("[needs] outputs truncated to 64KB");
    for (const s of builtNeeds.skipped) logParts.push(`[needs] env skipped (name collision): ${s}`);
    const stepEnv: Record<string, string> = {
      // Same curated keys as BYO runners and `cli local` (runner-sdk
      // parity.ts); job env may still override (notably CI).
      ...buildFlareEnv({
        repo: run.repo,
        sha: run.sha,
        runId: run.id,
        jobId: job.id,
        ref: run.branch ?? "",
        changedFiles: run.changed_files ?? "",
        selectionMode,
        selectedTests,
      }),
      ...builtNeeds.env,
      ...jobEnv,
      ...matrixEnv(spec.matrix),
    };
    // Per-domain egress: when the image carries the LD_PRELOAD shim,
    // step processes append their own traffic tally to a
    // container-side log, collected after the steps loop. Older
    // images fail the probe and run exactly as before, no rows. A
    // job-supplied LD_PRELOAD chains after ours (space-separated is
    // valid) rather than being clobbered.
    let shimEgress = false;
    try {
      const probe = await execBounded(["test", "-x", EGRESS_SHIM_PATH], {}, 15000);
      shimEgress = !probe.timedOut && probe.exitCode === 0;
    } catch {
      shimEgress = false;
    }
    if (shimEgress) {
      const prev = stepEnv["LD_PRELOAD"];
      stepEnv["LD_PRELOAD"] = prev ? `${EGRESS_SHIM_PATH} ${prev}` : EGRESS_SHIM_PATH;
      stepEnv["FLARE_EGRESS_LOG"] = EGRESS_LOG_PATH;
      // A snapshot-restored container carries the previous job's log
      // at this fixed path — remove it so domain rows never leak
      // across jobs (staging canary-01 proved the leak).
      try {
        await execBounded(["rm", "-f", EGRESS_LOG_PATH], {}, 15000);
      } catch {
        // Best effort: worst case the parser reads stale rows, which
        // the NIC cross-check still bounds.
      }
    }
    // Outbound allowlist: the shim enforces it at connect() time
    // (exact + subdomains pass, loopback always passes, unknown IPs
    // fail closed). No shim — or an observe-only shim predating
    // enforcement — fails closed rather than running unconfined.
    if (spec.egress && spec.egress.allow.length > 0) {
      if (!shimEgress) return release("egress allowlist needs the shim-carrying seat image");
      let enforcing = false;
      try {
        const cap = await execBounded(["sh", "-c", `grep -qa FLARE_EGRESS_ALLOW ${EGRESS_SHIM_PATH}`], {}, 15000);
        enforcing = !cap.timedOut && cap.exitCode === 0;
      } catch {
        enforcing = false;
      }
      if (!enforcing) return release("egress allowlist needs the enforcing shim image (this image predates it)");
      stepEnv["FLARE_EGRESS_ALLOW"] = spec.egress.allow.join(",");
      logParts.push(`[seat] egress allowlist: ${spec.egress.allow.length} domains`);
    }
    let timedOutJob = false;
    let anyFailed = false;
    let jobFailed = false;
    // Collected $FLARE_OUTPUT values by step id (`step<N>` fallback).
    const stepOutputs: Record<string, Record<string, string>> = {};
    const collectStepOutputs = async (index: number, label: string): Promise<void> => {
      // Killed steps still publish what they wrote before dying; a
      // missing file means the step published nothing.
      const bytes = await readContainerFile(`/tmp/flare-output-${index}`, 65536);
      if (!bytes) return;
      const parsed = parseStepOutputs(decode(bytes));
      if (Object.keys(parsed.outputs).length > 0) {
        stepOutputs[label] = parsed.outputs;
        logParts.push(mask(`[outputs] step ${label}: ${formatOutputsLine(parsed.outputs)}`));
      }
      if (parsed.truncated.length > 0 || parsed.ignored > 0) {
        logParts.push(
          mask(
            `[outputs] step ${label}: ${parsed.truncated.length > 0 ? `truncated values: ${parsed.truncated.join(", ")}; ` : ""}ignored lines: ${parsed.ignored}`,
          ),
        );
      }
    };
    for (let i = 0; i < spec.steps.length; i++) {
      if (Date.now() > deadline) {
        timedOutJob = true;
        logParts.push("[seat] job timeout exceeded");
        break;
      }
      const step = spec.steps[i];
      if (!stepRuns(step.if, { anyFailed, jobFailed }, { needs: needsCtx.needs, steps: stepOutputs })) {
        logParts.push(`--- step ${i + 1}: skipped (${step.if}) ---`);
        continue;
      }
      const command = interpolateSecrets(step.run, secrets);
      await note(`[seat] step ${i + 1} start: ${command}`);
      const startedAt = Date.now();
      const shell = step.shell ?? "sh";
      const stepTimeout = step.timeoutMinutes !== undefined ? step.timeoutMinutes * 60000 : timing.stepMs;
      const outFile = `/tmp/flare-output-${i}`;
      const r = await execBounded(
        ["sh", "-c", `${shell} -s > /tmp/step.log 2>&1; printf 'EXIT:%d' $?`],
        { stdin: command, env: { ...stepEnv, FLARE_OUTPUT: outFile, GITHUB_OUTPUT: outFile }, cwd: WORKDIR },
        stepTimeout,
      );
      const durationMs = Date.now() - startedAt;
      const label = step.id ?? `step${i + 1}`;
      if (r.timedOut) {
        records.push({ command: mask(command), exitCode: 124, durationMs, output: "[seat] step timed out after 10m" });
        logParts.push(mask(`--- step ${i + 1}: ${command} ---\n[seat] step timed out after 10m\n(exit 124, ${durationMs}ms)`));
        await collectStepOutputs(i, label);
        anyFailed = true;
        if (step.continueOnError) {
          logParts.push(`--- step ${i + 1} failed but continue-on-error is set ---`);
          continue;
        }
        jobFailed = true;
        continue;
      }
      if (!r.timedOut && r.exitCode === 125) {
        // The stop watcher won the exec race: the instance is gone, so
        // there is no step log to tail — say so explicitly.
        records.push({ command: mask(command), exitCode: 125, durationMs, output: "[seat] container stopped unexpectedly" });
        logParts.push(mask(`--- step ${i + 1}: ${command} ---\n[seat] container stopped unexpectedly\n(exit 125, ${durationMs}ms)`));
        anyFailed = true;
        jobFailed = true;
        continue;
      }
      const m = /EXIT:(\d+)\s*$/.exec(decode(r.stdout));
      const exitCode = m ? Number(m[1]) : r.exitCode;
      const tail = await execBounded(["tail", "-c", String(STEP_OUTPUT_CAP), "/tmp/step.log"], {}, 30000);
      const output = tail.timedOut ? "" : mask(decode(tail.stdout).trimEnd());
      records.push({ command: mask(command), exitCode, durationMs, output });
      logParts.push(mask(`--- step ${i + 1}: ${command} ---\n${output}\n(exit ${exitCode}, ${durationMs}ms)`));
      await collectStepOutputs(i, label);
      if (exitCode !== 0) {
        anyFailed = true;
        if (step.continueOnError) {
          logParts.push(`--- step ${i + 1} failed but continue-on-error is set ---`);
          continue;
        }
        jobFailed = true;
      }
    }
    // Job outputs resolve from collected step outputs (missing refs
    // stay absent — a typo must not publish an empty value).
    const resolvedOutputs = resolveJobOutputs(spec.outputs ?? {}, stepOutputs);
    if (spec.outputs) {
      if (Object.keys(resolvedOutputs.outputs).length > 0) {
        logParts.push(mask(`[outputs] job: ${formatOutputsLine(resolvedOutputs.outputs)}`));
      }
      for (const name of resolvedOutputs.missing) {
        logParts.push(mask(`[outputs] missing: ${name} (${spec.outputs[name]} not emitted)`));
      }
    }
    // Shim-log collection: the rows tally at terminal accounting
    // below, next to the (interface) row they detail. Retried
    // attempts return before that save, so only the final attempt
    // lands in job_egress — same as the NIC row.
    let domainEgress: EgressTally[] = [];
    if (shimEgress) {
      try {
        const bytes = await readContainerFile(EGRESS_LOG_PATH, SEAT_LOG_CAP);
        if (bytes) {
          const raw = decode(bytes);
          domainEgress = parseEgressLog(raw);
          if (domainEgress.length > 0) {
            const top = domainEgress
              .slice(0, 3)
              .map((d) => `${d.host} ↓${d.respBytes}b`)
              .join(", ");
            logParts.push(`[seat] domain egress: ${domainEgress.length} domains (top: ${top})`);
          }
          const denials = countBlockedConnects(raw);
          if (denials.blocked > 0) {
            logParts.push(`[seat] egress blocked ${denials.blocked} connects (${denials.sample.join(", ")})`);
          }
        }
      } catch {
        // A missing log (shim never loaded) is not a job failure.
      }
    }
    // Browser checks (seats-only): declarative load+assert checks run
    // worker-side after successful steps. Each check lands in records
    // like a step, so digests and triage see failures; screenshots
    // upload as artifacts for debugging. Any failure fails the job.
    if (spec.browserChecks && spec.browserChecks.length > 0) {
      if (timedOutJob || jobFailed || records.length === 0) {
        logParts.push("[seat] browser checks skipped (steps did not succeed)");
      } else if (!deps.browser) {
        const msg = "[seat] browser checks need the BROWSER binding (Browser Rendering not configured on this seats worker)";
        records.push({ command: "browser checks", exitCode: 1, durationMs: 0, output: msg });
        logParts.push(mask(`--- browser checks ---\n${msg}\n(exit 1, 0ms)`));
        anyFailed = true;
        jobFailed = true;
      } else {
        const recordCheckFailure = (name: string, url: string, startedAt: number, message: string): void => {
          const durationMs = Date.now() - startedAt;
          const msg = `browser error: ${message.slice(0, 300)}`;
          records.push({ command: `browser ${name}`, exitCode: 1, durationMs, output: mask(msg) });
          logParts.push(mask(`--- browser ${name}: ${url} ---\n${msg}\n(exit 1, ${durationMs}ms)`));
          anyFailed = true;
          jobFailed = true;
        };
        for (const check of spec.browserChecks) {
          const startedAt = Date.now();
          // Preview-URL templates resolve from the run row, then repo
          // secrets interpolate (values never scanned), then the URL
          // re-validates https-only like parse time.
          const resolved = resolveCheckUrl(
            check.url,
            { branch: run.branch ?? "", prNumber: run.pr_number ?? null, sha: run.sha },
            secrets,
          );
          if ("error" in resolved) {
            recordCheckFailure(check.name, check.url, startedAt, resolved.error);
            continue;
          }
          const finalUrl = resolved.url;
          const actions: JobBrowserActionSpec[] = (check.actions ?? []).map((a) => ({
            kind: a.kind,
            ...(a.selector !== undefined ? { selector: interpolateSecrets(a.selector, secrets) } : {}),
            ...(a.text !== undefined ? { text: interpolateSecrets(a.text, secrets) } : {}),
          }));
          // Masked: URLs and selectors may carry interpolated secrets.
          await note(`[seat] browser check start: ${check.name} ${mask(finalUrl)}`);
          try {
            const page = await deps.browser.check(finalUrl, {
              screenshot: check.screenshot !== false,
              timeoutMs: BROWSER_CHECK_TIMEOUT_MS,
              actions,
            });
            const durationMs = Date.now() - startedAt;
            const titleOk = check.expectTitle === undefined || page.title.includes(check.expectTitle);
            const textOk = check.expectText === undefined || page.text.includes(check.expectText);
            const failed = !titleOk
              ? `title ${JSON.stringify(page.title.slice(0, 120))} missing ${JSON.stringify(check.expectTitle)}`
              : !textOk
                ? `page text missing ${JSON.stringify(check.expectText)} (got ${JSON.stringify(page.text.slice(0, 200))})`
                : "";
            if (page.screenshot && page.screenshot.byteLength > 0) {
              if (page.screenshot.byteLength > SEAT_BLOB_CAP) {
                logParts.push(`[seat] browser screenshot skipped (>${SEAT_BLOB_CAP}b)`);
              } else if (cache) {
                const shotName = `browser-${check.name}.png`;
                await cache.put(`artifacts/${jobId}/${shotName}`, page.screenshot);
                logParts.push(`[seat] browser screenshot: ${shotName} (${page.screenshot.byteLength}b)`);
              }
            }
            const output = failed || `title ${JSON.stringify(page.title.slice(0, 120))} ok`;
            records.push({ command: `browser ${check.name}`, exitCode: failed ? 1 : 0, durationMs, output: mask(output) });
            logParts.push(mask(`--- browser ${check.name}: ${finalUrl} ---\n${output}\n(exit ${failed ? 1 : 0}, ${durationMs}ms)`));
            if (failed) {
              anyFailed = true;
              jobFailed = true;
            }
          } catch (err) {
            recordCheckFailure(check.name, finalUrl, startedAt, String(err instanceof Error ? err.message : err));
          }
        }
      }
    }
    const success = !timedOutJob && records.length > 0 && !jobFailed;

    // Retry policy: requeue instead of going terminal while attempts
    // remain (the job row is still `running`, so the conditional
    // release in maybeRetryJob is race-safe).
    if (!success) {
      const retried = await maybeRetryJob(deps.db, deps.queue, jobId, (p) => deps.spawn?.(p.jobId));
      if (retried) {
        try {
          deps.container.destroy();
        } catch {
          // Never started or already gone.
        }
        return { status: "retrying", jobId, detail: "requeued for another attempt" };
      }
    }

    // Cache save (success only, bounded).
    if (spec.cache && success && cache) {
      const safe = safeRelPaths(spec.cache.paths);
      if (!safe) {
        logParts.push("[seat] cache save skipped (unsafe paths)");
      } else {
        const made = await execBounded(["tar", "-czf", "/tmp/cache.tgz", "-C", WORKDIR, ...safe], {}, timing.blobMs);
        if (!made.timedOut && made.exitCode === 0) {
          const sized = await execBounded(["stat", "-c%s", "/tmp/cache.tgz"], {}, 30000);
          const bytes = Number(decode(sized.stdout).trim());
          if (Number.isFinite(bytes) && bytes <= SEAT_BLOB_CAP) {
            const blob = await execBounded(["cat", "/tmp/cache.tgz"], {}, timing.blobMs);
            if (!blob.timedOut && blob.exitCode === 0) {
              await cache.put(cacheObjectKey(spec.cache.key), blob.stdout);
              logParts.push(`[seat] cache saved ${spec.cache.key} (${blob.stdout.byteLength}b)`);
            }
          } else {
            logParts.push("[seat] cache save skipped (too large)");
          }
        }
      }
    }

    // Artifacts (single file raw, otherwise one tarball).
    const uploaded: string[] = [];
    if (spec.artifacts) {
      const safe = safeRelPaths(spec.artifacts.paths);
      if (!safe) {
        logParts.push("[seat] artifacts skipped (unsafe paths)");
      } else if (cache) {
        try {
          if (safe.length === 1 && !spec.artifacts.name) {
            const isFile = await execBounded(["sh", "-c", `test -f ${JSON.stringify(`${WORKDIR}/${safe[0]}`)}`], {}, 30000);
            if (!isFile.timedOut && isFile.exitCode === 0) {
              const sized = await execBounded(["stat", "-c%s", `${WORKDIR}/${safe[0]}`], {}, 30000);
              const bytes = Number(decode(sized.stdout).trim());
              if (Number.isFinite(bytes) && bytes <= SEAT_BLOB_CAP) {
                const blob = await execBounded(["cat", `${WORKDIR}/${safe[0]}`], {}, timing.blobMs);
                if (!blob.timedOut && blob.exitCode === 0) {
                  const base = safe[0].split("/").pop() ?? "artifact";
                  const name = sanitizeName(base);
                  await cache.put(`artifacts/${jobId}/${name}`, blob.stdout);
                  uploaded.push(name);
                  logParts.push(`[seat] artifact uploaded ${safe[0]} as ${name}`);
                }
              }
            }
          }
          if (uploaded.length === 0) {
            const made = await execBounded(["tar", "-czf", "/tmp/art.tgz", "-C", WORKDIR, ...safe], {}, timing.blobMs);
            if (!made.timedOut && made.exitCode === 0) {
              const sized = await execBounded(["stat", "-c%s", "/tmp/art.tgz"], {}, 30000);
              const bytes = Number(decode(sized.stdout).trim());
              if (Number.isFinite(bytes) && bytes <= SEAT_BLOB_CAP) {
                const blob = await execBounded(["cat", "/tmp/art.tgz"], {}, timing.blobMs);
                if (!blob.timedOut && blob.exitCode === 0) {
                  const name = `${sanitizeName(spec.artifacts.name ?? "artifacts")}.tar.gz`;
                  await cache.put(`artifacts/${jobId}/${name}`, blob.stdout);
                  uploaded.push(name);
                  logParts.push(`[seat] artifacts uploaded as ${name}`);
                }
              }
            }
          }
          if (uploaded.length === 0) logParts.push("[seat] artifacts: nothing uploaded");
        } catch (err) {
          logParts.push(`[seat] artifacts failed: ${String(err).slice(0, 200)}`);
        }
      }
    }

    // Test reports (JUnit): one listing exec, then one cat per file.
    // Parsed and stored directly — the seat has the D1 binding, so no
    // HTTP round-trip to the main worker is needed.
    try {
      const safe = safeRelPaths([...(spec.testReports?.paths ?? []), ...SEAT_TEST_DEFAULTS]);
      if (safe) {
        let found: string[] | null = null;
        if (deps.fs) {
          try {
            found = await findJUnitViaFs(deps.fs, safe);
          } catch {
            found = null;
          }
        }
        if (found === null) {
          const quoted = [...new Set(safe)].map((p) => JSON.stringify(`${WORKDIR}/${p}`)).join(" ");
          const scan = await execBounded(
            [
              "sh",
              "-c",
              `for p in ${quoted}; do if [ -d "$p" ] && [ ! -L "$p" ]; then find "$p" -maxdepth 1 -not -lname '*' -name '*.xml' -size -1024k; elif [ -f "$p" ] && [ ! -L "$p" ]; then case "$p" in *.xml) sz=$(stat -c%s "$p" 2>/dev/null || echo 0); if [ "$sz" -gt 0 ] && [ "$sz" -le ${MAX_JUNIT_BYTES} ]; then echo "$p"; fi;; esac; fi; done`,
            ],
            {},
            30000,
          );
          found =
            !scan.timedOut && scan.exitCode === 0
              ? decode(scan.stdout)
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l.startsWith(`${WORKDIR}/`))
                  .slice(0, SEAT_TEST_MAX_FILES)
              : [];
        }
        if (found.length > 0) {
          const parts: string[] = [];
          for (const file of found) {
            const bytes = await readContainerFile(file, MAX_JUNIT_BYTES);
            if (!bytes) continue;
            const text = decode(bytes);
            if (!text.slice(0, 1024).includes("<testsuite")) continue;
            parts.push(text);
          }
          if (parts.length > 0) {
            const xml = parts.join("\n").slice(0, MAX_JUNIT_BYTES);
            const parsed = parseJUnit(xml);
            if ("error" in parsed) {
              logParts.push(`[seat] tests: parse failed (${parsed.error})`);
            } else {
              await saveTestReport(deps.db, {
                jobId,
                runId: run.id,
                passed: parsed.passed,
                failed: parsed.failed,
                errors: parsed.errors,
                skipped: parsed.skipped,
                total: parsed.total,
                durationMs: parsed.durationMs,
                truncated: parsed.truncated,
                cases: parsed.cases,
              });
              if (cache) {
                await cache.put(`test-reports/${jobId}.xml`, new TextEncoder().encode(xml)).catch(() => undefined);
              }
              logParts.push(`[seat] tests: ${parsed.total} tests, ${parsed.failed + parsed.errors} failed`);
            }
          }
        }
      }
    } catch (err) {
      logParts.push(`[seat] tests failed: ${String(err).slice(0, 200)}`);
    }

    // Peak RSS via cgroupfs (v2, falling back to v1). Best-effort:
    // feeds right-sizing hints; a missing cgroupfs never fails the job.
    let peakRssBytes = 0;
    try {
      const mem = await execBounded(
        ["sh", "-c", "cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || echo 0"],
        {},
        15000,
      );
      if (!mem.timedOut && mem.exitCode === 0) {
        const n = Number(decode(mem.stdout).trim().split("\n").pop());
        if (Number.isFinite(n) && n > 0) peakRssBytes = Math.floor(n);
      }
    } catch {
      // Best effort.
    }

    // Report terminal status like a runner would. Once the row is final,
    // the rest is best-effort post-processing: it must never route into
    // the catch-all release, which would stamp a "released" line on a
    // finished job. Caps match the BYO /status route exactly (D1's 2MB
    // row limit is uncomfortably close to 100 steps × 32KB tails).
    const status = success ? "success" : "failure";
    const resultJson = mask(
      JSON.stringify({
        steps: records,
        cacheHit,
        artifacts: uploaded,
        executor: "seat",
        ...(spec.outputs ? { outputs: resolvedOutputs.outputs } : {}),
        ...(peakRssBytes > 0 ? { peakRssBytes } : {}),
      }),
    ).slice(0, SEAT_RESULT_CAP);
    const finalLog = mask(logParts.join("\n")).slice(0, SEAT_LOG_CAP);
    // Flaky auto-quarantine: all-quarantined failures land as success so
    // checks/triage/notifications see green (mirrors the BYO path).
    const q = await quarantineDowngrade(deps.db, jobId, status);
    const effectiveStatus = q.status;
    const effectiveLog = q.note ? `${finalLog}\n${q.note}` : finalLog;
    const recorded = await updateRunningJob(deps.db, jobId, {
      status: effectiveStatus,
      log: effectiveLog,
      result: resultJson,
    });
    if (!recorded) {
      try {
        deps.container.destroy();
      } catch {
        // Never started or already gone.
      }
      return { status: "released", jobId, detail: "job was requeued before completion; result dropped" };
    }
    await rollupRunStatus(deps.db, job.run_id, deps.analytics, deps.basin, { hosted: deps.hosted === true });
    await annotateSpan({ "flare.job.status": effectiveStatus, "seat.snapshot.restored": restored });
    // FTS index slice for global log search (best-effort, like monitors).
    await indexJobLog(deps.db, {
      jobId,
      runId: job.run_id,
      repo: run.repo,
      branch: run.branch,
      log: finalLog,
    }).catch(() => undefined);
    // Runtime prior for drain-order prediction (success/failure carry
    // real durations; seats only finish those two statuses here).
    const finished = await getJob(deps.db, jobId);
    const seatDurationMs = finished ? jobDurationMs(finished) : null;
    if (finished) {
      emitJobTerminal(deps.analytics, {
        repo: run.repo,
        runId: job.run_id,
        jobName: finished.name,
        status: effectiveStatus,
        durationMs: seatDurationMs ?? 0,
        executor: "seat",
        attempts: finished.attempts,
      });
      if (deps.basin) {
        sendBasin(deps.basin, basinJobTerminal({
          repo: run.repo,
          runId: job.run_id,
          jobName: finished.name,
          status: effectiveStatus,
          durationMs: seatDurationMs ?? 0,
          executor: "seat",
          attempts: finished.attempts,
        }));
      }
    }
    if (finished?.finished_at && seatDurationMs !== null) {
      await recordRuntimePrior(deps.db, {
        repo: run.repo,
        name: job.name,
        finishedAt: finished.finished_at,
        durationMs: seatDurationMs,
      }).catch(() => undefined);
    }
    try {
      await evaluateResultMonitors(deps.db, deps.mail ?? {}, run, {
        ...job,
        status: effectiveStatus,
        log: finalLog,
      });
      const promoted = await promoteBlockedJobs(deps.db, deps.queue, run.repo, (p) => deps.spawn?.(p.jobId), deps.analytics, deps.basin, { hosted: deps.hosted === true });
      if (promoted.length > 0) await note(`[seat] promoted ${promoted.length} job(s)`);
      if (deps.mail) {
        const finalRun = await getRun(deps.db, job.run_id);
        if (finalRun && isTerminal(finalRun.status)) {
          const mailed = await notifyRunCompleted(deps.db, deps.mail, { run: finalRun, origin: "" });
          if (mailed.sent > 0) await note(`[seat] notified ${mailed.sent} recipient(s)`);
        }
      }
      const ghState = effectiveStatus === "success" ? "success" : "failure";
      await reportGitHubStatus({
        appId: deps.appId,
        privateKey: deps.appKey,
        installationId: run.installation_id,
        repo: run.repo,
        sha: run.sha,
        state: ghState,
      });
      // Per-job Check Run (rich PR output), mirroring the BYO path.
      await reportJobCheck(
        {
          appId: deps.appId,
          privateKey: deps.appKey,
          installationId: run.installation_id,
          repo: run.repo,
          sha: run.sha,
          origin: "",
        },
        { ...job, status: effectiveStatus, result: resultJson },
      );
      if (effectiveStatus === "failure") {
        const jobs = await getJobsForRun(deps.db, job.run_id);
        const jobName = jobs.find((j) => j.id === job.id)?.name ?? "";
        await triageAndStore(deps.db, deps.ai, run, job.id, jobName, mask(logParts.join("\n")), resultJson, {
          gatewayId: deps.gatewayId,
          webSearch: deps.webSearch,
          model: deps.triageModel,
        });
        // Self-heal request (same cheap claim the worker files; the
        // worker's scheduled tick drains the queue).
        await requestHeal(deps.db, job.run_id, job.id);
      }
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", msg: "seat post-processing failed", jobId, error: String(err) }));
    }

    // Egress accounting, success and failure alike (retried attempts
    // record nothing — only the final attempt lands in job_egress).
    try {
      const end = await sampleIface();
      if (ifaceStart && end) {
        const dTx = Math.max(0, end.tx - ifaceStart.tx);
        const dRx = Math.max(0, end.rx - ifaceStart.rx);
        if (dTx > 0 || dRx > 0) tally("(interface)", dTx, dRx);
      }
      for (const d of domainEgress) tally(d.host, d.reqBytes, d.respBytes);
      if (egress.length > 0) await saveJobEgress(deps.db, jobId, job.run_id, egress);
    } catch {
      // Best effort.
    }

    // Snapshot the warm filesystem for the next job (V2, success only —
    // a failed build's state is exactly what you must not inherit).
    if (v2Image && status === "success" && !run.source) {
      try {
        const snap = await snapshotBounded(`${run.repo}@${run.sha.slice(0, 7)}`, timing.snapshotMs ?? 120000);
        if (snap) {
          await saveSeatSnapshot(deps.db, { image: v2Image, repo: run.repo, snapshotId: snap.id, jobId });
          await note(`[seat] snapshot saved (${snap.id.slice(0, 12)}…)`);
        } else {
          await note("[seat] snapshot timed out; skipped");
        }
      } catch (err) {
        await note(`[seat] snapshot skipped: ${String(err).slice(0, 160)}`);
      }
    }

    // Retain-on-failure (V2 only — the seat DO alarm enforces the
    // destroy deadline, and V1 has no alarm). The job row is already
    // terminal; the container simply stays up for debugging.
    if (effectiveStatus === "failure" && spec.retainOnFailure && v2Image) {
      const until = new Date(Date.now() + RETAIN_TTL_MS).toISOString();
      try {
        await markJobRetained(deps.db, jobId, until);
      } catch {
        // Discovery only; the DO alarm still enforces the deadline.
      }
      await note(`[seat] retained for debugging until ${until} (seat job-${jobId})`);
      return { status: "retained", jobId, retainedUntil: until };
    }
    try {
      deps.container.destroy();
    } catch {
      // Best effort.
    }
    return { status: "completed", jobId };
  } catch (err) {
    // Container died mid-job or persistence hiccuped: release so a BYO
    // runner can retry rather than failing terminally on our infra.
    return release(`seat error: ${String(err).slice(0, 200)}`);
  }
}
