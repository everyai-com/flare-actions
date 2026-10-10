/// <reference types="node" />
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { findLiveToken, setSetting } from "./db";
import { handleForgeRequest, type ForgeIdentity } from "./forge-routes";
import {
  buildPublicMcpServer,
  FORGE_PUBLIC_REPOS_KEY,
  handleForgePublicRequest,
  isolateRateLimiter,
  parsePublicRepos,
  publicPrincipal,
  publicView,
  SECRET_PATTERNS,
  watchHtml,
  type PublicForgeContext,
} from "./forge-public";
import { forgeServiceDeps, type ForgeServiceDeps } from "./forge-service";
import { fakeArtifacts, type FakeArtifacts } from "./forge.testkit";
import { SCHEMA_STATEMENTS } from "./schema";
import { authIdentityFromToken, hashToken, type ApiTokenIdentity } from "./tokens";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const TABLES = ["goals", "intents", "conflicts", "trains", "intent_messages", "forge_ledger", "audit_log", "app_settings", "api_tokens"];

function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  for (const sql of SCHEMA_STATEMENTS) {
    const m = /(?:TABLE IF NOT EXISTS|ON) (\w+)/.exec(sql);
    if (m && TABLES.includes(m[1])) raw.exec(sql);
  }
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values.map((v) => (v === undefined ? null : v)) as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => ((raw.prepare(query).get(...params) ?? null) as T | null),
            run: async () => {
              const info = raw.prepare(query).run(...params);
              return { meta: { changes: Number(info.changes ?? 0) } };
            },
          };
        },
      };
    },
  };
}

const RUNNER: ForgeIdentity & ApiTokenIdentity = { scope: "runner", actor: "token:runner1", repos: [] };
const ADMIN: ForgeIdentity & ApiTokenIdentity = { scope: "admin", actor: "email:pat@example.com", repos: [] };

interface H {
  db: Db;
  fake: FakeArtifacts;
  deps: ForgeServiceDeps;
  ids: { demo: string; claimed: string; other: string; protectedId: string };
  get(path: string, init?: RequestInit & { ip?: string }, over?: Partial<PublicForgeContext>): Promise<{ status: number; text: string; res: Response }>;
}

async function forge(h: { deps: ForgeServiceDeps }, method: string, path: string, body?: unknown, ident: ForgeIdentity = RUNNER): Promise<Record<string, unknown>> {
  const url = new URL(`http://x${path}`);
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handleForgeRequest(new Request(url, init), url, h.deps, async () => ident);
  if (!res) throw new Error("fell through");
  return (await res.json()) as Record<string, unknown>;
}

function id(v: Record<string, unknown>): string {
  return String((v.intent as Record<string, unknown>).id);
}

