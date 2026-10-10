import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, DASHBOARD_UI_ACTIONS, FORGE_MCP_TOOL_NAMES } from "./dashboard";
import { FORGE_JS } from "./dashboard-forge-js";
import { NEXT_MOVE_JS } from "./next-move";

// Static guards for the cognitive-load budget (docs/UX-BUDGET.md).
// Runtime-free: the head mode script runs against stubs; everything else
// reads the markup and the SC copy table in the inline script.
//
// Markers (the contract):
// - <html> gets ui-simple | ui-pro from the head script (key
//   flare-ui-mode, default simple, ?mode= overrides and persists).
// - data-simple-nav="primary" marks the Simple nav items; "more" the
//   More button. .simple-only / .pro-only swap copy per mode.
// - data-simple="head|label|text" marks static Simple copy.
// - SC (between simple-copy:start/end) holds all dynamic Simple copy:
//   h_ = headline, l_ = label, t_ = sentences.

// Pro words with a plain Simple word (docs/UX-BUDGET.md table). "Key" is
// the plain word for token; "project" for repo; "race" for tournament;
// "try" for attempt; "waiting to land" for merge queue.
const JARGON =
  /\b(intents?|footprints?|trains?|trunk|fixtures?|executors?|runners?|dispatch\w*|sha|pipelines?|tokens?|scopes?|webhooks?|hmac|tournaments?|attempts?|ledgers?|merge queues?|repos?|repositor(?:y|ies)|artifacts?|cron)\b/i;
// Case-sensitive: "CI" the acronym, not the letters inside a word.
const JARGON_CASED = /\bCI\b/;
function jargonFree(text: string, where: string): void {
  expect(text, where).not.toMatch(JARGON);
  expect(text, where).not.toMatch(JARGON_CASED);
}

function words(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
function sentences(s: string): string[] {
  return s.split(/(?<=[.!?…])\s+/).filter((x) => x.trim());
}
function headScript(): string {
  const head = DASHBOARD_HTML.slice(0, DASHBOARD_HTML.indexOf("</head>"));
  const open = '<script id="uiModeScript">';
  const start = head.indexOf(open);
  expect(start).toBeGreaterThan(-1);
  return head.slice(start + open.length, head.indexOf("</script>", start));
}
function mainScript(): string {
  const parts = DASHBOARD_HTML.split("<script>");
  return parts[parts.length - 1].split("</script>")[0];
}
// The dashboard's own script: without the Forge screens' code (owned and
// budget-tested in dashboard-forge-*) and the spliced next-move engine.
function ownScript(): string {
  const js = mainScript();
  expect(js).toContain(FORGE_JS);
  return js.replace(FORGE_JS, "").replace(NEXT_MOVE_JS, "");
}
// Balanced-paren argument text of a call starting at `open` (index of "(").
function callArgs(js: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < js.length; i++) {
    const c = js[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return js.slice(open + 1, i);
  }
  return js.slice(open + 1);
}
function simpleCopy(): Map<string, string> {
  const js = mainScript();
  const block = js.slice(js.indexOf("// simple-copy:start"), js.indexOf("// simple-copy:end"));
  expect(block.length).toBeGreaterThan(100);
  const out = new Map<string, string>();
  for (const m of block.matchAll(/\b([htl]_[a-z0-9_]+): "((?:[^"\\]|\\.)*)"/g)) out.set(m[1], m[2]);
  return out;
}
function markedCopy(): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  for (const m of DASHBOARD_HTML.matchAll(/<[a-z0-9]+[^>]*\sdata-simple="(head|label|text)"[^>]*>([^<]*)</g)) {
    out.push({ kind: m[1], text: m[2].trim() });
  }
  return out;
}

// Runs the head script with stub globals; returns the class it set and
// what it stored.
function runHead(search: string, stored: string | null, storageThrows = false) {
  const classes: string[] = [];
  const store: Record<string, string> = {};
  if (stored !== null) store["flare-ui-mode"] = stored;
  const localStorage = {
    getItem: (k: string) => {
      if (storageThrows) throw new Error("blocked");
      return k in store ? store[k] : null;
    },
    setItem: (k: string, v: string) => {
      if (storageThrows) throw new Error("blocked");
      store[k] = v;
    },
  };
  const document = { documentElement: { classList: { add: (c: string) => classes.push(c) } } };
  const location = { search };
  new Function("location", "localStorage", "document", headScript())(location, localStorage, document);
  return { classes, stored: store["flare-ui-mode"] };
}

