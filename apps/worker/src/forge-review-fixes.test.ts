import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { handleForgeRequest, type ForgeIdentity } from "./forge-routes";
import { forgeServiceDeps, gitAuthEnv, type ForgeServiceDeps } from "./forge-service";
import { openConflict } from "./intents";
import { DEFAULT_POLICY, routeLanding, scoreRisk } from "./intents-core";
import { fakeArtifacts, forgeSqliteDb, sha } from "./forge.testkit";

// Regression tests for the adversarial review of the forge surface
// (integrator update #5). One describe per finding.

const RUNNER: ForgeIdentity = { scope: "runner", actor: "token:runner1", repos: [] };

type Call = (method: string, path: string, body?: unknown, ident?: ForgeIdentity) => Promise<{ status: number; body: Record<string, unknown> }>;

export function reviewHarness(opts: { artifacts?: boolean } = {}): { db: Db; deps: ForgeServiceDeps; call: Call; fake: ReturnType<typeof fakeArtifacts> } {
  const db = forgeSqliteDb();
  const fake = fakeArtifacts("demo");
  const deps = forgeServiceDeps({ db, artifacts: opts.artifacts === false ? null : fake.artifacts, namespace: "ns", accountId: "a".repeat(32) });
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

describe("#5 truncated footprints fail closed", () => {
  it("scoreRisk adds +40 truncated_footprint, which routes to a human under the default policy", () => {
    const out = scoreRisk({ footprint: { paths: ["a.ts"] }, actualFootprint: { paths: ["a.ts"] }, truncated: true });
    expect(out.terms.map((t) => t.term)).toContain("truncated_footprint");
    expect(out.risk).toBeGreaterThanOrEqual(40);
    expect(routeLanding(out.risk, DEFAULT_POLICY, 0.99)).toBe("human");
    expect(scoreRisk({ footprint: { paths: ["a.ts"] }, actualFootprint: { paths: ["a.ts"] } }).terms.map((t) => t.term)).not.toContain("truncated_footprint");
  });

  it("report_push whose verified diff exceeds the footprint cap records the truncated term", async () => {
    const h = reviewHarness();
    const d = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Big change", footprint: ["src/**"], reasoning: "r", agent: "alpha" });
    const id = rec(d.body.intent).id as string;
    const c = await h.call("POST", `/v1/forge/intents/${id}/claim`, { agent: "alpha" });
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) files[`src/f${i}.ts`] = String(i);
    h.fake.commit(c.body.forkRepo as string, sha("7"), files);
    const r = await h.call("POST", `/v1/forge/intents/${id}/push`, { sha: sha("7"), agent: "alpha" });
    expect(r.status).toBe(200);
    expect(rec(r.body.actualFootprint).truncated).toBe(true);
    const terms = rec(r.body.risk).terms as Array<{ term: string }>;
    expect(terms.map((t) => t.term)).toContain("truncated_footprint");
  });
});

describe("#1 conflict claim/resolve follow the train convention (intent_a = dropped)", () => {
  it("replays intent_a and never mints a token on the landed other side", async () => {
    const h = reviewHarness();
    const mk = async (title: string, agent: string) =>
      rec((await h.call("POST", "/v1/forge/intents", { repo: "demo", title, footprint: ["src/x.ts"], reasoning: "r", agent })).body.intent).id as string;
    const landedId = await mk("Landed first", "alpha");
    const droppedId = await mk("Dropped by the train", "beta");
    const cl = await h.call("POST", `/v1/forge/intents/${landedId}/claim`, { agent: "alpha" });
    const cd = await h.call("POST", `/v1/forge/intents/${droppedId}/claim`, { agent: "beta" });
    const landedFork = cl.body.forkRepo as string;
    const droppedFork = cd.body.forkRepo as string;
    await h.db.prepare("UPDATE intents SET state = 'landed' WHERE id = ?").bind(landedId).run();
    await h.db.prepare("UPDATE intents SET state = 'conflicted', head_sha = ? WHERE id = ?").bind(sha("5"), droppedId).run();
    const conflict = await openConflict(h.db, { repo: "demo", intentA: droppedId, intentB: landedId, files: ["src/x.ts"] });
    const before = h.fake.tokens.length;
    const claimed = await h.call("POST", `/v1/forge/conflicts/${conflict.id}/claim`, { agent: "fixer" });
    expect(claimed.status).toBe(200);
    expect(rec(claimed.body.replay)).toMatchObject({ intentId: droppedId, forkRepo: droppedFork });
    const minted = h.fake.tokens.slice(before);
    expect(minted.length).toBeGreaterThan(0);
    expect(minted.every((t) => t.repo === droppedFork)).toBe(true);
    expect(minted.some((t) => t.repo === landedFork)).toBe(false);
    expect(rec((await h.call("GET", `/v1/forge/intents/${droppedId}`)).body.intent).state).toBe("replaying");
  });
});

describe("#2 the intent base is trunk main, never the caller's baseSha", () => {
  it("ignores a supplied baseSha so a pre-made base commit cannot hide changes", async () => {
    const h = reviewHarness();
    const d = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Sneaky", footprint: ["README.md"], reasoning: "r", agent: "alpha", baseSha: sha("9") });
    expect(d.status).toBe(201);
    expect(rec(d.body.intent).baseSha).toBe(sha("0"));
    const c = await h.call("POST", `/v1/forge/intents/${rec(d.body.intent).id as string}/claim`, { agent: "alpha" });
    const fork = c.body.forkRepo as string;
    // The agent's "base" already carries the protected change; the push
    // only touches README. Diffing against trunk still sees both files.
    h.fake.commit(fork, sha("9"), { "README.md": "x", "src/auth/keys.ts": "evil" });
    h.fake.commit(fork, sha("8"), { "README.md": "y", "src/auth/keys.ts": "evil" });
    const r = await h.call("POST", `/v1/forge/intents/${rec(d.body.intent).id as string}/push`, { sha: sha("8"), agent: "alpha" });
    expect(rec(r.body.actualFootprint).files).toContain("src/auth/keys.ts");
    expect(r.body.drift).toContain("src/auth/keys.ts");
    expect((await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Bad", footprint: ["a"], reasoning: "r", baseSha: "nope" })).body.code).toBe("invalid_request");
  });
});

describe("#16 git commands never put the token in a URL, argv or .git/config", () => {
  it("emits the GIT_CONFIG_* http.extraHeader env form, which git reads as Basic x:<token>", async () => {
    const h = reviewHarness();
    const d = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Edit x", footprint: ["x.ts"], reasoning: "r", agent: "alpha" });
    const c = await h.call("POST", `/v1/forge/intents/${rec(d.body.intent).id as string}/claim`, { agent: "alpha" });
    const clone = String(c.body.cloneCommand);
    const push = String(c.body.pushCommand);
    for (const cmd of [clone, push]) {
      expect(cmd).not.toMatch(/https:\/\/[^"\s]*@/);
      expect(cmd).toContain("GIT_CONFIG_KEY_0=http.extraHeader");
      expect(cmd).not.toContain(String(c.body.token));
    }
    // The prefix evaluates to the right header in a real shell.
    const prefix = gitAuthEnv("FLARE_FORK_TOKEN");
    const out = execFileSync("bash", ["-c", `${prefix} env | grep '^GIT_CONFIG_VALUE_0='`], { env: { ...process.env, FLARE_FORK_TOKEN: "tok123" } }).toString().trim();
    expect(out).toBe(`GIT_CONFIG_VALUE_0=Authorization: Basic ${Buffer.from("x:tok123").toString("base64")}`);
  });
});

describe("#9 owner-only verbs require the claiming credential, not just the agent label", () => {
  it("another run token naming the same agent cannot refresh the fork token, push, ready or abandon", async () => {
    const h = reviewHarness();
    const OTHER: ForgeIdentity = { scope: "runner", actor: "token:runner2", repos: [] };
    const ADMIN: ForgeIdentity = { scope: "admin", actor: "token:admin", repos: [] };
    const d = await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Owned", footprint: ["x.ts"], reasoning: "r", agent: "alpha" });
    const id = rec(d.body.intent).id as string;
    const c = await h.call("POST", `/v1/forge/intents/${id}/claim`, { agent: "alpha" });
    h.fake.commit(c.body.forkRepo as string, sha("4"), { "x.ts": "4" });
    const steal = await h.call("POST", `/v1/forge/intents/${id}/heartbeat`, { agent: "alpha", refreshToken: true }, OTHER);
    expect(steal.body.code).toBe("not_owner");
    expect(steal.body.forkToken).toBeUndefined();
    expect((await h.call("POST", `/v1/forge/intents/${id}/push`, { agent: "alpha", sha: sha("4") }, OTHER)).body.code).toBe("not_owner");
    expect((await h.call("POST", `/v1/forge/intents/${id}/ready`, { agent: "alpha" }, OTHER)).body.code).toBe("not_owner");
    expect((await h.call("POST", `/v1/forge/intents/${id}/abandon`, { agent: "alpha" }, OTHER)).body.code).toBe("not_owner");
    // The claiming credential still works; admins may abandon.
    expect((await h.call("POST", `/v1/forge/intents/${id}/heartbeat`, { agent: "alpha", refreshToken: true })).status).toBe(200);
    expect((await h.call("POST", `/v1/forge/intents/${id}/push`, { agent: "alpha", sha: sha("4") })).status).toBe(200);
    expect((await h.call("POST", `/v1/forge/intents/${id}/abandon`, { agent: "alpha" }, ADMIN)).body.state).toBe("abandoned");
  });
});

describe("#6 resolve re-derives the replay's footprint and risk", () => {
  it("replaces the pre-conflict actual footprint with the replay diff (drift surfaces)", async () => {
    const h = reviewHarness();
    const id = rec((await h.call("POST", "/v1/forge/intents", { repo: "demo", title: "Edit x", footprint: ["src/x.ts"], reasoning: "r", agent: "beta" })).body.intent).id as string;
    const c = await h.call("POST", `/v1/forge/intents/${id}/claim`, { agent: "beta" });
    const fork = c.body.forkRepo as string;
    h.fake.commit(fork, sha("2"), { "src/x.ts": "x2" });
    await h.call("POST", `/v1/forge/intents/${id}/push`, { sha: sha("2"), agent: "beta" });
    await h.db.prepare("UPDATE intents SET state = 'conflicted' WHERE id = ?").bind(id).run();
    const conflict = await openConflict(h.db, { repo: "demo", intentA: id, intentB: "trunk", files: ["src/x.ts"] });
    await h.call("POST", `/v1/forge/conflicts/${conflict.id}/claim`, { agent: "fixer" });
    // The replay also touches an undeclared file.
    h.fake.commit(fork, sha("3"), { "src/x.ts": "x3", "src/secret.ts": "s" });
    const r = await h.call("POST", `/v1/forge/conflicts/${conflict.id}/resolve`, { sha: sha("3"), agent: "fixer" });
    expect(r.status).toBe(200);
    const i = rec((await h.call("GET", `/v1/forge/intents/${id}`)).body.intent);
    expect(i.state).toBe("ready");
    expect(rec(i.actualFootprint).paths).toEqual(["src/secret.ts", "src/x.ts"]);
    expect((i.riskTerms as Array<{ term: string }>).map((t) => t.term)).toContain("drift");
  });
});