async function harness(publicRepos: string[] | null = ["demo"]): Promise<H> {
  const db = sqliteDb();
  const fake = fakeArtifacts("demo");
  fake.repos.get("demo")?.files.set(".flare/policy.yml", 'protected: ["src/auth/**"]\n');
  const deps = forgeServiceDeps({ db, artifacts: fake.artifacts, namespace: "ns", accountId: "a".repeat(32) });
  const h0 = { deps };
  const goal = await forge(h0, "POST", "/v1/forge/goals", { repo: "demo", text: "Make it observable (ask pat@example.com)" }, ADMIN);
  const goalId = String((goal.goal as Record<string, unknown>).id);
  const demo = id(await forge(h0, "POST", "/v1/forge/intents", { repo: "demo", goalId, title: "log ids", reasoning: "trace art_v1_SECRETSECRET", accept: "npm test", footprint: ["src/api/a.ts"], agent: "agent-1" }));
  const claimedIntent = id(await forge(h0, "POST", "/v1/forge/intents", { repo: "demo", title: "metrics", reasoning: "r", accept: "npm test", footprint: ["src/api/a.ts"], agent: "agent-2" }));
  await forge(h0, "POST", `/v1/forge/intents/${claimedIntent}/claim`, { agent: "agent-2" });
  await forge(h0, "POST", `/v1/forge/intents/${demo}/messages`, { fromIntent: claimedIntent, agent: "agent-2", text: `ping me at sam@example.com, token ${"f".repeat(64)}` });
  const protectedId = id(await forge(h0, "POST", "/v1/forge/intents", { repo: "demo", title: "auth", reasoning: "r", accept: "npm test", footprint: ["src/auth/x.ts"], agent: "agent-3" }));
  await forge(h0, "POST", `/v1/forge/intents/${protectedId}/approve-plan`, {}, ADMIN);
  const other = id(await forge(h0, "POST", "/v1/forge/intents", { repo: "other", title: "secret work", reasoning: "hidden", accept: "x", footprint: ["README.md"], agent: "agent-9" }));
  if (publicRepos) await setSetting(db, FORGE_PUBLIC_REPOS_KEY, JSON.stringify(publicRepos));
  return {
    db,
    fake,
    deps,
    ids: { demo, claimed: claimedIntent, other, protectedId },
    async get(path, init = {}, over = {}) {
      const url = new URL(`https://forge.test${path}`);
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", init.ip ?? "203.0.113.7");
      const req = new Request(url, { ...init, headers });
      const ctx: PublicForgeContext = {
        db,
        forge: () => deps,
        namespace: "ns",
        auth: async () => null,
        limiter: isolateRateLimiter(),
        dashboardHtml: "<!doctype html><html><head><title>Flare</title></head><body>app</body></html>",
        ...over,
      };
      const res = await handleForgePublicRequest(req, url, ctx);
      if (!res) throw new Error(`fell through: ${path}`);
      const text = await res.clone().text();
      return { status: res.status, text, res };
    },
  };
}

function assertClean(text: string): void {
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.source, p.flags.replace("g", ""));
    expect(re.test(text), `matched ${p.source} in ${text.slice(0, 400)}`).toBe(false);
  }
  expect(text).not.toContain("tok-");
  expect(text).not.toContain("example.com");
  expect(text).not.toContain("token:runner1");
  expect(text).not.toMatch(/"(token|forkRemote|remote|cloneCommand|pushCommand|mailbox|nextSteps)"/);
}

describe("forge public: off by default", () => {
  it("404s every public route when no repo is designated", async () => {
    const h = await harness(null);
    for (const p of ["/watch", "/v1/public/forge", "/v1/public/forge/join", "/v1/public/forge/snapshot?repo=demo", `/v1/public/forge/intents/${h.ids.demo}`]) {
      expect((await h.get(p)).status, p).toBe(404);
    }
  });

  it("parses settings defensively", () => {
    expect(parsePublicRepos(null)).toEqual([]);
    expect(parsePublicRepos("nope")).toEqual([]);
    expect(parsePublicRepos('["demo","../x","demo",3]')).toEqual(["demo"]);
    // Never an empty allowlist (which would mean "all repos").
    expect(publicPrincipal("ns", []).repos.length).toBe(1);
    expect(publicPrincipal("ns", ["demo"])).toMatchObject({ canWrite: false, isAdmin: false, repos: ["ns/demo"] });
  });

  it("falls through outside its paths", async () => {
    const h = await harness();
    const url = new URL("https://forge.test/v1/forge/snapshot?repo=demo");
    expect(await handleForgePublicRequest(new Request(url), url, { db: h.db, forge: () => h.deps, namespace: "ns", auth: async () => null })).toBeNull();
  });
});

