import { McpServer, ProtocolError, SUPPORTED_PROTOCOL_VERSIONS, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  audit,
  createSchedule,
  deleteSchedule,
  flakyStats,
  getJob,
  getJobsForRun,
  getRun,
  getSetting,
  listRuns,
  listSchedules,
  setScheduleEnabled,
  type Db,
} from "./db";
import { ARTIFACT_NAME_RE, artifactObjectKey, listRunArtifacts } from "./artifacts";
import { validateCron } from "./cron";
import { MCP_OAUTH_SCOPE_OFFLINE, MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN } from "./mcp-oauth";
import { reposAllow } from "./tokens";
import { jobDurationMs } from "./cost";
import { parseProfileName } from "./pipeline";
import type { RunDigest } from "./digest";
import { runGenerateWithStatus } from "./generate";
import { getTournamentBoard, tournamentAllowed } from "./tournaments";
import { SETTING_KEYS, parseAgentTag } from "./settings";
import type { AiBinding } from "./triage";

// MCP server over Streamable HTTP: POST JSON-RPC to /mcp. Stateless —
// no session ids — with Bearer auth mapped onto the existing scopes:
// read tools need `read`, dispatch/rerun/generate need `run`. One server
// instance is built per request by buildMcpServer and served by the MCP
// SDK's stateless handler (modern 2026-07-28 plus the SDK's legacy era).
//
// Transport notes (SDK v2 behavior, verified by spike 2026-10-05):
// - Clients MUST send `Accept: application/json, text/event-stream`
//   (both); anything else is a 406. Responses are SSE `data:` frames.
// - Zod input schemas are shape-only (all fields optional): the SDK
//   demotes schema failures to isError tool results, while this server's
//   contract is -32602 protocol errors with stable messages — so the tool
//   bodies below keep doing all validation, exactly as before.

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];
export const MCP_SERVER_VERSION = "0.3.0";

// WriteGuard risk tiers: read tools are side-effect free, contained-write
// tools mutate runs/jobs (reversible, token-scoped), critical is reserved
// for destructive tools (none exist yet — deleting runs/jobs has no MCP
// surface). Tiers drive audit + the optional write-confirm gate.
export type McpToolRisk = "read" | "contained-write" | "critical";
export const MCP_TOOL_RISK: Record<string, McpToolRisk> = {
  list_runs: "read",
  get_run: "read",
  get_run_digest: "read",
  get_flaky: "read",
  generate_pipeline: "read",
  list_artifacts: "read",
  get_artifact: "read",
  list_schedules: "read",
  dispatch_run: "contained-write",
  run_and_wait: "contained-write",
  rerun_job: "contained-write",
  create_schedule: "contained-write",
  set_schedule_enabled: "contained-write",
  delete_schedule: "contained-write",
  tournament_why: "read",
};

export interface McpToolDef {
  name: string;
  description: string;
}

// Shape-only input schemas (see header note): every field optional so the
// SDK never rejects ahead of the tool body; descriptions spell out the real
// requirements that the tool body enforces with stable -32602 messages.
const repoField = z.string().describe("owner/name (required)").optional();
const shaField = z.string().describe("commit sha, branch, or tag (required)").optional();
const runIdField = z.string().describe("Run id (required)").optional();