describe("ux budget: modes", () => {
  it("sets the mode class in <head> before first paint, defaulting to Simple", () => {
    const head = DASHBOARD_HTML.slice(0, DASHBOARD_HTML.indexOf("</head>"));
    expect(head.indexOf("flare-ui-mode")).toBeGreaterThan(-1);
    expect(head.indexOf("flare-ui-mode")).toBeLessThan(head.indexOf("<style>"));
    expect(runHead("", null).classes).toEqual(["ui-simple"]);
    expect(runHead("", "pro").classes).toEqual(["ui-pro"]);
    expect(runHead("", "garbage").classes).toEqual(["ui-simple"]);
    expect(runHead("", null, true).classes).toEqual(["ui-simple"]);
  });

  it("lets ?mode= override and persist", () => {
    expect(runHead("?mode=pro", null)).toEqual({ classes: ["ui-pro"], stored: "pro" });
    expect(runHead("?mode=simple", "pro")).toEqual({ classes: ["ui-simple"], stored: "simple" });
    expect(runHead("?demo=1&mode=pro", "simple").classes).toEqual(["ui-pro"]);
    expect(runHead("?mode=bogus", "pro").classes).toEqual(["ui-pro"]);
  });

  it("exposes uiSimple() and an accessible Simple/Pro switch in the sidebar footer", () => {
    expect(mainScript()).toContain('function uiSimple() { return document.documentElement.classList.contains("ui-simple"); }');
    const foot = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('class="side-foot"'), DASHBOARD_HTML.indexOf("</header>"));
    expect(foot).toMatch(/<button id="modeBtn"[^>]*role="switch"[^>]*aria-checked="false"[^>]*data-action="toggle_mode"/);
    expect(foot).toContain("Simple");
    expect(foot).toContain("Pro");
    // Toggling re-renders the current screen.
    const js = mainScript();
    const fn = js.slice(js.indexOf("function setUiMode("), js.indexOf("function syncModeBtn("));
    expect(fn).toContain("refreshCurrent()");
    expect(fn).toContain('localStorage.setItem("flare-ui-mode"');
  });

  it("swaps copy per mode with CSS, Pro being the default look without the class", () => {
    expect(DASHBOARD_HTML).toContain("html:not(.ui-simple) .simple-only { display: none !important; }");
    expect(DASHBOARD_HTML).toContain("html.ui-simple .pro-only { display: none !important; }");
    expect(DASHBOARD_HTML).toContain("html.ui-simple .side-group { display: none; }");
  });

  it("declares every new data-action", () => {
    const allowed = new Set<string>([...FORGE_MCP_TOOL_NAMES, ...DASHBOARD_UI_ACTIONS]);
    for (const a of ["toggle_mode", "toggle_more", "show_more", "open_section"]) expect(allowed).toContain(a);
    for (const m of DASHBOARD_HTML.matchAll(/data-action="([a-z_]+)"/g)) expect(allowed, m[1]).toContain(m[1]);
  });
});

