import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, FORGE_MCP_TOOL_NAMES } from "./dashboard";
import { FORGE_JS } from "./dashboard-forge-js";
import type { Db } from "./db";
import { handleForgeRequest, type ForgeIdentity } from "./forge-routes";
import { forgeServiceDeps, FORGE_MCP_OPS, type ForgeServiceDeps } from "./forge-service";
import { d1Trains, type TrainPort } from "./forge-ports";
import { createTrain, transitionIntent } from "./intents";
import { MCP_TOOLS, MCP_TOOL_RISK } from "./mcp";
import { fakeArtifacts, forgeSqliteDb, sha } from "./forge.testkit";

// The signed-in dashboard (dashboard-forge-js.ts) against the real Forge
// REST surface: every route it calls exists, every MCP-claiming
// data-action is a real MCP tool, and the response fields its renderers
// read are present (no fixture fallback needed).

const RUNNER: ForgeIdentity = { scope: "runner", actor: "token:runner1", repos: [] };
const ADMIN: ForgeIdentity = { scope: "admin", actor: "email:pat@example.com", repos: [] };

type Call = (method: string, path: string, body?: unknown, ident?: ForgeIdentity) => Promise<{ status: number; body: Record<string, unknown> }>;

function harness(trains?: (db: Db) => TrainPort): { db: Db; deps: ForgeServiceDeps; call: Call; fake: ReturnType<typeof fakeArtifacts> } {
  const db = forgeSqliteDb();
  const fake = fakeArtifacts("demo");
  const deps = forgeServiceDeps({ db, artifacts: fake.artifacts, namespace: "ns", accountId: "a".repeat(32), trains: trains ? trains(db) : undefined });
  const call: Call = async (method, path, body, ident = RUNNER) => {
    const url = new URL(`http://x${path}`);
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleForgeRequest(new Request(url, init), url, deps, async () => ident);
    if (!res) throw new Error("fell through");
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  return { db, deps, call, fake };
}

function rec(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}

function dataActions(): Set<string> {
  const found = new Set<string>();
  for (const re of [/data-action="([a-z_]+)"/g, /"data-action": "([a-z_]+)"/g, /btn\("[^"]*", "[^"]*", "([a-z_]+)"/g]) {
    for (const m of DASHBOARD_HTML.matchAll(re)) found.add(m[1]);
  }
  return found;
}

describe("dashboard <-> API contract", () => {
  it("every dashboard data-action that names an MCP tool is a registered MCP tool with a risk tier", () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    const claimed = [...dataActions()].filter((a) => (FORGE_MCP_TOOL_NAMES as readonly string[]).includes(a));
    expect(claimed.length).toBeGreaterThan(5);
    for (const a of claimed) {
      expect(names, `data-action ${a}`).toContain(a);
      expect(MCP_TOOL_RISK[a], `tier for ${a}`).toBeDefined();
    }
    for (const t of FORGE_MCP_TOOL_NAMES) expect(names, `FORGE_MCP_TOOL_NAMES ${t}`).toContain(t);
    for (const human of ["approve_plan", "send_back", "review_sample"]) expect(FORGE_MCP_OPS[human]).toBeDefined();
  });

  it("every REST path in the client's FX_REST map is a real route", async () => {
    const h = harness();
    const specs = [...FORGE_JS.matchAll(/^ {4}([a-z_]+): \{ m: "(POST|GET)", p: "([^"]+)" \}/gm)];
    expect(specs.length).toBeGreaterThan(5);
    for (const [, tool, method, path] of specs) {
      const r = await h.call(method, path.replace(":id", "00000000-0000-0000-0000-000000000000"), { repo: "demo" }, ADMIN);
      expect(String(r.body.error ?? ""), `${tool} ${method} ${path}`).not.toMatch(/no forge route/);
    }
    for (const path of ["/v1/forge/snapshot?repo=demo", "/v1/forge/inbox?repo=demo", "/v1/forge/intents?repo=demo&goal=g", "/v1/forge/trains?repo=demo", "/v1/forge/conflicts?repo=demo", "/v1/forge/agents?repo=demo", "/v1/forge/bench", "/v1/forge/why?repo=demo&path=a.ts&line=1"]) {
      const r = await h.call("GET", path);
      expect(r.status, path).toBe(200);
    }
  });

  it("serves the shapes the screens read: snapshot, inbox, intents, intent detail", async () => {
    const h = harness();
    const a = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Edit the API", footprint: ["src/api/**"], reasoning: "r", agent: "claude-1" });
    const b = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Touch a.ts", footprint: ["src/api/a.ts"], reasoning: "r", agent: "codex-2" });
    const aId = rec(a.body.intent).id as string;
    const bId = rec(b.body.intent).id as string;
    const snap = (await h.call("GET", "/v1/forge/snapshot?repo=demo")).body;
    expect(rec(snap.head)).toHaveProperty("sha");
    const intents = snap.intents as Array<Record<string, unknown>>;
    expect(intents.map((i) => i.id).sort()).toEqual([aId, bId].sort());
    expect(rec(intents[0].footprint).declared).toBeDefined();
    expect(snap.overlaps).toEqual([expect.objectContaining({ a: [aId, bId].sort()[0], b: [aId, bId].sort()[1], state: "overlap" })]);
    expect((snap.agents as Array<{ id: string; label: string }>).map((x) => x.label).sort()).toEqual(["C1", "C2"]);
    expect(rec(snap.track)).toHaveProperty("current", null);

    const list = (await h.call("GET", "/v1/forge/intents?repo=demo")).body;
    expect(rec((list.intents as unknown[])[0]).footprint).toHaveProperty("declared");
    expect(Array.isArray(list.goals)).toBe(true);

    const detail = (await h.call("GET", `/v1/forge/intents/${aId}`)).body;
    const i = rec(detail.intent);
    expect(rec(i.footprint).declared).toEqual(["src/api/**"]);
    expect(i.overlaps).toEqual([expect.objectContaining({ intent: bId, state: "overlap" })]);
    expect(Array.isArray(i.mailbox)).toBe(true);
    expect(i.created_at).toBe(i.createdAt);

    const inbox = (await h.call("GET", "/v1/forge/inbox?repo=demo")).body;
    const m = rec(inbox.metrics);
    expect(rec(m.sample)).toHaveProperty("count");
    expect(rec(m.policy)).toHaveProperty("auto_land_max_risk");
    expect(rec(m.disagreement)).toHaveProperty("days", 7);
  });

  it("launches a goal with intents from the composer and plans via /goals/plan", async () => {
    const h = harness();
    const r = await h.call("POST", "/v1/forge/goals", { repo: "demo", goal: "Make search fuzzy", intents: [{ title: "Fuzzy search", footprint: ["src/search.ts"] }, { title: "Docs", footprint: ["README.md"] }] });
    expect(r.status).toBe(201);
    expect(r.body.goal_id).toBe(rec(r.body.goal).id);
    expect((r.body.intents as unknown[]).length).toBe(2);
    const filtered = (await h.call("GET", `/v1/forge/intents?repo=demo&goal=${String(r.body.goal_id)}`)).body;
    expect((filtered.intents as unknown[]).length).toBe(2);
    const plan = await h.call("POST", "/v1/forge/goals/plan", { repo: "demo", text: "Speed up src/api/a.ts" });
    expect(plan.status).toBe(201);
    expect(rec(plan.body.planner).used).toBe(false);
    expect((plan.body.proposals as unknown[]).length).toBe(1);
  });

  it("send-back and review are admin-only, need a reason, and feed the ledger + disagreement rate", async () => {
    const h = harness();
    const d = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Edit x", footprint: ["x.ts"], reasoning: "r", agent: "alpha" });
    const id = rec(d.body.intent).id as string;
    expect((await h.call("POST", `/v1/forge/intents/${id}/send-back`, { reason: "no" }, RUNNER)).body.code).toBe("admin_required");
    expect((await h.call("POST", `/v1/forge/intents/${id}/send-back`, {}, ADMIN)).body.code).toBe("invalid_request");
    // ready -> working on send-back
    await transitionIntent(h.db, id, "draft", "claimed", {}, "alpha");
    await transitionIntent(h.db, id, "claimed", "working", { headSha: sha("1") }, "alpha");
    await transitionIntent(h.db, id, "working", "ready", {}, "alpha");
    const sb = await h.call("POST", `/v1/forge/intents/${id}/send-back`, { reason: "split the migration out" }, ADMIN);
    expect(sb.status).toBe(200);
    expect(sb.body).toMatchObject({ state: "working", transitioned: true });
    const inboxNotes = (await h.call("GET", `/v1/forge/intents/${id}/messages`)).body;
    expect(JSON.stringify(inboxNotes)).toContain("split the migration out");
    const bad = await h.call("POST", `/v1/forge/intents/${id}/review`, { decision: "disagree" }, ADMIN);
    expect(bad.body.code).toBe("invalid_request");
    expect((await h.call("POST", `/v1/forge/intents/${id}/review`, { decision: "agree" }, ADMIN)).body.ledger).toBe("review.sampled_ok");
    expect((await h.call("POST", `/v1/forge/intents/${id}/review`, { decision: "disagree", reason: "wrong" }, ADMIN)).body.ledger).toBe("review.disagreed");
    const m = rec((await h.call("GET", "/v1/forge/inbox?repo=demo")).body.metrics);
    expect(rec(m.disagreement)).toMatchObject({ n: 2, rate: 0.5 });
    const agents = (await h.call("GET", "/v1/forge/agents?repo=demo")).body.agents as Array<Record<string, unknown>>;
    expect(agents[0]).toMatchObject({ id: "alpha", active: 1, disagreement_rate: 0.667 });
  });

  it("serves the recorded bench run with simulated: true", async () => {
    const b = (await harness().call("GET", "/v1/forge/bench")).body;
    expect(b.simulated).toBe(true);
    expect(b.agents).toBe(10000);
    const mode = rec((b.modes as unknown[])[0]);
    expect(rec(mode.metrics)).toHaveProperty("median_declare_to_land_s");
  });

  it("approve-landing is admin-only and calls the train port", async () => {
    const approved: string[] = [];
    const h = harness((db) => ({ ...d1Trains(db), approveLanding: async (id: string) => (approved.push(id), true) }));
    const d = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Edit y", footprint: ["y.ts"], reasoning: "r", agent: "alpha" });
    const id = rec(d.body.intent).id as string;
    expect((await h.call("POST", `/v1/forge/intents/${id}/approve-landing`, {}, RUNNER)).body.code).toBe("admin_required");
    expect((await h.call("POST", `/v1/forge/intents/${id}/approve-landing`, {}, ADMIN)).body.code).toBe("stale_state");
    await transitionIntent(h.db, id, "draft", "claimed", {}, "alpha");
    await transitionIntent(h.db, id, "claimed", "working", { headSha: sha("1") }, "alpha");
    await transitionIntent(h.db, id, "working", "ready", {}, "alpha");
    const ok = await h.call("POST", `/v1/forge/intents/${id}/approve-landing`, {}, ADMIN);
    expect(ok.body.landingApproved).toBe(true);
    expect(approved).toEqual([id]);
  });

  it("train list/detail carry lanes and stages", async () => {
    const h = harness();
    const d = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Edit z", footprint: ["z.ts"], reasoning: "r", agent: "alpha" });
    const id = rec(d.body.intent).id as string;
    const t = await createTrain(h.db, { repo: "demo", lane: 0, baseSha: sha("0"), intentIds: [id] });
    const list = (await h.call("GET", "/v1/forge/trains?repo=demo")).body.trains as Array<Record<string, unknown>>;
    expect(rec((list[0].lanes as unknown[])[0])).toMatchObject({ n: 0, intents: [id] });
    const one = rec((await h.call("GET", `/v1/forge/trains/${t.id}`)).body.train);
    expect(one.base_sha).toBe(sha("0"));
    expect(rec(rec((one.lanes as unknown[])[0]).stages)).toHaveProperty("ci");
  });
});