const TOOL_SCHEMAS = {
  list_runs: z.object({ limit: z.number().describe("Max runs, 1-50 (default 10)").optional() }),
  get_run: z.object({ runId: runIdField }),
  dispatch_run: z.object({
    repo: repoField,
    sha: shaField,
    ref: z.string().describe("optional branch label").optional(),
    pipeline: z.string().describe("optional inline flare.yml (else fetched at sha)").optional(),
    priority: z.number().describe("0-10; higher jumps queued batch work (agent fast lane)").optional(),
    profile: z.string().describe("optional CI profile from flare.yml (job selection override)").optional(),
    confirm: z.boolean().describe("required true when the server's write-confirm gate is on").optional(),
  }),
  run_and_wait: z.object({
    repo: repoField,
    sha: shaField,
    ref: z.string().describe("optional branch label").optional(),
    pipeline: z.string().describe("optional inline flare.yml (else fetched at sha)").optional(),
    priority: z.number().describe("0-10; higher jumps queued batch work (agent fast lane)").optional(),
    profile: z.string().describe("optional CI profile from flare.yml (job selection override)").optional(),
    timeoutSeconds: z.number().describe("How long to block, 1-90 (default 45)").optional(),
    confirm: z.boolean().describe("required true when the server's write-confirm gate is on").optional(),
  }),
  get_run_digest: z.object({ runId: runIdField }),
  rerun_job: z.object({
    runId: runIdField,
    jobId: z.string().describe("Job id (required)").optional(),
    confirm: z.boolean().describe("required true when the server's write-confirm gate is on").optional(),
  }),
  get_flaky: z.object({
    repo: repoField,
    days: z.number().describe("1-365 (default 30)").optional(),
  }),
  generate_pipeline: z.object({ prompt: z.string().describe("Natural-language pipeline description (required)").optional() }),
  tournament_why: z.object({
    tournamentId: z.string().describe("Tournament id (required)").optional(),
  }),
  list_artifacts: z.object({ runId: runIdField }),
  get_artifact: z.object({
    jobId: z.string().describe("Job id (required)").optional(),
    name: z.string().describe("Artifact name (required, 1-128 word chars/dots/dashes)").optional(),
    maxBytes: z.number().describe("Preview cap, 1-65536 (default 16384)").optional(),
  }),
  list_schedules: z.object({}),
  create_schedule: z.object({
    repo: repoField,
    ref: z.string().describe("Branch or tag to run (required, max 128 chars)").optional(),
    cron: z.string().describe("5-field UTC cron (required)").optional(),
    profile: z.string().describe("optional CI profile from flare.yml").optional(),
    confirm: z.boolean().describe("required true when the server's write-confirm gate is on").optional(),
  }),
  set_schedule_enabled: z.object({
    scheduleId: z.string().describe("Schedule id (required)").optional(),
    enabled: z.boolean().describe("true to enable, false to pause (required)").optional(),
    confirm: z.boolean().describe("required true when the server's write-confirm gate is on").optional(),
  }),
  delete_schedule: z.object({
    scheduleId: z.string().describe("Schedule id (required)").optional(),
    confirm: z.boolean().describe("required true when the server's write-confirm gate is on").optional(),
  }),
};

export const MCP_TOOLS: McpToolDef[] = [
  { name: "list_runs", description: "List recent CI runs (newest first)." },
  { name: "get_run", description: "Get a run with per-job status, step results, log tails, and AI triage." },
  { name: "dispatch_run", description: "Trigger a run for repo@sha. Needs run scope." },
  {
    name: "run_and_wait",
    description:
      "Dispatch a run and block until it finishes, returning a compact digest (status, failing step commands/exit codes, bounded output tails, triage). The one-call verify loop: edit → run_and_wait → fix. Needs run scope.",
  },
  {
    name: "tournament_why",
    description:
      "Explain an agent tournament: task intent, per-agent attempt states and ranks, the verdict rationale, and the decision ledger. Answers why an attempt won or lost.",
  },
  {
    name: "get_run_digest",
    description:
      "Compact, token-efficient run result: per-job status, failing step command/exit code, bounded output tail, and AI triage. Prefer this over get_run for verification loops.",
  },
  { name: "rerun_job", description: "Reset a finished job to queued so a runner picks it up again. Needs run scope." },
  { name: "get_flaky", description: "Per-job failure rates for a repo over the trailing window, worst first." },
  {
    name: "generate_pipeline",
    description: "Generate a flare.yml pipeline from a natural-language description. Needs run scope.",
  },
  { name: "list_artifacts", description: "List a run's uploaded artifacts (job, name, size). Token repo-scoped." },
  {
    name: "get_artifact",
    description: "Read a text artifact's head (bounded preview; binary artifacts must use the HTTP API). Token repo-scoped.",
  },
  { name: "list_schedules", description: "List cron schedules (repo, ref, cron, enabled). Needs an admin token." },
  {
    name: "create_schedule",
    description: "Create a cron schedule that dispatches a repo ref on a 5-field UTC cron. Needs an admin token.",
  },
  { name: "set_schedule_enabled", description: "Enable or pause a cron schedule. Needs an admin token." },
  { name: "delete_schedule", description: "Delete a cron schedule. Needs an admin token." },
];

