// flare-forge-sim: the live load harness Worker (docs/FORGE-BENCH.md).
// AgentPool Durable Objects drive the REAL Forge REST API of a target
// deployment (FORGE_URL + FORGE_TOKEN) with synthetic agents; this
// Worker starts runs, aggregates measured counters, and cleans up forks.
//
//   POST /runs                 start {mode, agents, repo?, confirm?, ...}  (admin)
//   GET  /runs                 list runs                                    (read)
//   GET  /runs/:id/results     aggregate counters (JSON)                    (read)
//   GET  /runs/:id             the same as a small HTML page                (read)
//   POST /runs/:id/stop        stop all pools                               (admin)
//   POST /runs/:id/cleanup     delete forks the run created                 (admin)
//
// Admin = `Authorization: Bearer <SIM_ADMIN_TOKEN>`. Reads need it too
// unless PUBLIC_RESULTS="true". Without SIM_ADMIN_TOKEN everything 503s.

import type { SimEnv } from "./env.ts";
import { DEFAULT_LIMITS, mapLimit, planRun, type RunLimits } from "./harness/plan.ts";
import { aggregate, type PoolSnapshot, type RunSummary } from "./harness/pool.ts";
import type { RunMeta } from "./pool-do.ts";

export { AgentPool, SimRegistry } from "./pool-do.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function err(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// Digest-then-compare: constant time over equal-length digests.
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function authorized(req: Request, env: SimEnv): Promise<boolean> {
  const expected = env.SIM_ADMIN_TOKEN;
  if (!expected) return false;
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? tokenMatches(m[1].trim(), expected) : false;
}

export function limitsFrom(env: SimEnv): RunLimits {
  const n = Number(env.MAX_FULL_GIT_AGENTS);
  return Number.isInteger(n) && n > 0 ? { ...DEFAULT_LIMITS, maxFullGitAgents: n } : DEFAULT_LIMITS;
}

function registry(env: SimEnv): DurableObjectStub<import("./pool-do.ts").SimRegistry> {
  return env.SIM_REGISTRY.get(env.SIM_REGISTRY.idFromName("global"));
}

function pool(env: SimEnv, runId: string, index: number): DurableObjectStub<import("./pool-do.ts").AgentPool> {
  return env.AGENT_POOL.get(env.AGENT_POOL.idFromName(`${runId}:${index}`));
}

function newRunId(): string {
  return `r${Date.now().toString(36)}${crypto.getRandomValues(new Uint8Array(2)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
}

async function snapshots(env: SimEnv, meta: RunMeta): Promise<PoolSnapshot[]> {
  const idx = Array.from({ length: meta.pools }, (_, i) => i);
  const snaps = await mapLimit(idx, 6, (i) => pool(env, meta.runId, i).snapshot());
  const out: PoolSnapshot[] = [];
  for (const s of snaps) if (s) out.push(s);
  return out;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function renderHtml(meta: RunMeta, s: RunSummary): string {
  const rows = Object.entries(s.ops)
    .filter(([, o]) => o.requests > 0)
    .map(
      ([op, o]) =>
        `<tr><td>${esc(op)}</td><td>${o.requests}</td><td>${o.ok}</td><td>${o.errors}</td><td>${o.p50Ms ?? "-"}</td><td>${o.p95Ms ?? "-"}</td></tr>`,
    )
    .join("");
  const codes = Object.entries(s.errorCodes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([c, n]) => `<li><code>${esc(c)}</code> × ${n}</li>`)
    .join("");
  const dur = s.durationMs === null ? "-" : `${(s.durationMs / 1000).toFixed(1)} s`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Forge sim ${esc(meta.runId)}</title>
<style>:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--line:#ddd;--soft:#666}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#111;--line:#333;--soft:#999}}
body{font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:960px;padding:16px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:right}
td:first-child,th:first-child{text-align:left}.k{color:var(--soft);font-size:12px;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}.n{font-size:24px;font-weight:600}</style></head>
<body><h1>Forge live harness · run ${esc(meta.runId)}</h1>
<p>MEASURED against the target Forge deployment · mode <b>${esc(meta.mode)}</b> · ${meta.agents} agents in ${meta.pools} pools · repo <code>${esc(meta.repo)}</code> · started ${esc(meta.createdAt)}</p>
<div class="grid">
<div><div class="k">Intents declared</div><div class="n">${s.intentsDeclared}</div></div>
<div><div class="k">Intents / s</div><div class="n">${s.intentsPerSec ?? "-"}</div></div>
<div><div class="k">Forks claimed</div><div class="n">${s.claimed}</div></div>
<div><div class="k">Git pushes</div><div class="n">${s.gitPushed}</div></div>
<div><div class="k">Ready</div><div class="n">${s.ready}</div></div>
<div><div class="k">Rate limited</div><div class="n">${s.rateLimited}</div></div>
<div><div class="k">Done / failed / pending</div><div class="n">${s.done} / ${s.failed} / ${s.pending}</div></div>
<div><div class="k">Duration</div><div class="n">${dur}</div></div>
</div>
<table><thead><tr><th>Op</th><th>Requests</th><th>OK</th><th>Errors</th><th>p50 ms</th><th>p95 ms</th></tr></thead><tbody>${rows}</tbody></table>
<h3>Error codes</h3><ul>${codes || "<li>none</li>"}</ul>
<p class="k">Latency percentiles are log-bucket upper bounds (±12.5%). Auto-refreshes every 10 s.</p>
</body></html>`;
}