describe("forge public: scope", () => {
  it("serves designated repos and 404s everything else", async () => {
    const h = await harness();
    const snap = await h.get("/v1/public/forge/snapshot?repo=demo");
    expect(snap.status).toBe(200);
    expect(snap.res.headers.get("Cache-Control")).toContain("public");
    expect(snap.res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    for (const p of [
      "/v1/public/forge/snapshot?repo=other",
      "/v1/public/forge/snapshot",
      "/v1/public/forge/intents?repo=other",
      "/v1/public/forge/goals?repo=other",
      "/v1/public/forge/goals/nope",
      "/v1/public/forge/inbox?repo=other",
      "/v1/public/forge/why?repo=other&path=README.md",
      `/v1/public/forge/intents/${h.ids.other}`,
      "/v1/public/forge/intents/nope",
      "/v1/public/forge/trains/nope",
      "/v1/public/forge/conflicts/nope",
      "/v1/public/forge/feed?repo=other",
      "/watch?repo=other",
      "/v1/public/forge/unknown",
    ]) {
      const r = await h.get(p);
      expect(r.status, p).toBe(404);
      expect(r.text).not.toContain("secret work");
    }
    const detail = await h.get(`/v1/public/forge/intents/${h.ids.demo}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("log ids");
  });

  it("every write is unreachable and changes nothing", async () => {
    const h = await harness();
    const before = JSON.stringify((await h.db.prepare("SELECT id, state, agent FROM intents ORDER BY id").bind().all()).results);
    const paths = [
      "/v1/public/forge/goals",
      "/v1/public/forge/intents",
      `/v1/public/forge/intents/${h.ids.demo}`,
      `/v1/public/forge/intents/${h.ids.demo}/claim`,
      `/v1/public/forge/intents/${h.ids.demo}/abandon`,
      `/v1/public/forge/intents/${h.ids.claimed}/ready`,
      `/v1/public/forge/intents/${h.ids.claimed}/push`,
      `/v1/public/forge/intents/${h.ids.demo}/messages`,
      `/v1/public/forge/intents/${h.ids.protectedId}/approve-plan`,
      "/v1/public/forge/conflicts/c1/claim",
      "/v1/public/forge/conflicts/c1/resolve",
      "/v1/public/forge/snapshot?repo=demo",
    ];
    for (const p of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await h.get(p, { method, body: JSON.stringify({ agent: "agent-1", repo: "demo", sha: "a".repeat(40) }) });
        expect([404, 405], `${method} ${p}`).toContain(r.status);
      }
    }
    // GETs on write-shaped paths fall through to 404 too.
    for (const p of paths.slice(3, 11)) expect((await h.get(p)).status, p).toBe(404);
    const after = JSON.stringify((await h.db.prepare("SELECT id, state, agent FROM intents ORDER BY id").bind().all()).results);
    expect(after).toBe(before);
    expect(h.fake.tokens.filter((t) => t.scope === "write").length).toBe(1); // only the setup claim
  });
});

describe("forge public: sanitizer", () => {
  it("no token-like strings, emails, commands or mailboxes in any response", async () => {
    const h = await harness();
    // The authed surface really does carry what the public one must strip.
    const raw = JSON.stringify(await forge(h, "GET", `/v1/forge/intents/${h.ids.demo}`));
    expect(raw).toContain("sam@example.com");
    expect(raw).toContain("art_v1_SECRETSECRET");
    const rawGoal = JSON.stringify(await forge(h, "GET", `/v1/forge/intents/${h.ids.protectedId}`));
    expect(rawGoal).toContain("pat@example.com");
    const paths = [
      "/v1/public/forge",
      "/v1/public/forge/join",
      "/v1/public/forge/snapshot?repo=demo",
      "/v1/public/forge/live?repo=demo",
      "/v1/public/forge/inbox?repo=demo",
      "/v1/public/forge/intents?repo=demo",
      "/v1/public/forge/trains?repo=demo",
      "/v1/public/forge/conflicts?repo=demo",
      "/v1/public/forge/whats-happening?repo=demo",
      "/v1/public/forge/goals?repo=demo",
      "/v1/public/forge/why?repo=demo&path=src/api/a.ts&line=1",
      `/v1/public/forge/intents/${h.ids.demo}`,
      `/v1/public/forge/intents/${h.ids.claimed}`,
      `/v1/public/forge/intents/${h.ids.protectedId}`,
    ];
    for (const p of paths) {
      const r = await h.get(p);
      expect(r.status, p).toBe(200);
      assertClean(r.text);
    }
    const prot = JSON.parse((await h.get(`/v1/public/forge/intents/${h.ids.protectedId}`)).text) as { intent: { planApprovedBy: string } };
    expect(prot.intent.planApprovedBy).toBe("operator");
  });

  it("publicView drops credential keys and rewrites deep links", () => {
    const v = publicView({ token: "x", nested: [{ forkRemote: "https://u:p@h/x.git", text: "Bearer abc.def", links: { self: "/v1/forge/intents/i1" } }], actor: "github:pat" }) as Record<string, unknown>;
    expect(v).toEqual({ nested: [{ text: "Bearer [redacted]", links: { self: "/v1/public/forge/intents/i1" } }], actor: "operator" });
  });
});

describe("forge public: watch, rate limit, feed", () => {
  it("/watch serves the dashboard with the public meta flag", async () => {
    const h = await harness();
    const r = await h.get("/watch");
    expect(r.status).toBe(200);
    expect(r.text).toContain('<meta name="flare-public" content="demo">');
    expect(r.text.indexOf("flare-public")).toBeGreaterThan(r.text.indexOf("<head>"));
    expect(watchHtml("<html><head></head></html>", 'x"><script>')).toContain('content="xscript"');
  });

  it("rate-limits per IP", async () => {
    const h = await harness();
    const limiter = isolateRateLimiter({ read: 2, mcp: 1, feed: 1 });
    expect((await h.get("/v1/public/forge/snapshot?repo=demo", {}, { limiter })).status).toBe(200);
    expect((await h.get("/v1/public/forge/snapshot?repo=demo", {}, { limiter })).status).toBe(200);
    const r = await h.get("/v1/public/forge/snapshot?repo=demo", {}, { limiter });
    expect(r.status).toBe(429);
    expect(JSON.parse(r.text).code).toBe("rate_limited");
    // Another IP is unaffected.
    expect((await h.get("/v1/public/forge/snapshot?repo=demo", { ip: "198.51.100.1" }, { limiter })).status).toBe(200);
  });

  it("feed strips cookies/auth before the upgrade", async () => {
    const h = await harness();
    let seen: Request | null = null;
    const deps: ForgeServiceDeps = { ...h.deps, feed: { upgrade: async (req) => ((seen = req), new Response("ok")) } };
    const r = await h.get("/v1/public/forge/feed?repo=demo", { headers: { Upgrade: "websocket", Cookie: "flare_session=s", Authorization: "Bearer t" } }, { forge: () => deps });
    expect(r.status).toBe(200);
    const req = seen as Request | null;
    expect(req?.headers.get("cookie")).toBeNull();
    expect(req?.headers.get("authorization")).toBeNull();
    expect(req?.headers.get("upgrade")).toBe("websocket");
    expect((await h.get("/v1/public/forge/feed?repo=demo", {}, { forge: () => deps })).status).toBe(426);
  });
});

let rpc = 0;
async function mcp(h: H, method: string, params: Record<string, unknown>): Promise<{ result?: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } }> {
  const r = await h.get("/v1/public/forge/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer should-be-ignored" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
  });
  const line = r.text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : r.text) as { result?: { tools?: Array<{ name: string }> } };
}

describe("forge public: read-only MCP", () => {
  it("lists exactly the four read tools", async () => {
    const h = await harness();
    const out = await mcp(h, "tools/list", {});
    expect(out.result?.tools?.map((t) => t.name).sort()).toEqual(["forge_snapshot", "read_inbox", "whats_happening", "why"]);
  });

  it("answers reads for public repos, refuses others and every write tool", async () => {
    const h = await harness();
    const snap = await mcp(h, "tools/call", { name: "forge_snapshot", arguments: { repo: "demo" } });
    const text = snap.result?.content?.[0]?.text ?? "";
    expect(snap.result?.isError).not.toBe(true);
    expect(text).toContain("notice");
    assertClean(text);
    const inbox = await mcp(h, "tools/call", { name: "read_inbox", arguments: {} });
    assertClean(inbox.result?.content?.[0]?.text ?? "");
    const other = await mcp(h, "tools/call", { name: "forge_snapshot", arguments: { repo: "other" } });
    expect(other.result?.isError ?? !!other.error).toBe(true);
    for (const name of ["declare_intent", "claim_intent", "mark_ready", "send_note", "plan_goal", "resolve_conflict"]) {
      const w = await mcp(h, "tools/call", { name, arguments: { repo: "demo", title: "x" } });
      expect(w.result?.isError ?? !!w.error, name).toBe(true);
    }
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM intents").bind().first<{ n: number }>())?.n).toBe(4);
  });

  it("buildPublicMcpServer works standalone", async () => {
    const h = await harness();
    const handler = createMcpHandler(() => buildPublicMcpServer(() => h.deps, publicPrincipal("ns", ["demo"]), ["demo"]));
    const res = await handler.fetch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "why", arguments: { path: "src/api/a.ts" } } }),
      }),
    );
    expect(await res.text()).toContain("chain");
  });
});

describe("forge public: admin + judge tokens", () => {
  async function admin(h: H, method: string, path: string, body: unknown, ident: ApiTokenIdentity | null) {
    return h.get(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, { auth: async () => ident });
  }

  it("needs admin; sets and reads the designated repos", async () => {
    const h = await harness(null);
    expect((await admin(h, "GET", "/v1/admin/forge/public", undefined, null)).status).toBe(401);
    expect((await admin(h, "POST", "/v1/admin/forge/public", { repos: ["demo"] }, RUNNER)).status).toBe(401);
    expect((await admin(h, "POST", "/v1/admin/forge/public", { repos: ["../x"] }, ADMIN)).status).toBe(400);
    expect((await admin(h, "POST", "/v1/admin/forge/public", { repos: ["bookshelf-sandbox"] }, ADMIN)).status).toBe(400);
    expect((await admin(h, "POST", "/v1/admin/forge/public", { repos: ["demo"] }, ADMIN)).status).toBe(200);
    const got = JSON.parse((await admin(h, "GET", "/v1/admin/forge/public", undefined, ADMIN)).text) as { repos: string[] };
    expect(got.repos).toEqual(["demo"]);
    expect((await h.get("/v1/public/forge/snapshot?repo=demo")).status).toBe(200);
  });

  it("mints a runner token pinned to the sandbox repo, with an expiry", async () => {
    const h = await harness();
    expect((await admin(h, "POST", "/v1/admin/forge/judge-token", {}, RUNNER)).status).toBe(401);
    expect((await admin(h, "POST", "/v1/admin/forge/judge-token", { repo: "demo" }, ADMIN)).status).toBe(400); // public repo
    expect((await admin(h, "POST", "/v1/admin/forge/judge-token", { ttlDays: 99 }, ADMIN)).status).toBe(400);
    const r = await admin(h, "POST", "/v1/admin/forge/judge-token", { name: "judge-a" }, ADMIN);
    expect(r.status).toBe(201);
    const out = JSON.parse(r.text) as { token: string; repos: string[]; expiresAt: string; scope: string };
    expect(out.scope).toBe("runner");
    expect(out.repos).toEqual(["ns/bookshelf-sandbox"]);
    const days = (Date.parse(out.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const ident = await authIdentityFromToken(out.token, { db: h.db });
    expect(ident).toMatchObject({ scope: "runner", repos: ["ns/bookshelf-sandbox"] });
    // The token cannot touch the public repo.
    const denied = await forge(h, "POST", "/v1/forge/intents", { repo: "demo", title: "t", reasoning: "r", accept: "a", footprint: ["x"] }, { ...RUNNER, repos: out.repos });
    expect(denied.code).toBe("repo_not_allowed");
  });

  it("expired tokens stop authenticating", async () => {
    const h = await harness();
    await h.db
      .prepare("INSERT INTO api_tokens (id, name, token_hash, scopes, repos, created_at, revoked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
      .bind("t-old", "old", await hashToken("old-token"), "runner", "ns/bookshelf-sandbox", new Date().toISOString(), new Date(Date.now() - 1000).toISOString())
      .run();
    expect(await findLiveToken(h.db, await hashToken("old-token"))).toBeNull();
    expect(await authIdentityFromToken("old-token", { db: h.db })).toBeNull();
  });
});
