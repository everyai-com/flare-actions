import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { buildMcpServer, mcpAgentTag, mcpDiscovery, MCP_INSTRUCTIONS, MCP_TOOLS, type McpDeps } from "./mcp";

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

interface RpcOut {
  status: number;
  body: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null;
  raw: string;
}

// Drives the real SDK transport (per-request server, like prod): POSTs one
// JSON-RPC message and unwraps the SSE `data:` frame (request-level
// rejections like 400/406 come back as plain JSON instead).
async function rpc(d: McpDeps, msg: unknown, headers: Record<string, string> = {}): Promise<RpcOut> {
  const handler = createMcpHandler(() => buildMcpServer(d));
  const res = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: typeof msg === "string" ? msg : JSON.stringify(msg),
    }),
  );
  const raw = await res.text();
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    return { status: res.status, body: raw ? (JSON.parse(raw) as RpcOut["body"]) : null, raw };
  }
  const data = raw
    .split("\n")
    .find((l) => l.startsWith("data: "))
    ?.slice("data: ".length);
  return { status: res.status, body: data ? (JSON.parse(data) as RpcOut["body"]) : null, raw };
}

function text(body: RpcOut["body"]): string {
  return ((body as { result: { content: { text: string }[] } }).result.content[0].text);
}

// Tool failures (scope, validation, confirm gate) surface as isError tool
// results with the pre-migration message text — the SDK maps thrown tool
// errors there instead of -32602 protocol errors.
function toolErr(body: RpcOut["body"]): { isError: boolean; text: string } {
  const result = (body as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: result.isError === true, text: result.content[0].text };
}