export default {
  async fetch(req: Request, env: SimEnv): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (!env.SIM_ADMIN_TOKEN) return err(503, "not_configured", "set the SIM_ADMIN_TOKEN secret");
    const admin = await authorized(req, env);
    const canRead = admin || env.PUBLIC_RESULTS === "true";
    try {
      if (parts.length === 0 && req.method === "GET") {
        return json({ service: "flare-forge-sim", docs: "docs/FORGE-BENCH.md", routes: ["POST /runs", "GET /runs", "GET /runs/:id/results"] });
      }
      if (parts[0] !== "runs") return err(404, "not_found", "unknown route");

      if (parts.length === 1 && req.method === "GET") {
        if (!canRead) return err(401, "unauthorized", "bearer SIM_ADMIN_TOKEN required");
        return json({ runs: await registry(env).list() });
      }
      if (parts.length === 1 && req.method === "POST") {
        if (!admin) return err(401, "unauthorized", "bearer SIM_ADMIN_TOKEN required");
        if (!env.FORGE_URL || !env.FORGE_TOKEN) return err(503, "not_configured", "set FORGE_URL and the FORGE_TOKEN secret");
        const body: unknown = await req.json().catch(() => null);
        const planned = planRun(body, limitsFrom(env), { repo: env.SIM_REPO ?? "flare-sim-trunk", runId: newRunId() });
        if (!planned.ok) return err(planned.status, planned.code, planned.message);
        const { plan } = planned;
        const meta: RunMeta = {
          runId: plan.runId,
          mode: plan.mode,
          agents: plan.agents,
          pools: plan.pools.length,
          repo: plan.repo,
          createdAt: new Date().toISOString(),
        };
        if (!(await registry(env).add(meta))) return err(409, "run_exists", `run ${plan.runId} already exists`);
        const started = await mapLimit(plan.pools, 6, (cfg) => pool(env, plan.runId, cfg.poolIndex).start(cfg));
        const failed = started.filter((s) => !s.ok).length;
        return json({ run: meta, poolsStarted: started.length - failed, poolsFailed: failed }, 202);
      }

      const runId = parts[1];
      const meta = await registry(env).get(runId);
      if (!meta) return err(404, "run_not_found", `no run ${runId}`);

      if (req.method === "GET" && (parts.length === 2 || parts[2] === "results")) {
        if (!canRead) return err(401, "unauthorized", "bearer SIM_ADMIN_TOKEN required");
        const summary = aggregate(runId, await snapshots(env, meta));
        if (parts.length === 2 && url.searchParams.get("format") !== "json") {
          return new Response(renderHtml(meta, summary), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        return json({ run: meta, summary });
      }
      if (req.method === "POST" && parts[2] === "stop") {
        if (!admin) return err(401, "unauthorized", "bearer SIM_ADMIN_TOKEN required");
        const idx = Array.from({ length: meta.pools }, (_, i) => i);
        const out = await mapLimit(idx, 6, (i) => pool(env, runId, i).stop());
        return json({ stopped: out.filter(Boolean).length });
      }
      if (req.method === "POST" && parts[2] === "cleanup") {
        if (!admin) return err(401, "unauthorized", "bearer SIM_ADMIN_TOKEN required");
        if (!env.ARTIFACTS) return err(503, "not_configured", "ARTIFACTS binding (namespace flare-sim) missing");
        const idx = Array.from({ length: meta.pools }, (_, i) => i);
        const out = await mapLimit(idx, 6, (i) => pool(env, runId, i).cleanup());
        const total = out.reduce(
          (acc, r) => ({
            deleted: acc.deleted + r.deleted,
            missing: acc.missing + r.missing,
            failed: acc.failed + r.failed,
            remaining: acc.remaining + r.remaining,
          }),
          { deleted: 0, missing: 0, failed: 0, remaining: 0 },
        );
        return json(total);
      }
      return err(404, "not_found", "unknown route");
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "sim request failed", error: String(e).slice(0, 200) }));
      return err(500, "internal", "request failed");
    }
  },
} satisfies ExportedHandler<SimEnv>;
