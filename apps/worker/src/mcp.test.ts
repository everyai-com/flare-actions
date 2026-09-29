import { describe, expect, it } from "vitest";
import { handleMcpMessage, mcpDiscovery, MCP_TOOLS, type McpDeps } from "./mcp";
import type { Db } from "./db";

function fakeDb(routes: { all?: unknown[]; first?: unknown }): Db {
  return {
    prepare(_sql: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            all: async <T,>() => ({ results: (routes.all ?? []) as T[] }),
            first: async <T,>() => (routes.first ?? null) as T | null,
            run: async () => ({}),
          };
        },
      };
    },
  };
}

const RUN = {
  id: "run1",
  repo: "o/r",
  sha: "abc123",
  branch: "main",
  event: "push",
  installation_id: null,
  status: "success",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:01:00.000Z",
};

const JOB = {
  id: "job1",
  run_id: "run1",
  status: "success",
  log: "ok",
  name: "test",
  definition: JSON.stringify({ steps: [{ run: "echo" }], base: "test" }),
  result: JSON.stringify({ steps: [{ command: "echo", exitCode: 0, durationMs: 5 }] }),
  triage: "",
  labels: "",
  started_at: "2026-01-01T00:00:00.000Z",
  finished_at: "2026-01-01T00:01:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:01:00.000Z",
};

function deps(over: Partial<McpDeps> = {}): McpDeps {
  return {
    db: fakeDb({ all: [RUN], first: RUN }),
    canWrite: true,
    dispatchRun: async () => ({ runId: "run9", jobIds: ["job9"] }),
    rerunJob: async () => ({ ok: true }),
    ...over,
  };
}

describe("mcp", () => {
  it("handles initialize and tools/list", async () => {
    const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps());
    expect(init.status).toBe(200);
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("flare-actions");
    const list = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, deps());
    expect(((list.body as { result: { tools: unknown[] } }).result.tools)).toHaveLength(MCP_TOOLS.length);
  });

  it("answers notifications with 202 and no body", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, deps());
    expect(res).toEqual({ status: 202 });
  });

  it("rejects malformed requests", async () => {
    const bad = await handleMcpMessage({ jsonrpc: "1.0", id: 1, method: "tools/list" }, deps());
    expect(((bad.body as { error: { code: number } }).error.code)).toBe(-32600);
    const nomethod = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "bogus" }, deps());
    expect(((nomethod.body as { error: { code: number } }).error.code)).toBe(-32601);
    const notool = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bogus", arguments: {} } },
      deps(),
    );
    expect(((notool.body as { error: { code: number } }).error.code)).toBe(-32602);
  });

  it("lists runs and gets run detail", async () => {
    const d = deps({ db: fakeDb({ all: [RUN], first: RUN }) });
    const listed = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_runs", arguments: {} } }, d);
    const text = ((listed.body as { result: { content: { text: string }[] } }).result.content[0].text);
    expect(JSON.parse(text).runs[0].id).toBe("run1");
    const d2 = deps({ db: fakeDb({ all: [JOB], first: RUN }) });
    const got = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_run", arguments: { runId: "run1" } } },
      d2,
    );
    const detail = JSON.parse(((got.body as { result: { content: { text: string }[] } }).result.content[0].text));
    expect(detail.jobs[0].durationMs).toBe(60000);
    expect(detail.jobs[0].steps[0].exitCode).toBe(0);
  });

  it("gates write tools on scope", async () => {
    const d = deps({ canWrite: false });
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dispatch_run", arguments: { repo: "o/r", sha: "abc" } } },
      d,
    );
    expect(((res.body as { error: { message: string } }).error.message)).toContain("run scope");
  });

  it("dispatches, reruns, flakes, and generates", async () => {
    const d = deps({ ai: { run: async () => ({ response: "jobs:\n  a: {}\n" }) } });
    const dis = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dispatch_run", arguments: { repo: "o/r", sha: "abc" } } },
      d,
    );
    expect(JSON.parse(((dis.body as { result: { content: { text: string }[] } }).result.content[0].text)).runId).toBe("run9");
    const badRepo = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dispatch_run", arguments: { repo: "nope", sha: "abc" } } },
      d,
    );
    expect(((badRepo.body as { error: { code: number } }).error.code)).toBe(-32602);
    const re = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rerun_job", arguments: { runId: "r", jobId: "j" } } },
      d,
    );
    expect(JSON.parse(((re.body as { result: { content: { text: string }[] } }).result.content[0].text)).ok).toBe(true);
    const fl = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_flaky", arguments: { repo: "o/r" } } },
      deps({ db: fakeDb({ all: [], first: null }) }),
    );
    expect(JSON.parse(((fl.body as { result: { content: { text: string }[] } }).result.content[0].text)).stats).toEqual([]);
    const gen = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_pipeline", arguments: { prompt: "node" } } },
      d,
    );
    expect(JSON.parse(((gen.body as { result: { content: { text: string }[] } }).result.content[0].text)).yaml).toContain("jobs:");
  });

  it("exposes discovery metadata", () => {
    expect(mcpDiscovery().tools).toContain("dispatch_run");
  });
});
