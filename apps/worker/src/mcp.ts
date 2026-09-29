import { flakyStats, getJobsForRun, getRun, listRuns, type Db } from "./db";
import { jobDurationMs } from "./cost";
import { runGenerate } from "./generate";
import type { AiBinding } from "./triage";

// MCP server over Streamable HTTP: POST JSON-RPC to /mcp. Stateless —
// no session ids — with Bearer auth mapped onto the existing scopes:
// read tools need `read`, dispatch/rerun/generate need `run`.

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_VERSION = "0.2.0";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "list_runs",
    description: "List recent CI runs (newest first).",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max runs, 1-50 (default 10)" } } },
  },
  {
    name: "get_run",
    description: "Get a run with per-job status, step results, log tails, and AI triage.",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
  },
  {
    name: "dispatch_run",
    description: "Trigger a run for repo@sha. Needs run scope.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        sha: { type: "string", description: "commit sha or branch" },
        ref: { type: "string", description: "optional branch label" },
        pipeline: { type: "string", description: "optional inline flare.yml (else fetched at sha)" },
      },
      required: ["repo", "sha"],
    },
  },
  {
    name: "rerun_job",
    description: "Reset a finished job to queued so a runner picks it up again. Needs run scope.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, jobId: { type: "string" } },
      required: ["runId", "jobId"],
    },
  },
  {
    name: "get_flaky",
    description: "Per-job failure rates for a repo over the trailing window, worst first.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, days: { type: "number", description: "1-365 (default 30)" } },
      required: ["repo"],
    },
  },
  {
    name: "generate_pipeline",
    description: "Generate a flare.yml pipeline from a natural-language description. Needs run scope.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  },
];

export interface McpDispatchInput {
  repo: string;
  sha: string;
  ref?: string;
  pipeline?: string;
}

export interface McpDeps {
  db: Db;
  ai?: AiBinding;
  canWrite: boolean;
  dispatchRun: (input: McpDispatchInput) => Promise<{ runId: string; jobIds: string[] }>;
  rerunJob: (runId: string, jobId: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface McpResult {
  status: number;
  body?: unknown;
}

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function fail(id: JsonRpcId, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function toolResult(id: JsonRpcId, data: unknown, isError = false): McpResult {
  return ok(id, { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });
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

async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps, id: JsonRpcId): Promise<McpResult> {
  switch (name) {
    case "list_runs": {
      const limit = args.limit === undefined ? 10 : num(args.limit);
      if (limit === null || limit < 1 || limit > 50) return fail(id, -32602, "limit must be 1-50");
      const runs = await listRuns(deps.db, Math.floor(limit));
      return toolResult(id, {
        runs: runs.map((r) => ({ id: r.id, repo: r.repo, sha: r.sha, branch: r.branch, event: r.event, status: r.status, created_at: r.created_at })),
      });
    }
    case "get_run": {
      const runId = str(args.runId);
      if (!runId) return fail(id, -32602, "runId is required");
      const run = await getRun(deps.db, runId);
      if (!run) return toolResult(id, { error: "run not found" }, true);
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
      if (!/^[\w.-]+$/.test(sha) || sha.length > 128) return fail(id, -32602, "invalid sha");
      const ref = args.ref === undefined ? undefined : str(args.ref);
      if (ref === null || (ref !== undefined && ref.length > 128)) return fail(id, -32602, "invalid ref");
      const pipeline = args.pipeline === undefined ? undefined : str(args.pipeline);
      if (pipeline === null || (pipeline !== undefined && pipeline.length > 65536)) {
        return fail(id, -32602, "invalid pipeline");
      }
      const dispatched = await deps.dispatchRun({ repo, sha, ref, pipeline });
      return toolResult(id, dispatched);
    }
    case "rerun_job": {
      if (!deps.canWrite) return fail(id, -32602, "rerun_job needs run scope");
      const runId = str(args.runId);
      const jobId = str(args.jobId);
      if (!runId || !jobId) return fail(id, -32602, "runId and jobId are required");
      const res = await deps.rerunJob(runId, jobId);
      if (!res.ok) return toolResult(id, { error: res.error ?? "rerun failed" }, true);
      return toolResult(id, { ok: true });
    }
    case "get_flaky": {
      const repo = str(args.repo);
      if (!repo) return fail(id, -32602, "repo is required");
      const days = args.days === undefined ? 30 : num(args.days);
      if (days === null || days < 1 || days > 365) return fail(id, -32602, "days must be 1-365");
      return toolResult(id, { stats: await flakyStats(deps.db, repo, Math.floor(days)) });
    }
    case "generate_pipeline": {
      if (!deps.canWrite) return fail(id, -32602, "generate_pipeline needs run scope");
      const prompt = str(args.prompt);
      if (!prompt || prompt.length > 2000) return fail(id, -32602, "prompt is required (max 2000 chars)");
      if (!deps.ai) return toolResult(id, { error: "AI not configured" }, true);
      const yaml = await runGenerate(deps.ai, prompt);
      if (!yaml) return toolResult(id, { error: "generation failed" }, true);
      return toolResult(id, { yaml });
    }
    default:
      return fail(id, -32602, `unknown tool: ${name}`);
  }
}

export async function handleMcpMessage(msg: unknown, deps: McpDeps): Promise<McpResult> {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return fail(null, -32600, "invalid request");
  }
  const rec = msg as Record<string, unknown>;
  const id = rec.id === undefined ? undefined : (rec.id as JsonRpcId);
  if (rec.jsonrpc !== "2.0" || typeof rec.method !== "string") {
    return fail(typeof id === "string" || typeof id === "number" ? id : null, -32600, "invalid request");
  }
  // Notifications (no id) get no response body.
  if (id === undefined) return { status: 202 };
  const normId: JsonRpcId = typeof id === "string" || typeof id === "number" ? id : null;
  try {
    switch (rec.method) {
      case "initialize":
        return ok(normId, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "flare-actions", version: MCP_SERVER_VERSION },
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return { status: 202 };
      case "tools/list":
        return ok(normId, { tools: MCP_TOOLS });
      case "tools/call": {
        const params = (rec.params ?? {}) as Record<string, unknown>;
        if (typeof params !== "object" || params === null || typeof params.name !== "string") {
          return fail(normId, -32602, "tool name is required");
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          return fail(normId, -32602, "arguments must be an object");
        }
        return await callTool(params.name, args, deps, normId);
      }
      default:
        if (rec.method.startsWith("notifications/")) return { status: 202 };
        return fail(normId, -32601, `method not found: ${rec.method}`);
    }
  } catch (err) {
    return fail(normId, -32603, `internal error: ${String(err)}`);
  }
}

export function mcpDiscovery(): Record<string, unknown> {
  return {
    name: "flare-actions",
    version: MCP_SERVER_VERSION,
    protocol: "mcp-streamable-http",
    protocolVersion: MCP_PROTOCOL_VERSION,
    endpoint: "/mcp",
    auth: "Authorization: Bearer <token> (readonly for reads, runner for dispatch/rerun/generate)",
    tools: MCP_TOOLS.map((t) => t.name),
  };
}
