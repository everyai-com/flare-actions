// Self-healing runs (HealingAgent pattern): on failure, an agent step
// proposes a fix on a NEW branch, opens a DRAFT pull request, and
// dispatches a verification run — the source run stays failed, and a
// human must merge. Triage is step one; this is step two.
//
// Flow (async by design — inference plus a dozen GitHub calls never
// belong on a status callback):
//   1. Both executors call requestHeal() next to triageAndStore: cheap
//      D1 guards plus an atomic claim, so concurrent failure
//      callbacks cannot queue duplicate heals for one run.
//   2. The worker's scheduled tick drains pending claims through
//      processHealClaims (production only, bounded per tick): model
//      proposes full-file replacements, the Git Data API commits them
//      to flare-heal/<run>, a draft PR opens against the run branch,
//      and a verification run dispatches on the heal branch.
//
// Guards (every one must hold): the heal_on_failure toggle is on,
// the run has a GitHub App installation (token source), the run is
// still failed (a retry may have fixed it since the claim), and the
// run is not itself a heal branch or verification run (no heal loops).
// The App needs contents:write (heal pushes) plus the pre-existing
// pull_requests:write (draft PRs); see buildManifest.

import {
  audit,
  claimHealAttempt,
  getJob,
  getRun,
  getSetting,
  listPendingHealClaims,
  setHealClaimResult,
  setRunHeal,
  type Db,
} from "./db";
import { parseReportedSteps } from "./finish";
import { SETTING_KEYS } from "./settings";
import {
  gatewayOptions,
  isModelBusyError,
  TRIAGE_MODEL,
  type AiBinding,
  type TriageMessage,
  type TriageStep,
} from "./triage";
import { buildJudgeText, JUDGE_FLAKY_THRESHOLD } from "./judge";
import { annotateSpan, readAiUsage, startGenAiSpan } from "./trace";

export const HEAL_BRANCH_PREFIX = "flare-heal/";
export const HEAL_SOURCE_PREFIX = "heal:";
export const HEAL_MAX_TOKENS = 2048;
export const HEAL_MAX_LOG_CHARS = 4000;
export const HEAL_MAX_FILES = 3;
export const HEAL_MAX_FILE_CHARS = 8000;
export const HEAL_MAX_TREE_PATHS = 300;

export interface HealFile {
  path: string;
  content: string;
}

export interface HealProposal {
  files: HealFile[];
  summary: string;
}

export interface HealInput {
  repo: string;
  sha: string;
  branch: string;
  jobName: string;
  steps: TriageStep[];
  logTail: string;
  triage: string;
  treePaths: string[];
  runId?: string;
  jobId?: string;
}

// GitHub surface heals need, injected so tests use fakes (the real
// implementations live in github.ts and never throw — they degrade
// to false/empty/null).
export interface HealGitHub {
  treePaths(token: string, repo: string, sha: string): Promise<string[]>;
  commitFiles(
    token: string,
    repo: string,
    baseSha: string,
    branch: string,
    files: HealFile[],
    message: string,
  ): Promise<boolean>;
  openDraftPr(
    token: string,
    repo: string,
    base: string,
    head: string,
    title: string,
    body: string,
  ): Promise<string | null>;
  defaultBranch(token: string, repo: string): Promise<string>;
}

export interface HealDeps {
  db: Db;
  ai: AiBinding | undefined;
  installationToken: (installationId: number) => Promise<string | null>;
  gh: HealGitHub;
  // Dispatch a verification run on the heal branch; resolves to the
  // verify run id, or null when the dispatch fails.
  verify: (repo: string, branch: string, source: string) => Promise<string | null>;
  // Flaky-vs-real judge (probability the failure is flaky). Absent =
  // no judge configured, heals proceed (fail open).
  judge?: (text: string) => Promise<number | null>;
  model?: string;
  gatewayId?: string;
}

export function healBranchForRun(runId: string): string {
  return `${HEAL_BRANCH_PREFIX}${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "run"}`;
}

function isSafeHealPath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(path)) return false;
  return !path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

// Parse the model's repair proposal: strict JSON, full-file contents
// (never diffs — applying hunks needs a parser we do not want to
// trust). Any violation rejects the whole proposal: a half-valid
// patch is worse than no patch.
export function parseHealFiles(text: string): HealProposal | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.files) || rec.files.length === 0 || rec.files.length > HEAL_MAX_FILES) return null;
  const files: HealFile[] = [];
  const seen = new Set<string>();
  for (const entry of rec.files) {
    if (typeof entry !== "object" || entry === null) return null;
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || !isSafeHealPath(file.path) || seen.has(file.path)) return null;
    if (typeof file.content !== "string" || file.content.length === 0 || file.content.length > HEAL_MAX_FILE_CHARS) {
      return null;
    }
    seen.add(file.path);
    files.push({ path: file.path, content: file.content });
  }
  const summary = typeof rec.summary === "string" ? rec.summary.slice(0, 500) : "";
  return { files, summary };
}

