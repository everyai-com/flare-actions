import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, DASHBOARD_UI_ACTIONS, FORGE_MCP_TOOL_NAMES, dashboardRedirectUrl } from "./dashboard";
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

  it("pins Home (the signed-in landing screen) first, then the agent forge group", () => {
    const nav = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('id="sideNav"'), DASHBOARD_HTML.indexOf("</nav>"));
    expect(nav.indexOf('id="tabHome"')).toBeLessThan(nav.indexOf("Agent forge"));
    expect(nav.indexOf("Agent forge")).toBeLessThan(nav.indexOf("Flare CI"));
    expect(nav.indexOf('id="tabAgents"')).toBeLessThan(nav.indexOf('id="tabRuns"'));
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

  it("models trains like docs/FORGE.md: fixed forge/lane-N refs, stacked lanes, culprit fails", () => {
    const f = FORGE_FIXTURES;
    const text = JSON.stringify(f) + FORGE_JS;
    expect(text).not.toMatch(/train\/t?\d/); // never a per-train ref
    for (const t of f.trains) {
      t.lanes.forEach((l, i) => {
        expect(l.n, t.id).toBe(i);
        expect(l.ref, t.id).toBe("forge/lane-" + i);
      });
    }
    const t142 = f.trains.find((t) => t.id === "t-142");
    const culprit = t142?.bisect?.children.find((c) => "culprit" in c && c.culprit);
    expect(culprit?.intents).toEqual(["i-c310"]);
    expect(f.intents.find((i) => i.id === "i-c310")?.state).toBe("failed");
    // lanes behind the first red lane never land; the red lane is last here
    const red = t142?.lanes.findIndex((l) => l.stages.ci.status === "failure");
    expect(red).toBe((t142?.lanes.length ?? 0) - 1);
    // conflict a is the intent the train dropped; b covers the file and landed first
    const c9 = f.conflicts[0];
    expect(f.intents.find((i) => i.id === c9.a.intent)?.state).not.toBe("landed");
    expect(c9.b.landed).toBe(true);
    // the overlap feed uses the Feed DO's "edge" ops
    expect(FORGE_JS).toContain('op.kind === "edge"');
    expect(FORGE_JS).toContain('kind: "edge"');
    expect(FORGE_JS).toContain('label: "Main red (integration)"');
    expect(FORGE_JS).toContain('truncated_footprint: "footprint truncated — routed to a human"');
    expect(FORGE_JS).toContain("main only moves to a SHA CI verified green as that exact SHA");
  });

  it("offers a demo path from the signed-out screens and teaches empty states", () => {
    const auth = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('id="authPane"'), DASHBOARD_HTML.indexOf('id="invitePane"'));
    expect(auth).toContain('href="/dashboard?demo=1#/live"');
    expect(auth).toContain("Explore the live demo →");
    for (const code of ["inbox_empty", "forge_demo_seed", "forge_connect_agent", "forge_demo_data"]) expect(FORGE_JS).toContain('"' + code + '"');
    expect(FORGE_JS).toContain('"data-command": cmd');
    expect(FORGE_JS).toContain('var cmd = "npm run forge:demo";');
    // boot's one-shot param cleanup keeps demo/stage/tour and the hash route
    expect(DASHBOARD_HTML).toContain('["demo", "stage", "tour"].forEach');
    expect(DASHBOARD_HTML).toContain('(location.hash || "")');
  });

  it("ships master-detail lists with filter chips and j/k/Enter", () => {
    for (const fn of ["function fxMasterDetail", "function fxMdSelect", "function fxMdMove", "FX_INTENT_FILTERS", "FX_TRAIN_FILTERS", "FX_CONFLICT_FILTERS"]) expect(FORGE_JS).toContain(fn);
    expect(FORGE_JS).toContain('if (k === "j" || k === "ArrowDown") { e.preventDefault(); fxMdMove(1); return; }');
    expect(FORGE_CSS).toContain(".fx-md {");
    expect(FORGE_CSS).toMatch(/@media \(max-width: 1100px\) \{\s*\.fx-md \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it("names agents on the map and keeps hot treemap cells readable", () => {
    expect(FORGE_PANE_HTML).toContain('id="fxAgentsRail" aria-label="Agents on map"');
    expect(FORGE_JS).toContain("function fxRenderAgentsRail");
    expect(FORGE_JS).toContain("function fxHighlightAgent");
    expect(FORGE_JS).toContain("var hotFloor");
    expect(FORGE_JS).toContain("function fxFitPath");
    for (const a of FORGE_FIXTURES.agents) expect(a.name.length, a.id).toBeGreaterThan(2);
  });

  it("runs a skippable four-step tour built only from UI-only verbs", () => {
    const tourActions = [...(FORGE_OVERLAYS_HTML + FORGE_PANE_HTML).matchAll(/data-action="(tour_[a-z]+)"/g)].map((m) => m[1]);
    expect(new Set(tourActions)).toEqual(new Set(["tour_start", "tour_next", "tour_back", "tour_skip"]));
    for (const a of tourActions) {
      expect(DASHBOARD_UI_ACTIONS as readonly string[]).toContain(a);
      expect(FORGE_MCP_TOOL_NAMES as readonly string[]).not.toContain(a);
    }
    const steps = FORGE_JS.slice(FORGE_JS.indexOf("var FX_TOUR = ["), FORGE_JS.indexOf("var FX_TOUR_KEY"));
    expect(steps.match(/\{ hash: "/g)).toHaveLength(4);
    for (const q of ["Who's doing what?", "What do humans review?", "What happens when they collide?", "Why does this line exist?"]) expect(steps).toContain(q);
    // the tour never calls the API, persists via guarded storage, and honors ?tour
    const tourJs = FORGE_JS.slice(FORGE_JS.indexOf("// ---------- first-run tour"), FORGE_JS.indexOf("// ---------- palette, keys"));
    expect(tourJs).not.toContain("fxFetch");
    expect(tourJs).not.toContain("fxCall");
    expect(tourJs).toContain('try { localStorage.setItem(FX_TOUR_KEY, "done"); } catch (e) {}');
    expect(tourJs).toContain('if (t === "0") return false;');
    expect(tourJs).toContain('if (t === "1") return true;');
    const rm = FORGE_CSS.slice(FORGE_CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm.slice(0, rm.indexOf("\n}"))).toContain(".fx-tour-ring { transition: none; }");
  });
});

// Simple mode copy (docs/UX-BUDGET.md): every word a Simple screen shows
// lives in FX_SIMPLE_COPY inside the embedded script.
function simpleCopy(): Record<string, string> {
  const start = FORGE_JS.indexOf("var FX_SIMPLE_COPY = {");
  const end = FORGE_JS.indexOf("\n  };", start);
  expect(start).toBeGreaterThan(0);
  const literal = FORGE_JS.slice(start + "var FX_SIMPLE_COPY = ".length, end + 4);
  const parsed: unknown = new Function("return " + literal)();
  expect(typeof parsed).toBe("object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    expect(typeof v, k).toBe("string");
    out[k] = String(v);
  }
  return out;
}
const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}{]/u.test(w));

describe("forge simple mode", () => {
  it("keeps Simple copy inside the cognitive-load budget", () => {
    const copy = simpleCopy();
    expect(Object.keys(copy).length).toBeGreaterThan(100);
    const jargon = /\b(intents?|footprints?|trains?|trunk|fixtures?|sha|overlaps?|conflict\w*|repo|repository|pipeline|runners?|dispatch|lanes?|ci|mcp|lease|bisect\w*|cas|ledgers?|trailers?|replay\w*|fork\w*|sessions?)\b/i;
    for (const [key, text] of Object.entries(copy)) {
      expect(text, key).not.toMatch(jargon);
      expect(text.trim(), key).not.toBe("");
      if (key.endsWith("_h")) expect(words(text).length, key + ": " + text).toBeLessThanOrEqual(6);
      for (const sentence of text.split(/(?<=[.!?])\s+/)) expect(words(sentence).length, key + ": " + sentence).toBeLessThanOrEqual(15);
    }
  });

  it("only reads Simple copy keys that exist", () => {
    const copy = simpleCopy();
    const used = [...FORGE_JS.matchAll(/fxS\("([a-z0-9_]+)"[,)]/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(60);
    for (const k of used) expect(copy, "fxS key " + k).toHaveProperty(k);
    // dynamic families the renderers build from data
    for (const st of ["working", "awaiting_plan", "in_train", "landed", "conflicted", "replaying", "open", "resolved", "idle"]) expect(copy).toHaveProperty("st_" + st);
    for (const b of ["low", "med", "high"]) expect(copy).toHaveProperty("risk_" + b);
    for (const r of ["plan", "sample", "help"]) { expect(copy).toHaveProperty("inbox_" + r + "_h"); expect(copy).toHaveProperty("inbox_why_" + r); }
    for (const k of ["same", "landed", "clash"]) expect(copy).toHaveProperty("toast_" + k);
    for (const n of [1, 2, 3, 4]) for (const part of ["_h", "_b", "_t"]) expect(copy).toHaveProperty("tour" + n + part);
    for (const s of ["live", "inbox", "intents", "trains", "conflicts", "agents", "bench", "why"]) expect(copy).toHaveProperty("scr_" + s + "_h");
    // detail views build these keys from data
    for (const st of ["draft", "awaiting_plan", "claimed", "working", "ready", "in_train", "landed", "conflicted", "replaying", "bisected", "failed", "expired", "abandoned", "other"]) expect(copy).toHaveProperty("plan_st_" + st);
    for (const k of ["running", "forming", "landed", "bisected", "failed"]) { expect(copy).toHaveProperty("land_h_" + k); if (k !== "bisected") expect(copy).toHaveProperty("land_p_" + k); }
    expect(copy).toHaveProperty("land_p_some");
    for (const k of ["claimed", "replaying", "test", "train", "landed", "other"]) expect(copy).toHaveProperty("cstep_" + k);
    const cstep = FORGE_JS.slice(FORGE_JS.indexOf("var FX_CSTEP = {"), FORGE_JS.indexOf("};", FORGE_JS.indexOf("var FX_CSTEP = {")));
    for (const m of cstep.matchAll(/"(cstep_[a-z_]+)"/g)) expect(copy).toHaveProperty(m[1]);
    for (const k of ["err_network", "err_auth", "err_missing", "err_p"]) expect(copy).toHaveProperty(k);
    for (const [kind, keys] of [["intents", ["all", "human", "active", "train", "landed", "failed"]], ["trains", ["all", "running", "landed", "red"]], ["conflicts", ["all", "open", "claimed", "resolved", "failed"]]] as const) {
      for (const k of keys) expect(copy).toHaveProperty("f_" + kind + "_" + k);
    }
  });

  it("branches Live, Inbox and Agents on the shared html.ui-simple contract", () => {
    expect(FORGE_JS).toContain('function fxSimple() { return document.documentElement.classList.contains("ui-simple"); }');
    for (const fn of ["function fxRenderLiveSimple", "function fxRenderTrackSimple", "function fxRenderInboxSimple", "function fxRenderAgentsSimple", "function fxGameDiff", "function fxPollAgents"]) expect(FORGE_JS).toContain(fn);
    expect(FORGE_JS).toContain("if (fxSimple()) { fxRenderInboxSimple(); return; }");
    expect(FORGE_JS).toContain("if (fxSimple()) fxRenderTrackSimple(s); else fxRenderTrack(s);");
    expect(FORGE_JS).toContain("if (fxSimple()) { fxRenderAgentsSimple(");
    for (const id of ['id="fxLiveSimple"', 'id="fxInboxSimple"', 'id="fxMoreBtn"']) expect(FORGE_PANE_HTML).toContain(id);
    expect(FORGE_CSS).toContain("html:not(.ui-simple) .fx-simple-only { display: none !important; }");
    expect(FORGE_CSS).toContain(".ui-simple #forgePane:not(.fx-more) .fx-pro-only, .ui-simple .fx-pro-view { display: none !important; }");
    // the machine [code] line stays in the DOM, hidden only visually
    expect(FORGE_CSS).toContain(".ui-simple .fx-empty .fx-code");
    // pulses respect reduced motion; toasts only in Simple, never while paused
    const rm = FORGE_CSS.slice(FORGE_CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm.slice(0, rm.indexOf("\n}"))).toContain(".fx-main-rule.fx-pulse { animation: none; }");
    expect(FORGE_JS).toContain("if (!fxSimple() || FX.paused) return;");
    // screens expose their one job and the phase for agents
    expect(FORGE_JS).toContain('root.setAttribute("data-job", FX_SCREEN_JOB[s] || s)');
    // demo visitors default to Simple unless a mode is already set
    expect(FORGE_JS).toContain('if (FX.demo && q.get("stage") !== "1" && !rootCl.contains("ui-simple") && !rootCl.contains("ui-pro")) rootCl.add("ui-simple");');
  });
});

describe("forge simple detail views", () => {
  it("branches every detail view and the why drawer on Simple, keeping the Pro render intact", () => {
    for (const [disp, fn] of [
      ["if (fxSimple()) { fxRenderIntentSimple(box, i); return; }", "function fxRenderIntentFull("],
      ["if (fxSimple()) { fxRenderTrainSimple(box, t); return; }", "function fxRenderTrainFull("],
      ["if (fxSimple()) { fxRenderConflictSimple(box, c); return; }", "function fxRenderConflictFull("],
      ["if (fxSimple()) { fxRenderWhySimple(body, d, path, line); return; }", "function fxRenderWhyFull("],
      ["if (fxSimple()) { fxRenderBenchSimple(box, b); return; }", "function fxRenderBenchFull("],
    ]) {
      expect(FORGE_JS).toContain(disp);
      expect(FORGE_JS).toContain(fn);
    }
    // each Simple view states its one job and hides the rest under Show more
    for (const job of ["is_this_plan_safe", "is_this_batch_safe", "who_fixes_this_clash", "explain_line", "compare_speed"]) expect(FORGE_JS).toContain('"data-job": "' + job + '"');
    for (const k of ["intent:", "train:", "conflict:", "why:", "bench:"]) expect(FORGE_JS).toContain('fxShowMore("' + k + '"');
    expect(FORGE_JS).toContain('h("summary", { "data-action": "show_more"');
    // one primary move, and only when this viewer can make it
    expect(FORGE_JS).toContain("function fxCanAct()");
    expect(FORGE_JS).toContain('if (fxCanAct()) card.appendChild(h("div", { cls: "fx-actions" }, [h("button", { type: "button", cls: "fx-sv-primary", "data-action": "approve_plan"');
    expect(FORGE_JS).toContain('if (fxCanAct()) who.push(h("div", { cls: "fx-actions" }, [h("button", { type: "button", cls: "fx-sv-primary", "data-action": "claim_conflict"');
    // a landed batch is celebrated, and reduced motion turns it off
    expect(FORGE_CSS).toContain(".fx-celebrate {");
    const rm = FORGE_CSS.slice(FORGE_CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm.slice(0, rm.indexOf("\n}"))).toContain(".fx-celebrate { animation: none; }");
  });

  it("keeps errors, toasts and empty states plain in Simple with the code in data-*", () => {
    expect(FORGE_JS).toContain('cls: "fx-error fx-error-simple", role: "alert", "data-state": "error", "data-code": code');
    expect(FORGE_CSS).toContain("html.ui-simple .fx-error .fx-code { display: none; }");
    expect(FORGE_JS).toContain('if (fxSimple()) { fxToast(fxS("toast_fail"), true, err.code); throw err; }');
    expect(FORGE_JS).toContain('fxToast(fxS("toast_" + kind), false, "", "game");');
    expect(FORGE_JS).toContain('role: isErr ? "alert" : "status", "data-code": code || null');
    for (const code of ["intent_not_found", "train_not_found", "conflict_not_found", "no_trains", "bench_not_found", "source_unavailable"]) expect(FORGE_JS).toContain('fxEmptySimple("' + code + '"');
  });

  it("styles Simple Forge with the shared Simple tokens and keeps mono for code", () => {
    for (const tok of ["--s-font", "--s-radius", "--s-gap", "--s-primary", "--s-primary-fg", "--s-ok", "--s-bad", "--s-wait", "--s-muted", "--s-card-bg", "--s-border", "--s-h1", "--s-h2", "--s-body"]) {
      expect(FORGE_CSS, tok).toMatch(new RegExp("var\\(" + tok + ", [^)]"));
    }
    expect(FORGE_CSS).toContain("html.ui-simple #forgePane :is(code, pre, kbd, .mono,");
    expect(FORGE_CSS).toContain("html.ui-simple #forgePane :is(a, button, summary, input, select, textarea, [tabindex]):focus-visible");
    // every Simple-only rule is scoped, so Pro keeps its look
    for (const line of FORGE_CSS.split("\n")) if (line.includes("var(--s-font")) expect(line.startsWith("html.ui-simple")).toBe(true);
  });

  it("leaves the Pro strings in place", () => {
    for (const pro of ['["Approve plan ", h("kbd", { text: "a" })]', "Both intents' why, side by side", "merge into stacked lanes", '"Baseline vs Forge"', "Could not load this screen", '["Fork session"]', '"Copy chain"', "Live updates paused · press p to resume", "Launch intents", "Each intent needs a title and at least one footprint path", "\"Why · line \" + line"]) {
      expect(FORGE_JS).toContain(pro);
    }
  });
});

describe("dashboard redirect", () => {
  it("keeps the query string on GET / -> /dashboard", () => {
    expect(dashboardRedirectUrl(new URL("https://x.dev/?demo=1"))).toBe("https://x.dev/dashboard?demo=1");
    expect(dashboardRedirectUrl(new URL("https://x.dev/?demo=1&stage=1&tour=1#/live"))).toBe("https://x.dev/dashboard?demo=1&stage=1&tour=1");
    expect(dashboardRedirectUrl(new URL("https://x.dev/"))).toBe("https://x.dev/dashboard");
  });
});