describe("ux budget: Simple nav", () => {
  const nav = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('id="sideNav"'), DASHBOARD_HTML.indexOf("</nav>"));

  it("has at most five primary items: Home, Checks, Agents, Projects, Settings", () => {
    const primary = [...nav.matchAll(/<button id="([a-zA-Z]+)"[^>]*data-simple-nav="primary"/g)].map((m) => m[1]);
    expect(primary.length).toBeLessThanOrEqual(5);
    expect(primary.sort()).toEqual(["tabHome", "tabLive", "tabRepos", "tabRuns", "tabSettings"]);
    for (const label of ["Home", "Checks", "Agents", "Projects", "Settings"]) {
      expect(nav).toContain('data-simple="label">' + label + "<");
    }
  });

  it("puts everything else behind a More disclosure that only Simple shows", () => {
    expect(nav).toMatch(/<button id="navMoreBtn" class="[^"]*simple-only[^"]*"[^>]*data-simple-nav="more"[^>]*data-action="toggle_more"[^>]*aria-expanded="false"/);
    expect(DASHBOARD_HTML).toContain("html.ui-simple nav.side-nav > .side-link:not([data-simple-nav]) { display: none; }");
    for (const id of ["tabInbox", "tabIntents", "tabTrains", "tabConflicts", "tabAgents", "tabMerge", "tabTournaments", "tabBench"]) {
      const tag = nav.slice(nav.indexOf('id="' + id + '"') - 12, nav.indexOf(">", nav.indexOf('id="' + id + '"')));
      expect(tag, id).not.toContain("data-simple-nav");
    }
  });
});