export function buildHealMessages(input: HealInput): TriageMessage[] {
  const failing = input.steps.filter((s) => s.exitCode !== 0).slice(0, 3);
  const stepBlock =
    failing.length > 0
      ? failing
          .map((s) => `$ ${s.command.slice(0, 200)} (exit ${s.exitCode})\n${s.output.slice(-1500)}`)
          .join("\n\n")
      : "(no per-step results; use the log tail)";
  const treeBlock = input.treePaths.slice(0, HEAL_MAX_TREE_PATHS).join("\n") || "(tree unavailable)";
  return [
    {
      role: "system",
      content:
        "You are a CI repair agent. Given a failed CI job, propose a minimal fix as COMPLETE file contents (not diffs). " +
        "Reply with exactly one JSON object, no prose: {\"files\": [{\"path\": \"...\", \"content\": \"...\"}], \"summary\": \"...\"}. " +
        `Rules: at most ${HEAL_MAX_FILES} files; paths must be repo-relative files from the tree below (existing files only, no new files); ` +
        "each content is the ENTIRE new file; keep unrelated code identical; summary is one sentence. " +
        "If the failure is environmental (network, credentials, flaky infra) or you cannot fix it, reply {\"files\": [], \"summary\": \"...reason...\"}.",
    },
    {
      role: "user",
      content:
        `repo: ${input.repo}\nsha: ${input.sha}\nbranch: ${input.branch || "(detached)"}\njob: ${input.jobName}\n\n` +
        `Triage (prior analysis, may be empty):\n${input.triage || "(none)"}\n\n` +
        `Failing steps:\n${stepBlock}\n\n` +
        `Log tail:\n${input.logTail.slice(-HEAL_MAX_LOG_CHARS) || "(empty)"}\n\n` +
        `Repo tree (repair targets must come from this list):\n${treeBlock}`,
    },
  ];
}

async function runHealModel(ai: AiBinding, input: HealInput, opts: { model?: string; gatewayId?: string }): Promise<string | null> {
  try {
    const model = opts.model?.trim() || TRIAGE_MODEL;
    const span = await startGenAiSpan({ operation: "chat", model, agentName: "heal", runId: input.runId, jobId: input.jobId });
    try {
      const out = (await ai.run(
        model,
        { messages: buildHealMessages(input), max_tokens: HEAL_MAX_TOKENS },
        gatewayOptions(opts.gatewayId),
      )) as { response?: unknown };
      const usage = readAiUsage(out);
      if (usage) span.setUsage(usage.inputTokens, usage.outputTokens);
      if (typeof out?.response !== "string" || !out.response.trim()) {
        span.end(false);
        return null;
      }
      span.end(true);
      return out.response.trim();
    } catch (err) {
      span.recordError(err);
      span.end(false);
      throw err;
    }
  } catch (err) {
    if (!isModelBusyError(err)) {
      console.log(JSON.stringify({ level: "warn", msg: "heal model call failed", error: String(err) }));
    }
    return null;
  }
}

// Trigger-side: cheap guards plus the atomic claim. Called next to
// triageAndStore by both executors; never throws.
export async function requestHeal(db: Db, runId: string, jobId: string): Promise<boolean> {
  try {
    if ((await getSetting(db, SETTING_KEYS.healOnFailure)) !== "1") return false;
    const run = await getRun(db, runId);
    if (!run || run.installation_id === null) return false;
    // Never heal a heal branch or a verification run: heals must not loop.
    if (run.branch.startsWith(HEAL_BRANCH_PREFIX)) return false;
    if (run.source?.startsWith(HEAL_SOURCE_PREFIX)) return false;
    const claimed = await claimHealAttempt(db, runId, jobId);
    if (claimed) await annotateSpan({ "flare.run.id": runId, "flare.job.id": jobId, "heal.claimed": true });
    return claimed;
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "heal request failed", runId, error: String(err) }));
    return false;
  }
}

