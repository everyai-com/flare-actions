// Local MCP server (stdio) for warm dev boxes: agents running on
// this machine drive boxes over JSON-RPC without touching the
// hosted API. This grants the MCP client local code execution by
// design (devbox_exec runs arbitrary commands) — only register it
// with clients you trust, same as any shell-capable MCP server.
import { createInterface } from "node:readline";
import type { DevboxOps } from "./devbox.ts";

export const DEVBOX_MCP_VERSION = "0.1.0";
export const DEVBOX_MCP_PROTOCOLS = ["2026-07-28", "2024-11-05"];
const DEFAULT_PROTOCOL = "2026-07-28";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required?: string[] };
}

export const DEVBOX_MCP_TOOLS: ToolDef[] = [
  {
    name: "devbox_create",
    description: "Create a persistent warm dev box (a named local container with a /work dir).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, image: { type: "string", description: "Docker image (default alpine:3.20)." } },
      required: ["name"],
    },
  },
  {
    name: "devbox_exec",
    description: "Run a command in a dev box workdir; returns exit code plus truncated stdout/stderr.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        cmd: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["name", "cmd"],
    },
  },
  {
    name: "devbox_sync",
    description: "Tar local paths and extract them into the box workdir.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        dir: { type: "string", description: "Local directory the paths are relative to (default: process cwd)." },
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    },
  },
  {
    name: "devbox_fetch",
    description: "Copy a workdir-relative path out of the box into a local directory.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, path: { type: "string" }, dir: { type: "string" } },
      required: ["name", "path"],
    },
  },
  {
    name: "devbox_snapshot",
    description: "Commit the box filesystem to a named local image tag.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, tag: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "devbox_restore",
    description: "Recreate the box instance from one of its snapshot tags.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, tag: { type: "string" } },
      required: ["name", "tag"],
    },
  },
  {
    name: "devbox_list",
    description: "List all dev boxes with their images, workdirs, and snapshot tags.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "devbox_destroy",
    description: "Remove the box instance (snapshot images are kept; prune with docker).",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

type JsonRpcId = string | number | null;

function response(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function errorResponse(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`argument ${key} must be a non-empty string`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) throw new Error(`argument ${key} must be a non-empty string`);
  return v;
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) throw new Error(`argument ${key} must be a non-empty string array`);
  const out: string[] = [];
  for (const e of v) {
    if (typeof e !== "string") throw new Error(`argument ${key} must be a non-empty string array`);
    out.push(e);
  }
  return out;
}

function optStrRecord(args: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  const rec = asRecord(v);
  if (!rec) throw new Error(`argument ${key} must be an object of string to string`);
  const out: Record<string, string> = {};
  for (const [k, e] of Object.entries(rec)) {
    if (typeof e !== "string") throw new Error(`argument ${key} must be an object of string to string`);
    out[k] = e;
  }
  return out;
}

function toolResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolError(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true as const };
}

async function callTool(ops: DevboxOps, name: string, params: unknown): Promise<unknown> {
  const args = asRecord(params) ?? {};
  switch (name) {
    case "devbox_create":
      return toolResult(await ops.create(reqStr(args, "name"), { image: optStr(args, "image") }));
    case "devbox_exec":
      return toolResult(
        await ops.exec(reqStr(args, "name"), strArray(args, "cmd"), { cwd: optStr(args, "cwd"), env: optStrRecord(args, "env") }),
      );
    case "devbox_sync": {
      const raw = args["paths"];
      const paths = raw === undefined ? ["."] : Array.isArray(raw) ? raw : null;
      if (!paths || paths.length === 0 || !paths.every((e): e is string => typeof e === "string")) {
        throw new Error("argument paths must be a non-empty string array");
      }
      return toolResult(await ops.sync(reqStr(args, "name"), optStr(args, "dir") ?? process.cwd(), paths));
    }
    case "devbox_fetch":
      return toolResult(await ops.fetch(reqStr(args, "name"), reqStr(args, "path"), optStr(args, "dir") ?? process.cwd()));
    case "devbox_snapshot":
      return toolResult(await ops.snapshot(reqStr(args, "name"), optStr(args, "tag")));
    case "devbox_restore":
      return toolResult(await ops.restore(reqStr(args, "name"), reqStr(args, "tag")));
    case "devbox_list":
      return toolResult(await ops.list());
    case "devbox_destroy":
      return toolResult(await ops.destroy(reqStr(args, "name")));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// One JSON-RPC message in, one response line out (null for
// notifications). Never throws: protocol violations become JSON-RPC
// errors, tool failures become isError results the agent reads.
export async function handleDevboxMcpMessage(ops: DevboxOps, line: string): Promise<string | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(line) as unknown;
  } catch {
    return errorResponse(null, -32700, "parse error: expected one JSON object per line");
  }
  const rec = asRecord(msg);
  if (rec === null || typeof rec["method"] !== "string") return errorResponse(null, -32600, "invalid request: missing method");
  if (!("id" in rec)) return null; // Notification: no response ever.
  const rawId: unknown = rec["id"];
  if (typeof rawId !== "string" && typeof rawId !== "number" && rawId !== null) {
    return errorResponse(null, -32600, "invalid request: id must be a string, number, or null");
  }
  const id: JsonRpcId = rawId;
  const method = rec["method"] as string;
  try {
    switch (method) {
      case "initialize": {
        const params = asRecord(rec["params"]) ?? {};
        const asked = typeof params["protocolVersion"] === "string" ? (params["protocolVersion"] as string) : "";
        const negotiated = (DEVBOX_MCP_PROTOCOLS as string[]).includes(asked) ? asked : DEFAULT_PROTOCOL;
        return response(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: "flare-devbox", version: DEVBOX_MCP_VERSION },
        });
      }
      case "notifications/initialized":
        return null;
      case "ping":
        return response(id, {});
      case "tools/list":
        return response(id, { tools: DEVBOX_MCP_TOOLS });
      case "tools/call": {
        const params = asRecord(rec["params"]) ?? {};
        const name = params["name"];
        if (typeof name !== "string" || !DEVBOX_MCP_TOOLS.some((t) => t.name === name)) {
          return errorResponse(id, -32602, `unknown tool: ${typeof name === "string" ? name : JSON.stringify(name) ?? "?"}`);
        }
        try {
          return response(id, await callTool(ops, name, params["arguments"]));
        } catch (err) {
          return response(id, toolError(err instanceof Error ? err.message : String(err)));
        }
      }
      default:
        return errorResponse(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    return errorResponse(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

export async function runDevboxMcpServer(ops: DevboxOps): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const out = await handleDevboxMcpMessage(ops, line);
    if (out !== null) process.stdout.write(`${out}\n`);
  }
}