export interface McpDispatchInput {
  repo: string;
  sha: string;
  ref?: string;
  pipeline?: string;
  priority?: number;
  agent?: string;
  profile?: string;
}

// The X-Flare-Agent header doubles as the run's identity tag — but only
// when it is already a clean slug. Free-form User-Agent strings stay
// out of runs.agent (audit keeps the raw value either way).
export function mcpAgentTag(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const tag = parseAgentTag(header);
  return "agent" in tag ? tag.agent : undefined;
}

export interface McpDeps {
  db: Db;
  ai?: AiBinding;
  canWrite: boolean;
  // Token repo allowlist ([] = every repo) and admin flag, threaded
  // from the validated principal; unset in older callers means all
  // repos and no admin tools.
  repos?: string[];
  isAdmin?: boolean;
  // R2 bucket for the artifact tools (env.CACHE); unset = unconfigured.
  artifacts?: R2Bucket;
  // Artifacts namespace: tournaments scope as `namespace/source_repo`.
  artifactsNamespace?: string;
  // Env-provided AI Gateway id for generate_pipeline (D1 fills the gap
  // inside the tool). Unset = direct inference.
  gatewayId?: string;
  // Agent attribution for the audit trail (X-Flare-Agent or User-Agent).
  agent?: string;
  dispatchRun: (input: McpDispatchInput) => Promise<{ runId: string; jobIds: string[] }>;
  rerunJob: (runId: string, jobId: string) => Promise<{ ok: boolean; error?: string }>;
  // Blocking wait until terminal (or timeout); `timedOut` tells the agent
  // whether to call get_run_digest again later.
  waitForRun: (runId: string, timeoutMs: number) => Promise<{ timedOut: boolean }>;
  digestRun: (runId: string) => Promise<RunDigest | null>;
}

export interface McpResult {
  status: number;
  body?: unknown;
}

type JsonRpcId = string | number | null;