async function processOneClaim(deps: HealDeps, claim: { run_id: string; job_id: string }): Promise<"done" | "failed" | "skipped"> {
  const fail = async (reason: string): Promise<"failed"> => {
    await setHealClaimResult(deps.db, claim.run_id, "failed").catch(() => undefined);
    await audit(deps.db, "heal", "run.heal_failed", `${claim.run_id} ${reason}`).catch(() => undefined);
    await annotateSpan({ "flare.run.id": claim.run_id, "flare.job.id": claim.job_id, "heal.outcome": `failed:${reason}` });
    return "failed";
  };
  const skip = async (reason: string): Promise<"skipped"> => {
    await setHealClaimResult(deps.db, claim.run_id, "skipped").catch(() => undefined);
    await audit(deps.db, "heal", "run.heal_skipped", `${claim.run_id} ${reason}`).catch(() => undefined);
    await annotateSpan({ "flare.run.id": claim.run_id, "flare.job.id": claim.job_id, "heal.outcome": `skipped:${reason}` });
    return "skipped";
  };
  if (!deps.ai) return skip("no-ai-binding");
  if ((await getSetting(deps.db, SETTING_KEYS.healOnFailure).catch(() => null)) !== "1") return skip("toggle-off");
  const run = await getRun(deps.db, claim.run_id).catch(() => null);
  if (!run) return skip("run-gone");
  // A retry or rerun may have fixed the run since the claim: only
  // heal runs that are still red.
  if (run.status !== "failure" && run.status !== "error") return skip(`run-${run.status}`);
  if (run.installation_id === null) return skip("no-installation");
  if (run.branch.startsWith(HEAL_BRANCH_PREFIX)) return skip("heal-branch");
  if (run.source?.startsWith(HEAL_SOURCE_PREFIX)) return skip("verify-run");
  const token = await deps.installationToken(run.installation_id).catch(() => null);
  if (!token) return fail("no-token");
  const job = await getJob(deps.db, claim.job_id).catch(() => null);
  if (!job) return skip("job-gone");
  // Judge gate: flaky failures (timeout, port collision, auth hiccup)
  // heal by retrying, not by patching — skip before spending model +
  // branch + PR + verification run. Null verdict fails open.
  if (deps.judge) {
    const steps = parseReportedSteps(job.result);
    const pFlaky = await deps
      .judge(buildJudgeText({ jobName: job.name, steps, logTail: (job.log ?? "").slice(-2000), triage: job.triage ?? "" }))
      .catch(() => null);
    if (pFlaky !== null && pFlaky >= JUDGE_FLAKY_THRESHOLD) return skip(`flaky-${pFlaky.toFixed(2)}`);
  }
  const treePaths = await deps.gh.treePaths(token, run.repo, run.sha).catch(() => [] as string[]);
  const modelText = await runHealModel(
    deps.ai,
    {
      repo: run.repo,
      sha: run.sha,
      branch: run.branch,
      jobName: job.name,
      steps: parseReportedSteps(job.result),
      logTail: (job.log ?? "").slice(-HEAL_MAX_LOG_CHARS),
      triage: job.triage ?? "",
      treePaths: treePaths.slice(0, HEAL_MAX_TREE_PATHS),
      runId: run.id,
      jobId: job.id,
    },
    { model: deps.model, gatewayId: deps.gatewayId },
  );
  if (!modelText) return fail("model-empty");
  const proposal = parseHealFiles(modelText);
  if (!proposal || proposal.files.length === 0) return fail("unparseable-or-empty");
  const branch = healBranchForRun(run.id);
  const committed = await deps.gh
    .commitFiles(token, run.repo, run.sha, branch, proposal.files, `heal: fix ${job.name} failure (flare ${run.id.slice(0, 8)})`)
    .catch(() => false);
  if (!committed) return fail("push-failed");
  const base = run.branch || (await deps.gh.defaultBranch(token, run.repo).catch(() => "main"));
  const prUrl = await deps.gh
    .openDraftPr(
      token,
      run.repo,
      base,
      branch,
      `HealingAgent: fix ${job.name} failure`,
      [
        proposal.summary || "Automated fix proposal for a failed CI run.",
        "",
        `Run: \`${run.id}\` · \`${run.repo}@${run.sha.slice(0, 12)}\` · job \`${job.name}\``,
        `Files: ${proposal.files.map((f) => `\`${f.path}\``).join(", ")}`,
        "",
        "Draft — human review required. A verification run on this branch follows automatically.",
      ].join("\n"),
    )
    .catch(() => null);
  if (!prUrl) return fail("pr-failed");
  await setRunHeal(deps.db, run.id, branch, prUrl).catch(() => undefined);
  await setHealClaimResult(deps.db, run.id, "done", branch, prUrl).catch(() => undefined);
  // Verification: a run on the heal branch. Its source marks it so
  // heals never recurse; a failed dispatch is audited, not fatal —
  // the draft PR is already up for human review.
  const verifyRunId = await deps.verify(run.repo, branch, `${HEAL_SOURCE_PREFIX}${run.id}`).catch(() => null);
  await audit(
    deps.db,
    "heal",
    "run.healed",
    `${run.id} ${branch} ${prUrl}${verifyRunId ? ` verify:${verifyRunId}` : " verify:failed"}`,
  ).catch(() => undefined);
  await annotateSpan({
    "flare.run.id": run.id,
    "flare.job.id": job.id,
    "heal.outcome": "done",
    "heal.pr_url": prUrl,
    ...(verifyRunId ? { "heal.verify_run_id": verifyRunId } : {}),
  });
  return "done";
}

// Scheduler-side: drain pending claims, bounded per tick. Never
// throws; per-claim outcomes land in heal_claims + the audit log.
export async function processHealClaims(deps: HealDeps, limit = 2): Promise<{ processed: number; healed: number }> {
  let processed = 0;
  let healed = 0;
  try {
    const claims = await listPendingHealClaims(deps.db, limit);
    for (const claim of claims) {
      try {
        const outcome = await processOneClaim(deps, claim);
        processed += 1;
        if (outcome === "done") healed += 1;
      } catch (err) {
        console.log(JSON.stringify({ level: "warn", msg: "heal claim crashed", runId: claim.run_id, error: String(err) }));
        await setHealClaimResult(deps.db, claim.run_id, "failed").catch(() => undefined);
        processed += 1;
      }
    }
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "heal drain failed", error: String(err) }));
  }
  return { processed, healed };
}
