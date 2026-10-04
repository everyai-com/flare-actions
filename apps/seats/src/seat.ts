import {
  appendJobLog,
  claimJob,
  getJob,
  getJobsForRun,
  getRun,
  isTerminal,
  releaseJob,
  rollupRunStatus,
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
import { bytesEqual, getInstallationToken, mintAppJwt } from "../../worker/src/github";
import { reportJobCheck } from "../../worker/src/checks";
import { notifyRunCompleted, type NotifyMailEnv } from "../../worker/src/notify";
import { seatEligible } from "../../worker/src/pipeline";
import { getDecryptedRepoSecrets } from "../../worker/src/secrets";
import type { AiBinding } from "../../worker/src/triage";
import { interpolateSecrets, maskSecrets } from "../../../packages/runner-sdk/src/secrets";
import { matrixEnv, parseJobSpec } from "../../../packages/runner-sdk/src/spec";

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
export interface ContainerStartOptions {
  enableInternet?: boolean;
}

export interface ContainerCtl {
  readonly running: boolean;
  start(opts?: ContainerStartOptions): void;
  destroy(): void;
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecHandle>;
}

export interface SeatBlobStore {
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, data: Uint8Array): Promise<unknown>;
}

export interface SeatTiming {
  startWaitMs: number;
  startAttempts: number;
  startPollMs: number;
  stepMs: number;
  blobMs: number;
  checkoutMs?: number;
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
  container: ContainerCtl;
  timing?: SeatTiming;
  sleep?: (ms: number) => Promise<void>;
  spawn?: (jobId: string) => Promise<void>;
  // Run-email sender; absent in unit contexts that never notify.
  mail?: NotifyMailEnv;
  // Raw SECRETS_KEY env passthrough; absent means D1-held data key.
  secretsKey?: string;
}

export type SeatOutcome =
  | { status: "completed"; jobId: string }
  | { status: "released"; jobId: string; detail: string }
  | { status: "skipped"; jobId: string; detail: string }
  | { status: "failed"; jobId: string; detail: string }
  | { status: "retrying"; jobId: string; detail: string };