// Internal result envelope (not on the wire anymore — the SDK owns the
// JSON-RPC framing; adaptTool unwraps these into SDK results/errors).
function fail(id: JsonRpcId, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function toolResult(id: JsonRpcId, data: unknown, isError = false): McpResult {
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) },
    },
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function summarizeSteps(result: string): { command: string; exitCode: number; durationMs: number }[] {
  try {
    const parsed = JSON.parse(result) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps)) return [];
    const out: { command: string; exitCode: number; durationMs: number }[] = [];
    for (const s of parsed.steps) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      if (typeof rec.command !== "string" || typeof rec.exitCode !== "number") continue;
      out.push({ command: rec.command.slice(0, 300), exitCode: rec.exitCode, durationMs: typeof rec.durationMs === "number" ? rec.durationMs : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

// WriteGuard wrapper: the run-scope check inside execTool is the
// always-on server-side block; on top, write-tier calls are confirm-gated
// when the admin enables mcp_write_confirm, and every write-tier call is
// audit-logged with agent attribution. Audit detail is identifiers only
// (never free text like pipeline YAML), so secrets cannot leak into it.
const AUDIT_ARG_KEYS = ["repo", "sha", "ref", "runId", "jobId", "priority", "profile", "timeoutSeconds", "limit", "days", "scheduleId", "enabled", "cron"];

function auditTarget(name: string, args: Record<string, unknown>, agent: string | undefined): string {
  const picked: Record<string, unknown> = {};
  for (const k of AUDIT_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") picked[k] = v;
  }
  return `${name} ${JSON.stringify(picked)} agent:${agent ?? "?"}`.slice(0, 500);
}

async function writeConfirmOn(deps: McpDeps): Promise<boolean> {
  try {
    return (await getSetting(deps.db, SETTING_KEYS.mcpWriteConfirm)) === "1";
  } catch {
    return false;
  }
}

async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps, id: JsonRpcId): Promise<McpResult> {
  const tier = MCP_TOOL_RISK[name] ?? "read";
  if (tier !== "read") {
    if ((await writeConfirmOn(deps)) && args.confirm !== true) {
      return fail(id, -32602, `${name} needs confirm: true (write-confirm is on)`);
    }
  }
  const res = await execTool(name, args, deps, id);
  if (tier !== "read") {
    const body = res.body as { error?: unknown; result?: { isError?: boolean } } | undefined;
    const outcome = body?.error || body?.result?.isError ? "error" : "ok";
    await audit(deps.db, deps.agent ?? "mcp", `mcp.${name}`, `${outcome} ${auditTarget(name, args, deps.agent)}`).catch(() => undefined);
  }
  return res;
}

async function execTool(name: string, args: Record<string, unknown>, deps: McpDeps, id: JsonRpcId): Promise<McpResult> {
  switch (name) {
    case "list_runs": {
      const limit = args.limit === undefined ? 10 : num(args.limit);
      if (limit === null || limit < 1 || limit > 50) return fail(id, -32602, "limit must be 1-50");
      const runs = await listRuns(deps.db, Math.floor(limit), 0, deps.repos ?? []);
      return toolResult(id, {
        runs: runs.map((r) => ({ id: r.id, repo: r.repo, sha: r.sha, branch: r.branch, event: r.event, status: r.status, created_at: r.created_at })),
      });
    }
    case "get_run": {
      const runId = str(args.runId);
      if (!runId) return fail(id, -32602, "runId is required");
      const run = await getRun(deps.db, runId);
      // Out-of-scope runs answer like unknown ids (no existence leak).
      if (!run || !reposAllow(deps.repos ?? [], run.repo)) return toolResult(id, { error: "run not found" }, true);
      const jobs = await getJobsForRun(deps.db, runId);
      return toolResult(id, {
        run,
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          labels: j.labels,
          durationMs: jobDurationMs(j),
          steps: summarizeSteps(j.result),
          triage: j.triage || null,
          logTail: j.log.slice(-2000),
        })),
      });
    }
    case "dispatch_run": {
      if (!deps.canWrite) return fail(id, -32602, "dispatch_run needs run scope");
      const repo = str(args.repo);
      const sha = str(args.sha);
      if (!repo || !sha) return fail(id, -32602, "repo and sha are required");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(id, -32602, "repo must be owner/name");
      // Same ref rules as the HTTP dispatch API: slashed branch names
      // work identically on both surfaces.
      if (!/^[\w./-]+$/.test(sha) || sha.length > 128 || sha.includes("..")) {
        return fail(id, -32602, "sha must be a commit SHA, branch, or tag");
      }
      const ref = args.ref === undefined ? undefined : str(args.ref);
      if (ref === null || (ref !== undefined && ref.length > 128)) return fail(id, -32602, "invalid ref");
      const pipeline = args.pipeline === undefined ? undefined : str(args.pipeline);
      if (pipeline === null || (pipeline !== undefined && pipeline.length > 65536)) {
        return fail(id, -32602, "invalid pipeline");
      }
      const priority = args.priority === undefined ? undefined : num(args.priority);
      if (priority === null || (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 10))) {
        return fail(id, -32602, "priority must be an integer 0-10");
      }
      let profile: string | undefined;
      if (args.profile !== undefined) {
        const named = parseProfileName(args.profile);
        if ("error" in named) return fail(id, -32602, named.error);
        profile = named.profile;
      }
      const dispatched = await deps.dispatchRun({ repo, sha, ref, pipeline, priority, agent: mcpAgentTag(deps.agent), profile });
      return toolResult(id, dispatched);
    }
    case "run_and_wait": {
      if (!deps.canWrite) return fail(id, -32602, "run_and_wait needs run scope");
      const repo = str(args.repo);
      const sha = str(args.sha);
      if (!repo || !sha) return fail(id, -32602, "repo and sha are required");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(id, -32602, "repo must be owner/name");
      if (!/^[\w./-]+$/.test(sha) || sha.length > 128 || sha.includes("..")) {
        return fail(id, -32602, "sha must be a commit SHA, branch, or tag");
      }
      const ref = args.ref === undefined ? undefined : str(args.ref);
      if (ref === null || (ref !== undefined && ref.length > 128)) return fail(id, -32602, "invalid ref");
      const pipeline = args.pipeline === undefined ? undefined : str(args.pipeline);
      if (pipeline === null || (pipeline !== undefined && pipeline.length > 65536)) {
        return fail(id, -32602, "invalid pipeline");
      }
      const priority = args.priority === undefined ? undefined : num(args.priority);
      if (priority === null || (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 10))) {
        return fail(id, -32602, "priority must be an integer 0-10");
      }
      const timeoutSeconds = args.timeoutSeconds === undefined ? 45 : num(args.timeoutSeconds);
      if (timeoutSeconds === null || timeoutSeconds < 1 || timeoutSeconds > 90) {
        return fail(id, -32602, "timeoutSeconds must be 1-90");
      }
      let runProfile: string | undefined;
      if (args.profile !== undefined) {
        const named = parseProfileName(args.profile);
        if ("error" in named) return fail(id, -32602, named.error);
        runProfile = named.profile;
      }
      const dispatched = await deps.dispatchRun({ repo, sha, ref, pipeline, priority, agent: mcpAgentTag(deps.agent), profile: runProfile });
      const waited = await deps.waitForRun(dispatched.runId, Math.floor(timeoutSeconds) * 1000);
      const digest = await deps.digestRun(dispatched.runId);
      return toolResult(id, {
        runId: dispatched.runId,
        jobIds: dispatched.jobIds,
        timedOut: waited.timedOut,
        ...(digest ?? {}),
      });
    }
    case "get_run_digest": {
      const runId = str(args.runId);
      if (!runId) return fail(id, -32602, "runId is required");
      if ((deps.repos ?? []).length > 0) {
        const scoped = await getRun(deps.db, runId);
        if (!scoped || !reposAllow(deps.repos ?? [], scoped.repo)) return toolResult(id, { error: "run not found" }, true);
      }
      const digest = await deps.digestRun(runId);
      if (!digest) return toolResult(id, { error: "run not found" }, true);
      return toolResult(id, digest);
    }
    case "tournament_why": {
      const tournamentId = str(args.tournamentId);
      if (!tournamentId) return fail(id, -32602, "tournamentId is required");
      const board = await getTournamentBoard(deps.db, tournamentId);
      if (!board || !tournamentAllowed(deps.repos ?? [], deps.artifactsNamespace ?? "", board.tournament.source_repo)) {
        return toolResult(id, { error: "tournament not found" }, true);
      }
      return toolResult(id, {
        intent: board.tournament.intent,
        state: board.tournament.state,
        attempts: board.attempts.map((a) => ({
          agent: a.agent,
          state: a.state,
          rank: a.verdict_rank,
          runId: a.run_id,
        })),
        verdict: board.verdict
          ? { ranking: board.verdict.ranking, rationale: board.verdict.rationale, model: board.verdict.model }
          : null,
        ledger: board.ledger.map((l) => ({ kind: l.kind, body: l.body })),
      });
    }
    case "rerun_job": {
      if (!deps.canWrite) return fail(id, -32602, "rerun_job needs run scope");
      const runId = str(args.runId);
      const jobId = str(args.jobId);
      if (!runId || !jobId) return fail(id, -32602, "runId and jobId are required");
      if ((deps.repos ?? []).length > 0) {
        const target = await getRun(deps.db, runId);
        if (!target || !reposAllow(deps.repos ?? [], target.repo)) return toolResult(id, { error: "run not found" }, true);
      }
      const res = await deps.rerunJob(runId, jobId);
      if (!res.ok) return toolResult(id, { error: res.error ?? "rerun failed" }, true);
      return toolResult(id, { ok: true });
    }
    case "get_flaky": {
      const repo = str(args.repo);
      if (!repo) return fail(id, -32602, "repo is required");
      if (!reposAllow(deps.repos ?? [], repo)) return toolResult(id, { error: "token is not scoped to that repo" }, true);
      const days = args.days === undefined ? 30 : num(args.days);
      if (days === null || days < 1 || days > 365) return fail(id, -32602, "days must be 1-365");
      return toolResult(id, { stats: await flakyStats(deps.db, repo, Math.floor(days)) });
    }
    case "generate_pipeline": {
      if (!deps.canWrite) return fail(id, -32602, "generate_pipeline needs run scope");
      const prompt = str(args.prompt);
      if (!prompt || prompt.length > 2000) return fail(id, -32602, "prompt is required (max 2000 chars)");
      if (!deps.ai) return toolResult(id, { error: "AI not configured" }, true);
      const outcome = await runGenerateWithStatus(deps.ai, prompt, {
        gatewayId: deps.gatewayId ?? (await getSetting(deps.db, SETTING_KEYS.aiGatewayId)) ?? undefined,
      });
      if (outcome.status === "busy") return toolResult(id, { error: "model busy, retry later", retryable: true }, true);
      if (outcome.status !== "ok") return toolResult(id, { error: "generation failed" }, true);
      return toolResult(id, { yaml: outcome.yaml });
    }
    case "list_artifacts": {
      const runId = str(args.runId);
      if (!runId) return fail(id, -32602, "runId is required");
      const run = await getRun(deps.db, runId);
      // Missing and out-of-scope conflate (no scope oracle), like the
      // REST route's 404.
      if (!run || !reposAllow(deps.repos ?? [], run.repo)) return toolResult(id, { error: "run not found" }, true);
      if (!deps.artifacts) return toolResult(id, { error: "artifact storage not configured" }, true);
      const artifacts = await listRunArtifacts(deps.artifacts, deps.db, run.id);
      if (!artifacts) return toolResult(id, { error: "artifact storage not configured" }, true);
      return toolResult(id, { artifacts });
    }
    case "get_artifact": {
      const jobId = str(args.jobId);
      const name = str(args.name);
      if (!jobId || !name) return fail(id, -32602, "jobId and name are required");
      if (!ARTIFACT_NAME_RE.test(name)) return fail(id, -32602, "invalid artifact name");
      const maxBytes = args.maxBytes === undefined ? 16384 : num(args.maxBytes);
      if (maxBytes === null || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) {
        return fail(id, -32602, "maxBytes must be an integer 1-65536");
      }
      const job = await getJob(deps.db, jobId);
      if (!job) return toolResult(id, { error: "job not found" }, true);
      const run = await getRun(deps.db, job.run_id);
      if (!run || !reposAllow(deps.repos ?? [], run.repo)) return toolResult(id, { error: "job not found" }, true);
      if (!deps.artifacts) return toolResult(id, { error: "artifact storage not configured" }, true);
      // One byte past the cap makes truncation exact without trusting
      // the ranged object's reported size.
      const cap = Math.floor(maxBytes);
      const obj = await deps.artifacts.get(artifactObjectKey(jobId, name), { range: { offset: 0, length: cap + 1 } });
      if (!obj) return toolResult(id, { error: "artifact not found" }, true);
      const buf = new Uint8Array(await obj.arrayBuffer());
      const truncated = buf.length > cap;
      const head = truncated ? buf.slice(0, cap) : buf;
      // Binary sniff on the char-aligned head start; the preview decode
      // itself stays lenient because truncation may split a codepoint.
      try {
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head.slice(0, Math.min(1024, head.length)));
      } catch {
        return toolResult(id, { error: `artifact is binary; download it via GET /v1/jobs/${jobId}/artifacts/${name}` }, true);
      }
      return toolResult(id, { name, bytes: head.byteLength, truncated, text: new TextDecoder().decode(head) });
    }
    case "list_schedules": {
      if (!deps.isAdmin) return fail(id, -32602, "list_schedules needs an admin token");
      const schedules = await listSchedules(deps.db);
      return toolResult(id, {
        schedules: schedules.map((s) => ({
          id: s.id,
          repo: s.repo,
          ref: s.ref,
          cron: s.cron,
          profile: s.profile,
          enabled: s.enabled === 1,
          lastRunAt: s.last_run_at,
          createdAt: s.created_at,
        })),
      });
    }
    case "create_schedule": {
      if (!deps.isAdmin) return fail(id, -32602, "create_schedule needs an admin token");
      const repo = str(args.repo);
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(id, -32602, "repo must be owner/name");
      const ref = str(args.ref);
      if (!ref || !/^[\w./-]+$/.test(ref) || ref.length > 128 || ref.includes("..")) {
        return fail(id, -32602, "ref must be a branch or tag (max 128 chars)");
      }
      const cron = str(args.cron);
      if (!cron) return fail(id, -32602, "cron is required");
      const cronErr = validateCron(cron);
      if (cronErr) return fail(id, -32602, cronErr);
      let profile: string | undefined;
      if (args.profile !== undefined) {
        const named = parseProfileName(args.profile);
        if ("error" in named) return fail(id, -32602, named.error);
        profile = named.profile;
      }
      if (!reposAllow(deps.repos ?? [], repo)) return toolResult(id, { error: "token is not scoped to that repo" }, true);
      if ((await listSchedules(deps.db)).length >= 50) {
        return toolResult(id, { error: "schedule limit reached (50)" }, true);
      }
      const scheduleId = crypto.randomUUID();
      await createSchedule(deps.db, { id: scheduleId, repo, ref, cron: cron.trim(), profile });
      return toolResult(id, { id: scheduleId });
    }
    case "set_schedule_enabled": {
      if (!deps.isAdmin) return fail(id, -32602, "set_schedule_enabled needs an admin token");
      const scheduleId = str(args.scheduleId);
      if (!scheduleId) return fail(id, -32602, "scheduleId is required");
      if (typeof args.enabled !== "boolean") return fail(id, -32602, "enabled must be a boolean");
      const ok = await setScheduleEnabled(deps.db, scheduleId, args.enabled);
      if (!ok) return toolResult(id, { error: "schedule not found" }, true);
      return toolResult(id, { ok: true });
    }
    case "delete_schedule": {
      if (!deps.isAdmin) return fail(id, -32602, "delete_schedule needs an admin token");
      const scheduleId = str(args.scheduleId);
      if (!scheduleId) return fail(id, -32602, "scheduleId is required");
      const ok = await deleteSchedule(deps.db, scheduleId);
      if (!ok) return toolResult(id, { error: "schedule not found" }, true);
      return toolResult(id, { ok: true });
    }
    default:
      return fail(id, -32602, `unknown tool: ${name}`);
  }
}