describe("mcp", () => {
  it("handles initialize and tools/list", async () => {
    const init = await rpc(deps(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("flare-actions");
    const list = await rpc(deps(), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((list.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(MCP_TOOLS.length);
  });

  it("sends start-here instructions that only name real tools", async () => {
    const init = await rpc(deps(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect((init.body as { result: { instructions?: string } }).result.instructions).toBe(MCP_INSTRUCTIONS);
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    for (const m of MCP_INSTRUCTIONS.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) expect(names, m[1]).toContain(m[1]);
  });

  it("answers notifications with 202 and no body", async () => {
    const res = await rpc(deps(), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it("rejects malformed requests", async () => {
    // Request-level rejections are HTTP 400 + plain JSON (SDK behavior;
    // the pre-migration server answered these with HTTP 200).
    const bad = await rpc(deps(), { jsonrpc: "1.0", id: 1, method: "tools/list" });
    expect(bad.status).toBe(400);
    expect(bad.body?.error?.code).toBe(-32600);
    const nomethod = await rpc(deps(), { jsonrpc: "2.0", id: 1, method: "bogus" });
    expect(nomethod.body?.error?.code).toBe(-32601);
    const notool = await rpc(deps(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "bogus", arguments: {} },
    });
    expect(notool.body?.error?.code).toBe(-32602);
    const parse = await rpc(deps(), "{not json");
    expect(parse.status).toBe(400);
    expect(parse.body?.error?.code).toBe(-32700);
  });

  it("requires the dual Accept header", async () => {
    const res = await rpc(deps(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { accept: "application/json" });
    expect(res.status).toBe(406);
  });

  it("lists runs and gets run detail", async () => {
    const d = deps({ db: fakeDb({ all: [RUN], first: RUN }) });
    const listed = await rpc(d, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_runs", arguments: {} } });
    expect(JSON.parse(text(listed.body)).runs[0].id).toBe("run1");
    const d2 = deps({ db: fakeDb({ all: [JOB], first: RUN }) });
    const got = await rpc(d2, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_run", arguments: { runId: "run1" } },
    });
    const detail = JSON.parse(text(got.body));
    expect(detail.jobs[0].durationMs).toBe(60000);
    expect(detail.jobs[0].steps[0].exitCode).toBe(0);
  });

  it("scopes list_runs, get_run, digests, reruns, and flaky to the token allowlist", async () => {
    const seen: { sql: string; binds: unknown[] }[] = [];
    const recording: Db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            seen.push({ sql, binds: values });
            return {
              all: async <T,>() => ({ results: (/FROM jobs/.test(sql) ? [JOB] : [RUN]) as T[] }),
              first: async <T,>() => RUN as T,
              run: async () => ({}),
            };
          },
        };
      },
    };
    const call = (name: string, args: Record<string, unknown>, repos: string[]) =>
      rpc(deps({ db: recording, repos }), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    await call("list_runs", {}, ["other/r"]);
    const listSql = seen.find((q) => q.sql.includes("FROM runs") && q.sql.includes("LIMIT"));
    expect(listSql?.sql).toContain("lower(repo) IN");
    expect(listSql?.binds).toContain("other/r");
    // RUN lives in o/r: a token scoped elsewhere sees "not found".
    for (const [name, args] of [
      ["get_run", { runId: "run1" }],
      ["get_run_digest", { runId: "run1" }],
      ["rerun_job", { runId: "run1", jobId: "job1" }],
    ] as const) {
      const denied = toolErr((await call(name, args, ["other/r"])).body);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("not found");
    }
    const flaky = toolErr((await call("get_flaky", { repo: "o/r" }, ["other/r"])).body);
    expect(flaky.isError).toBe(true);
    // In scope: detail comes back.
    const ok = await call("get_run", { runId: "run1" }, ["o/*"]);
    expect(JSON.parse(text(ok.body)).run.id).toBe("run1");
  });

  it("passes the CI profile override through dispatch_run", async () => {
    let seen: unknown;
    const d = deps({ dispatchRun: async (input) => { seen = input; return { runId: "run9", jobIds: ["job9"] }; } });
    const ok = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_run", arguments: { repo: "o/r", sha: "abc", profile: "smoke" } },
    });
    expect(JSON.parse(text(ok.body)).runId).toBe("run9");
    expect(seen).toMatchObject({ profile: "smoke" });
    const bad = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_run", arguments: { repo: "o/r", sha: "abc", profile: "has space" } },
    });
    const badErr = toolErr(bad.body);
    expect(badErr.isError).toBe(true);
    expect(badErr.text).toContain("profile must be 1-64 chars");
  });

  it("gates write tools on scope", async () => {
    const d = deps({ canWrite: false });
    const res = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_run", arguments: { repo: "o/r", sha: "abc" } },
    });
    const err = toolErr(res.body);
    expect(err.isError).toBe(true);
    expect(err.text).toContain("run scope");
  });

  it("dispatches, reruns, flakes, and generates", async () => {
    const d = deps({ ai: { run: async () => ({ response: "jobs:\n  a: {}\n" }) } });
    const dis = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_run", arguments: { repo: "o/r", sha: "abc" } },
    });
    expect(JSON.parse(text(dis.body)).runId).toBe("run9");
    const badRepo = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_run", arguments: { repo: "nope", sha: "abc" } },
    });
    const badRepoErr = toolErr(badRepo.body);
    expect(badRepoErr.isError).toBe(true);
    expect(badRepoErr.text).toContain("repo must be owner/name");
    const re = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "rerun_job", arguments: { runId: "r", jobId: "j" } },
    });
    expect(JSON.parse(text(re.body)).ok).toBe(true);
    const fl = await rpc(
      deps({ db: fakeDb({ all: [], first: null }) }),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_flaky", arguments: { repo: "o/r" } } },
    );
    expect(JSON.parse(text(fl.body)).stats).toEqual([]);
    const gen = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "generate_pipeline", arguments: { prompt: "node" } },
    });
    expect(JSON.parse(text(gen.body)).yaml).toContain("jobs:");
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
    const res = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_and_wait", arguments: { repo: "o/r", sha: "main", priority: 9, timeoutSeconds: 30 } },
    });
    const out = JSON.parse(text(res.body));
    expect(out.runId).toBe("run9");
    expect(out.timedOut).toBe(false);
    expect(out.failedJobs).toBe(1);
    expect(calls).toEqual([{ runId: "run9", timeoutMs: 30000 }]);
  });

  it("validates run_and_wait inputs and scope", async () => {
    const d = deps({ canWrite: false });
    const gated = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_and_wait", arguments: { repo: "o/r", sha: "main" } },
    });
    const gatedErr = toolErr(gated.body);
    expect(gatedErr.isError).toBe(true);
    expect(gatedErr.text).toContain("run scope");
    const badTimeout = await rpc(
      deps(),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_and_wait", arguments: { repo: "o/r", sha: "main", timeoutSeconds: 120 } },
      },
    );
    const timeoutErr = toolErr(badTimeout.body);
    expect(timeoutErr.isError).toBe(true);
    expect(timeoutErr.text).toContain("timeoutSeconds");
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
    const ok = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_run_digest", arguments: { runId: "run1" } },
    });
    expect(JSON.parse(text(ok.body)).status).toBe("success");
    const missing = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_run_digest", arguments: { runId: "nope" } },
    });
    expect((missing.body as { result: { isError?: boolean } }).result.isError).toBe(true);
  });

  it("tournament_why explains the board and verdict", async () => {
    const boardDb: Db = {
      prepare(sql: string) {
        return {
          bind(..._values: unknown[]) {
            const norm = sql.replace(/\s+/g, " ");
            return {
              all: async <T,>() => {
                if (norm.startsWith("SELECT * FROM attempts")) {
                  return { results: [{ id: "a1", agent: "a1", state: "terminal", run_id: "run1", verdict_rank: 1 }] as T[] };
                }
                if (norm.startsWith("SELECT * FROM ledger")) {
                  return { results: [{ id: "l1", kind: "verdict", body: "winner a1" }] as T[] };
                }
                return { results: [] as T[] };
              },
              first: async <T,>() => {
                if (norm.startsWith("SELECT * FROM tournaments")) {
                  return { id: "t1", intent: "fix it", state: "verifying", source_repo: "base" } as T;
                }
                if (norm.startsWith("SELECT * FROM verdicts")) {
                  return { tournament_id: "t1", ranking: "[\"a1\"]", rationale: "a1 green", model: "m" } as T;
                }
                return null as T | null;
              },
              run: async () => ({}),
            };
          },
        };
      },
    };
    const d = deps({ db: boardDb });
    const ok = await rpc(d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tournament_why", arguments: { tournamentId: "t1" } },
    });
    const data = JSON.parse(text(ok.body)) as { intent: string; verdict: { rationale: string }; ledger: unknown[] };
    expect(data.intent).toBe("fix it");
    expect(data.verdict.rationale).toBe("a1 green");
    expect(data.ledger).toHaveLength(1);
    const missing = await rpc(deps({ db: fakeDb({}) }), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tournament_why", arguments: { tournamentId: "nope" } },
    });
    expect(toolErr(missing.body).isError).toBe(true);
    // Repo scope: the race's source is ns/base.
    const why = (repos: string[]) =>
      rpc(deps({ db: boardDb, repos, artifactsNamespace: "ns" }), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tournament_why", arguments: { tournamentId: "t1" } },
      });
    const denied = toolErr((await why(["ns/other"])).body);
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("tournament not found");
    expect(JSON.parse(text((await why(["ns/base"])).body)).intent).toBe("fix it");
  });

  it("exposes discovery metadata", () => {
    expect(mcpDiscovery().tools).toContain("dispatch_run");
    expect(mcpDiscovery().tools).toContain("run_and_wait");
    expect(mcpDiscovery().tools).toContain("get_run_digest");
    expect(mcpDiscovery().protocolVersions).toContain("2024-11-05");
    expect((mcpDiscovery().toolRisk as Record<string, string>).dispatch_run).toBe("contained-write");
    expect((mcpDiscovery().toolRisk as Record<string, string>).list_runs).toBe("read");
  });

  it("negotiates protocol versions on the legacy handshake", async () => {
    // Claim-less handshakes serve the SDK's legacy era: old clients keep
    // their version, unknown ones get the legacy latest. Modern 2026-07-28
    // needs the per-request envelope claim (real modern clients send it).
    const init = async (params: unknown) =>
      (
        await rpc(deps(), {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { capabilities: {}, clientInfo: { name: "t", version: "1" }, ...(params as Record<string, unknown>) },
        })
      ).body as {
        result?: { protocolVersion: string };
        error?: { code: number };
      };
    expect((await init({ protocolVersion: "2024-11-05" })).result?.protocolVersion).toBe("2024-11-05");
    expect((await init({ protocolVersion: "2026-07-28" })).result?.protocolVersion).toBe("2025-11-25");
    expect((await init({})).error?.code).toBe(-32603);
    expect((await init({ protocolVersion: "1999-01-01" })).result?.protocolVersion).toBe("2025-11-25");
    // server/discover is modern-envelope-only now; legacy callers use the
    // unauthenticated GET /mcp discovery document instead.
    const disc = await rpc(deps(), { jsonrpc: "2.0", id: 2, method: "server/discover" });
    expect(disc.body?.error?.code).toBe(-32601);
  });

  it("confirm-gates write tools only when the setting is on", async () => {
    const call = (db: Db, args: Record<string, unknown>) =>
      rpc(deps({ db }), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rerun_job", arguments: args } });
    const on = fakeDb({ first: { value: "1" } });
    const blocked = await call(on, { runId: "r", jobId: "j" });
    const blockedErr = toolErr(blocked.body);
    expect(blockedErr.isError).toBe(true);
    expect(blockedErr.text).toContain("confirm");
    const confirmed = await call(on, { runId: "r", jobId: "j", confirm: true });
    expect(JSON.parse(text(confirmed.body)).ok).toBe(true);
    const off = await call(fakeDb({ first: null }), { runId: "r", jobId: "j" });
    expect(JSON.parse(text(off.body)).ok).toBe(true);
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
    await rpc(
      deps({ db, agent: "agent-x" }),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "dispatch_run",
          arguments: { repo: "o/r", sha: "abc", pipeline: "jobs:\n env:\n  TOKEN: s3cret-value" },
        },
      },
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
    await rpc(
      deps({ db, agent: "agent-x" }),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_runs", arguments: {} } },
    );
    expect(runs.filter((r) => r.sql.startsWith("INSERT INTO audit_log"))).toHaveLength(0);
  });
});

