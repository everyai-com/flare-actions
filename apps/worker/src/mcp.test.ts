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
  source: null,
  pr_number: null,
  pr_comment_id: null,
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
  priority: 0,
  attempts: 0,
  started_at: "2026-01-01T00:00:00.000Z",
  finished_at: "2026-01-01T00:01:00.000Z",
  retained_until: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:01:00.000Z",
};

function deps(over: Partial<McpDeps> = {}): McpDeps {
  return {
    db: fakeDb({ all: [RUN], first: RUN }),
    canWrite: true,
    dispatchRun: async () => ({ runId: "run9", jobIds: ["job9"] }),
    rerunJob: async () => ({ ok: true }),
    waitForRun: async () => ({ timedOut: false }),
    digestRun: async () => null,
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

  it("runs and waits in one call, returning the digest", async () => {
    const calls: { runId: string; timeoutMs: number }[] = [];
    const digest = {
      runId: "run9",
      repo: "o/r",
      sha: "abc",
      branch: "main",
      event: "dispatch",
      status: "failure",
      durationMs: 42000,
      totalJobs: 1,
      failedJobs: 1,
      jobs: [{ id: "job9", name: "test", status: "failure", durationMs: 40000, stepCount: 2 }],
    };
    const d = deps({
      waitForRun: async (runId, timeoutMs) => {
        calls.push({ runId, timeoutMs });
        return { timedOut: false };
      },
      digestRun: async () => digest,
    });
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_and_wait", arguments: { repo: "o/r", sha: "main", priority: 9, timeoutSeconds: 30 } },
      },
      d,
    );
    const out = JSON.parse(((res.body as { result: { content: { text: string }[] } }).result.content[0].text));
    expect(out.runId).toBe("run9");
    expect(out.timedOut).toBe(false);
    expect(out.failedJobs).toBe(1);
    expect(calls).toEqual([{ runId: "run9", timeoutMs: 30000 }]);
  });

  it("validates run_and_wait inputs and scope", async () => {
    const d = deps({ canWrite: false });
    const gated = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_and_wait", arguments: { repo: "o/r", sha: "main" } } },
      d,
    );
    expect(((gated.body as { error: { message: string } }).error.message)).toContain("run scope");
    const badTimeout = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_and_wait", arguments: { repo: "o/r", sha: "main", timeoutSeconds: 120 } },
      },
      deps(),
    );
    expect(((badTimeout.body as { error: { message: string } }).error.message)).toContain("timeoutSeconds");
  });

  it("serves compact digests and reports missing runs as tool errors", async () => {
    const d = deps({
      digestRun: async (runId) =>
        runId === "run1"
          ? {
              runId,
              repo: "o/r",
              sha: "abc",
              branch: "main",
              event: "dispatch",
              status: "success",
              durationMs: 1000,
              totalJobs: 1,
              failedJobs: 0,
              jobs: [],
            }
          : null,
    });
    const ok = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_run_digest", arguments: { runId: "run1" } } },
      d,
    );
    expect(JSON.parse(((ok.body as { result: { content: { text: string }[] } }).result.content[0].text)).status).toBe("success");
    const missing = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_run_digest", arguments: { runId: "nope" } } },
      d,
    );
    const body = missing.body as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });

  it("exposes discovery metadata", () => {
    expect(mcpDiscovery().tools).toContain("dispatch_run");
    expect(mcpDiscovery().tools).toContain("run_and_wait");
    expect(mcpDiscovery().tools).toContain("get_run_digest");
    expect(mcpDiscovery().protocolVersions).toContain("2024-11-05");
    expect((mcpDiscovery().toolRisk as Record<string, string>).dispatch_run).toBe("contained-write");
    expect((mcpDiscovery().toolRisk as Record<string, string>).list_runs).toBe("read");
  });

  it("negotiates protocol versions and serves server/discover", async () => {
    const init = async (params: unknown) =>
      (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params }, deps())).body as {
        result: { protocolVersion: string };
      };
    expect((await init({ protocolVersion: "2024-11-05" })).result.protocolVersion).toBe("2024-11-05");
    expect((await init({ protocolVersion: "2026-07-28" })).result.protocolVersion).toBe("2026-07-28");
    expect((await init({})).result.protocolVersion).toBe("2026-07-28");
    expect((await init({ protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2026-07-28");
    const disc = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "server/discover" }, deps())).body as {
      result: { tools: string[] };
    };
    expect(disc.result.tools).toContain("dispatch_run");
  });

  it("confirm-gates write tools only when the setting is on", async () => {
    const call = (db: Db, args: Record<string, unknown>) =>
      handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rerun_job", arguments: args } },
        deps({ db }),
      );
    const on = fakeDb({ first: { value: "1" } });
    const blocked = await call(on, { runId: "r", jobId: "j" });
    expect(((blocked.body as { error: { message: string } }).error.message)).toContain("confirm");
    const confirmed = await call(on, { runId: "r", jobId: "j", confirm: true });
    expect(JSON.parse(((confirmed.body as { result: { content: { text: string }[] } }).result.content[0].text)).ok).toBe(true);
    const off = await call(fakeDb({ first: null }), { runId: "r", jobId: "j" });
    expect(JSON.parse(((off.body as { result: { content: { text: string }[] } }).result.content[0].text)).ok).toBe(true);
  });

  it("audits write-tier calls with attribution and identifiers only", async () => {
    const runs: { sql: string; values: unknown[] }[] = [];
    const db: Db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              all: async <T,>() => ({ results: [] as T[] }),
              first: async <T,>() => null as T | null,
              run: async () => {
                runs.push({ sql, values });
                return {};
              },
            };
          },
        };
      },
    };
    await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "dispatch_run",
          arguments: { repo: "o/r", sha: "abc", pipeline: "jobs:\n env:\n  TOKEN: s3cret-value" },
        },
      },
      deps({ db, agent: "agent-x" }),
    );
    const audits = runs.filter((r) => r.sql.startsWith("INSERT INTO audit_log"));
    expect(audits).toHaveLength(1);
    expect(audits[0].values[1]).toBe("agent-x");
    expect(audits[0].values[2]).toBe("mcp.dispatch_run");
    const target = audits[0].values[3] as string;
    expect(target).toContain("ok");
    expect(target).toContain("o/r");
    expect(target).not.toContain("s3cret-value");
    expect(target).not.toContain("pipeline");

    // Read-tier calls leave no audit rows.
    runs.length = 0;
    await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_runs", arguments: {} } },
      deps({ db, agent: "agent-x" }),
    );
    expect(runs.filter((r) => r.sql.startsWith("INSERT INTO audit_log"))).toHaveLength(0);
  });
});