export const SEAT_BLOB_CAP = 50 * 1024 * 1024;
const STEP_OUTPUT_CAP = 32768;
export const WORKDIR = "/work";

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
    await rollupRunStatus(deps.db, job.run_id);
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
    await releaseJob(deps.db, jobId);
    await rollupRunStatus(deps.db, job.run_id);
    return { status: "released", jobId, detail };
  };

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
      const out = await Promise.race([proc.output(), timeout]);
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

  // Boot (bounded retries for cold starts and capacity). Both start()
  // and the running probe are throw-tolerant: a transient control-plane
  // error must not abort the window while the container may still boot.
  let started = false;
  let startAttempt = 0;
  for (let attempt = 1; attempt <= timing.startAttempts && !started; attempt++) {
    startAttempt = attempt;
    try {
      // Seats must reach github.com (checkout) and pypi/npm mirrors;
      // containers boot offline unless internet is enabled.
      if (!deps.container.running) deps.container.start({ enableInternet: true });
    } catch (err) {
      await note(`[seat] start attempt ${attempt} error: ${String(err).slice(0, 200)}`);
    }
    const bootUntil = Date.now() + timing.startWaitMs;
    while (Date.now() < bootUntil) {
      let up = false;
      try {
        up = deps.container.running;
      } catch {
        up = false;
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
  await note(`[seat] container running (attempt ${startAttempt})`);

  try {
    // Checkout (script over stdin so the token never appears in argv).
    if (!/^[\w.-]+\/[\w.-]+$/.test(run.repo) || !/^[\w.-]+$/.test(run.sha)) {
      return release("invalid repo or sha");
    }
    let appToken: string | null = null;
    if (run.installation_id && deps.appId && deps.appKey) {
      try {
        const jwt = await mintAppJwt(deps.appId, deps.appKey);
        appToken = await getInstallationToken(jwt, run.installation_id);
      } catch {
        appToken = null;
      }
    }
    const remote = appToken
      ? `https://x-access-token:${appToken}@github.com/${run.repo}.git`
      : `https://github.com/${run.repo}.git`;
    const checkoutScript = `set -e\nrm -rf ${WORKDIR}\nmkdir -p ${WORKDIR}\ncd ${WORKDIR}\ngit init -q\ngit remote add origin ${remote}\ngit fetch -q --depth 1 origin ${run.sha}\ngit checkout -q FETCH_HEAD\n`;
    const co = await execBounded(["sh", "-s"], { stdin: checkoutScript }, timing.checkoutMs ?? 180000);
    if (co.timedOut || co.exitCode !== 0) {
      const raw = decode(co.timedOut ? co.stderr : new Uint8Array([...co.stdout, ...co.stderr])).slice(0, 300);
      // git errors can echo the remote URL — scrub the token (the
      // release detail lands in seat logs, never in job rows).
      const errText = appToken ? raw.split(appToken).join("[redacted]") : raw;
      return release(`checkout failed: ${errText || "unknown"}`);
    }
    await note("[seat] checkout ok");

    // Cache restore.
    let cacheHit = false;
    if (spec.cache) {
      const entry = deps.cache ? await deps.cache.get(`cache/${spec.cache.key}`) : null;
      if (!entry) {
        logParts.push(`[seat] cache miss: ${spec.cache.key}`);
      } else if (entry.size > SEAT_BLOB_CAP) {
        logParts.push(`[seat] cache skipped (>${SEAT_BLOB_CAP}b)`);
      } else {
        const blob = new Uint8Array(await entry.arrayBuffer());
        const r = await execBounded(["tar", "-xzf", "-", "-C", WORKDIR], { stdin: blob }, timing.blobMs);
        cacheHit = !r.timedOut && r.exitCode === 0;
        logParts.push(cacheHit ? `[seat] cache hit: ${spec.cache.key}` : "[seat] cache extract failed");
      }
    }

    // Steps (each writes to a file; only a bounded tail crosses).
    const jobEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env ?? {})) jobEnv[k] = interpolateSecrets(v, secrets);
    const stepEnv: Record<string, string> = {
      FLARE_REPO: run.repo,
      FLARE_SHA: run.sha,
      FLARE_RUN_ID: run.id,
      FLARE_JOB_ID: job.id,
      // GitHub parity (see runner-sdk job.ts); job env may override.
      CI: "true",
      ...jobEnv,
      ...matrixEnv(spec.matrix),
    };
    let timedOutJob = false;
    let hardFailure = false;
    for (let i = 0; i < spec.steps.length; i++) {
      if (Date.now() > deadline) {
        timedOutJob = true;
        logParts.push("[seat] job timeout exceeded");
        break;
      }
      const step = spec.steps[i];
      const command = interpolateSecrets(step.run, secrets);
      await note(`[seat] step ${i + 1} start: ${command}`);
      const startedAt = Date.now();
      const r = await execBounded(
        ["sh", "-c", `sh -s > /tmp/step.log 2>&1; printf 'EXIT:%d' $?`],
        { stdin: command, env: stepEnv, cwd: WORKDIR },
        timing.stepMs,
      );
      const durationMs = Date.now() - startedAt;
      if (r.timedOut) {
        records.push({ command: mask(command), exitCode: 124, durationMs, output: "[seat] step timed out after 10m" });
        logParts.push(mask(`--- step ${i + 1}: ${command} ---\n[seat] step timed out after 10m\n(exit 124, ${durationMs}ms)`));
        if (step.continueOnError) {
          logParts.push(`--- step ${i + 1} failed but continue-on-error is set ---`);
          continue;
        }
        hardFailure = true;
        break;
      }
      const m = /EXIT:(\d+)\s*$/.exec(decode(r.stdout));
      const exitCode = m ? Number(m[1]) : r.exitCode;
      const tail = await execBounded(["tail", "-c", String(STEP_OUTPUT_CAP), "/tmp/step.log"], {}, 30000);
      const output = tail.timedOut ? "" : mask(decode(tail.stdout).trimEnd());
      records.push({ command: mask(command), exitCode, durationMs, output });
      logParts.push(mask(`--- step ${i + 1}: ${command} ---\n${output}\n(exit ${exitCode}, ${durationMs}ms)`));
      if (exitCode !== 0) {
        if (step.continueOnError) {
          logParts.push(`--- step ${i + 1} failed but continue-on-error is set ---`);
          continue;
        }
        hardFailure = true;
        break;
      }
    }
    const success = !timedOutJob && records.length > 0 && !hardFailure;

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
    if (spec.cache && success && deps.cache) {
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
              await deps.cache.put(`cache/${spec.cache.key}`, blob.stdout);
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
      } else if (deps.cache) {
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
                  await deps.cache.put(`artifacts/${jobId}/${name}`, blob.stdout);
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
                  await deps.cache.put(`artifacts/${jobId}/${name}`, blob.stdout);
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

    // Report terminal status like a runner would. Once the row is final,
    // the rest is best-effort post-processing: it must never route into
    // the catch-all release, which would stamp a "released" line on a
    // finished job.
    const status = success ? "success" : "failure";
    const resultJson = mask(JSON.stringify({ steps: records, cacheHit, artifacts: uploaded, executor: "seat" }));
    const recorded = await updateRunningJob(deps.db, jobId, {
      status,
      log: mask(logParts.join("\n")),
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
    await rollupRunStatus(deps.db, job.run_id);
    try {
      const promoted = await promoteBlockedJobs(deps.db, deps.queue, run.repo, (p) => deps.spawn?.(p.jobId));
      if (promoted.length > 0) await note(`[seat] promoted ${promoted.length} job(s)`);
      if (deps.mail) {
        const finalRun = await getRun(deps.db, job.run_id);
        if (finalRun && isTerminal(finalRun.status)) {
          const mailed = await notifyRunCompleted(deps.db, deps.mail, { run: finalRun, origin: "" });
          if (mailed.sent > 0) await note(`[seat] notified ${mailed.sent} recipient(s)`);
        }
      }
      const ghState = status === "success" ? "success" : "failure";
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
        { ...job, status, result: resultJson },
      );
      if (status === "failure") {
        const jobs = await getJobsForRun(deps.db, job.run_id);
        const jobName = jobs.find((j) => j.id === job.id)?.name ?? "";
        await triageAndStore(deps.db, deps.ai, run, job.id, jobName, mask(logParts.join("\n")), resultJson);
      }
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", msg: "seat post-processing failed", jobId, error: String(err) }));
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