describe("mcp artifacts + schedules", () => {
  const SCHED = {
    id: "sched-1",
    repo: "o/r",
    ref: "main",
    cron: "0 * * * *",
    profile: null,
    enabled: 1,
    last_run_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const RUNS: { sql: string; values: unknown[] }[] = [];

  function mcpDb(opts: {
    run?: unknown;
    job?: unknown;
    jobs?: unknown[];
    schedules?: unknown[];
    setting?: string | null;
    changes?: number;
  } = {}): Db {
    return {
      prepare(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim();
        return {
          bind(...values: unknown[]) {
            return {
              all: async <T,>() => {
                if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) return { results: (opts.jobs ?? []) as T[] };
                if (norm.startsWith("SELECT * FROM schedules")) return { results: (opts.schedules ?? []) as T[] };
                return { results: [] as T[] };
              },
              first: async <T,>() => {
                if (norm.startsWith("SELECT * FROM runs WHERE id")) return (opts.run ?? null) as T | null;
                if (norm.startsWith("SELECT * FROM jobs WHERE id")) return (opts.job ?? null) as T | null;
                if (norm.startsWith("SELECT value FROM app_settings")) {
                  return (opts.setting ? { value: opts.setting } : null) as T | null;
                }
                return null as T | null;
              },
              run: async () => {
                RUNS.push({ sql: norm, values });
                if (norm.startsWith("UPDATE schedules") || norm.startsWith("DELETE FROM schedules")) {
                  return { meta: { changes: opts.changes ?? 1 } };
                }
                return {};
              },
            };
          },
        };
      },
    };
  }

  function fakeArtifactsBucket(files: Record<string, string | Uint8Array>) {
    const store = new Map<string, Uint8Array>(
      Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v]),
    );
    return {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...store]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, data]) => ({ key, size: data.length, uploaded: new Date("2026-01-01T00:00:00.000Z") })),
      }),
      get: async (key: string, opts?: { range?: { offset: number; length?: number } }) => {
        const data = store.get(key);
        if (!data) return null;
        const start = opts?.range?.offset ?? 0;
        const end = opts?.range?.length !== undefined ? start + opts.range.length : data.length;
        const slice = data.slice(start, Math.min(end, data.length));
        return {
          size: data.length,
          arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer,
        };
      },
    };
  }

  const call = (d: McpDeps, name: string, args: Record<string, unknown>) =>
    rpc(d, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

  it("lists run artifacts, scoped to the token's repos", async () => {
    const bucket = fakeArtifactsBucket({ "artifacts/job1/report.txt": "hello", "artifacts/job1/log.txt": "x" });
    const d = deps({ db: mcpDb({ run: RUN, jobs: [JOB] }), artifacts: bucket as unknown as R2Bucket });
    const listed = await call(d, "list_artifacts", { runId: "run1" });
    const body = JSON.parse(text(listed.body));
    expect(body.artifacts).toHaveLength(2);
    expect(body.artifacts[0]).toMatchObject({ jobId: "job1", jobName: "test", name: "report.txt", size: 5 });
    // Out-of-scope and missing runs conflate; unconfigured storage errors.
    const scoped = await call(deps({ db: mcpDb({ run: RUN, jobs: [JOB] }), repos: ["other/r"] }), "list_artifacts", {
      runId: "run1",
    });
    expect(toolErr(scoped.body).text).toContain("run not found");
    const bare = await call(deps({ db: mcpDb({ run: RUN, jobs: [JOB] }) }), "list_artifacts", { runId: "run1" });
    expect(toolErr(bare.body).text).toContain("not configured");
    const missing = await call(d, "list_artifacts", {});
    expect(toolErr(missing.body).text).toContain("runId is required");
  });

  it("reads bounded text previews and refuses binaries", async () => {
    const bucket = fakeArtifactsBucket({
      "artifacts/job1/report.txt": "0123456789",
      "artifacts/job1/blob.bin": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
    });
    const d = deps({ db: mcpDb({ run: RUN, job: JOB }), artifacts: bucket as unknown as R2Bucket });
    const full = await call(d, "get_artifact", { jobId: "job1", name: "report.txt" });
    expect(JSON.parse(text(full.body))).toEqual({ name: "report.txt", bytes: 10, truncated: false, text: "0123456789" });
    const head = await call(d, "get_artifact", { jobId: "job1", name: "report.txt", maxBytes: 4 });
    expect(JSON.parse(text(head.body))).toEqual({ name: "report.txt", bytes: 4, truncated: true, text: "0123" });
    const bin = await call(d, "get_artifact", { jobId: "job1", name: "blob.bin" });
    expect(toolErr(bin.body).text).toContain("artifact is binary");
    expect(toolErr(bin.body).text).toContain("/v1/jobs/job1/artifacts/blob.bin");
    const bad = await call(d, "get_artifact", { jobId: "job1", name: "a/b" });
    expect(toolErr(bad.body).text).toContain("invalid artifact name");
    const gone = await call(d, "get_artifact", { jobId: "job1", name: "missing.txt" });
    expect(toolErr(gone.body).text).toContain("artifact not found");
    const scoped = await call(
      deps({ db: mcpDb({ run: RUN, job: JOB }), artifacts: bucket as unknown as R2Bucket, repos: ["other/r"] }),
      "get_artifact",
      { jobId: "job1", name: "report.txt" },
    );
    expect(toolErr(scoped.body).text).toContain("job not found");
  });

  it("gates schedule tools on admin tokens", async () => {
    const admin = deps({ db: mcpDb({ schedules: [SCHED] }), isAdmin: true });
    const listed = await call(admin, "list_schedules", {});
    expect(JSON.parse(text(listed.body)).schedules).toEqual([
      { id: "sched-1", repo: "o/r", ref: "main", cron: "0 * * * *", profile: null, enabled: true, lastRunAt: null, createdAt: SCHED.created_at },
    ]);
    const gatedTools: [string, Record<string, unknown>][] = [
      ["list_schedules", {}],
      ["create_schedule", { repo: "o/r", ref: "main", cron: "0 * * * *" }],
      ["set_schedule_enabled", { scheduleId: "sched-1", enabled: false }],
      ["delete_schedule", { scheduleId: "sched-1" }],
    ];
    for (const [name, args] of gatedTools) {
      const denied = await call(deps({ db: mcpDb({ schedules: [SCHED] }) }), name, args);
      expect(toolErr(denied.body).text).toContain("needs an admin token");
    }
  });

  it("creates schedules with REST-identical validation, scope, and limit", async () => {
    RUNS.length = 0;
    const admin = deps({ db: mcpDb({ schedules: [] }), isAdmin: true });
    const badRepo = await call(admin, "create_schedule", { repo: "nope", ref: "main", cron: "0 * * * *" });
    expect(toolErr(badRepo.body).text).toContain("repo must be owner/name");
    const badRef = await call(admin, "create_schedule", { repo: "o/r", ref: "../x", cron: "0 * * * *" });
    expect(toolErr(badRef.body).text).toContain("ref must be a branch or tag");
    const badCron = await call(admin, "create_schedule", { repo: "o/r", ref: "main", cron: "blah" });
    expect(toolErr(badCron.body).text).toContain("exactly 5 fields");
    const scoped = await call(deps({ db: mcpDb({ schedules: [] }), isAdmin: true, repos: ["other/r"] }), "create_schedule", {
      repo: "o/r",
      ref: "main",
      cron: "0 * * * *",
    });
    expect(toolErr(scoped.body).text).toContain("not scoped to that repo");
    const capped = await call(
      deps({ db: mcpDb({ schedules: Array.from({ length: 51 }, () => SCHED) }), isAdmin: true }),
      "create_schedule",
      { repo: "o/r", ref: "main", cron: "0 * * * *" },
    );
    expect(toolErr(capped.body).text).toContain("schedule limit reached");
    const created = await call(admin, "create_schedule", { repo: "o/r", ref: "main", cron: " 0 * * * * " });
    const id = JSON.parse(text(created.body)).id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const insert = RUNS.find((r) => r.sql.startsWith("INSERT INTO schedules"));
    expect(insert?.values.slice(1, 5)).toEqual(["o/r", "main", "0 * * * *", null]);
    // WriteGuard audits every attempt; exactly one succeeded.
    const audits = RUNS.filter((r) => r.sql.startsWith("INSERT INTO audit_log"));
    expect(audits).toHaveLength(6);
    const ok = audits.filter((a) => String(a.values[3]).startsWith("ok "));
    expect(ok).toHaveLength(1);
    expect(ok[0].values[2]).toBe("mcp.create_schedule");
    expect(String(ok[0].values[3])).toContain("o/r");
  });

  it("confirm-gates schedule writes and toggles/deletes by id", async () => {
    const gated = deps({ db: mcpDb({ schedules: [], setting: "1" }), isAdmin: true });
    const blocked = await call(gated, "create_schedule", { repo: "o/r", ref: "main", cron: "0 * * * *" });
    expect(toolErr(blocked.body).text).toContain("needs confirm: true");
    const confirmed = await call(gated, "create_schedule", { repo: "o/r", ref: "main", cron: "0 * * * *", confirm: true });
    expect(JSON.parse(text(confirmed.body)).id).toBeTruthy();
    const admin = deps({ db: mcpDb({}), isAdmin: true });
    expect(JSON.parse(text((await call(admin, "set_schedule_enabled", { scheduleId: "s1", enabled: false })).body))).toEqual({
      ok: true,
    });
    expect(JSON.parse(text((await call(admin, "delete_schedule", { scheduleId: "s1" })).body))).toEqual({ ok: true });
    // Missing (not mistyped — the shape-only schema lets undefined
    // through to the body, which rejects it).
    const noflag = await call(admin, "set_schedule_enabled", { scheduleId: "s1" });
    expect(toolErr(noflag.body).text).toContain("enabled must be a boolean");
    const missing = deps({ db: mcpDb({ changes: 0 }), isAdmin: true });
    expect(toolErr((await call(missing, "set_schedule_enabled", { scheduleId: "s1", enabled: true })).body).text).toContain(
      "schedule not found",
    );
    expect(toolErr((await call(missing, "delete_schedule", { scheduleId: "s1" })).body).text).toContain("schedule not found");
  });
});

describe("mcpAgentTag", () => {
  it("passes clean slugs through and drops free-form user agents", () => {
    expect(mcpAgentTag("atlas-1")).toBe("atlas-1");
    expect(mcpAgentTag(undefined)).toBeUndefined();
    expect(mcpAgentTag("")).toBeUndefined();
    expect(mcpAgentTag("Mozilla/5.0 (Macintosh)")).toBeUndefined();
    expect(mcpAgentTag("has space")).toBeUndefined();
  });
});