describe("ux budget: words", () => {
  it("keeps marked headlines and labels to six words and sentences to fifteen", () => {
    const marked = markedCopy();
    expect(marked.length).toBeGreaterThan(20);
    for (const { kind, text } of marked) {
      expect(text, kind + ": empty").not.toBe("");
      if (kind === "text") for (const s of sentences(text)) expect(words(s), s).toBeLessThanOrEqual(15);
      else expect(words(text), text).toBeLessThanOrEqual(6);
    }
  });

  it("keeps the SC copy table inside the budget", () => {
    const sc = simpleCopy();
    expect(sc.size).toBeGreaterThan(40);
    for (const [key, text] of sc) {
      if (key.startsWith("t_")) for (const s of sentences(text)) expect(words(s), key).toBeLessThanOrEqual(15);
      else expect(words(text), key).toBeLessThanOrEqual(6);
    }
    // Home headlines (quest + health) are the screen's one question.
    expect(sc.get("h_health")).toBe("Is my code OK?");
    for (const lvl of ["account", "github", "repos", "first_run", "green"]) expect(sc.has("l_lvl_" + lvl), lvl).toBe(true);
  });

  it("uses no jargon in Simple copy", () => {
    for (const { text } of markedCopy()) jargonFree(text, text);
    for (const [key, text] of simpleCopy()) jargonFree(text, key);
  });

  it("catches the extended jargon list, and lets the plain words through", () => {
    for (const bad of ["Make a token", "Pick scopes", "Webhook secret", "HMAC check", "Open tournament", "Each attempt", "The ledger", "Merge queue", "CI ready", "My repo", "Repositories", "Head SHA", "Build artifact", "A cron line"]) {
      expect(JARGON.test(bad) || JARGON_CASED.test(bad), bad).toBe(true);
    }
    for (const ok of ["Make a key", "Waiting to land", "Start a race", "Your projects", "Every check", "Decide", "specific"]) {
      expect(JARGON.test(ok) || JARGON_CASED.test(ok), ok).toBe(false);
    }
  });

  it("keeps every SC entry in use (no dead copy)", () => {
    const js = ownScript();
    const block = js.slice(js.indexOf("// simple-copy:start"), js.indexOf("// simple-copy:end"));
    const rest = js.replace(block, "");
    // Keys looked up by prefix + a value: statuses, levels, race and try
    // states, merge states, key powers, tab titles, nav tooltips, options.
    const dynamic = /^(l_st_|l_lvl_|l_race_|l_try_|l_mq_|l_can_|l_tab_|t_nav_|l_notify_)/;
    for (const key of simpleCopy().keys()) {
      if (dynamic.test(key)) continue;
      const used = new RegExp("\\bSC\\." + key + "\\b").test(rest) || rest.includes('"' + key + '"');
      expect(used, key).toBe(true);
    }
  });

  it("references only SC keys that exist", () => {
    const sc = simpleCopy();
    const js = mainScript();
    for (const m of js.matchAll(/\bSC\.([a-z0-9_]+)/g)) expect(sc.has(m[1]), "SC." + m[1]).toBe(true);
    for (const m of js.matchAll(/\bscf\("([a-z0-9_]+)"/g)) expect(sc.has(m[1]), "scf " + m[1]).toBe(true);
    for (const m of js.matchAll(/\bplainf?\("([a-z0-9_]+)"/g)) expect(sc.has(m[1]), "plain " + m[1]).toBe(true);
    for (const m of js.matchAll(/: "(l_ph_[a-z0-9_]+|l_pal_ph)"/g)) expect(sc.has(m[1]), "placeholder " + m[1]).toBe(true);
    // Dynamic lookups: every run status and quest level has a word.
    for (const st of ["success", "failure", "error", "running", "queued", "blocked", "cancelled", "skipped"]) {
      expect(sc.has("l_st_" + st), st).toBe(true);
    }
  });

  it("shows state as colour, icon, and words", () => {
    const js = mainScript();
    const fn = js.slice(js.indexOf("function simplePill("), js.indexOf("function setUiMode("));
    // pill class carries the colour dot; text carries icon + word.
    expect(fn).toContain('"pill " + status');
    expect(fn).toContain('st[0] + " " + st[1]');
  });
});

describe("ux budget: game rules", () => {
  const js = mainScript();

  it("shows one next move on Home and in the side bar, with the phase on <html>", () => {
    expect(DASHBOARD_HTML).toMatch(/<button id="nextMoveChip" class="[^"]*simple-only[^"]*"[^>]*data-action="next_move"/);
    expect(js).toContain('root.setAttribute("data-next-move", currentMove.key)');
    expect(js).toContain('root.setAttribute("data-phase", currentMove.phase)');
    expect(js).toContain('primary.id = "homePrimary"');
    // Home picks its screen from the phase, not from separate pages.
    const fn = js.slice(js.indexOf("function renderHomeSimple("), js.indexOf("function renderHome(st)"));
    expect(fn).toContain('m.phase === "onboarding"');
    expect(js).toContain('if (m.phase === "endgame") box.appendChild(everywhereCard())');
  });

  it("leads the signed-out screen with meaning and a curiosity demo link", () => {
    const auth = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('id="authPane"'), DASHBOARD_HTML.indexOf('id="emailBox"'));
    expect(auth).toMatch(/<h2 data-simple="head">[^<]+<\/h2>/);
    expect(auth).toContain('href="/dashboard?demo=1&amp;tour=1#/live" data-action="explore_demo"');
  });

  it("runs setup as a five-level quest with one open level", () => {
    expect(js).toContain('var QUEST_LEVELS = ["account", "github", "repos", "first_run", "green"];');
    expect(js).toContain("function renderQuest(");
    expect(DASHBOARD_HTML).toContain(".quest-map li.locked::before");
  });

  it("celebrates with reduced-motion-safe confetti and remembers what it celebrated", () => {
    const fn = js.slice(js.indexOf("function confetti("), js.indexOf("function greenStreak("));
    expect(fn).toContain("prefers-reduced-motion: reduce");
    expect(fn).toContain('"flare-celebrated"');
    expect(fn).toMatch(/setTimeout\([^]*1200\)/);
    expect(DASHBOARD_HTML).toContain("@media (prefers-reduced-motion: reduce) { .confetti { display: none; } }");
  });

  it("counts a green streak newest first", () => {
    const src = js.slice(js.indexOf("function greenStreak("), js.indexOf("\n  }\n", js.indexOf("function greenStreak(")) + 4);
    const greenStreak = new Function(src + "; return greenStreak;")() as (runs: { status: string }[]) => number;
    expect(greenStreak([{ status: "running" }, { status: "success" }, { status: "success" }, { status: "failure" }, { status: "success" }])).toBe(2);
    expect(greenStreak([{ status: "failure" }, { status: "success" }])).toBe(0);
    expect(greenStreak([])).toBe(0);
  });
});

describe("ux budget: errors and toasts", () => {
  // Every person-facing error line and toast in the dashboard's own
  // script reaches Simple mode through SC: plain("key", proText),
  // plainf(...), scf(...), or SC.x. A bare string literal (or a raw
  // server message) at a toast( or an error/status line would show Pro
  // words, or a dead end, in Simple mode.
  const routed = /\b(plain|plainf|scf)\(|\bSC\./;
  const literal = /"[^"]*[A-Za-z][^"]*"/;
  const rawServer = /\b(?:e|fail)\.message\b/;
  // Documented exceptions (Pro-only by construction): none today. Add
  // "snippet": "why" pairs here rather than loosening the rule.
  const ALLOW: Record<string, string> = {};

  function check(where: string, expr: string): void {
    const t = expr.trim();
    if (ALLOW[t]) return;
    if (literal.test(t) || rawServer.test(t)) expect(routed.test(t), where + ": " + t).toBe(true);
  }

  it("routes every toast through SC", () => {
    const js = ownScript();
    let n = 0;
    for (const m of js.matchAll(/\btoast\(/g)) {
      const at = m.index ?? 0;
      if (js.slice(at - 9, at) === "function ") continue;
      check("toast", callArgs(js, at + 5));
      n++;
    }
    expect(n).toBeGreaterThan(15);
  });

  it("routes every error and status line through SC", () => {
    const js = ownScript();
    const lines = [
      ...js.matchAll(/(?:\b(?:err|ok|msg|errEl)|(?:Err|Ok|Msg|Info)"\))\.textContent =\s*([^;]+);/g),
      // stateRow(body, cols, text, cls): table empty/loading/error rows.
      ...js.matchAll(/\bstateRow\([^,]+, \d, ((?:plain\([^)]*\))|"[^"]*"|[^,]+), "(?:err|muted)"\)/g),
    ];
    expect(lines.length).toBeGreaterThan(60);
    for (const m of lines) {
      if (/^"Loading…"$/.test(m[1].trim())) continue; // a progress word, same in both modes
      check("line", m[1]);
    }
  });

  it("never swallows a failed click silently in Simple mode", () => {
    const js = ownScript();
    // Revoke/remove/re-run used to .catch(function () {}): Simple now says so.
    for (const fn of ["/revoke", '"/rerun", { method: "POST" })', "/v1/admin/users/email", 'action: "remove"']) {
      const at = js.indexOf(fn);
      expect(at, fn).toBeGreaterThan(-1);
      const tail = js.slice(at, js.indexOf(".catch(", at) + 80);
      expect(tail, fn).toMatch(/\.catch\(function \(\) \{ if \(uiSimple\(\)\) toast\(SC\.t_\w+, true\); \}\)/);
    }
  });

  it("asks twice before destructive Simple clicks (safe to explore)", () => {
    const js = ownScript();
    const fn = js.slice(js.indexOf("function twoClick("), js.indexOf("var SIMPLE_PH"));
    expect(fn).toContain("if (!uiSimple()) { btn.addEventListener(\"click\", fn); return; }");
    expect(fn).toContain("SC.l_sure");
    expect((js.match(/twoClick\(btn, function/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe("ux budget: screens", () => {
  const js = ownScript();
  const section = (id: string, end: string) => DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('<section id="' + id + '"'), DASHBOARD_HTML.indexOf(end, DASHBOARD_HTML.indexOf('<section id="' + id + '"')));

  it("defines the shared Simple design tokens on html.ui-simple", () => {
    const css = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf("html.ui-simple {"), DASHBOARD_HTML.indexOf("}", DASHBOARD_HTML.indexOf("html.ui-simple {")));
    for (const name of ["--s-font", "--s-radius", "--s-gap", "--s-primary", "--s-primary-fg", "--s-ok", "--s-bad", "--s-wait", "--s-muted", "--s-card-bg", "--s-border", "--s-h1", "--s-h2", "--s-body"]) {
      expect(css, name).toContain(name + ":");
    }
    expect(css).toContain("--s-radius: 12px");
    expect(css).toContain("--s-gap: 16px");
    expect(css).toContain("--s-h1: 24px");
    expect(css).toContain("--s-h2: 18px");
    expect(css).toContain("--s-body: 15px");
    // Every non-Forge screen opts into the shared Simple look.
    for (const id of ["authPane", "invitePane", "resetPane", "resetConfirmPane", "magicConfirmPane", "homePane", "runsPane", "teamPane", "settingsPane", "tournamentsPane", "reposPane", "mergePane"]) {
      expect(DASHBOARD_HTML, id).toMatch(new RegExp('<section id="' + id + '" class="card s-pane'));
    }
  });

  it("gives each open Settings section at most one primary form", () => {
    const panes = section("teamPane", "</section>") + section("settingsPane", "</section>");
    const ids = ["setTokens", "setRunner", "setPeople", "setWebhook", "setNotify", "setGithub"];
    for (let i = 0; i < ids.length; i++) {
      const start = panes.indexOf('<h2 id="' + ids[i] + '"');
      const next = i + 1 < ids.length ? panes.indexOf('<h2 id="' + ids[i + 1] + '"') : panes.length;
      expect(start, ids[i]).toBeGreaterThan(-1);
      const body = panes.slice(start, next);
      const forms = [...body.matchAll(/<form [^>]*class="([^"]*)"/g)].filter((m) => !/\bsimple-more\b/.test(m[1]));
      expect(forms.length, ids[i]).toBeLessThanOrEqual(1);
      // Advanced inputs are Pro-only, never just unlabeled in Simple.
      expect(body, ids[i]).not.toMatch(/<(?:input|select) id="(?:tokenScope|tokenRepos)"(?![^>]*pro-only)/);
    }
  });

  it("swaps placeholders, options, tooltips, and the palette to plain words", () => {
    expect(js).toContain("function syncSimpleWords()");
    expect(js).toMatch(/function setUiMode\([^]*syncSimpleWords\(\);[^]*function syncModeBtn/);
    const pal = js.slice(js.indexOf("function palCommands("), js.indexOf("function palMarkActive("));
    expect(pal).toContain("tabTitle(name)");
    expect(pal).toContain("SC.l_pal_go");
    expect(pal).toContain("SC.l_pal_refresh");
    for (const tab of ["home", "live", "inbox", "intents", "trains", "conflicts", "agents", "repos", "tournaments", "runs", "merge", "settings", "bench"]) {
      expect(simpleCopy().has("t_nav_" + tab), tab).toBe(true);
    }
  });

  it("keeps the Home health screen to three numbers and three links", () => {
    const fn = js.slice(js.indexOf("function renderHealth("), js.indexOf("function everywhereCard("));
    // Latest checks show icon + word; the time is a tooltip, not a number.
    expect(fn).not.toContain('className = "when"');
    expect(fn).toContain("badges.slice(0, 3)");
    // The agent shortcut leaves once an agent connected (endgame link budget).
    expect(js).toContain('document.getElementById("homeAgentLink").hidden = moveState(st).agentSeen;');
  });

  it("answers 'What's in this project?' with a status, files, and three checks", () => {
    expect(js).toContain("function renderRepoStatus()");
    const fn = js.slice(js.indexOf("function renderRepoStatus()"), js.indexOf("function renderRepoHead("));
    expect(fn).toContain("SC.l_checked");
    expect(fn).toContain("SC.l_not_setup");
    expect(fn).toContain("SC.h_project_q");
    expect(js).toContain("runs.slice(0, 3).forEach");
    expect(DASHBOARD_HTML).toContain('<div id="repoCommits" class="simple-more"></div>');
  });

  it("shows a race's winner and why first, internals under Show more", () => {
    const fn = js.slice(js.indexOf("function renderTournamentReviewSimple("), js.indexOf("function renderTournamentReview("));
    expect(fn).toContain("SC.l_winner");
    expect(fn).toContain("SC.l_why_won");
    expect(fn).toContain("SC.h_who_wins");
    for (const id of ["tLanes", "tRadar", "tActivity"]) expect(DASHBOARD_HTML).toContain('<div id="' + id + '" class="simple-more"></div>');
    expect(section("tournamentsPane", "</section>")).toContain('data-more-for="tournamentsPane"');
  });

  it("keeps Waiting to land to one job and one action", () => {
    const pane = section("mergePane", "</section>");
    expect(pane).toContain('data-simple="head">Waiting to land<');
    expect(pane).toMatch(/<form id="mergeEnqueueForm" class="inline simple-more">/);
    expect(pane).toMatch(/<div id="mergeCollisions" class="simple-more">/);
    expect(js).toContain('plain("t_merge_empty", "Queue is empty.")');
  });
});
