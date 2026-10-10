import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, DASHBOARD_UI_ACTIONS, FORGE_MCP_TOOL_NAMES } from "./dashboard";
import { FORGE_FIXTURES, forgeFixturesJson } from "./forge-fixtures";
import { FORGE_JS } from "./dashboard-forge-js";
import { FORGE_CSS, FORGE_PANE_HTML, FORGE_OVERLAYS_HTML, FORGE_NAV_HTML } from "./dashboard-forge-ui";

// Static guards for the Forge screens (docs/FORGE-UX.md). Runtime-free:
// the embedded script is compiled, never executed.

function inlineScript(): string {
  const parts = DASHBOARD_HTML.split("<script>");
  return parts[parts.length - 1].split("</script>")[0];
}

function dataActions(): Set<string> {
  const found = new Set<string>();
  const patterns = [
    /data-action="([a-z_]+)"/g, // static markup
    /"data-action": "([a-z_]+)"/g, // h() attribute objects
    /\[data-action=([a-z_]+)\]/g, // selectors
    /btn\("[^"]*", "[^"]*", "([a-z_]+)"/g, // fxRowActions helper
  ];
  for (const re of patterns) for (const m of DASHBOARD_HTML.matchAll(re)) found.add(m[1]);
  return found;
}

describe("forge dashboard", () => {
  it("keeps every fragment free of backticks and interpolation", () => {
    for (const frag of [FORGE_JS, FORGE_CSS, FORGE_PANE_HTML, FORGE_OVERLAYS_HTML, FORGE_NAV_HTML, forgeFixturesJson()]) {
      expect(frag).not.toContain("${");
      expect(frag).not.toContain("`");
    }
  });

  it("compiles the embedded script", () => {
    const js = inlineScript();
    expect(js).toContain("function fxRenderMap");
    // Syntax check only: the Function body is never invoked.
    expect(() => new Function(js)).not.toThrow();
  });

  it("maps every data-action to an MCP tool or a declared UI-only verb", () => {
    const allowed = new Set<string>([...FORGE_MCP_TOOL_NAMES, ...DASHBOARD_UI_ACTIONS]);
    const actions = dataActions();
    expect(actions.size).toBeGreaterThan(10);
    for (const a of actions) expect(allowed, "data-action " + a).toContain(a);
    // and the REST map the actions call covers only declared tools
    for (const m of FORGE_JS.matchAll(/^ {4}([a-z_]+): \{ m: "POST"/gm)) expect(FORGE_MCP_TOOL_NAMES).toContain(m[1]);
  });

  it("puts the agent forge first, with Home (the signed-in landing screen) right under it", () => {
    const nav = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('id="sideNav"'), DASHBOARD_HTML.indexOf("</nav>"));
    expect(nav.indexOf("Agent forge")).toBeLessThan(nav.indexOf('id="tabHome"'));
    expect(nav.indexOf('id="tabAgents"')).toBeLessThan(nav.indexOf('id="tabHome"'));
    expect(nav.indexOf('id="tabHome"')).toBeLessThan(nav.indexOf("Code"));
    // Home links into Forge
    expect(DASHBOARD_HTML).toContain('id="homeCardForge" href="#/live"');
    expect(nav.indexOf('id="tabLive"')).toBeLessThan(nav.indexOf('id="tabRepos"'));
    for (const tab of ["tabLive", "tabInbox", "tabIntents", "tabTrains", "tabConflicts", "tabAgents", "tabBench"]) {
      expect(nav).toContain('id="' + tab + '"');
    }
    expect(DASHBOARD_HTML).toContain('palGoTab("home")');
    expect(DASHBOARD_HTML).toContain('fxNav("#/live")');
    expect(DASHBOARD_HTML).toContain('l: "live", i: "inbox", n: "intents", p: "trains", c: "conflicts", a: "agents", b: "bench"');
  });

  it("codes against the stream-B data contract with a feed and polling fallback", () => {
    for (const ep of ["/v1/forge/snapshot?repo=", "/v1/forge/inbox?repo=", "/v1/forge/intents", "/v1/forge/trains", "/v1/forge/conflicts", "/v1/forge/why?repo=", "/v1/forge/goals", "/v1/forge/feed?repo=", "/v1/forge/bench"]) {
      expect(FORGE_JS).toContain(ep);
    }
    expect(FORGE_JS).toContain('m.type === "snapshot"');
    expect(FORGE_JS).toContain('m.type !== "delta"');
    expect(FORGE_JS).toContain("fxStartPolling");
    expect(FORGE_JS).toContain("}, 5000);");
    expect(FORGE_JS).toMatch(/err\.status === 404 \|\| err\.status === 405 \|\| err\.status === 501/);
  });

  it("is agent-readable: alternate JSON link, JSON button, landmarks, table twin, machine empty states", () => {
    expect(DASHBOARD_HTML).toContain('<link rel="alternate" type="application/json" id="fxAltLink"');
    expect(DASHBOARD_HTML).toContain('id="fxJsonLink"');
    expect(DASHBOARD_HTML).toContain('aria-describedby="fxLiveTableWrap"');
    expect(DASHBOARD_HTML).toContain('<table id="fxLiveTable">');
    expect(DASHBOARD_HTML).toContain('aria-label="Why chain"');
    for (const code of ["forge_no_active_intents", "inbox_clear", "no_goals", "no_trains", "no_conflicts", "why_not_found", "bench_not_found"]) {
      expect(FORGE_JS).toContain('"' + code + '"');
    }
    expect(FORGE_JS).toContain('"data-code": code');
  });

  it("never shows bench fixtures outside demo mode", () => {
    expect(FORGE_JS).toContain('var p = FX.demo ? Promise.resolve(fxFixtures().bench) : fxFetch("/v1/forge/bench");');
    expect(FORGE_JS).toContain("This panel never shows placeholder numbers outside demo mode.");
  });

  it("renders API data through textContent, never innerHTML", () => {
    expect(FORGE_JS).not.toContain("innerHTML");
    expect(FORGE_JS).not.toContain("insertAdjacentHTML");
    expect(FORGE_JS).not.toContain("document.write");
  });

  it("respects reduced motion and ships stage mode and a light theme", () => {
    expect(FORGE_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(FORGE_CSS).toContain('@media (prefers-color-scheme: light) { :root:not([data-theme="dark"])');
    expect(FORGE_CSS).toContain(':root[data-theme="light"]');
    expect(FORGE_CSS).toContain("body.fx-stagemode .fx-cval { font-size: 56px");
    for (const tok of ["--st-working", "--st-overlap", "--st-conflict", "--st-landed", "--st-train", "--st-human", "--st-idle", "--risk-low", "--risk-med", "--risk-high", "--tint-overlap"]) {
      expect(FORGE_CSS).toContain(tok + ":");
    }
  });

  it("embeds fixtures that cannot break out of their script element", () => {
    const json = forgeFixturesJson();
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(FORGE_FIXTURES)));
    expect(DASHBOARD_HTML).toContain('<script type="application/json" id="fxFixtures">');
  });

  it("keeps the Bookshelf fixtures internally consistent", () => {
    const f = FORGE_FIXTURES;
    const goals = new Set(f.goals.map((g) => g.id));
    const agents = new Set(f.agents.map((a) => a.id));
    const intents = new Map(f.intents.map((i) => [i.id, i]));
    for (const i of f.intents) {
      expect(goals, i.id).toContain(i.goal_id);
      expect(agents, i.id).toContain(i.agent);
      // explainable risk: the score is exactly the sum of its terms
      expect(i.risk, i.id).toBe(i.risk_terms.reduce((n, t) => n + t.points, 0));
      for (const d of i.footprint.drift) expect(i.footprint.actual, i.id).toContain(d);
    }
    for (const t of f.trains) for (const l of t.lanes) for (const id of l.intents) expect(intents.has(id), t.id + " " + id).toBe(true);
    for (const c of f.conflicts) {
      expect(intents.has(c.a.intent)).toBe(true);
      expect(intents.has(c.b.intent)).toBe(true);
      expect(c.race.filter((r) => r.winner)).toHaveLength(1);
    }
    for (const id of Object.values(f.why.blame)) if (id) expect(intents.has(id)).toBe(true);
    // the protected-path intent waits for a plan, as .flare/policy.yml says
    expect(intents.get("i-9a01")?.state).toBe("awaiting_plan");
  });
});
