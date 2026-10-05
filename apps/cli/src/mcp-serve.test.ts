import { describe, expect, it } from "vitest";
import { DEVBOX_MCP_TOOLS, handleDevboxMcpMessage } from "./mcp-serve";
import type { DevboxOps } from "./devbox";

function fakeOps(overrides: Partial<DevboxOps> = {}): DevboxOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: () => {
      calls.push("list");
      return [];
    },
    create: async (name) => {
      calls.push(`create:${name}`);
      return { name, container: `c-${name}`, image: "i", workdir: "/work", createdAt: "", snapshots: [] };
    },
    exec: async (name, cmd) => {
      calls.push(`exec:${name}:${cmd.join(" ")}`);
      return { exitCode: 0, stdout: "ok", stderr: "", truncated: false };
    },
    sync: async (name, dir, paths) => {
      calls.push(`sync:${name}:${dir}:${paths.join(",")}`);
      return { bytes: 10, paths };
    },
    fetch: async (name, path, dir) => {
      calls.push(`fetch:${name}:${path}:${dir}`);
      return { bytes: 10, path };
    },
    snapshot: async (name, tag) => {
      calls.push(`snapshot:${name}:${tag ?? ""}`);
      return { tag: tag ?? "auto", createdAt: "" };
    },
    restore: async (name, tag) => {
      calls.push(`restore:${name}:${tag}`);
      return { name, container: `c-${name}`, image: "i", workdir: "/work", createdAt: "", snapshots: [] };
    },
    destroy: async (name) => {
      calls.push(`destroy:${name}`);
      return { name, imagesKept: [] };
    },
    ...overrides,
  };
}

async function rpc(ops: DevboxOps, msg: object): Promise<Record<string, unknown>> {
  const out = await handleDevboxMcpMessage(ops, JSON.stringify(msg));
  if (out === null) throw new Error("expected a response, got notification-null");
  return JSON.parse(out) as Record<string, unknown>;
}

describe("devbox MCP server", () => {
  it("negotiates the protocol version and identifies itself", async () => {
    const res = await rpc(fakeOps(), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const result = res["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2024-11-05");
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("flare-devbox");
    const fallback = await rpc(fakeOps(), { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((fallback["result"] as Record<string, unknown>)["protocolVersion"]).toBe("2026-07-28");
  });

  it("answers ping and stays silent on notifications", async () => {
    const ops = fakeOps();
    expect(await rpc(ops, { jsonrpc: "2.0", id: 1, method: "ping" })).toMatchObject({ id: 1, result: {} });
    expect(await handleDevboxMcpMessage(ops, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    // Blank-line skipping lives in the stdio loop; the handler reports it.
    expect(JSON.parse((await handleDevboxMcpMessage(ops, "   ")) as string) as object).toMatchObject({
      error: { code: -32700 },
    });
  });

  it("lists the eight devbox tools", async () => {
    const res = await rpc(fakeOps(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res["result"] as Record<string, unknown>)["tools"] as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(DEVBOX_MCP_TOOLS.map((t) => t.name).sort());
    expect(tools).toHaveLength(8);
  });

  it("routes tools/call to the box manager and wraps results as text", async () => {
    const ops = fakeOps();
    const res = await rpc(ops, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "devbox_exec", arguments: { name: "api", cmd: ["make", "test"] } },
    });
    expect(ops.calls).toEqual(["exec:api:make test"]);
    const result = res["result"] as Record<string, unknown>;
    expect(result["isError"]).toBeUndefined();
    const text = ((result["content"] as { text: string }[])[0] as { text: string }).text;
    expect(JSON.parse(text) as object).toMatchObject({ exitCode: 0, stdout: "ok" });
  });

  it("reports tool failures as isError results, not protocol errors", async () => {
    const ops = fakeOps({ destroy: async () => Promise.reject(new Error('unknown devbox "ghost"')) });
    const res = await rpc(ops, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "devbox_destroy", arguments: { name: "ghost" } },
    });
    expect(res["error"]).toBeUndefined();
    const result = res["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
  });

  it("rejects unknown tools and methods with protocol errors", async () => {
    const ops = fakeOps();
    const badTool = await rpc(ops, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "devbox_hack" } });
    expect((badTool["error"] as Record<string, unknown>)["code"]).toBe(-32602);
    const badMethod = await rpc(ops, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    expect((badMethod["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    expect(ops.calls).toEqual([]);
  });

  it("rejects malformed input without throwing", async () => {
    const ops = fakeOps();
    const parse = await handleDevboxMcpMessage(ops, "{not json");
    expect(JSON.parse(parse as string) as object).toMatchObject({ error: { code: -32700 } });
    const noMethod = await rpc(ops, { jsonrpc: "2.0", id: 1 });
    expect((noMethod["error"] as Record<string, unknown>)["code"]).toBe(-32600);
    const badId = await handleDevboxMcpMessage(ops, JSON.stringify({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }));
    expect(JSON.parse(badId as string) as object).toMatchObject({ error: { code: -32600 } });
  });

  it("validates tool arguments and surfaces them as isError", async () => {
    const ops = fakeOps();
    const res = await rpc(ops, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "devbox_exec", arguments: { name: "api", cmd: [] } },
    });
    const result = res["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    expect(ops.calls).toEqual([]);
  });
});