// Adapter: the tool bodies above speak the internal McpResult envelope
// (kept so WriteGuard, audit, and every validation message stay byte
// identical); the SDK speaks CallToolResult or a thrown ProtocolError,
// which it maps to an isError tool result carrying the message verbatim.
async function adaptTool(name: string, args: Record<string, unknown>, deps: McpDeps): Promise<CallToolResult> {
  const res = await callTool(name, args, deps, 0);
  const body = res.body as { result?: CallToolResult; error?: { code: number; message: string } } | undefined;
  if (body?.error) throw new ProtocolError(body.error.code, body.error.message);
  if (!body?.result) {
    console.log(JSON.stringify({ level: "error", msg: "mcp tool returned no result", tool: name }));
    throw new ProtocolError(-32603, "internal error");
  }
  return body.result;
}

// One server per request (the SDK's stateless factory shape). Scope and
// validation failures stay -32602 protocol errors with the pre-migration
// messages; unexpected throws become -32603 without leaking internals.
export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "flare-actions", version: MCP_SERVER_VERSION });
  for (const tool of MCP_TOOLS) {
    const schema = TOOL_SCHEMAS[tool.name as keyof typeof TOOL_SCHEMAS];
    server.registerTool(tool.name, { description: tool.description, inputSchema: schema }, async (args: Record<string, unknown>) => {
      try {
        return await adaptTool(tool.name, args, deps);
      } catch (err) {
        // Never echo internal error text to clients; the log keeps detail.
        if (err instanceof ProtocolError) throw err;
        console.log(JSON.stringify({ level: "error", msg: "mcp request failed", error: String(err) }));
        throw new ProtocolError(-32603, "internal error");
      }
    });
  }
  return server;
}

export function mcpDiscovery(): Record<string, unknown> {
  return {
    name: "flare-actions",
    version: MCP_SERVER_VERSION,
    protocol: "mcp-streamable-http",
    protocolVersion: MCP_PROTOCOL_VERSION,
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    endpoint: "/mcp",
    accept: "application/json, text/event-stream (both required; responses are SSE data frames)",
    oauth: {
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      registrationEndpoint: "/oauth/register",
      scopes: [MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN, MCP_OAUTH_SCOPE_OFFLINE],
    },
    auth: "Authorization: Bearer <oauth access token or API token> (flare:read for reads, flare:run for dispatch/rerun/generate)",
    tools: MCP_TOOLS.map((t) => t.name),
    toolRisk: MCP_TOOL_RISK,
  };
}
