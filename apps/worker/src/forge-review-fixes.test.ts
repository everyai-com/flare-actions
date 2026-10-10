import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { handleForgeRequest, type ForgeIdentity } from "./forge-routes";
import { forgeServiceDeps, type ForgeServiceDeps } from "./forge-service";
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
