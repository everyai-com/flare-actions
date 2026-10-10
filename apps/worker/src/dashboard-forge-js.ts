// Forge dashboard client script (docs/FORGE-UX.md §5-§9). Spliced into
// the dashboard IIFE (dashboard.ts) so it shares api/el/toast/selectTab.
// House rules: ES5-style, no backticks, no dollar-brace, API data only via
// textContent (never innerHTML). String.raw keeps backslashes literal.
//
// Data: codes against the stream-B contract (/v1/forge/*). A 404/405/501
// falls back to fixtures (forge-fixtures.ts) with a visible demo notice;
// ?demo=1 (or ?demo=scale) forces fixtures and needs no login.

export const FORGE_JS = String.raw`
  // ===================== Forge =====================
  var FX_SCREENS = { live: "Live", inbox: "Inbox", intents: "Intents", trains: "Trains", conflicts: "Conflicts", agents: "Agents", bench: "Bench", why: "Why" };
  var FX_TONE = { working: "working", claimed: "working", replaying: "working", draft: "idle", expired: "idle", abandoned: "idle", awaiting_plan: "human", ready: "train", in_train: "train", landed: "landed", conflicted: "conflict", failed: "conflict", bisected: "conflict", forming: "train", merging: "train", verifying: "train", aborted: "idle", open: "conflict", resolved: "landed", success: "landed", failure: "conflict", running: "train", pending: "idle", queued: "idle", error: "conflict", cancelled: "idle", skipped: "idle", overlap: "overlap" };
  var FX_GLYPH = { working: "●", overlap: "◐", conflict: "✕", landed: "✓", train: "▶", human: "!", idle: "○" };
  var FX_TERM_LABEL = { protected_path: "protected", footprint_size: "size", drift: "drift", llm_replay: "LLM replay", weak_evidence: "weak CI", reviewer_disagrees: "reviewer disagrees" };
  var FX_REST = {
    approve_plan: { m: "POST", p: "/v1/forge/intents/:id/approve" },
    send_back: { m: "POST", p: "/v1/forge/intents/:id/send-back" },
    review_sample: { m: "POST", p: "/v1/forge/intents/:id/review" },
    mark_ready: { m: "POST", p: "/v1/forge/intents/:id/ready" },
    send_note: { m: "POST", p: "/v1/forge/intents/:id/notes" },
    fork_session: { m: "POST", p: "/v1/forge/intents/:id/fork" },
    claim_conflict: { m: "POST", p: "/v1/forge/conflicts/:id/claim" },
    plan_goal: { m: "POST", p: "/v1/forge/goals/plan" },
    declare_intent: { m: "POST", p: "/v1/forge/goals" }
  };
  var FX = {
    demo: false, demoScale: false, anon: false, stage: false, repo: "", repos: [], paused: false, buffer: [],
    ws: null, wsFails: 0, wsTimer: null, pollTimer: null, simTimer: null, msgTimes: [], seq: null,
    snap: null, inbox: null, route: { screen: "live", id: "", q: null }, fixtures: null, fallback: {},
    inboxFilter: "all", groupBy: "story", inboxFocus: "", selected: {}, expandEvidence: {}, sendBack: "",
    pathFilter: "", tableView: false, renderTimer: null, lastUpdate: 0, undo: null, benchOk: false,
    sim: { t: 0, landedAt: 0 }, proposals: [], drawer: null, knownIds: {}
  };

  // ---------- small utils ----------
  function fxQ() { try { return new URLSearchParams(window.location.search); } catch (e) { return { get: function () { return null; } }; } }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "text") e.textContent = String(v);
        else if (k === "cls") e.className = v;
        else if (k === "on") { for (var ev in v) { if (Object.prototype.hasOwnProperty.call(v, ev)) e.addEventListener(ev, v[ev]); } }
        else e.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c === null || c === undefined || c === false) continue;
        e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
      }
    }
    return e;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k])); }
    return e;
  }
  function fxClear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }
  function fxHash(str) {
    var x = 2166136261;
    str = String(str);
    for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }
  function fxRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fxNum(n) { n = Number(n); if (!isFinite(n)) return "—"; return n.toLocaleString("en-US"); }
  function fxClock(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    var m = Math.floor(s / 60); var r = s % 60;
    if (m >= 60) return Math.floor(m / 60) + "h " + (m % 60) + "m";
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
  function fxSecs(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return (s % 60) ? m + "m " + (s % 60) + "s" : m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function fxTone(state) { return FX_TONE[state] || "idle"; }
  function fxWord(state) { return String(state || "unknown").split("_").join(" "); }
  function fxBand(n) { n = Number(n) || 0; return n > 60 ? "high" : n > 30 ? "med" : "low"; }
  function fxShort(sha) { return sha ? String(sha).slice(0, 7) : ""; }
  function fxReduced() { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
  function fxCopy(text, okMsg) {
    function done(ok) { toast(ok ? (okMsg || "Copied") : "Copy failed", !ok); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    else done(false);
  }

  // ---------- shared components ----------
  function fxPill(state, label) {
    var tone = fxTone(state);
    return h("span", { cls: "fx-pill", "data-tone": tone, "data-state": state }, [h("span", { cls: "g", "aria-hidden": "true", text: FX_GLYPH[tone] }), label || fxWord(state)]);
  }
  function fxRisk(n) {
    n = Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    return h("span", { cls: "fx-risk " + fxBand(n), "data-risk": n, title: "Risk " + n + " of 100 (" + fxBand(n) + ")", "aria-label": "risk " + n, text: n });
  }
  function fxTermChip(t) {
    var pts = Number(t.points !== undefined ? t.points : t.weight) || 0;
    var name = t.term || "";
    var label = FX_TERM_LABEL[name] || fxWord(name);
    var detail = t.detail || "";
    var chipEl = h("span", { cls: "fx-term", "data-term": name, "data-weight": pts, title: label + ": " + detail }, [
      h("span", { cls: "w " + (pts >= 30 ? "high" : pts >= 10 ? "med" : "low"), text: "+" + pts }),
      label + (detail ? " " + detail.replace(/^touches /, "").replace(/^[0-9]+ undeclared files?: /, "") : "")
    ]);
    return chipEl;
  }
  function fxIdChip(id, href) {
    if (!id) return h("span", { cls: "muted", text: "—" });
    FX.knownIds[id] = true;
    var kind = fxKindOf(id);
    var attrs = { cls: "fx-idchip", "data-kind": kind, "data-id": id, title: id + " (click to copy)" };
    if (href) {
      attrs.href = href; attrs.title = "Open " + id;
      return h("a", attrs, [id]);
    }
    attrs.role = "button"; attrs.tabindex = "0";
    attrs.on = { click: function (ev) { ev.stopPropagation(); fxCopy(id, "Copied " + id); }, keydown: function (ev) { if (ev.key === "Enter") { ev.stopPropagation(); fxCopy(id, "Copied " + id); } } };
    return h("span", attrs, [id]);
  }
  function fxKindOf(id) {
    var p = String(id).slice(0, 2);
    return { "i-": "intent", "g-": "goal", "t-": "train", "c-": "conflict", "a-": "agent", "r-": "run", "b-": "bench" }[p] || "entity";
  }
  function fxHref(id) {
    var k = fxKindOf(id);
    if (k === "intent") return "#/intents/" + id;
    if (k === "train") return "#/trains/" + id;
    if (k === "conflict") return "#/conflicts/" + id;
    if (k === "goal") return "#/intents?goal=" + id;
    if (k === "agent") return "#/agents";
    return null;
  }
  function fxLink(id) { return fxIdChip(id, fxHref(id)); }
  function fxAgent(id) {
    var list = (FX.snap && FX.snap.agents) || (fxFixtures().agents) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return { id: id || "", label: String(id || "?").replace(/^a-/, "").slice(-2).toUpperCase(), client: "" };
  }
  function fxMono(agentId, state) {
    var a = fxAgent(agentId);
    var tone = state ? fxTone(state) : null;
    var m = h("span", { cls: "fx-mono-av", "data-kind": "agent", "data-id": a.id, title: a.label + " · " + a.id + (a.client ? " (" + a.client + ")" : ""), "aria-label": "agent " + a.label, text: a.label });
    if (tone) m.style.setProperty("--av-dot", "var(--st-" + tone + ")");
    return m;
  }
  function fxEvidence(ev) {
    if (!ev) return h("span", { cls: "fx-evidence", text: "no CI evidence yet" });
    var st = ev.status;
    var glyph = st === "success" ? "✓" : st === "failure" ? "✕" : "▶";
    var cls = st === "success" ? "ok" : st === "failure" ? "bad" : "run";
    var weak = st === "success" && Number(ev.tests) === 0;
    var parts = [h("span", { cls: weak ? "weak" : cls, text: weak ? "◐" : glyph }), "CI " + (ev.run_id || "")];
    if (ev.sha) { parts.push("· exact SHA"); parts.push(fxSha(ev.sha)); }
    if (st === "running") parts.push("· running");
    else if (weak) parts.push("· green but 0 tests touched footprint");
    else if (ev.tests !== undefined) parts.push("· " + ev.tests + " tests");
    if (ev.duration_s) parts.push("· " + fxClock(ev.duration_s));
    if (ev.reviewer && ev.reviewer !== "pending" && ev.reviewer !== "none") parts.push("· reviewer " + ev.reviewer);
    if (ev.note) parts.push("· " + ev.note);
    return h("span", { cls: "fx-evidence", "data-kind": "evidence", "data-state": st }, parts.map(function (p) { return typeof p === "string" ? h("span", { text: p }) : p; }));
  }
  function fxSha(sha) {
    var s = fxShort(sha);
    return h("span", { cls: "fx-sha", title: String(sha) + " (click to copy)", role: "button", tabindex: "0", "data-kind": "sha", "data-id": String(sha), text: s, on: { click: function (e) { e.stopPropagation(); fxCopy(String(sha), "Copied " + s); } } });
  }
  function fxTime(iso) {
    if (!iso) return h("span", { cls: "muted", text: "—" });
    return h("time", { datetime: iso, title: fmtTime(iso), "data-ago": iso, text: fmtAgo(iso) });
  }
  function fxCmd(text) {
    var code = h("code", { text: text });
    var b = h("button", { cls: "ghost", type: "button", text: "Copy", on: { click: function () { fxCopy(text, "Command copied"); } } });
    return h("div", { cls: "fx-cmd" }, [h("span", { "aria-hidden": "true", text: "$" }), code, b]);
  }
  function fxEmpty(code, title, hint, command, hero) {
    var box = h("div", { cls: "fx-empty" + (hero ? " hero" : ""), "data-state": "empty", "data-code": code, "data-hint": hint || "" }, [h("h3", { text: title })]);
    if (hint) box.appendChild(h("p", { text: hint }));
    if (command) box.appendChild(fxCmd(command));
    box.appendChild(h("div", { cls: "fx-code", text: "[" + code + "]" }));
    return box;
  }
  function fxErrorCard(err, retry) {
    var code = (err && err.code) || "request_failed";
    var box = h("div", { cls: "fx-error", role: "alert", "data-state": "error", "data-code": code, "data-hint": (err && err.hint) || "" }, [
      h("h3", { text: "Could not load this screen" }),
      h("p", { text: (err && err.message) || "Request failed." })
    ]);
    if (err && err.hint) box.appendChild(h("p", { text: err.hint }));
    box.appendChild(h("p", { cls: "mono", text: "[" + code + "]" }));
    if (retry) box.appendChild(h("button", { cls: "ghost", type: "button", text: "Retry", on: { click: retry } }));
    return box;
  }
  function fxPanel(title, kids, extra) {
    var head = h("div", { cls: "fx-panel-head" }, [h("span", { text: title })].concat(extra || []));
    return h("section", { cls: "fx-panel", "aria-label": title }, [head].concat(kids));
  }
  function fxSkeleton(node, rows) {
    fxClear(node);
    for (var i = 0; i < rows; i++) node.appendChild(h("div", { cls: "skel skel-row" }));
  }

  // ---------- data ----------
  function fxFixtures() {
    if (FX.fixtures) return FX.fixtures;
    try { FX.fixtures = JSON.parse(document.getElementById("fxFixtures").textContent || "{}"); } catch (e) { FX.fixtures = {}; }
    var f = FX.fixtures;
    // Shift fixture clocks so the demo reads as "just now".
    var anchor = Date.parse("2026-10-12T14:08:00Z");
    var shift = Date.now() - anchor;
    function sh(iso) { var t = Date.parse(iso); return isFinite(t) ? new Date(t + shift).toISOString() : iso; }
    (f.intents || []).forEach(function (i) {
      i.created_at = sh(i.created_at);
      if (i.lease_expires_in_s !== null && i.lease_expires_in_s !== undefined) i.lease_expires_at = new Date(Date.now() + i.lease_expires_in_s * 1000).toISOString();
    });
    (f.trains || []).forEach(function (t) { t.started_at = sh(t.started_at); });
    (f.conflicts || []).forEach(function (c) { (c.replay && c.replay.stages || []).forEach(function (s) { if (s.at) s.at = sh(s.at); }); });
    Object.keys(f.mailbox || {}).forEach(function (k) { f.mailbox[k].forEach(function (m) { m.at = sh(m.at); }); });
    Object.keys(f.snapshot || {}).forEach(function (k) { var s = f.snapshot[k]; if (s.head) s.head.at = sh(s.head.at); });
    if (f.bench) f.bench.measured_at = sh(f.bench.measured_at);
    return f;
  }
  function fxFetch(path, opts) {
    opts = opts || {};
    var headers = { "Accept": "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (token()) headers["Authorization"] = "Bearer " + token();
    return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }).then(function (res) {
      return res.text().then(function (txt) {
        var body = null;
        try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = null; }
        if (!res.ok) {
          var err = new Error((body && (body.message || body.error)) || ("HTTP " + res.status));
          err.status = res.status;
          err.code = (body && body.code) || ("http_" + res.status);
          err.hint = (body && body.hint) || "";
          throw err;
        }
        if (body && typeof body === "object" && body.data !== undefined && (body.version || body.kind)) return body.data;
        return body;
      });
    }, function () { var err = new Error("Network error: the dashboard could not reach the API."); err.status = 0; err.code = "network_error"; throw err; });
  }
  function fxMissing(err) { return err && (err.status === 404 || err.status === 405 || err.status === 501); }
  // Load a screen's data; endpoints that don't exist yet fall back to the
  // fixtures and flag the screen as demo data (never silently).
  function fxLoad(path, fixtureFn, key) {
    if (FX.demo) return Promise.resolve(fixtureFn());
    return fxFetch(path).then(function (d) { delete FX.fallback[key]; return d; }, function (err) {
      if (fxMissing(err)) { FX.fallback[key] = "GET " + path.split("?")[0] + " returned " + err.status; return fixtureFn(); }
      throw err;
    });
  }
  function fxIsDemoScreen(key) { return FX.demo || !!FX.fallback[key]; }
  function fxRenderNotice(key) {
    var n = document.getElementById("fxNotice");
    var tag = document.getElementById("fxDemoTag");
    var demo = fxIsDemoScreen(key);
    tag.hidden = !demo;
    n.hidden = !demo;
    n.setAttribute("data-state", demo ? "demo" : "live");
    fxClear(n);
    if (!demo) return;
    n.appendChild(h("strong", { text: "Demo data." }));
    if (FX.demo) n.appendChild(h("span", { text: " Fixture mode (?demo=" + (FX.demoScale ? "scale" : "1") + "): the designed Bookshelf scenario from examples/forge-demo" + (FX.demoScale ? " and a 10,000-agent simulated monorepo" : "") + ". Nothing here is a measurement, and actions stay in this tab." }));
    else n.appendChild(h("span", { text: " " + FX.fallback[key] + ", so this screen shows fixtures until the Forge API is deployed. Nothing here is a measurement." }));
  }

  // fixture builders ------------------------------------------------
  var FX_LIVE_STATES = { draft: 1, awaiting_plan: 1, claimed: 1, working: 1, ready: 1, in_train: 1, conflicted: 1, replaying: 1, bisected: 1 };
  function fxFxSnapshot(repo) {
    var f = fxFixtures();
    var base = (f.snapshot || {})[repo] || (f.snapshot || {})[(f.repos || [])[0]];
    if (!base) return { repo: repo, counters: {}, tree: [], intents: [] };
    var s = JSON.parse(JSON.stringify(base));
    s._fixture = true;
    if (s.sim) return fxExpandSim(s);
    s.intents = (f.intents || []).filter(function (i) { return FX_LIVE_STATES[i.state]; });
    s.agents = f.agents;
    s.conflicts = (f.conflicts || []).filter(function (c) { return c.state === "open" || c.state === "claimed"; });
    s.track = { current: null, recent: [] };
    (f.trains || []).forEach(function (t) {
      if (!s.track.current && (t.state === "forming" || t.state === "merging" || t.state === "verifying")) s.track.current = t;
      else s.track.recent.push(t);
    });
    return s;
  }
  function fxExpandSim(s) {
    var total = 0;
    s.cells.forEach(function (c) { total += c.agents; });
    var target = (s.counters && s.counters.agents) || total;
    var acc = 0;
    s.cells.forEach(function (c, i) {
      c.agents = i === s.cells.length - 1 ? Math.max(0, target - acc) : Math.round(c.agents * target / total);
      acc += c.agents;
      c.overlap = s.overlap_cells.indexOf(c.path) >= 0;
      c.conflict = s.conflict_cells.indexOf(c.path) >= 0;
    });
    s.intents = [];
    s.agents = [{ id: "a-pool", label: "SM", client: "sim" }];
    s.conflicts = s.conflict_cells.map(function (p, i) { return { id: "c-44" + (71 + i * 9), state: "open", files: [p + "/index.ts"], sim: true }; });
    s.track = fxSimTrain(9412, 0);
    s.track.recent = [];
    for (var k = 1; k <= 5; k++) s.track.recent.push(fxSimTrainDone(9412 - k));
    return s;
  }
  function fxSimTrain(n, phase) {
    var rng = fxRng(n);
    var cells = ((fxFixtures().snapshot || {})["sim/monorepo"] || { cells: [] }).cells;
    var lanes = [];
    for (var l = 1; l <= 6; l++) {
      var c = cells[Math.floor(rng() * cells.length)] || { path: "src" };
      var count = 3 + Math.floor(rng() * 9);
      var ids = [];
      for (var j = 0; j < count; j++) ids.push("i-" + (fxHash(n + ":" + l + ":" + j) % 65536).toString(16));
      lanes.push({ n: l, paths: [c.path + "/**"], intents: ids, stages: { merge: "done", push: phase > 0 ? "done" : "running", ci: { status: phase > 1 ? "success" : phase > 0 ? "running" : "pending", run: phase > 0 ? "r-" + (n * 3 + l) : null, sha: phase > 0 ? (fxHash("sha" + n + l) % 268435456).toString(16) : null, duration_s: 0 }, cas: "pending" } });
    }
    return { current: { id: "t-" + n, state: "verifying", lanes: lanes, sim: true }, recent: [] };
  }
  function fxSimTrainDone(n) {
    var rng = fxRng(n);
    var total = 20 + Math.floor(rng() * 40);
    var bis = rng() < 0.2;
    return { id: "t-" + n, state: bis ? "bisected" : "landed", lanes: [], result: { landed: bis ? total - 1 : total, requeued: bis ? 1 : 0 }, total: total, duration_s: 30 + Math.floor(rng() * 20), sim: true };
  }
  function fxFxInbox(repo) {
    var f = fxFixtures();
    var base = JSON.parse(JSON.stringify(f.inbox || {}));
    var groups = (f.goals || []).map(function (g) {
      var items = (f.intents || []).filter(function (i) { return i.goal_id === g.id && i.route; }).map(function (i) {
        var bucket = i.route === "human" ? "needs_you" : i.route === "audit" ? "sample" : "auto";
        if (i.state === "landed" && i.route === "human") bucket = "auto";
        return { intent: { id: i.id, title: i.title, agent: i.agent, state: i.state }, bucket: bucket, reason: i.escalation === "plan" ? "plan" : i.escalation ? "escalation" : "", why: i.escalation === "plan" ? "Protected path per .flare/policy.yml: " + fxProtectedHits(i.footprint.declared).join(", ") : (i.escalation || (bucket === "sample" ? "Random audit of auto-landed work (audit_sample 0.05)." : "")), risk: i.risk, terms: i.risk_terms, evidence: i.evidence, plan: i.plan, footprint: i.footprint.declared, train_id: i.train_id };
      });
      return { goal: g, items: items };
    });
    base.repo = repo;
    base.groups = groups;
    var needs = 0, sample = 0, auto = 0;
    groups.forEach(function (g) { g.items.forEach(function (it) { if (it.bucket === "needs_you") needs++; else if (it.bucket === "sample") sample++; else auto++; }); });
    base.metrics.needs_you = needs; base.metrics.auto_landed = auto; base.metrics.sample.count = sample; base.metrics.sample.of = auto + sample;
    return base;
  }
  function fxProtectedHits(paths) {
    var prot = (FX.snap && FX.snap.policy && FX.snap.policy.protected) || ["src/auth/**", "migrations/**"];
    var hits = [];
    prot.forEach(function (g) { (paths || []).forEach(function (p) { if (fxPathsOverlap(g, p) && hits.indexOf(g) < 0) hits.push(g); }); });
    return hits;
  }
  function fxFxIntent(id) {
    var f = fxFixtures();
    var i = null;
    (f.intents || []).forEach(function (x) { if (x.id === id) i = x; });
    if (!i) return null;
    var out = JSON.parse(JSON.stringify(i));
    out.goal = null;
    (f.goals || []).forEach(function (g) { if (g.id === i.goal_id) out.goal = g; });
    out.session = { repo: "flare/session", fork: "i-" + id.slice(2), steps: (f.sessions || {})[id] || fxSynthSteps(i) };
    out.mailbox = (f.mailbox || {})[id] || [];
    out.overlaps = [];
    var snap = (f.snapshot || {})[f.repos[0]] || {};
    (snap.overlaps || []).forEach(function (o) {
      if (o.a === id) out.overlaps.push({ intent: o.b, paths: o.paths, state: o.state });
      if (o.b === id) out.overlaps.push({ intent: o.a, paths: o.paths, state: o.state });
    });
    return out;
  }
  function fxSynthSteps(i) {
    var st = [{ t: 0, kind: "plan", text: (i.plan && i.plan[0]) || "Read the footprint" }, { t: 30, kind: "tool", text: "declare_intent -> overlaps[0]" }];
    if (i.evidence && i.evidence.sha) st.push({ t: 180, kind: "push", text: fxShort(i.evidence.sha) + " " + i.footprint.actual.length + " files" });
    if (i.state === "landed") st.push({ t: 260, kind: "tool", text: "mark_ready -> " + (i.train_id || "train") });
    return st;
  }
  function fxFxTrains() { return { trains: (fxFixtures().trains || []).slice() }; }
  function fxFxTrain(id) { var t = null; (fxFixtures().trains || []).forEach(function (x) { if (x.id === id) t = x; }); return t; }
  function fxFxConflicts() { return { conflicts: (fxFixtures().conflicts || []).slice() }; }
  function fxFxConflict(id) { var c = null; (fxFixtures().conflicts || []).forEach(function (x) { if (x.id === id) c = x; }); return c; }
  function fxFxIntents() { var f = fxFixtures(); return { goals: f.goals || [], intents: f.intents || [] }; }
  function fxFxAgents() { return { agents: fxFixtures().agents || [] }; }
  function fxIntentById(id) { var r = null; (fxFixtures().intents || []).forEach(function (x) { if (x.id === id) r = x; }); return r; }
  function fxFxWhy(repo, path, line) {
    var f = fxFixtures();
    var w = f.why || {};
    var id = null;
    if (w.path === path && w.blame) id = w.blame[String(line)] || null;
    else {
      (f.intents || []).forEach(function (i) { if (!id && i.state === "landed" && (i.footprint.actual || []).indexOf(path) >= 0) id = i.id; });
      (f.intents || []).forEach(function (i) { if (!id && (i.footprint.actual || []).indexOf(path) >= 0) id = i.id; });
    }
    var src = w.path === path && w.source ? (w.source[line - 1] || "") : "";
    var chain = [{ kind: "line", id: path + ":" + line, title: "Line " + line, text: src || path }];
    if (!id) return { repo: repo, path: path, line: line, chain: chain, empty: { code: "why_not_found", hint: "No why note for this line (pre-Forge commit).", command: "git log -L" + line + "," + line + ":" + path } };
    var i = fxIntentById(id);
    var g = null; (f.goals || []).forEach(function (x) { if (x.id === i.goal_id) g = x; });
    var a = fxAgent(i.agent);
    chain.push({ kind: "commit", id: i.landed_sha || (i.evidence && i.evidence.sha) || "", title: "Commit", text: "Flare-Intent: " + i.id + " · Flare-Agent: " + a.label + " (" + a.client + ")", meta: i.landed_sha ? "on main" : "in flight" });
    chain.push({ kind: "intent", id: i.id, title: "Intent", text: i.title, meta: i.state === "landed" ? "landed in " + i.train_id + " @ " + fxShort(i.landed_sha) : fxWord(i.state) });
    if (g) chain.push({ kind: "goal", id: g.id, title: "Goal", text: g.text });
    chain.push({ kind: "reason", id: i.id, title: "Reason", text: i.reasoning });
    (i.rejected || []).forEach(function (r) { chain.push({ kind: "rejected", id: i.id, title: "Rejected", text: r }); });
    if (i.evidence) chain.push({ kind: "evidence", id: i.evidence.run_id, title: "Evidence", text: "CI " + i.evidence.run_id + " " + i.evidence.status + " on exact SHA " + fxShort(i.evidence.sha) + " · " + i.evidence.tests + " tests", meta: "reviewer " + i.evidence.reviewer + " · risk " + i.risk });
    chain.push({ kind: "review", id: i.id, title: "Review", text: (i.route === "auto" ? "auto-landed under policy risk ≤ 30" : i.route === "audit" ? "auto-landed, picked for the audit sample" : "human review") });
    chain.push({ kind: "session", id: "flare/session@" + i.id, title: "Session", text: "flare/session @ " + i.id + " (fork " + "i-" + i.id.slice(2) + ")" });
    return { repo: repo, path: path, line: line, intent: i.id, chain: chain, command: "flare why " + path + ":" + line };
  }
  function fxFxPlan(text) {
    return { proposals: (fxFixtures().planner || []).map(function (p) { return { title: p.title, footprint: p.footprint.slice() }; }), planner: "demo planner (fixtures)" };
  }

  // normalizers (tolerate envelope and naming drift from stream B)
  function fxArr(d, key) { if (!d) return []; if (Array.isArray(d)) return d; if (Array.isArray(d[key])) return d[key]; if (Array.isArray(d.items)) return d.items; return []; }
  function fxNormIntent(i) {
    if (!i) return i;
    if (!i.footprint || Array.isArray(i.footprint)) {
      var declared = Array.isArray(i.footprint) ? i.footprint : (i.footprint && i.footprint.paths) || [];
      var actual = i.actual_footprint || i.actualFootprint || [];
      if (actual && actual.paths) actual = actual.paths;
      if (declared && declared.paths) declared = declared.paths;
      i.footprint = { declared: declared, actual: actual, drift: i.drift || actual.filter(function (p) { return !declared.some(function (d) { return fxPathsOverlap(d, p); }); }) };
    }
    if (!i.risk_terms && i.riskTerms) i.risk_terms = i.riskTerms;
    if (!i.goal_id && i.goalId) i.goal_id = i.goalId;
    if (!i.path) i.path = (i.footprint.actual && i.footprint.actual[0]) || i.footprint.declared[0] || "";
    if (i.agent && typeof i.agent === "object") i.agent = i.agent.id;
    if (!i.lease_expires_at && i.leaseExpiresAt) i.lease_expires_at = i.leaseExpiresAt;
    return i;
  }
  function fxNormSnapshot(d) {
    d = d || {};
    d.counters = d.counters || {};
    d.series = d.series || {};
    d.rates = d.rates || {};
    d.intents = fxArr(d.intents || d.dots, "intents").map(fxNormIntent);
    d.overlaps = d.overlaps || [];
    d.conflicts = d.conflicts || [];
    d.track = d.track || { current: null, recent: [] };
    if (!d.tree && !d.cells) d.tree = fxTreeFromIntents(d.intents);
    return d;
  }
  function fxTreeFromIntents(list) {
    var m = {};
    list.forEach(function (i) { (i.footprint.declared || []).concat(i.footprint.actual || []).forEach(function (p) { var k = fxCellKey(p); m[k] = (m[k] || 0) + 1; }); });
    return Object.keys(m).map(function (k) { return { path: k, files: m[k] }; });
  }
  function fxCellKey(p) {
    var seg = String(p).split("/").filter(function (s) { return s && s.indexOf("*") < 0; });
    if (seg.length <= 1) return seg.length && seg[0].indexOf(".") > 0 ? "(root)" : (seg[0] || "(root)");
    return seg.length === 2 && seg[1].indexOf(".") > 0 ? seg.join("/") : seg[0] + "/" + seg[1];
  }
  // Conservative footprint overlap (mirror of intents-core pathsOverlap):
  // literal prefix of each entry up to its first glob segment; a literal
  // covers its subtree.
  function fxGlobBase(p) {
    var out = [];
    var segs = String(p).split("/");
    for (var i = 0; i < segs.length; i++) { if (segs[i].indexOf("*") >= 0) break; out.push(segs[i]); }
    return out;
  }
  function fxPathsOverlap(a, b) {
    var x = fxGlobBase(a), y = fxGlobBase(b);
    var n = Math.min(x.length, y.length);
    for (var i = 0; i < n; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  function fxInCell(path, cellPath) {
    if (cellPath === "(root)") return String(path).indexOf("/") < 0;
    return path === cellPath || String(path).indexOf(cellPath + "/") === 0;
  }

  // ---------- routing ----------
  function fxIsScreen(name) { return Object.prototype.hasOwnProperty.call(FX_SCREENS, name); }
  function fxRouteFromHash() {
    var hash = location.hash || "";
    if (hash.slice(0, 2) !== "#/") return null;
    var rest = hash.slice(2);
    var qi = rest.indexOf("?");
    var q = new URLSearchParams(qi >= 0 ? rest.slice(qi + 1) : "");
    var parts = (qi >= 0 ? rest.slice(0, qi) : rest).split("/");
    var screen = parts[0] || "";
    if (screen === "goals") return { screen: "intents", id: "", q: new URLSearchParams("goal=" + encodeURIComponent(parts[1] || "")) };
    if (!fxIsScreen(screen)) return null;
    return { screen: screen, id: parts[1] ? decodeURIComponent(parts[1]) : "", q: q };
  }
  function fxRouteHash() {
    var r = FX.route;
    var hsh = "#/" + r.screen + (r.id ? "/" + encodeURIComponent(r.id) : "");
    var q = new URLSearchParams();
    if (r.q) r.q.forEach(function (v, k) { if (k !== "repo") q.set(k, v); });
    if (FX.repo && (r.screen === "live" || r.screen === "inbox" || r.screen === "why")) q.set("repo", FX.repo);
    var qs = q.toString();
    return hsh + (qs ? "?" + qs : "");
  }
  function fxWriteHash() {
    try { history.replaceState(null, "", window.location.pathname + window.location.search + fxRouteHash()); } catch (e) {}
  }
  function fxEndpoint() {
    var r = FX.route; var repo = encodeURIComponent(FX.repo || "");
    if (r.screen === "live") return "/v1/forge/snapshot?repo=" + repo;
    if (r.screen === "inbox") return "/v1/forge/inbox?repo=" + repo;
    if (r.screen === "intents") return r.id ? "/v1/forge/intents/" + encodeURIComponent(r.id) : (r.q && r.q.get("goal") ? "/v1/forge/goals/" + encodeURIComponent(r.q.get("goal")) : "/v1/forge/intents?repo=" + repo);
    if (r.screen === "trains") return r.id ? "/v1/forge/trains/" + encodeURIComponent(r.id) : "/v1/forge/trains?repo=" + repo;
    if (r.screen === "conflicts") return r.id ? "/v1/forge/conflicts/" + encodeURIComponent(r.id) : "/v1/forge/conflicts?repo=" + repo;
    if (r.screen === "agents") return "/v1/forge/agents?repo=" + repo;
    if (r.screen === "bench") return "/v1/forge/bench";
    if (r.screen === "why") return "/v1/forge/why?repo=" + repo + "&path=" + encodeURIComponent((r.q && r.q.get("path")) || "") + "&line=" + encodeURIComponent((r.q && r.q.get("line")) || "1");
    return "/v1/forge/snapshot?repo=" + repo;
  }
  function fxSyncChrome() {
    var url = fxEndpoint();
    var a = document.getElementById("fxJsonLink");
    a.href = url;
    a.setAttribute("aria-label", "Open JSON for this screen: " + url);
    var alt = document.getElementById("fxAltLink");
    if (alt) alt.href = url;
    var crumbs = fxClear(document.getElementById("fxCrumbs"));
    var r = FX.route;
    var trail = [[FX_SCREENS[r.screen], r.id || (r.q && r.q.get("goal")) ? "#/" + r.screen : null]];
    if (r.screen === "intents" && r.id) {
      var it = fxIntentById(r.id);
      if (it && it.goal_id) trail.push([it.goal_id, "#/intents?goal=" + it.goal_id]);
    }
    if (r.q && r.q.get("goal") && !r.id) trail.push([r.q.get("goal"), null]);
    if (r.id) trail.push([r.id, null]);
    if (r.screen === "why" && r.q) trail.push([(r.q.get("path") || "") + ":" + (r.q.get("line") || ""), null]);
    trail.forEach(function (t, i) {
      if (i) crumbs.appendChild(h("span", { cls: "sep", "aria-hidden": "true", text: "›" }));
      crumbs.appendChild(t[1] ? h("a", { href: t[1], text: t[0] }) : h("span", { cls: "cur " + (i ? "mono" : ""), "aria-current": "page", text: t[0] }));
    });
    var stageBtn = document.getElementById("fxStageBtn");
    stageBtn.setAttribute("aria-pressed", FX.stage ? "true" : "false");
  }
  function fxGo(screen, id, q) {
    if (!fxIsScreen(screen)) return;
    FX.route = { screen: screen, id: id || "", q: q || new URLSearchParams() };
    if (FX.route.q.get("repo")) fxSetRepo(FX.route.q.get("repo"), true);
    selectTab(screen);
  }
  function fxNav(hash) { location.hash = hash; }
  // Called by selectTab for every tab change.
  function fxOnSelect(name) {
    var forge = fxIsScreen(name);
    var pane = document.getElementById("forgePane");
    pane.hidden = !forge;
    var wrap = document.querySelector("main .wrap");
    if (wrap) wrap.className = forge ? "wrap wide" : "wrap";
    var btns = document.querySelectorAll(".side-link[data-tab]");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-tab") === name;
      btns[i].className = "side-link" + (on ? " active" : "");
      if (on) btns[i].setAttribute("aria-current", "page"); else btns[i].removeAttribute("aria-current");
    }
    if (!forge) { fxStopFeed(); fxCloseDrawer(); return; }
    if (FX.route.screen !== name) FX.route = { screen: name, id: "", q: new URLSearchParams() };
    var screens = document.querySelectorAll("#forgePane .fx-screen");
    for (var j = 0; j < screens.length; j++) screens[j].hidden = screens[j].getAttribute("data-screen") !== name;
    document.title = FX_SCREENS[name] + (FX.route.id ? " " + FX.route.id : "") + " · Flare Forge";
    fxSyncChrome();
    fxWriteHash();
    fxRenderScreen();
    if (!FX.ws && !FX.simTimer && !FX.pollTimer) fxStartFeed();
  }
  function fxRenderScreen() {
    var s = FX.route.screen;
    fxRenderNotice(s === "intents" && FX.route.id ? "intent" : s);
    if (s === "live") fxLoadLive(false);
    else if (s === "inbox") fxLoadInbox();
    else if (s === "intents") { if (FX.route.id) fxLoadIntent(FX.route.id); else fxLoadIntents(); }
    else if (s === "trains") { if (FX.route.id) fxLoadTrain(FX.route.id); else fxLoadTrains(); }
    else if (s === "conflicts") { if (FX.route.id) fxLoadConflict(FX.route.id); else fxLoadConflicts(); }
    else if (s === "agents") fxLoadAgents();
    else if (s === "bench") fxLoadBench();
    else if (s === "why") fxLoadWhyScreen();
  }
  function fxSetRepo(repo, silent) {
    if (!repo || repo === FX.repo) return;
    FX.repo = repo;
    try { localStorage.setItem("flare-forge-repo", repo); } catch (e) {}
    FX.snap = null; FX.inbox = null; FX.seq = null; FX.pathFilter = "";
    var sel = document.getElementById("fxRepo");
    if (FX.repos.indexOf(repo) < 0) FX.repos.push(repo);
    fxFillRepos();
    sel.value = repo;
    if (!silent) { fxStopFeed(); fxWriteHash(); fxSyncChrome(); fxRenderScreen(); fxStartFeed(); }
  }
  function fxFillRepos() {
    var sel = fxClear(document.getElementById("fxRepo"));
    FX.repos.forEach(function (r) { sel.appendChild(h("option", { value: r, text: r })); });
    sel.value = FX.repo;
  }
  function fxInitRepos() {
    var q = fxQ();
    var saved = null;
    try { saved = localStorage.getItem("flare-forge-repo"); } catch (e) {}
    if (FX.demo) {
      FX.repos = (fxFixtures().repos || []).slice();
      FX.repo = FX.demoScale ? "sim/monorepo" : (saved && FX.repos.indexOf(saved) >= 0 ? saved : FX.repos[0]);
      fxFillRepos();
      return Promise.resolve();
    }
    FX.repo = saved || "";
    return fxFetch("/v1/repos?limit=50").then(function (b) {
      FX.repos = ((b && b.repos) || []).map(function (r) { return r.name; });
    }, function () { FX.repos = []; }).then(function () {
      if (!FX.repos.length) FX.repos = (fxFixtures().repos || []).slice();
      if (!FX.repo || FX.repos.indexOf(FX.repo) < 0) FX.repo = FX.repos[0];
      if (q.get("repo")) FX.repo = q.get("repo");
      fxFillRepos();
    });
  }

  // ---------- Live map ----------
  var FX_LIVE_COUNTERS = [
    { key: "agents", label: "Agents active", series: "agents" },
    { key: "intents", label: "Intents live", series: "intents" },
    { key: "overlaps_caught", label: "Overlaps caught", series: "overlaps_caught", rate: "overlaps_per_min", unit: "at declare" },
    { key: "conflicts_open", label: "Conflicts open", kind: "conflicts" },
    { key: "landed_today", label: "Landed today", series: "landed_today", rate: "landed_per_min" },
    { key: "main_red_minutes", label: "Main red min", kind: "invariant" }
  ];
  function fxSpark(values) {
    var s = svgEl("svg", { "class": "fx-spark", viewBox: "0 0 64 18", preserveAspectRatio: "none", "aria-hidden": "true" });
    if (!values || values.length < 2) return s;
    var mx = Math.max.apply(null, values), mn = Math.min.apply(null, values);
    var span = mx - mn || 1;
    var pts = values.map(function (v, i) { return (i * 64 / (values.length - 1)).toFixed(1) + "," + (16 - (v - mn) / span * 14).toFixed(1); }).join(" ");
    s.appendChild(svgEl("polyline", { points: pts }));
    return s;
  }
  function fxRenderCounters(list, defs, d) {
    var ul = document.getElementById(list);
    defs.forEach(function (def, idx) {
      var li = ul.children[idx];
      if (!li || li.getAttribute("data-metric") !== def.key) {
        li = h("li", { cls: "fx-counter", "data-metric": def.key }, [h("div", { cls: "fx-clabel", text: def.label }), h("div", { cls: "fx-cval" }), h("div", { cls: "fx-csub" })]);
        if (ul.children[idx]) ul.replaceChild(li, ul.children[idx]); else ul.appendChild(li);
      }
      var v = def.value(d);
      var val = li.children[1];
      var prev = val.getAttribute("data-value");
      if (prev !== String(v.text)) {
        fxClear(val);
        val.appendChild(document.createTextNode(v.text));
        if (v.small) val.appendChild(h("small", { text: v.small }));
        val.setAttribute("data-value", String(v.text));
        li.setAttribute("data-value", v.raw === undefined ? String(v.text) : String(v.raw));
        if (prev !== null) fxFlash(li);
      }
      var sub = fxClear(li.children[2]);
      sub.className = "fx-csub" + (v.tone ? " " + v.tone : "");
      (v.sub || []).forEach(function (n) { sub.appendChild(typeof n === "string" ? h("span", { text: n }) : n); });
    });
    ul.className = "fx-counters" + (fxStale() ? " stale" : "");
  }
  function fxFlash(node) {
    if (fxReduced()) { node.classList.add("fx-flash"); setTimeout(function () { node.classList.remove("fx-flash"); }, 2000); return; }
    node.classList.add("flash");
    setTimeout(function () { node.classList.remove("flash"); }, 30);
  }
  function fxStale() { return !FX.demo && (document.getElementById("fxLiveBadge").getAttribute("data-state") === "reconnecting"); }
  function fxLiveCounterDefs() {
    return FX_LIVE_COUNTERS.map(function (c) {
      return { key: c.key, label: c.label, value: function (s) {
        var n = s.counters[c.key];
        var out = { text: fxNum(n === undefined ? 0 : n), raw: n };
        if (c.kind === "invariant") {
          out.tone = n ? "bad" : "ok";
          out.sub = [n ? "✕ main was red" : "✓ always green"];
        } else if (c.kind === "conflicts") {
          out.tone = n ? "bad" : "ok";
          out.sub = [n ? "✕ replaying" : "✓ none open"];
        } else {
          out.sub = [fxSpark(s.series[c.series])];
          if (c.rate && s.rates[c.rate] !== undefined) out.sub.push("▲ " + s.rates[c.rate] + "/min");
          if (c.unit) out.sub.push(c.unit);
        }
        return out;
      } };
    });
  }
  function fxLoadLive(quiet) {
    var map = document.getElementById("fxMap");
    if (!FX.snap && !quiet) fxSkeleton(map, 0);
    var repo = FX.repo;
    // Fixture snapshots keep their simulated progress across navigation.
    return fxLoad("/v1/forge/snapshot?repo=" + encodeURIComponent(repo), function () { return FX.snap && FX.snap._fixture && FX.snap.repo === repo ? FX.snap : fxFxSnapshot(repo); }, "live").then(function (d) {
      if (repo !== FX.repo) return;
      FX.snap = fxNormSnapshot(d);
      if (FX.fallback.live && !FX.simTimer && !document.getElementById("forgePane").hidden) fxStartFeed();
      FX.lastUpdate = Date.now();
      fxRenderNotice("live");
      fxUpdateBadges();
      if (FX.route.screen === "live") fxRenderLive(true);
    }, function (err) {
      if (quiet) return;
      fxClear(map).appendChild(fxErrorCard(err, function () { fxLoadLive(false); }));
    });
  }
  function fxRenderLive(full) {
    var s = FX.snap;
    if (!s) return;
    fxRenderCounters("fxLiveCounters", fxLiveCounterDefs(), s);
    fxRenderTrack(s);
    fxRenderLegend(s);
    if (full !== false) fxRenderMap(s);
    fxRenderLiveTable(s);
  }
  function fxCells(s) {
    var cells = (s.cells || s.tree || []).map(function (c) { return { path: c.path, files: Math.max(1, Number(c.files) || 1), agents: c.agents, overlap: !!c.overlap, conflict: !!c.conflict, protected: !!c.protected, intents: [] }; });
    cells.sort(function (a, b) { return b.files - a.files || (a.path < b.path ? -1 : 1); });
    if (cells.length > 64) {
      var keep = cells.slice(0, 63), rest = cells.slice(63);
      var other = { path: "other", files: 0, agents: 0, intents: [] };
      rest.forEach(function (c) { other.files += c.files; other.agents += c.agents || 0; });
      keep.push(other); cells = keep;
    }
    var prot = (s.policy && s.policy.protected) || [];
    cells.forEach(function (c) {
      prot.forEach(function (g) { if (fxPathsOverlap(g, c.path === "(root)" ? "" : c.path) && c.path !== "(root)") c.protected = true; });
    });
    s.intents.forEach(function (i) {
      var best = null;
      cells.forEach(function (c) { if (fxInCell(i.path, c.path) && (!best || c.path.length > best.path.length)) best = c; });
      if (!best) cells.forEach(function (c) { if (!best && c.path === "(root)") best = c; });
      if (best) best.intents.push(i);
      i._cell = best ? best.path : "";
    });
    s.overlaps.forEach(function (o) {
      (o.paths || []).forEach(function (p) {
        cells.forEach(function (c) {
          if (!fxInCell(p, c.path)) return;
          if (o.state === "conflict") c.conflict = true; else c.overlap = true;
          c.overlapPairs = (c.overlapPairs || []).concat([[o.a, o.b]]);
        });
      });
    });
    s.conflicts.forEach(function (cf) {
      (cf.files || []).forEach(function (p) { cells.forEach(function (c) { if (fxInCell(p, c.path)) { c.conflict = true; c.conflictId = cf.sim ? null : cf.id; } }); });
    });
    return cells;
  }
  function fxWorst(row, side) {
    var sum = 0, mx = 0, mn = Infinity;
    row.forEach(function (r) { sum += r.area; if (r.area > mx) mx = r.area; if (r.area < mn) mn = r.area; });
    var s2 = sum * sum, w2 = side * side;
    return Math.max(w2 * mx / s2, s2 / (w2 * mn));
  }
  function fxSquarify(items, x, y, w, hgt) {
    var out = [];
    var total = 0;
    items.forEach(function (i) { total += i.value; });
    if (!total || w <= 1 || hgt <= 1) return out;
    var scale = (w * hgt) / total;
    var rest = items.map(function (i) { return { item: i, area: i.value * scale }; });
    var rx = x, ry = y, rw = w, rh = hgt;
    while (rest.length) {
      var side = Math.min(rw, rh);
      var row = [rest.shift()];
      var worst = fxWorst(row, side);
      while (rest.length) {
        var cand = row.concat([rest[0]]);
        var wv = fxWorst(cand, side);
        if (wv > worst) break;
        row = cand; worst = wv; rest.shift();
      }
      var sum = 0;
      row.forEach(function (r) { sum += r.area; });
      if (rw >= rh) {
        var cw = sum / rh, cy = ry;
        row.forEach(function (r) { var ch = r.area / cw; out.push({ item: r.item, x: rx, y: cy, w: cw, h: ch }); cy += ch; });
        rx += cw; rw -= cw;
      } else {
        var rh2 = sum / rw, cx = rx;
        row.forEach(function (r) { var cw2 = r.area / rh2; out.push({ item: r.item, x: cx, y: ry, w: cw2, h: rh2 }); cx += cw2; });
        ry += rh2; rh -= rh2;
      }
    }
    return out;
  }
  function fxCellState(c) {
    if (c.conflict) return "conflict";
    if (c.overlap) return "overlap";
    var st = "idle";
    var rank = { idle: 0, landed: 1, train: 2, working: 3, human: 4 };
    c.intents.forEach(function (i) { var t = fxTone(i.state); if (t === "conflict") t = "working"; if ((rank[t] || 0) > (rank[st] || 0)) st = t; });
    if (c.agents && st === "idle") st = "working";
    return st;
  }
  function fxRenderMap(s) {
    var map = fxClear(document.getElementById("fxMap"));
    if (FX.tableView || document.getElementById("forgePane").hidden) return;
    if (window.innerWidth > 900) {
      var legend = document.getElementById("fxLegend");
      var avail = window.innerHeight - map.getBoundingClientRect().top - (legend.offsetHeight || 40) - 32 + (window.scrollY || 0);
      map.style.height = Math.max(380, Math.round(avail)) + "px";
    } else map.style.height = "";
    var W = map.clientWidth, H = map.clientHeight;
    if (W < 40 || H < 40) { FX.mapRetry = (FX.mapRetry || 0) + 1; if (FX.mapRetry < 20) setTimeout(function () { if (FX.route.screen === "live" && FX.snap) fxRenderMap(FX.snap); }, 60); return; }
    FX.mapRetry = 0;
    var cells = fxCells(s);
    if (!cells.length) {
      map.appendChild(h("div", { style: "padding:16px" }, [fxEmpty("forge_no_active_intents", "No agents are working on " + (FX.repo || "this repo") + ".", "Connect an agent over MCP; its intents show up here as dots on the paths they declare.", "npx flare mcp-config --client claude-code")]));
      return;
    }
    cells.forEach(function (c) { c.area = Math.pow(c.files, 0.55) + 2.5 * c.intents.length; });
    var totalFiles = 0;
    cells.forEach(function (c) { totalFiles += c.area; });
    var floor = totalFiles * 0.02;
    var groups = {}, order = [];
    cells.forEach(function (c) {
      var g = c.path === "(root)" || c.path.indexOf("/") < 0 ? c.path : c.path.split("/")[0];
      if (!groups[g]) { groups[g] = { key: g, cells: [], value: 0 }; order.push(g); }
      groups[g].cells.push(c);
      groups[g].value += Math.max(c.area, floor);
    });
    var gitems = order.map(function (k) { return groups[k]; }).sort(function (a, b) { return b.value - a.value || (a.key < b.key ? -1 : 1); });
    var placedDots = [];
    var simBudget = 2000;
    var maxAgents = 1;
    cells.forEach(function (c) { if ((c.agents || 0) > maxAgents) maxAgents = c.agents; });
    var heatCut = 200;
    var simTotal = 0;
    cells.forEach(function (c) { if ((c.agents || 0) <= heatCut) simTotal += c.agents || 0; });
    if (simTotal > simBudget) heatCut = 60;
    FX_CELL_RECTS = {};
    fxSquarify(gitems, 0, 0, W, H).forEach(function (gr) {
      var g = gr.item;
      var gx = gr.x + 2, gy = gr.y + 2, gw = gr.w - 4, gh = gr.h - 4;
      var single = g.cells.length === 1 && g.cells[0].path === g.key;
      var inner = { x: gx, y: gy, w: gw, h: gh };
      if (!single) {
        map.appendChild(h("div", { cls: "fx-group", style: "left:" + gx + "px;top:" + gy + "px;width:" + gw + "px;height:" + gh + "px", "aria-hidden": "true" }, [h("span", { cls: "fx-group-label", text: g.key })]));
        inner = { x: gx + 3, y: gy + 20, w: gw - 6, h: gh - 23 };
      }
      var citems = g.cells.map(function (c) { return { value: Math.max(c.area, floor), cell: c, key: c.path }; }).sort(function (a, b) { return b.value - a.value || (a.key < b.key ? -1 : 1); });
      fxSquarify(citems, inner.x, inner.y, inner.w, inner.h).forEach(function (r) {
        fxRenderCell(map, r.item.cell, r.x + 1.5, r.y + 1.5, Math.max(0, r.w - 3), Math.max(0, r.h - 3), single, placedDots, heatCut, maxAgents);
      });
    });
    fxRenderArcs(map, s, placedDots, W, H);
  }
  var FX_CELL_RECTS = {};
  function fxRenderCell(map, c, x, y, w, hh, single, placedDots, heatCut, maxAgents) {
    var state = fxCellState(c);
    var label = single ? c.path : c.path.split("/").slice(1).join("/") || c.path;
    var n = c.agents !== undefined ? c.agents : c.intents.length;
    var owners = [];
    c.intents.forEach(function (i) { var a = fxAgent(i.agent).label; if (owners.indexOf(a) < 0) owners.push(a); });
    var cls = "fx-cell" + (c.overlap ? " overlap" : "") + (c.conflict ? " conflict" : "") + (FX.pathFilter && FX.pathFilter === c.path ? " sel" : "") + (FX.pathFilter && FX.pathFilter !== c.path ? " dim" : "");
    FX_CELL_RECTS[c.path] = { x: x, y: y, w: w, h: hh };
    var cell = h("button", { cls: cls, type: "button", "data-kind": "path", "data-id": c.path, "data-state": state, "data-agents": n, style: "left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + hh + "px",
      "aria-label": c.path + ": " + c.files + " files, " + fxNum(n) + (c.agents !== undefined ? " agents" : " intents") + (c.overlap ? ", overlap" : "") + (c.conflict ? ", conflict" : "") + (c.protected ? ", protected" : "") });
    cell.addEventListener("click", function () { FX.pathFilter = FX.pathFilter === c.path ? "" : c.path; fxApplyPathFilter(); });
    cell.addEventListener("mousemove", function (ev) {
      var lines = [h("div", { cls: "mono", text: c.path + " · " + c.files + " files" + (c.protected ? " · protected" : "") }), h("div", { cls: "fx-tip-title", text: fxNum(n) + (c.agents !== undefined ? " agents" : " intents") + (owners.length ? " · " + owners.join(" ") : "") })];
      if (c.conflict) lines.push(h("div", { cls: "st-conflict", text: "✕ conflict" + (c.conflictId ? " " + c.conflictId + " (open from the ✕ badge)" : "") }));
      else if (c.overlap) lines.push(h("div", { cls: "st-overlap", text: "◐ footprints overlap (advisory, caught at declare)" }));
      fxTipShow(ev, lines);
    });
    cell.addEventListener("mouseleave", fxTipHide);
    if (w > 46 && hh > 26) cell.appendChild(h("span", { cls: "fx-cell-label", text: label }));
    if (w > 70 && hh > 48) cell.appendChild(h("span", { cls: "fx-cell-meta", text: c.files + " files" + (c.intents.length ? " · " + c.intents.length + " intents" : "") }));
    var badges = h("span", { cls: "fx-cell-badges" });
    if (c.protected) badges.appendChild(h("span", { cls: "fx-cbadge lock", title: "Protected by .flare/policy.yml: intents stop for plan approval", "aria-label": "protected path", text: "!" }));
    if (c.conflict) {
      var xb = h("span", { cls: "fx-cbadge x", role: "link", tabindex: "0", title: c.conflictId ? "Open conflict " + c.conflictId : "Open conflicts", "aria-label": "conflict " + (c.conflictId || ""), "data-kind": "conflict", "data-id": c.conflictId || "", text: "✕" });
      xb.addEventListener("click", function (ev) { ev.stopPropagation(); fxNav(c.conflictId ? "#/conflicts/" + c.conflictId : "#/conflicts"); });
      badges.appendChild(xb);
    }
    if (badges.firstChild) cell.appendChild(badges);
    map.appendChild(cell);
    var dw = Math.max(0, w - 12), dh = Math.max(0, hh - 40);
    var dots = h("span", { cls: "fx-dots", "aria-hidden": "true" });
    cell.appendChild(dots);
    if (c.agents !== undefined && c.agents > heatCut) {
      var op = 0.06 + 0.3 * Math.log(1 + c.agents) / Math.log(1 + maxAgents);
      cell.insertBefore(h("span", { cls: "fx-heat", style: "opacity:" + op.toFixed(3) }), cell.firstChild);
      if (w > 50 && hh > 34) cell.appendChild(h("span", { cls: "fx-heat-count", "data-count": c.agents, text: "×" + fxNum(c.agents) }));
    } else if (c.agents) {
      var rng = fxRng(fxHash(c.path));
      for (var k = 0; k < c.agents; k++) {
        var r = rng();
        var tone = r < 0.8 ? "" : r < 0.95 ? " train" : " human";
        dots.appendChild(h("span", { cls: "fx-sdot" + tone, style: "left:" + (4 + rng() * 92).toFixed(2) + "%;top:" + (4 + rng() * 92).toFixed(2) + "%" }));
      }
    }
    c.intents.forEach(function (i) {
      var hsh = fxHash(i.id);
      var u = 0.12 + ((hsh & 1023) / 1023) * 0.76, v = 0.15 + (((hsh >>> 10) & 1023) / 1023) * 0.7;
      var tone = fxTone(i.state);
      var a = fxAgent(i.agent);
      var lease = i.lease_expires_at ? Math.max(0, Math.round((Date.parse(i.lease_expires_at) - Date.now()) / 1000)) : null;
      var dot = h("button", { cls: "fx-dot", type: "button", "data-kind": "intent", "data-id": i.id, "data-state": i.state, "data-tone": tone, "data-risk": i.risk, "data-agent": i.agent, style: "left:" + (u * 100).toFixed(2) + "%;top:" + (v * 100).toFixed(2) + "%",
        "aria-label": a.label + " " + i.id + " " + fxWord(i.state) + ": " + i.title },
        [h("span", { cls: "fx-dot-core" }), dw > 60 ? h("span", { cls: "fx-dot-tag", text: a.label }) : null]);
      dot.addEventListener("click", function (ev) { ev.stopPropagation(); fxNav("#/intents/" + i.id); });
      dot.addEventListener("mousemove", function (ev) {
        ev.stopPropagation();
        fxTipShow(ev, [h("div", { cls: "mono", text: a.label + " · " + i.id + " · " + fxWord(i.state) + (lease !== null ? " · lease " + lease + "s" : "") }), h("div", { cls: "fx-tip-title", text: "“" + i.title + "”" }), h("div", { cls: "mono", text: (i.footprint.declared || []).slice(0, 3).join(", ") + ((i.footprint.declared || []).length > 3 ? " …" : "") })]);
      });
      dot.addEventListener("mouseleave", fxTipHide);
      dot.addEventListener("focus", function () { var r = dot.getBoundingClientRect(); fxTipShow({ clientX: r.right, clientY: r.bottom }, [h("div", { cls: "mono", text: a.label + " · " + i.id }), h("div", { cls: "fx-tip-title", text: i.title })]); });
      dot.addEventListener("blur", fxTipHide);
      dots.appendChild(dot);
      placedDots.push({ id: i.id, x: x + 6 + u * dw, y: y + 22 + v * dh, label: a.label });
    });
  }
  function fxRenderArcs(map, s, placed, W, H) {
    var byId = {};
    placed.forEach(function (p) { byId[p.id] = p; });
    var svg = svgEl("svg", { "class": "fx-arcs", viewBox: "0 0 " + W + " " + H, width: W, height: H, "aria-hidden": "true" });
    s.overlaps.forEach(function (o) {
      var a = byId[o.a], b = byId[o.b];
      if (!a || !b) return;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var off = Math.min(80, len * 0.28);
      var cx = mx - dy / len * off, cy = my + dx / len * off;
      var via = null;
      (o.paths || []).forEach(function (p) { Object.keys(FX_CELL_RECTS).forEach(function (k) { if (!via && fxInCell(p, k)) via = FX_CELL_RECTS[k]; }); });
      if (via) {
        var vx = via.x + via.w / 2, vy = via.y + Math.min(via.h / 2, 40);
        cx = 2 * vx - mx; cy = 2 * vy - my;
      }
      var path = svgEl("path", { d: "M" + a.x.toFixed(1) + " " + a.y.toFixed(1) + " Q" + cx.toFixed(1) + " " + cy.toFixed(1) + " " + b.x.toFixed(1) + " " + b.y.toFixed(1), "class": o.state === "conflict" ? "conflict" : "", "data-kind": "overlap", "data-id": o.a + "~" + o.b });
      svg.appendChild(path);
      var t = svgEl("text", { x: ((a.x + 2 * cx + b.x) / 4).toFixed(1), y: ((a.y + 2 * cy + b.y) / 4 + 16).toFixed(1), "text-anchor": "middle" });
      t.textContent = a.label + " ↔ " + b.label;
      svg.appendChild(t);
    });
    map.appendChild(svg);
  }
  function fxApplyPathFilter() {
    var cells = document.querySelectorAll("#fxMap .fx-cell");
    for (var i = 0; i < cells.length; i++) {
      var p = cells[i].getAttribute("data-id");
      cells[i].classList.toggle("sel", !!FX.pathFilter && p === FX.pathFilter);
      cells[i].classList.toggle("dim", !!FX.pathFilter && p !== FX.pathFilter);
    }
    var lab = document.getElementById("fxMapPath");
    lab.textContent = FX.pathFilter ? (FX.repo + " › " + FX.pathFilter.split("/").join(" › ")) : FX.repo;
    document.getElementById("fxClearPath").hidden = !FX.pathFilter;
    if (FX.snap) fxRenderLiveTable(FX.snap);
    if (FX.pathFilter) FX.route.q.set("path", FX.pathFilter); else FX.route.q.delete("path");
    fxWriteHash();
  }
  function fxRenderLiveTable(s) {
    var body = fxClear(document.querySelector("#fxLiveTable tbody"));
    var cells = fxCells(s);
    cells.filter(function (c) { return !FX.pathFilter || c.path === FX.pathFilter; }).forEach(function (c) {
      var owners = [], ids = [], with_ = [];
      c.intents.forEach(function (i) { ids.push(i.id); var a = fxAgent(i.agent).label; if (owners.indexOf(a) < 0) owners.push(a); });
      (c.overlapPairs || []).forEach(function (p) { var k = p[0] + " ↔ " + p[1]; if (with_.indexOf(k) < 0) with_.push(k); });
      var st = fxCellState(c);
      var idCell = h("td", { cls: "mono" });
      if (ids.length) ids.forEach(function (id, n) { if (n) idCell.appendChild(document.createTextNode(" ")); idCell.appendChild(fxLink(id)); });
      else idCell.textContent = c.agents !== undefined ? fxNum(c.agents) + " sim agents" : "—";
      body.appendChild(h("tr", { "data-kind": "path", "data-id": c.path, "data-state": st }, [
        h("td", { cls: "mono", text: c.path + (c.protected ? " (protected)" : "") }),
        h("td", { cls: "num", text: c.files }),
        idCell,
        h("td", { cls: "mono", text: owners.join(" ") || "—" }),
        h("td", {}, [h("span", { cls: "st-" + st, text: FX_GLYPH[st] + " " + st })]),
        h("td", { cls: "mono", text: with_.join(", ") || (c.conflict ? "conflict" : "—") })
      ]));
    });
  }
  function fxRenderTrack(s) {
    var rail = fxClear(document.getElementById("fxTrack"));
    rail.appendChild(h("div", { cls: "fx-panel-head" }, [h("span", { text: "Track → main" }), h("span", { cls: "fx-spacer" }), h("a", { href: "#/trains", cls: "fx-path", text: "all trains" })]));
    var body = h("div", { cls: "fx-rail-body" });
    rail.appendChild(body);
    var t = s.track && s.track.current;
    if (t) {
      var red = (t.lanes || []).some(function (l) { return l.stages && l.stages.ci && l.stages.ci.status === "failure"; });
      var cur = h("div", { cls: "fx-train-cur" + (red ? " red" : ""), "data-kind": "train", "data-id": t.id, "data-state": t.state }, [
        h("div", { cls: "fx-train-head" }, [t.sim ? h("span", { cls: "fx-idchip", text: t.id }) : fxLink(t.id), fxPill(t.state), h("span", { cls: "fx-spacer" }), h("span", { cls: "mono muted", text: (t.lanes || []).length + " lanes" })])
      ]);
      (t.lanes || []).slice(0, 6).forEach(function (l) {
        var lane = h("div", { cls: "fx-lane", "data-kind": "lane", "data-id": t.id + "/" + l.n }, [
          h("div", { cls: "fx-lane-top" }, [h("span", { text: "lane " + l.n }), h("span", { cls: "lp", title: (l.paths || []).join(", "), text: (l.paths || []).join(", ") })]),
          fxStageChain(l.stages, true),
          fxIntentChips(l.intents, 4, t.sim)
        ]);
        cur.appendChild(lane);
      });
      body.appendChild(cur);
    } else {
      body.appendChild(h("div", { cls: "fx-empty", "data-state": "empty", "data-code": "no_train_in_flight", "data-hint": "The next train forms when an intent is marked ready." }, [h("p", { text: "No train in flight. The next one forms when an intent is marked ready." })]));
    }
    var recent = (s.track && s.track.recent) || [];
    if (recent.length) {
      var ul = h("ul", { cls: "fx-recent", "aria-label": "Recent trains" });
      recent.slice(0, 5).forEach(function (r) {
        var tone = fxTone(r.state);
        var res = r.result || {};
        var total = r.total || (res.landed || 0) + (res.requeued || 0);
        var txt = r.state === "bisected" ? "✕→bisect " + (res.landed || 0) + "/" + total : r.state === "landed" ? "landed " + (res.landed || total) : fxWord(r.state);
        ul.appendChild(h("li", { "data-kind": "train", "data-id": r.id, "data-state": r.state }, [r.sim ? h("span", { cls: "fx-idchip", text: r.id }) : fxLink(r.id), h("span", { cls: "st-" + tone, text: FX_GLYPH[tone] }), h("span", { text: txt }), h("span", { cls: "r-right", text: r.duration_s ? fxClock(r.duration_s) : "" })]));
      });
      body.appendChild(h("div", {}, [h("div", { cls: "fx-sec-h", text: "Recent" }), ul]));
    }
    var head = s.head || {};
    body.appendChild(h("div", { cls: "fx-main-rule", id: "fxMainRule" }, [
      h("div", { cls: "meta" }, [h("strong", { text: "main" }), h("span", {}, [head.sha ? fxSha(head.sha) : "—"])]),
      h("div", { cls: "rule", role: "img", "aria-label": "main at " + (head.sha || "unknown") }),
      h("div", { cls: "meta" }, [h("span", { text: "only trains write main" }), h("span", { text: "CI green on exact SHA" })])
    ]));
  }
  function fxStageChain(st, compact) {
    st = st || {};
    var wrap = h("div", { cls: "fx-stages" });
    var ci = st.ci || {};
    var parts = [["merge", st.merge], ["push", st.push], ["CI", ci.status], ["CAS", st.cas]];
    parts.forEach(function (p, i) {
      var v = p[1] || "pending";
      var cls = v === "done" || v === "success" ? "done" : v === "running" ? "running" : v === "failure" || v === "error" ? "failure" : v === "skipped" ? "skipped" : "";
      var label = p[0];
      if (p[0] === "CI" && (ci.duration_s || v === "running")) label += " " + fxClock(ci.duration_s || 0);
      if (i) wrap.appendChild(h("span", { cls: "fx-stage-arrow", "aria-hidden": "true", text: "→" }));
      var chip = h("span", { cls: "fx-stage " + cls, "data-stage": p[0].toLowerCase(), "data-state": v, text: label });
      wrap.appendChild(chip);
      if (p[0] === "CI" && ci.sha && !compact) { wrap.appendChild(h("span", { cls: "muted mono", text: " on " })); wrap.appendChild(fxSha(ci.sha)); }
    });
    return wrap;
  }
  function fxIntentChips(ids, max, sim) {
    var wrap = h("div", { cls: "fx-chips" });
    (ids || []).slice(0, max).forEach(function (id) { wrap.appendChild(sim ? h("span", { cls: "fx-idchip", text: id }) : fxLink(id)); });
    if ((ids || []).length > max) wrap.appendChild(h("span", { cls: "fx-idchip", title: ids.length + " intents", text: "… " + ids.length }));
    return wrap;
  }
  function fxRenderLegend(s) {
    var lg = fxClear(document.getElementById("fxLegend"));
    function item(sw, text) { return h("span", { cls: "lg" }, [sw, text]); }
    lg.appendChild(item(h("span", { cls: "sw bg-working" }), "● working"));
    lg.appendChild(item(h("span", { cls: "sw hatch" }), "◐ overlap"));
    lg.appendChild(item(h("span", { cls: "sw box" }), "✕ conflict"));
    lg.appendChild(item(h("span", { cls: "sw bg-train" }), "▶ train"));
    lg.appendChild(item(h("span", { cls: "sw bg-landed" }), "✓ landed"));
    lg.appendChild(item(h("span", { cls: "sw bg-human" }), "! needs human"));
    lg.appendChild(h("span", { cls: "muted", text: (s && s.sim ? "· 1 dot = 1 agent · ×N above 200 per cell" : "· 1 dot = 1 intent") + " · area ≈ files (dampened) + activity" }));
    lg.appendChild(h("span", { cls: "fx-spacer", style: "flex:1" }));
    lg.appendChild(h("span", { cls: "muted", text: "p pause · t table · ⇧S stage" }));
    if (FX.lastUpdate) lg.appendChild(h("span", { cls: "muted", text: "· updated " + new Date(FX.lastUpdate).toLocaleTimeString() }));
  }
  function fxTipShow(ev, lines) {
    var tip = fxClear(document.getElementById("fxTip"));
    lines.forEach(function (l) { tip.appendChild(l); });
    tip.hidden = false;
    var x = (ev.clientX || 0) + 14, y = (ev.clientY || 0) + 14;
    var r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = (ev.clientX || 0) - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = (ev.clientY || 0) - r.height - 14;
    tip.style.left = Math.max(4, x) + "px"; tip.style.top = Math.max(4, y) + "px";
  }
  function fxTipHide() { document.getElementById("fxTip").hidden = true; }
  function fxToggleTable(force) {
    FX.tableView = force === undefined ? !FX.tableView : force;
    document.getElementById("fxLiveTableWrap").hidden = !FX.tableView;
    document.getElementById("fxMap").hidden = FX.tableView;
    document.getElementById("fxTableBtn").setAttribute("aria-pressed", FX.tableView ? "true" : "false");
    if (!FX.tableView && FX.snap) fxRenderMap(FX.snap);
  }

  // ---------- feed: WebSocket, 5s polling fallback, demo simulator ----------
  function fxSetBadge(state, label) {
    var b = document.getElementById("fxLiveBadge");
    if (FX.paused) { state = "paused"; label = "paused · " + FX.buffer.length + " buffered"; }
    b.setAttribute("data-state", state);
    var text = label;
    if (!text) {
      if (state === "live") text = "live" + (fxHz() ? " · " + fxHz() + " Hz" : "");
      else if (state === "polling") text = "polling 5s";
      else if (state === "reconnecting") text = "reconnecting" + (FX.lastUpdate ? " · last " + new Date(FX.lastUpdate).toLocaleTimeString() : "");
      else text = "offline";
    }
    b.textContent = text;
    b.setAttribute("aria-label", "Feed: " + text);
  }
  function fxHz() {
    var now = Date.now();
    FX.msgTimes = FX.msgTimes.filter(function (t) { return now - t < 5000; });
    var hz = FX.msgTimes.length / 5;
    return hz ? (hz < 10 ? hz.toFixed(1) : String(Math.round(hz))) : "";
  }
  function fxStopFeed() {
    if (FX.ws) { var ws = FX.ws; FX.ws = null; try { ws.close(); } catch (e) {} }
    if (FX.wsTimer) { clearTimeout(FX.wsTimer); FX.wsTimer = null; }
    if (FX.simTimer) { clearInterval(FX.simTimer); FX.simTimer = null; }
    fxStopPolling();
  }
  function fxStopPolling() { if (FX.pollTimer) { clearInterval(FX.pollTimer); FX.pollTimer = null; } }
  function fxStartPolling() {
    fxStopPolling();
    fxSetBadge("polling");
    FX.pollTimer = setInterval(function () {
      if (document.hidden || FX.paused || document.getElementById("forgePane").hidden) return;
      if (FX.route.screen === "live" && !FX.fallback.live) fxLoadLive(true);
      else if (FX.route.screen === "inbox" && !FX.fallback.inbox) fxLoadInbox(true);
    }, 5000);
  }
  function fxStartFeed() {
    fxStopFeed();
    if (document.getElementById("forgePane").hidden) return;
    if (FX.demo || FX.fallback.live) {
      FX.simTimer = setInterval(fxSimTick, 700);
      fxSetBadge("live", "live · demo sim");
      return;
    }
    if (!window.WebSocket) { fxStartPolling(); return; }
    var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/v1/forge/feed?repo=" + encodeURIComponent(FX.repo || "");
    var ws;
    try { ws = new WebSocket(url); } catch (e) { fxStartPolling(); return; }
    FX.ws = ws;
    if (!FX.pollTimer) fxSetBadge("reconnecting");
    ws.onopen = function () { if (FX.ws !== ws) return; FX.wsFails = 0; fxStopPolling(); fxSetBadge("live"); };
    ws.onmessage = function (ev) {
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      fxOnFeed(m);
    };
    ws.onclose = function () {
      if (FX.ws !== ws) return;
      FX.ws = null;
      FX.wsFails++;
      if (FX.wsFails >= 2 && !FX.pollTimer) fxStartPolling();
      else if (!FX.pollTimer) fxSetBadge("reconnecting");
      var delay = Math.min(30000, 1000 * Math.pow(2, FX.wsFails));
      FX.wsTimer = setTimeout(function () {
        FX.wsTimer = null;
        if (!document.getElementById("forgePane").hidden && !FX.ws) {
          var polling = FX.pollTimer;
          FX.pollTimer = null;
          fxStartFeedWs(polling);
        }
      }, delay);
    };
  }
  // Reconnect attempt that keeps polling alive until the socket opens.
  function fxStartFeedWs(polling) {
    FX.pollTimer = polling;
    var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/v1/forge/feed?repo=" + encodeURIComponent(FX.repo || "");
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return; }
    FX.ws = ws;
    ws.onopen = function () { if (FX.ws !== ws) return; FX.wsFails = 0; fxStopPolling(); fxSetBadge("live"); fxLoadLive(true); };
    ws.onmessage = function (ev) { var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; } fxOnFeed(m); };
    ws.onclose = function () {
      if (FX.ws !== ws) return;
      FX.ws = null; FX.wsFails++;
      if (!FX.pollTimer) fxStartPolling();
      FX.wsTimer = setTimeout(function () { FX.wsTimer = null; if (!document.getElementById("forgePane").hidden && !FX.ws) { var p = FX.pollTimer; FX.pollTimer = null; fxStartFeedWs(p); } }, Math.min(30000, 1000 * Math.pow(2, FX.wsFails)));
    };
  }
  function fxOnFeed(m) {
    if (!m || m.v !== 1) return;
    FX.msgTimes.push(Date.now());
    if (FX.paused) { FX.buffer.push(m); if (FX.buffer.length > 2000) FX.buffer = [{ v: 1, type: "resync" }]; fxSetBadge("paused"); return; }
    fxApplyFeed(m);
    if (!FX.pollTimer) fxSetBadge("live", FX.simTimer ? "live · demo sim" + (fxHz() ? " · " + fxHz() + " Hz" : "") : null);
  }
  function fxApplyFeed(m) {
    if (m.type === "resync") { fxLoadLive(true); return; }
    if (m.type === "snapshot") {
      if ((m.repo || (m.data && m.data.repo)) && (m.repo || m.data.repo) !== FX.repo) return;
      FX.snap = fxNormSnapshot(m.data || m.snapshot || {});
      FX.seq = m.seq === undefined ? null : m.seq;
      FX.lastUpdate = Date.now();
      fxScheduleRender(true);
      return;
    }
    if (m.type !== "delta" || !FX.snap) return;
    if (FX.seq !== null && m.seq !== undefined && m.seq !== FX.seq + 1) { FX.seq = null; fxLoadLive(true); return; }
    if (m.seq !== undefined) FX.seq = m.seq;
    var structural = false;
    (m.ops || []).forEach(function (op) { if (fxApplyOp(op)) structural = true; });
    FX.lastUpdate = Date.now();
    fxScheduleRender(structural);
  }
  function fxUpsert(list, id, fields, key) {
    key = key || "id";
    for (var i = 0; i < list.length; i++) {
      if (list[i][key] === id) { for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) list[i][k] = fields[k]; return list[i]; }
    }
    var o = { }; o[key] = id;
    for (var f in fields) if (Object.prototype.hasOwnProperty.call(fields, f)) o[f] = fields[f];
    list.push(o);
    return o;
  }
  // Returns true when the op changes map structure (dots, cells, arcs).
  function fxApplyOp(op) {
    var s = FX.snap;
    var f = op.fields || {};
    if (op.kind === "counters") { for (var k in f) if (Object.prototype.hasOwnProperty.call(f, k)) s.counters[k] = f[k]; return false; }
    if (op.kind === "series") { for (var k2 in f) if (Object.prototype.hasOwnProperty.call(f, k2)) s.series[k2] = f[k2]; return false; }
    if (op.kind === "head") { s.head = f; return false; }
    if (op.kind === "intent") {
      if (op.op === "remove" || f.state === "landed" || f.state === "abandoned" || f.state === "failed") {
        if (f.state === "landed") fxAnimateLanding(op.id);
        s.intents = s.intents.filter(function (i) { return i.id !== op.id; });
        return true;
      }
      var it = fxUpsert(s.intents, op.id, f);
      fxNormIntent(it);
      return true;
    }
    if (op.kind === "overlap") {
      if (op.op === "remove") s.overlaps = s.overlaps.filter(function (o) { return (o.a + "~" + o.b) !== op.id; });
      else fxUpsert(s.overlaps, op.id, f, "_id");
      return true;
    }
    if (op.kind === "conflict") {
      if (op.op === "remove" || f.state === "resolved" || f.state === "abandoned") s.conflicts = s.conflicts.filter(function (c) { return c.id !== op.id; });
      else fxUpsert(s.conflicts, op.id, f);
      return true;
    }
    if (op.kind === "train") {
      var tr = s.track;
      if (op.op === "remove") { if (tr.current && tr.current.id === op.id) tr.current = null; return false; }
      var done = f.state === "landed" || f.state === "bisected" || f.state === "failed" || f.state === "aborted";
      if (tr.current && tr.current.id === op.id) {
        for (var k3 in f) if (Object.prototype.hasOwnProperty.call(f, k3)) tr.current[k3] = f[k3];
        if (done) { tr.recent.unshift(tr.current); tr.recent = tr.recent.slice(0, 8); tr.current = null; }
      } else if (done) { var o = { id: op.id }; for (var k4 in f) if (Object.prototype.hasOwnProperty.call(f, k4)) o[k4] = f[k4]; tr.recent.unshift(o); tr.recent = tr.recent.slice(0, 8); }
      else { var n = { id: op.id }; for (var k5 in f) if (Object.prototype.hasOwnProperty.call(f, k5)) n[k5] = f[k5]; tr.current = n; }
      return false;
    }
    if (op.kind === "cell") {
      var cells = s.cells || s.tree || [];
      var c = fxUpsert(cells, op.id, f, "path");
      var node = document.querySelector("#fxMap .fx-cell[data-id=\"" + String(op.id).replace(/"/g, "") + "\"] .fx-heat-count");
      if (node && c.agents !== undefined) { node.textContent = "×" + fxNum(c.agents); node.setAttribute("data-count", c.agents); }
      return false;
    }
    return false;
  }
  function fxScheduleRender(structural) {
    if (structural) FX.mapDirty = true;
    if (FX.renderTimer) return;
    FX.renderTimer = setTimeout(function () {
      FX.renderTimer = null;
      var dirty = FX.mapDirty; FX.mapDirty = false;
      if (FX.route.screen === "live" && !document.getElementById("forgePane").hidden) fxRenderLive(dirty && !FX.tableView);
      fxUpdateBadges();
      if (FX.route.screen === "trains" && FX.route.id) fxLoadTrain(FX.route.id, true);
      if (FX.route.screen === "conflicts" && FX.route.id && dirty) fxLoadConflict(FX.route.id, true);
    }, 250);
  }
  function fxAnimateLanding(id) {
    if (fxReduced()) return;
    var dot = document.querySelector("#fxMap .fx-dot[data-id=\"" + String(id).replace(/"/g, "") + "\"]");
    var rule = document.getElementById("fxMainRule");
    if (!dot || !rule) return;
    var a = dot.getBoundingClientRect(), b = rule.getBoundingClientRect();
    var ghost = h("span", { cls: "fx-landing", "aria-hidden": "true", style: "left:" + (a.left) + "px;top:" + (a.top) + "px" });
    document.body.appendChild(ghost);
    setTimeout(function () { ghost.style.transform = "translate(" + (b.right - 10 - a.left) + "px," + (b.top + 14 - a.top) + "px) scale(0.4)"; ghost.style.opacity = "0.2"; }, 20);
    setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 800);
  }
  function fxTogglePause(force) {
    FX.paused = force === undefined ? !FX.paused : force;
    var b = document.getElementById("fxPauseBtn");
    b.setAttribute("aria-pressed", FX.paused ? "true" : "false");
    fxClear(b).appendChild(document.createTextNode(FX.paused ? "Resume " : "Pause "));
    b.appendChild(h("kbd", { text: "p" }));
    if (!FX.paused) {
      var buf = FX.buffer; FX.buffer = [];
      buf.forEach(fxApplyFeed);
      fxSetBadge(FX.ws || FX.simTimer ? "live" : FX.pollTimer ? "polling" : "off", FX.simTimer ? "live · demo sim" : null);
      toast("Live updates resumed" + (buf.length ? " · applied " + buf.length + " buffered" : ""));
    } else {
      fxSetBadge("paused");
      toast("Live updates paused · press p to resume");
    }
  }
  // Demo simulator: emits the same {v:1,type:"delta"} messages a Feed DO
  // would, driven by the fixtures, so every live path is exercised.
  function fxSimTick() {
    if (FX.paused) { fxOnFeed({ v: 1, type: "delta", ops: [] }); return; }
    var s = FX.snap;
    if (!s || document.hidden) return;
    FX.sim.t++;
    var ops = [];
    if (s.sim) fxSimScale(s, ops); else fxSimBookshelf(s, ops);
    fxOnFeed({ v: 1, type: "delta", ops: ops });
  }
  function fxSimScale(s, ops) {
    var rng = fxRng(FX.sim.t * 7919);
    var cur = s.track.current;
    var t = FX.sim.t % 14;
    if (cur) {
      cur.lanes.forEach(function (l, i) {
        if (t === 2 + (i % 3)) { l.stages.push = "done"; l.stages.ci.status = "running"; l.stages.ci.sha = l.stages.ci.sha || (fxHash("s" + FX.sim.t + i) % 268435456).toString(16); }
        if (l.stages.ci.status === "running") l.stages.ci.duration_s = (l.stages.ci.duration_s || 0) + 1;
        if (t === 10 + (i % 3)) { l.stages.ci.status = "success"; l.stages.cas = "running"; }
        if (t === 12) l.stages.cas = "done";
      });
      ops.push({ op: "upsert", kind: "train", id: cur.id, fields: { lanes: cur.lanes } });
      if (t === 13) {
        var n = 0; cur.lanes.forEach(function (l) { n += l.intents.length; });
        ops.push({ op: "upsert", kind: "train", id: cur.id, fields: { state: "landed", result: { landed: n, requeued: 0 }, total: n, duration_s: 9 + Math.round(rng() * 6) } });
        var num = Number(cur.id.slice(2)) + 1;
        ops.push({ op: "upsert", kind: "counters", fields: { landed_today: (s.counters.landed_today || 0) + n } });
        var next = fxSimTrain(num, 0).current;
        ops.push({ op: "upsert", kind: "train", id: next.id, fields: next });
      }
    }
    if (rng() < 0.3) ops.push({ op: "upsert", kind: "counters", fields: { overlaps_caught: (s.counters.overlaps_caught || 0) + 1 } });
    ops.push({ op: "upsert", kind: "counters", fields: { intents: Math.max(0, (s.counters.intents || 0) + Math.round(rng() * 6 - 3)) } });
    for (var k = 0; k < 3; k++) {
      var c = s.cells[Math.floor(rng() * s.cells.length)];
      if (c && c.agents > 200) ops.push({ op: "upsert", kind: "cell", id: c.path, fields: { agents: c.agents + Math.round(rng() * 8 - 4) } });
    }
  }
  function fxSimBookshelf(s, ops) {
    var f = fxFixtures();
    var t = FX.sim.t;
    var cur = s.track.current;
    // leases: heartbeat when under 12s
    s.intents.forEach(function (i) {
      if (!i.lease_expires_at) return;
      var left = (Date.parse(i.lease_expires_at) - Date.now()) / 1000;
      if (left < 12) { var at = new Date(Date.now() + 300000).toISOString(); i.lease_expires_at = at; var fi = fxIntentById(i.id); if (fi) fi.lease_expires_at = at; }
    });
    if (cur && cur.id === "t-143") {
      var l1 = cur.lanes[0], l2 = cur.lanes[1];
      if (l1.stages.ci.status === "running") l1.stages.ci.duration_s++;
      if (l1.stages.ci.status === "running" && l1.stages.ci.duration_s >= 33) { l1.stages.ci.status = "success"; l1.stages.cas = "running"; }
      else if (l1.stages.cas === "running") l1.stages.cas = "done";
      if (l2.stages.push === "running" && t > 4) { l2.stages.push = "done"; l2.stages.ci = { status: "running", run: "r-908", sha: "f1c0a92", duration_s: 0 }; }
      else if (l2.stages.ci.status === "running") { l2.stages.ci.duration_s++; if (l2.stages.ci.duration_s >= 26) { l2.stages.ci.status = "success"; l2.stages.cas = "running"; } }
      else if (l2.stages.cas === "running") l2.stages.cas = "done";
      cur.duration_s = (cur.duration_s || 0) + 1;
      ops.push({ op: "upsert", kind: "train", id: cur.id, fields: { lanes: cur.lanes, duration_s: cur.duration_s } });
      if (l1.stages.cas === "done" && l2.stages.cas === "done") {
        ["i-3b90", "i-55e0"].forEach(function (id) {
          var fi = fxIntentById(id);
          if (fi) { fi.state = "landed"; fi.landed_sha = "d03b7e5"; fi.route = "auto"; }
          ops.push({ op: "upsert", kind: "intent", id: id, fields: { state: "landed" } });
        });
        cur.state = "landed"; cur.result = { landed: 2, requeued: 0, sha: "d03b7e5", run: "r-907", tests: 46 };
        ops.push({ op: "upsert", kind: "train", id: cur.id, fields: { state: "landed", result: cur.result } });
        ops.push({ op: "upsert", kind: "head", fields: { sha: "d03b7e5", at: new Date().toISOString() } });
        ops.push({ op: "upsert", kind: "counters", fields: { landed_today: (s.counters.landed_today || 0) + 2, intents: Math.max(0, (s.counters.intents || 0) - 2) } });
        FX.sim.landedAt = t;
        fxSyncInboxCounts();
      }
    } else if (FX.sim.landedAt && t === FX.sim.landedAt + 10) {
      // c-9 replay goes green on the exact SHA and the replayed intent queues.
      var c9 = null; (f.conflicts || []).forEach(function (c) { if (c.id === "c-9") c9 = c; });
      if (c9) { c9.state = "resolved"; c9.replay.stage = "train"; c9.replay.stages[2].status = "done"; c9.replay.stages[2].at = new Date().toISOString(); c9.replay.stages[3].status = "running"; }
      var ri = fxIntentById("i-31c2"); if (ri) { ri.state = "in_train"; ri.train_id = "t-144"; ri.evidence = { run_id: "r-906", sha: "b81f3d0", status: "success", tests: 44, duration_s: 29, reviewer: "agrees" }; }
      ops.push({ op: "upsert", kind: "conflict", id: "c-9", fields: { state: "resolved" } });
      ops.push({ op: "remove", kind: "overlap", id: "i-1d4e~i-31c2" });
      ops.push({ op: "upsert", kind: "intent", id: "i-31c2", fields: { state: "in_train", train_id: "t-144" } });
      ops.push({ op: "upsert", kind: "counters", fields: { conflicts_open: 0 } });
      var t144 = { id: "t-144", state: "verifying", base_sha: "d03b7e5", head_sha: "0b5e7d1", started_at: new Date().toISOString(), duration_s: 0, lanes: [{ n: 1, paths: ["src/middleware/logging.ts"], intents: ["i-31c2"], stages: { merge: "done", push: "done", ci: { status: "running", run: "r-909", sha: "0b5e7d1", duration_s: 0 }, cas: "pending" } }], bisect: null, result: null };
      f.trains.unshift(t144);
      ops.push({ op: "upsert", kind: "train", id: "t-144", fields: t144 });
    } else if (cur && cur.id === "t-144" && cur.state === "verifying") {
      var ln = cur.lanes[0];
      if (ln.stages.ci.status === "running") { ln.stages.ci.duration_s++; if (ln.stages.ci.duration_s >= 29) { ln.stages.ci.status = "success"; ln.stages.cas = "running"; } }
      else if (ln.stages.cas === "running") ln.stages.cas = "done";
      cur.duration_s = (cur.duration_s || 0) + 1;
      ops.push({ op: "upsert", kind: "train", id: "t-144", fields: { lanes: cur.lanes, duration_s: cur.duration_s } });
      if (ln.stages.cas === "done") {
        var li = fxIntentById("i-31c2"); if (li) { li.state = "landed"; li.landed_sha = "0b5e7d1"; li.route = "auto"; }
        var cc = null; (f.conflicts || []).forEach(function (c) { if (c.id === "c-9") cc = c; });
        if (cc) { cc.replay.stages[3].status = "done"; cc.replay.stages[3].at = new Date().toISOString(); cc.replay.stages[4].status = "done"; cc.replay.stages[4].at = new Date().toISOString(); cc.replay.stage = "landed"; }
        cur.state = "landed"; cur.result = { landed: 1, requeued: 0, sha: "0b5e7d1", run: "r-909", tests: 44 };
        ops.push({ op: "upsert", kind: "intent", id: "i-31c2", fields: { state: "landed" } });
        ops.push({ op: "upsert", kind: "train", id: "t-144", fields: { state: "landed", result: cur.result } });
        ops.push({ op: "upsert", kind: "head", fields: { sha: "0b5e7d1", at: new Date().toISOString() } });
        ops.push({ op: "upsert", kind: "counters", fields: { landed_today: (s.counters.landed_today || 0) + 1, intents: Math.max(0, (s.counters.intents || 0) - 1) } });
        fxSyncInboxCounts();
      }
    }
  }
  function fxSyncInboxCounts() { if (FX.route.screen === "inbox") fxLoadInbox(true); }
  function fxUpdateBadges() {
    var ib = document.getElementById("fxBadgeInbox");
    var cb = document.getElementById("fxBadgeConflicts");
    var needs = FX.inbox && FX.inbox.metrics ? FX.inbox.metrics.needs_you : null;
    if (needs === null && FX.snap) needs = null;
    if (needs !== null && needs !== undefined) {
      ib.hidden = !needs; ib.textContent = String(needs);
      document.getElementById("tabInbox").setAttribute("aria-label", "Inbox, " + needs + " need you");
    }
    var open = FX.snap ? (FX.snap.counters.conflicts_open !== undefined ? FX.snap.counters.conflicts_open : FX.snap.conflicts.length) : null;
    if (open !== null) {
      cb.hidden = !open; cb.textContent = String(open);
      document.getElementById("tabConflicts").setAttribute("aria-label", "Conflicts, " + open + " open");
    }
  }

  // ---------- Inbox ----------
  var FX_INBOX_COUNTERS = [
    { key: "human", label: "Human time today", value: function (m) { return { text: fxSecs(m.human_seconds_today || 0), sub: ["reviewing, not rebasing"] }; } },
    { key: "needs", label: "Needs you", value: function (m) { return { text: fxNum(m.needs_you || 0), tone: m.needs_you ? "" : "ok", sub: [m.needs_you ? "plans + escalations" : "✓ all clear"] }; } },
    { key: "sample", label: "Audit sample", value: function (m) { var sm = m.sample || {}; return { text: fxNum(sm.count || 0), small: "of " + fxNum(sm.of || 0), sub: [Math.round((sm.rate || 0) * 100) + "% of auto-landed"] }; } },
    { key: "auto", label: "Auto-landed", value: function (m) { return { text: fxNum(m.auto_landed || 0), sub: ["risk ≤ " + ((m.policy && m.policy.auto_land_max_risk) || 30)] }; } },
    { key: "disagree", label: "Reviewer disagrees", value: function (m) { var d = m.disagreement || {}; return { text: Math.round((d.rate || 0) * 100) + "%", sub: [(d.days || 7) + "d · n=" + fxNum(d.n || 0)] }; } },
    { key: "policy", label: "Policy", value: function (m) { return { text: "≤ " + ((m.policy && m.policy.auto_land_max_risk) || 30), small: "lands", sub: ["sample " + Math.round(((m.policy && m.policy.audit_sample) || 0.05) * 100) + "%"] }; } }
  ];
  function fxLoadInbox(quiet) {
    var box = document.getElementById("fxStories");
    if (!quiet && !FX.inbox) fxSkeleton(box, 4);
    var repo = FX.repo;
    return fxLoad("/v1/forge/inbox?repo=" + encodeURIComponent(repo), function () { return fxFxInbox(repo); }, "inbox").then(function (d) {
      if (repo !== FX.repo) return;
      FX.inbox = fxNormInbox(d);
      fxUpdateBadges();
      if (FX.route.screen !== "inbox") return;
      fxRenderNotice("inbox");
      fxRenderInbox();
    }, function (err) {
      if (quiet) return;
      fxClear(box).appendChild(fxErrorCard(err, function () { fxLoadInbox(false); }));
    });
  }
  function fxNormInbox(d) {
    d = d || {};
    d.metrics = d.metrics || {};
    d.items = [];
    (d.groups || []).forEach(function (g) {
      (g.items || []).forEach(function (it) {
        var i = it.intent || it;
        d.items.push({ id: i.id, title: i.title, agent: typeof i.agent === "object" && i.agent ? i.agent.id : i.agent, state: i.state, bucket: it.bucket || "auto", reason: it.reason || "", why: it.why || it.why_needs_you || "", risk: it.risk !== undefined ? it.risk : i.risk, terms: it.terms || it.risk_terms || i.risk_terms || [], evidence: it.evidence || null, plan: it.plan || [], footprint: it.footprint || [], goal: g.goal || null, train_id: it.train_id || null });
      });
    });
    var rank = { needs_you: 0, sample: 1, auto: 2 };
    d.items.sort(function (a, b) {
      return (rank[a.bucket] - rank[b.bucket]) || ((a.reason === "plan" ? 0 : 1) - (b.reason === "plan" ? 0 : 1)) || (b.risk - a.risk) || (a.id < b.id ? -1 : 1);
    });
    return d;
  }
  function fxInboxMatches(it) {
    var f = FX.inboxFilter;
    if (f === "all") return true;
    if (f === "needs_you") return it.bucket === "needs_you";
    if (f === "plans") return it.bucket === "needs_you" && it.reason === "plan";
    if (f === "escalations") return it.bucket === "needs_you" && it.reason !== "plan";
    return it.bucket === f;
  }
  function fxRenderInbox() {
    var d = FX.inbox;
    if (!d) return;
    var m = d.metrics;
    fxRenderCounters("fxInboxCounters", FX_INBOX_COUNTERS.map(function (c) { return { key: c.key, label: c.label, value: function () { return c.value(m); } }; }), m);
    // filters
    var nav = fxClear(document.getElementById("fxInboxFilters"));
    function count(fn) { return d.items.filter(fn).length; }
    var defs = [
      ["all", "All", "", count(function () { return true; }), false],
      ["needs_you", "Needs you", "!", count(function (i) { return i.bucket === "needs_you"; }), false],
      ["plans", "Plans", "", count(function (i) { return i.bucket === "needs_you" && i.reason === "plan"; }), true],
      ["escalations", "Escalations", "", count(function (i) { return i.bucket === "needs_you" && i.reason !== "plan"; }), true],
      ["sample", "Audit sample", "◐", count(function (i) { return i.bucket === "sample"; }), false],
      ["auto", "Auto-landed", "✓", count(function (i) { return i.bucket === "auto"; }), false]
    ];
    nav.appendChild(h("div", { cls: "fx-fhead", text: "Filter" }));
    defs.forEach(function (df, idx) {
      nav.appendChild(h("button", { type: "button", cls: df[4] ? "sub" : "", "aria-pressed": FX.inboxFilter === df[0] ? "true" : "false", "data-filter": df[0], title: idx > 0 && idx < 4 ? "Key " + (idx === 1 ? "1" : "") : "", on: { click: function () { FX.inboxFilter = df[0]; FX.route.q.set("filter", df[0]); fxWriteHash(); fxRenderInbox(); } } }, [
        h("span", { cls: "g " + (df[2] === "!" ? "st-human" : df[2] === "◐" ? "st-overlap" : df[2] === "✓" ? "st-landed" : ""), "aria-hidden": "true", text: df[2] }), df[1], h("span", { cls: "n", text: df[3] })
      ]));
    });
    nav.appendChild(h("div", { cls: "fx-fhead", text: "Group by" }));
    [["story", "Story"], ["risk", "Risk"], ["agent", "Agent"]].forEach(function (g) {
      nav.appendChild(h("button", { type: "button", "aria-pressed": FX.groupBy === g[0] ? "true" : "false", on: { click: function () { FX.groupBy = g[0]; fxRenderInbox(); } } }, [h("span", { cls: "g", "aria-hidden": "true", text: FX.groupBy === g[0] ? "●" : "○" }), g[1]]));
    });
    // list
    var box = fxClear(document.getElementById("fxStories"));
    var visible = d.items.filter(fxInboxMatches);
    var needs = d.items.filter(function (i) { return i.bucket === "needs_you"; }).length;
    if (!needs && (FX.inboxFilter === "all" || FX.inboxFilter === "needs_you")) {
      var sm = (m.sample && m.sample.count) || 0;
      box.appendChild(fxEmpty("inbox_clear", "Nothing needs you.", fxNum(m.auto_landed || 0) + " changes auto-landed today under policy risk ≤ " + ((m.policy && m.policy.auto_land_max_risk) || 30) + ". " + sm + (sm === 1 ? " is" : " are") + " in the audit sample.", null, true));
      if (FX.inboxFilter === "needs_you") visible = [];
    }
    if (!visible.length && FX.inboxFilter !== "all" && FX.inboxFilter !== "needs_you") box.appendChild(fxEmpty("inbox_filter_empty", "Nothing in this filter.", "Switch filters with 1, 2 and 3.", null));
    var groups = fxGroupInbox(visible);
    groups.forEach(function (g) {
      var sec = h("section", { cls: "fx-panel fx-story", "data-kind": g.kind, "data-id": g.id || "", "aria-label": g.label });
      var landed = g.items.filter(function (i) { return i.state === "landed"; }).length;
      var nNeeds = g.items.filter(function (i) { return i.bucket === "needs_you"; }).length;
      var nSample = g.items.filter(function (i) { return i.bucket === "sample"; }).length;
      sec.appendChild(h("div", { cls: "fx-story-head" }, [
        g.id ? fxLink(g.id) : null,
        h("span", { cls: "t", text: g.label }),
        h("span", { cls: "m", text: g.items.length + " intents · " + landed + " landed" + (nSample ? " · " + nSample + " sample" : "") + (nNeeds ? " · " + nNeeds + " needs you" : "") })
      ]));
      var ul = h("ul", { cls: "fx-rows", role: "list" });
      var autos = [];
      g.items.forEach(function (it) { if (it.bucket === "auto") autos.push(it); else ul.appendChild(fxInboxRow(it)); });
      if (ul.firstChild) sec.appendChild(ul);
      if (autos.length) {
        var det = h("details", { cls: "fx-autoline", "data-kind": "auto-landed", "data-count": autos.length });
        det.appendChild(h("summary", { text: autos.length + " auto-landed (risk ≤ " + ((m.policy && m.policy.auto_land_max_risk) || 30) + ")" }));
        var aul = h("ul", { cls: "fx-rows", role: "list" });
        autos.forEach(function (it) { aul.appendChild(fxInboxRow(it)); });
        det.appendChild(aul);
        if (FX.inboxFilter === "auto") det.open = true;
        sec.appendChild(det);
      }
      box.appendChild(sec);
    });
    if (!FX.inboxFocus || !fxFindItem(FX.inboxFocus)) { var first = visible.filter(function (i) { return i.bucket !== "auto"; })[0] || visible[0]; FX.inboxFocus = first ? first.id : ""; }
    fxMarkFocus();
    fxRenderInboxDetail();
    fxRenderBulk();
    var foot = fxClear(document.getElementById("fxInboxFoot"));
    foot.appendChild(h("strong", { text: "How is risk computed? " }));
    foot.appendChild(document.createTextNode("Six deterministic terms, never a bare model score: +40 protected path, up to +15 footprint size, +15 drift, +15 LLM replay, +10 weak CI evidence, +15 reviewer disagrees. Weights and the auto-land line live in "));
    foot.appendChild(h("code", { text: ".flare/policy.yml" }));
    foot.appendChild(document.createTextNode(". Keys: j/k move · ⏎ open or approve · a approve · x send back · e evidence · w why · s select · 1/2/3 filters."));
  }
  function fxGroupInbox(items) {
    var out = [], idx = {};
    items.forEach(function (it) {
      var key, label, kind = "story";
      if (FX.groupBy === "risk") { var b = fxBand(it.risk); key = b; label = { high: "High risk (61-100)", med: "Medium risk (31-60)", low: "Low risk (0-30)" }[b]; kind = "risk-band"; }
      else if (FX.groupBy === "agent") { var a = fxAgent(it.agent); key = a.id; label = a.label + " · " + a.id + (a.client ? " (" + a.client + ")" : ""); kind = "agent"; }
      else { key = it.goal ? it.goal.id : "none"; label = it.goal ? it.goal.text : "No goal"; }
      if (!idx[key]) { idx[key] = { id: kind === "story" && it.goal ? it.goal.id : kind === "agent" ? key : "", label: label, kind: kind, items: [] }; out.push(idx[key]); }
      idx[key].items.push(it);
    });
    if (FX.groupBy === "risk") { var order = { high: 0, med: 1, low: 2 }; out.sort(function (a, b) { return order[fxBand(a.items[0].risk)] - order[fxBand(b.items[0].risk)]; }); }
    return out;
  }
  function fxFindItem(id) { var r = null; ((FX.inbox && FX.inbox.items) || []).forEach(function (i) { if (i.id === id) r = i; }); return r; }
  function fxInboxRow(it) {
    var tone = it.bucket === "needs_you" ? "human" : it.bucket === "sample" ? "overlap" : fxTone(it.state);
    var li = h("li", { cls: "fx-row" + (FX.inboxFocus === it.id ? " focus" : "") + (it.pending ? " done" : ""), role: "listitem", tabindex: "-1", "data-kind": "intent", "data-id": it.id, "data-state": it.state, "data-risk": it.risk, "data-bucket": it.bucket, "aria-labelledby": "fxrow-" + it.id });
    var cb = h("input", { type: "checkbox", cls: "sel", "aria-label": "Select " + it.id, "data-action": "select_item", "data-target": it.id });
    cb.checked = !!FX.selected[it.id];
    cb.addEventListener("click", function (ev) { ev.stopPropagation(); fxToggleSelect(it.id); });
    li.appendChild(cb);
    li.appendChild(fxRisk(it.risk));
    li.appendChild(h("div", { cls: "l1" }, [
      h("span", { cls: "st-" + tone, "aria-hidden": "true", text: FX_GLYPH[tone] }),
      fxLink(it.id),
      h("span", { cls: "title", id: "fxrow-" + it.id, text: it.title }),
      it.bucket === "needs_you" ? h("span", { cls: "reason", text: it.reason === "plan" ? "plan approval" : "escalation" }) : it.bucket === "sample" ? h("span", { cls: "reason st-overlap", text: "sample" }) : null
    ]));
    li.appendChild(fxMono(it.agent, it.state));
    var l2 = h("div", { cls: "l2" });
    (it.terms || []).forEach(function (t) { l2.appendChild(fxTermChip(t)); });
    if (it.bucket !== "needs_you" || it.reason !== "plan" || FX.expandEvidence[it.id]) l2.appendChild(fxEvidence(it.evidence));
    li.appendChild(l2);
    if (it.bucket !== "auto" && !it.pending) li.appendChild(fxRowActions(it));
    if (FX.sendBack === it.id) li.appendChild(fxSendBackForm(it));
    li.addEventListener("click", function () { FX.inboxFocus = it.id; fxMarkFocus(); fxRenderInboxDetail(); });
    li.addEventListener("dblclick", function () { fxNav("#/intents/" + it.id); });
    return li;
  }
  function fxRowActions(it) {
    var acts = h("div", { cls: "acts" });
    function btn(label, key, action, ghost, fn, extra) {
      var b = h("button", { type: "button", cls: ghost ? "ghost" : "", "data-action": action, "data-target": it.id, "aria-keyshortcuts": key }, [label, key ? h("kbd", { text: key === "Enter" ? "⏎" : key }) : null]);
      b.addEventListener("click", function (ev) { ev.stopPropagation(); fn(); });
      if (extra) for (var k in extra) b.setAttribute(k, extra[k]);
      return b;
    }
    if (it.bucket === "needs_you" && it.reason === "plan") {
      acts.appendChild(btn("Approve plan", "a", "approve_plan", false, function () { fxApprove(it); }));
      acts.appendChild(btn("Send back", "x", "send_back", true, function () { fxOpenSendBack(it); }));
    } else if (it.bucket === "sample") {
      acts.appendChild(btn("Looks good", "a", "review_sample", false, function () { fxReviewSample(it); }, { "data-decision": "agree" }));
      acts.appendChild(btn("Send back", "x", "send_back", true, function () { fxOpenSendBack(it); }));
    } else {
      acts.appendChild(btn("Send back", "x", "send_back", true, function () { fxOpenSendBack(it); }));
      acts.appendChild(h("a", { href: "#/intents/" + it.id, cls: "fx-json", text: "Open intent ↗" }));
    }
    return acts;
  }
  function fxSendBackForm(it) {
    var input = h("input", { type: "text", maxlength: "500", placeholder: "One-line reason for " + it.id + " (required)", "aria-label": "Reason for sending back " + it.id });
    var go = h("button", { type: "button", "data-action": "send_back", "data-target": it.id, text: "Send back" });
    function submit() {
      var reason = input.value.trim();
      if (!reason) { input.focus(); toast("A one-line reason is required", true); return; }
      FX.sendBack = "";
      fxCommitWithUndo("Sent back · " + it.id, it, function () { return fxCall("send_back", it.id, { reason: reason }); });
    }
    go.addEventListener("click", function (ev) { ev.stopPropagation(); submit(); });
    input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); submit(); } else if (ev.key === "Escape") { ev.preventDefault(); FX.sendBack = ""; fxRenderInbox(); } });
    input.addEventListener("click", function (ev) { ev.stopPropagation(); });
    setTimeout(function () { input.focus(); }, 0);
    return h("div", { cls: "sendback" }, [input, go]);
  }
  function fxOpenSendBack(it) { FX.sendBack = it.id; FX.inboxFocus = it.id; fxRenderInbox(); }
  function fxApprove(it) {
    if (it.bucket === "sample") { fxReviewSample(it); return; }
    if (it.reason !== "plan") { toast(it.id + " has no plan to approve"); return; }
    fxCommitWithUndo("Plan approved · " + it.id, it, function () { return fxCall("approve_plan", it.id, {}); });
  }
  function fxReviewSample(it) {
    fxCommitWithUndo("Looks good · " + it.id, it, function () { return fxCall("review_sample", it.id, { decision: "agree" }); });
  }
  function fxMarkFocus() {
    var rows = document.querySelectorAll("#fxStories .fx-row");
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].getAttribute("data-id") === FX.inboxFocus;
      rows[i].classList.toggle("focus", on);
      if (on && document.activeElement && document.activeElement.closest && !document.activeElement.closest("input,button")) rows[i].focus({ preventScroll: false });
    }
  }
  function fxVisibleRowIds() {
    var rows = document.querySelectorAll("#fxStories .fx-row");
    var ids = [];
    for (var i = 0; i < rows.length; i++) { if (rows[i].offsetParent !== null) ids.push(rows[i].getAttribute("data-id")); }
    return ids;
  }
  function fxMoveFocus(d) {
    var ids = fxVisibleRowIds();
    if (!ids.length) return;
    var i = ids.indexOf(FX.inboxFocus);
    i = i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + d));
    FX.inboxFocus = ids[i];
    fxMarkFocus();
    fxRenderInboxDetail();
  }
  function fxRenderInboxDetail() {
    var box = fxClear(document.getElementById("fxInboxDetail"));
    var it = fxFindItem(FX.inboxFocus);
    if (!it) { box.appendChild(h("p", { cls: "muted", text: "Select a row to see why it is here." })); return; }
    box.setAttribute("data-kind", "intent"); box.setAttribute("data-id", it.id);
    box.appendChild(h("div", { cls: "fx-head", style: "padding:0" }, [
      h("div", { cls: "meta", style: "margin-bottom:6px" }, [h("span", { cls: "fx-sec-h", style: "margin:0", text: "Detail" }), fxLink(it.id)]),
      h("h3", { text: it.title }),
      h("div", { cls: "meta" }, [fxPill(it.state), fxRisk(it.risk), fxMono(it.agent, it.state), h("span", { cls: "mono muted", text: fxAgent(it.agent).label })])
    ]));
    var why = h("section", { cls: "fx-sec" }, [h("h4", { cls: "fx-sec-h", text: it.bucket === "needs_you" ? "Why this needs you" : it.bucket === "sample" ? "Why you're seeing this" : "Why it landed on its own" }),
      h("p", { style: "margin:0;font-size:13px", text: it.why || (it.bucket === "auto" ? "Risk " + it.risk + " is under the auto-land line." : "") })]);
    box.appendChild(why);
    var terms = h("div", { cls: "fx-terms-col" });
    (it.terms || []).forEach(function (t) { terms.appendChild(fxTermChip(t)); });
    if (!(it.terms || []).length) terms.appendChild(h("span", { cls: "muted", text: "no terms fired" }));
    box.appendChild(h("section", { cls: "fx-sec" }, [h("h4", { cls: "fx-sec-h", text: "Risk " + it.risk + " = sum of terms" }), terms]));
    if ((it.plan || []).length) {
      var ol = h("ol");
      it.plan.forEach(function (p) { ol.appendChild(h("li", { text: p })); });
      box.appendChild(h("section", { cls: "fx-sec" }, [h("h4", { cls: "fx-sec-h", text: "Plan (from session)" }), ol]));
    }
    if ((it.footprint || []).length) {
      var ul = h("ul", { cls: "mono", style: "list-style:none;padding:0" });
      it.footprint.forEach(function (p) { ul.appendChild(h("li", { text: p })); });
      box.appendChild(h("section", { cls: "fx-sec" }, [h("h4", { cls: "fx-sec-h", text: "Footprint · declared " + it.footprint.length }), ul]));
    }
    box.appendChild(h("section", { cls: "fx-sec" }, [h("h4", { cls: "fx-sec-h", text: "Evidence" }), fxEvidence(it.evidence)]));
    var acts = it.bucket === "auto" || it.pending ? h("div", { cls: "fx-actions" }) : fxRowActions(it);
    acts.className = "fx-actions";
    acts.appendChild(h("a", { href: "#/intents/" + it.id, cls: "fx-json", text: "Open intent ↗" }));
    box.appendChild(acts);
  }
  function fxToggleSelect(id) {
    if (FX.selected[id]) delete FX.selected[id]; else FX.selected[id] = true;
    var cb = document.querySelector("#fxStories .fx-row[data-id=\"" + id + "\"] input.sel");
    if (cb) cb.checked = !!FX.selected[id];
    fxRenderBulk();
  }
  function fxRenderBulk() {
    var bar = fxClear(document.getElementById("fxBulk"));
    var ids = Object.keys(FX.selected).filter(function (id) { return !!fxFindItem(id); });
    bar.hidden = !ids.length;
    if (!ids.length) return;
    bar.appendChild(h("span", { cls: "num", text: ids.length + " selected" }));
    var appr = h("button", { type: "button", "data-action": "approve_plan", "data-target": ids.join(","), text: "Approve all" });
    appr.addEventListener("click", function () {
      ids.forEach(function (id) { var it = fxFindItem(id); if (it && it.bucket === "needs_you" && it.reason === "plan") fxCall("approve_plan", id, {}); else if (it && it.bucket === "sample") fxCall("review_sample", id, { decision: "agree" }); });
      FX.selected = {}; toast("Approved " + ids.length + " (plans approved, samples marked good)");
    });
    var back = h("button", { type: "button", cls: "ghost", "data-action": "send_back", "data-target": ids.join(","), text: "Send back" });
    back.addEventListener("click", function () { FX.sendBack = ids[0]; FX.inboxFocus = ids[0]; FX.selected = {}; fxRenderInbox(); });
    var clr = h("button", { type: "button", cls: "ghost", "aria-label": "Clear selection", text: "✕" });
    clr.addEventListener("click", function () { FX.selected = {}; fxRenderInbox(); });
    bar.appendChild(appr); bar.appendChild(back); bar.appendChild(clr);
  }
  // 5s undo window before the call goes out (Plan approved · Undo z).
  function fxCommitWithUndo(label, it, commit) {
    if (FX.undo) fxFlushUndo();
    it.pending = true;
    fxRenderInbox();
    var box = document.getElementById("toasts");
    var t = h("div", { cls: "toast", role: "status" }, [label + " · ", h("span", { cls: "muted", text: "sending in 5s" })]);
    var u = h("button", { type: "button", cls: "ghost fx-undo", "aria-keyshortcuts": "z" }, ["Undo ", h("kbd", { text: "z" })]);
    t.appendChild(u);
    box.appendChild(t);
    var entry = { it: it, commit: commit, node: t, timer: null };
    entry.timer = setTimeout(function () { fxFlushUndo(); }, 5000);
    u.addEventListener("click", function () { fxCancelUndo(); });
    FX.undo = entry;
  }
  function fxFlushUndo() {
    var e = FX.undo; if (!e) return;
    FX.undo = null;
    clearTimeout(e.timer);
    if (e.node.parentNode) e.node.parentNode.removeChild(e.node);
    e.commit().then(function () { fxLoadInbox(true); }, function () { e.it.pending = false; fxRenderInbox(); });
  }
  function fxCancelUndo() {
    var e = FX.undo; if (!e) return;
    FX.undo = null;
    clearTimeout(e.timer);
    if (e.node.parentNode) e.node.parentNode.removeChild(e.node);
    e.it.pending = false;
    fxRenderInbox();
    toast("Undone · nothing was sent");
  }

  // ---------- actions (data-action = MCP tool name) ----------
  function fxCall(tool, target, args) {
    args = args || {};
    if (FX.demo || FX.fallback.inbox || FX.fallback.intent || FX.fallback.conflicts) {
      fxDemoMutate(tool, target, args);
      toast("Demo · " + tool + (target ? " " + target : "") + " applied locally (no server call)");
      return Promise.resolve({ demo: true });
    }
    var spec = FX_REST[tool];
    if (!spec) return Promise.reject(new Error("unknown action " + tool));
    var path = spec.p.replace(":id", encodeURIComponent(target || ""));
    var body = {};
    for (var k in args) if (Object.prototype.hasOwnProperty.call(args, k)) body[k] = args[k];
    if (!body.repo) body.repo = FX.repo;
    return fxFetch(path, { method: spec.m, body: body }).then(function (r) { toast(tool + (target ? " · " + target : "") + " done"); return r; }, function (err) {
      toast(tool + " failed: " + err.message + (err.hint ? " · " + err.hint : "") + " [" + err.code + "]", true);
      throw err;
    });
  }
  function fxDemoMutate(tool, target, args) {
    var f = fxFixtures();
    var i = fxIntentById(target);
    if (tool === "approve_plan" && i) { i.state = "draft"; i.route = null; i.escalation = null; f.inbox.metrics.human_seconds_today += 15; }
    else if (tool === "review_sample" && i) { i.route = "auto"; f.inbox.metrics.human_seconds_today += 20; f.inbox.metrics.disagreement.n += 1; }
    else if (tool === "send_back" && i) { i.route = null; i.escalation = null; i.state = i.state === "landed" ? "landed" : "working"; f.inbox.metrics.human_seconds_today += 30; if (args.reason) { f.mailbox[i.id] = (f.mailbox[i.id] || []).concat([{ from_intent: "human", from_agent: "you", body: args.reason, at: new Date().toISOString() }]); } }
    else if (tool === "mark_ready" && i) { i.state = "ready"; }
    else if (tool === "send_note" && i) { f.mailbox[i.id] = (f.mailbox[i.id] || []).concat([{ from_intent: "human", from_agent: "you", body: args.text || "", at: new Date().toISOString() }]); }
    else if (tool === "claim_conflict") { (f.conflicts || []).forEach(function (c) { if (c.id === target && c.state === "open") c.state = "claimed"; }); }
    else if (tool === "declare_intent") {
      var gid = "g-" + ((f.goals || []).length + 1);
      f.goals.push({ id: gid, text: args.goal || "New goal" });
      (args.intents || []).forEach(function (p, n) {
        var hits = fxProtectedHits(p.footprint);
        var risk = fxPreviewRisk(p.footprint);
        f.intents.push({ id: "i-" + (fxHash(gid + n + p.title) % 65536).toString(16), goal_id: gid, title: p.title, agent: "", state: hits.length ? "awaiting_plan" : "draft", risk: risk.risk, risk_terms: risk.terms, path: p.footprint[0] || "", footprint: { declared: p.footprint, actual: [], drift: [] }, reasoning: "", accept: "", rejected: [], plan: [], train_id: null, landed_sha: null, lease_expires_in_s: null, route: hits.length ? "human" : null, escalation: hits.length ? "plan" : null, evidence: null, created_at: new Date().toISOString() });
      });
      FX.lastGoal = gid;
    }
  }

  // ---------- Intents ----------
  function fxLoadIntents() {
    var box = document.getElementById("fxIntents");
    fxSkeleton(box, 5);
    var repo = FX.repo;
    var goal = FX.route.q.get("goal") || "";
    fxLoad("/v1/forge/intents?repo=" + encodeURIComponent(repo) + (goal ? "&goal=" + encodeURIComponent(goal) : ""), fxFxIntents, "intents").then(function (d) {
      fxRenderNotice("intents");
      var intents = fxArr(d, "intents").map(fxNormIntent);
      var goals = (d && d.goals) || [];
      fxClear(box);
      box.appendChild(h("div", { cls: "fx-actions", style: "margin:0 0 12px" }, [
        h("button", { type: "button", "data-action": "plan_goal", "aria-keyshortcuts": "c", on: { click: fxOpenComposer } }, ["New goal ", h("kbd", { text: "c" })]),
        goal ? h("a", { href: "#/intents", cls: "fx-json", text: "All goals" }) : null
      ]));
      if (!intents.length) { box.appendChild(fxEmpty("no_goals", "No goals yet.", "Write one and the planner proposes intents with footprints. You edit them before launch.", null)); return; }
      var byGoal = {}, order = [];
      intents.forEach(function (i) { var g = i.goal_id || "none"; if (goal && g !== goal) return; if (!byGoal[g]) { byGoal[g] = []; order.push(g); } byGoal[g].push(i); });
      goals.forEach(function (g) { if (!byGoal[g.id] && (!goal || g.id === goal)) { byGoal[g.id] = []; order.push(g.id); } });
      order.sort();
      order.forEach(function (gid) {
        var g = null; goals.forEach(function (x) { if (x.id === gid) g = x; });
        var list = byGoal[gid];
        var rank = { awaiting_plan: 0, conflicted: 1, replaying: 1, bisected: 1, working: 2, claimed: 2, ready: 3, in_train: 4, draft: 5, landed: 6 };
        list.sort(function (a, b) { return ((rank[a.state] === undefined ? 9 : rank[a.state]) - (rank[b.state] === undefined ? 9 : rank[b.state])) || (b.risk - a.risk) || (a.id < b.id ? -1 : 1); });
        var landed = list.filter(function (i) { return i.state === "landed"; }).length;
        var ul = h("ul", { cls: "fx-list", role: "list" });
        list.forEach(function (i) {
          var li = h("li", { cls: "fx-li", role: "listitem", tabindex: "0", "data-kind": "intent", "data-id": i.id, "data-state": i.state, "data-risk": i.risk }, [
            fxRisk(i.risk), fxPill(i.state), fxIdChip(i.id), h("span", { cls: "title", text: i.title }), i.agent ? fxMono(i.agent, i.state) : null,
            h("span", { cls: "r", text: (i.footprint.declared[0] || "") + (i.footprint.declared.length > 1 ? " +" + (i.footprint.declared.length - 1) : "") })
          ]);
          li.addEventListener("click", function () { fxNav("#/intents/" + i.id); });
          li.addEventListener("keydown", function (ev) { if (ev.key === "Enter") fxNav("#/intents/" + i.id); });
          ul.appendChild(li);
        });
        var head = [h("span", { text: (g ? g.id + " · " : "") + list.length + " intents · " + landed + " landed" })];
        var sec = fxPanel("Goal", [h("p", { cls: "fx-pad", style: "margin:0;padding-bottom:4px;font-size:14px;font-weight:500", text: g ? g.text : "Intents without a goal" }), ul], head);
        sec.setAttribute("data-kind", "goal"); sec.setAttribute("data-id", gid);
        sec.style.marginBottom = "12px";
        box.appendChild(sec);
      });
    }, function (err) { fxClear(box).appendChild(fxErrorCard(err, fxLoadIntents)); });
  }
  var FX_STEPS = ["draft", "claimed", "working", "ready", "in_train", "landed"];
  function fxStepper(state) {
    var pos = FX_STEPS.indexOf(state);
    var label = null, branch = null;
    if (pos < 0) {
      var m = { awaiting_plan: [0, "awaiting plan", null], expired: [1, "expired", "lease expired → open for re-claim"], conflicted: [4, null, "conflicted → replaying"], replaying: [4, null, "conflicted → replaying"], bisected: [4, null, "bisected → ready | failed"], failed: [4, null, "failed"], abandoned: [0, "abandoned", null] }[state] || [0, null, null];
      pos = m[0]; label = m[1]; branch = m[2];
    }
    var tone = fxTone(state);
    var wrap = h("div", { cls: "fx-stepper", role: "list", "aria-label": "Lifecycle: " + fxWord(state) });
    FX_STEPS.forEach(function (s, i) {
      if (i) wrap.appendChild(h("span", { cls: "fx-step-line" + (i <= pos ? " past" : ""), "aria-hidden": "true" }));
      var st = h("span", { cls: "fx-step" + (i < pos ? " past" : i === pos ? " cur" : ""), role: "listitem", "aria-current": i === pos ? "step" : null, text: i === pos && label ? label : fxWord(s) });
      if (i === pos) { st.style.setProperty("--step-c", "var(--st-" + tone + ")"); st.style.setProperty("--step-t", "var(--tint-" + tone + ")"); }
      wrap.appendChild(st);
    });
    if (branch) wrap.appendChild(h("span", { cls: "fx-branch st-" + tone, text: "↳ " + branch }));
    return wrap;
  }
  function fxLoadIntent(id) {
    var box = document.getElementById("fxIntents");
    fxSkeleton(box, 5);
    fxLoad("/v1/forge/intents/" + encodeURIComponent(id), function () { return fxFxIntent(id); }, "intent").then(function (d) {
      fxRenderNotice("intent");
      fxClear(box);
      if (!d) { box.appendChild(fxEmpty("intent_not_found", "No intent " + id + ".", "IDs look like i-7f3a. Jump to one from ⌘K by typing its prefix.", null)); return; }
      fxRenderIntent(box, fxNormIntent(d.intent || d));
      fxSyncChrome();
    }, function (err) { fxClear(box).appendChild(fxErrorCard(err, function () { fxLoadIntent(id); })); });
  }
  function fxRenderIntent(box, i) {
    FX.current = { kind: "intent", id: i.id, state: i.state };
    var a = fxAgent(i.agent);
    var lease = i.lease_expires_at ? Math.max(0, Math.round((Date.parse(i.lease_expires_at) - Date.now()) / 1000)) : null;
    var head = h("div", { cls: "fx-head", "data-kind": "intent", "data-id": i.id, "data-state": i.state, "data-risk": i.risk }, [
      h("h1", { text: i.title }),
      h("div", { cls: "meta" }, [fxPill(i.state), fxRisk(i.risk), i.agent ? fxMono(i.agent, i.state) : null, i.agent ? h("span", { cls: "mono muted", text: a.label + " " + a.id + (a.client ? " (" + a.client + ")" : "") }) : null, fxIdChip(i.id),
        lease !== null ? h("span", { cls: "fx-lease", title: "Lease time left; renewed by heartbeat" }, [h("span", { cls: "fx-ring", style: "--p:" + Math.round(lease / 3) }), "lease " + lease + "s"]) : null,
        h("span", { cls: "fx-idchip", title: "Artifacts fork for this intent", text: "fork i-" + String(i.id).slice(2) })]),
      fxStepper(i.state)
    ]);
    box.appendChild(head);
    var left = h("div", {});
    var right = h("aside", { cls: "fx-panel fx-pad", "aria-label": "Properties", style: "position:sticky;top:60px" });
    box.appendChild(h("div", { cls: "fx-detail-grid" }, [left, right]));
    // why block
    var kv = h("dl", { cls: "fx-kv" });
    function row(k, v) { kv.appendChild(h("dt", { text: k })); kv.appendChild(h("dd", {}, [v])); }
    if (i.goal) row("Goal", h("span", {}, [fxLink(i.goal.id), " " + i.goal.text]));
    row("Reasoning", h("span", { text: i.reasoning || "—" }));
    if ((i.rejected || []).length) { var rj = h("ul", { style: "margin:0;padding-left:16px" }); i.rejected.forEach(function (r) { rj.appendChild(h("li", { text: r })); }); row("Rejected", rj); }
    row("Accept", h("code", { cls: "mono", text: i.accept || "—" }));
    left.appendChild(fxPanel("Why", [h("div", { cls: "fx-pad" }, [kv])]));
    // footprint diff
    var fp = i.footprint;
    var declared = fp.declared || [], actual = fp.actual || [], drift = fp.drift || [];
    var tbl = h("table", { cls: "fx-fp", "aria-label": "Footprint: declared versus actual" });
    var tb = h("tbody");
    declared.forEach(function (p) {
      var touched = actual.some(function (x) { return fxPathsOverlap(p, x); });
      tb.appendChild(h("tr", { cls: touched ? "eq" : "miss", "data-kind": "path", "data-id": p, "data-state": touched ? "touched" : "untouched" }, [h("td", { cls: "mk", "aria-label": touched ? "declared and touched" : "declared, not touched", text: touched ? "=" : "−" }), h("td", { text: p }), h("td", { cls: "st", text: touched ? "✓" : "not touched" })]));
    });
    drift.forEach(function (p) {
      tb.appendChild(h("tr", { cls: "drift", "data-kind": "path", "data-id": p, "data-state": "drift" }, [h("td", { cls: "mk", "aria-label": "undeclared drift", text: "+" }), h("td", { text: p }), h("td", { cls: "st", text: "◐ drift (undeclared)" })]));
    });
    tbl.appendChild(tb);
    left.appendChild(fxPanel("Footprint", [h("div", { cls: "fx-pad", style: "padding-top:6px" }, [tbl])], [h("span", { cls: "fx-path", text: "declared " + declared.length + " · actual " + actual.length + (drift.length ? " · drift " + drift.length : "") })]));
    left.lastChild.style.marginTop = "12px";
    left.appendChild(fxPanel("Evidence", [h("div", { cls: "fx-pad" }, [fxEvidence(i.evidence)])]));
    left.lastChild.style.marginTop = "12px";
    // session
    var steps = (i.session && i.session.steps) || [];
    if (steps.length) {
      var maxT = 1; steps.forEach(function (s) { if (s.t > maxT) maxT = s.t; });
      var ticks = h("div", { cls: "fx-ticks", "aria-hidden": "true" });
      steps.forEach(function (s) { ticks.appendChild(h("span", { cls: s.kind, style: "left:" + (s.t / maxT * 98).toFixed(1) + "%", title: fxClock(s.t) + " " + s.kind })); });
      var log = h("ol", { cls: "fx-steplog", "aria-label": "Session step log" });
      steps.forEach(function (s) { log.appendChild(h("li", { "data-kind": "step", "data-state": s.kind }, [h("span", { cls: "t", text: fxClock(s.t) }), h("span", { cls: "k " + s.kind, text: s.kind }), h("span", { text: s.text })])); });
      left.appendChild(fxPanel("Session", [h("div", { cls: "fx-pad" }, [ticks, log])], [h("span", { cls: "fx-path", text: ((i.session && i.session.repo) || "flare/session") + " · 0:00 → " + fxClock(maxT) })]));
      left.lastChild.style.marginTop = "12px";
    }
    // mailbox
    var mb = h("div", { cls: "fx-pad" });
    (i.mailbox || []).forEach(function (m) {
      mb.appendChild(h("div", { cls: "fx-note", "data-kind": "note", "data-untrusted": "true" }, [h("div", { cls: "fx-note-h", text: "Peer note · from " + (m.from_intent || "?") + " (" + fxAgent(m.from_agent).label + ") · untrusted data" }), h("div", { cls: "fx-note-b", text: m.body })]));
    });
    if (!(i.mailbox || []).length) mb.appendChild(h("p", { cls: "muted", style: "margin:0 0 8px;font-size:13px", text: "No peer notes. Notes are delivered on the recipient's next tool call and shown to agents as untrusted data." }));
    var noteIn = h("input", { type: "text", maxlength: "2000", placeholder: "Note to " + i.id + " (delivered on its next tool call)", "aria-label": "Note text", style: "flex:1" });
    var noteBtn = h("button", { type: "button", cls: "ghost", "data-action": "send_note", "data-target": i.id, "aria-keyshortcuts": "n" }, ["Send note ", h("kbd", { text: "n" })]);
    noteBtn.addEventListener("click", function () { var t = noteIn.value.trim(); if (!t) { noteIn.focus(); return; } fxCall("send_note", i.id, { text: t }).then(function () { noteIn.value = ""; if (FX.demo) fxLoadIntent(i.id); }); });
    noteIn.addEventListener("keydown", function (ev) { if (ev.key === "Enter") noteBtn.click(); });
    noteIn.id = "fxNoteInput";
    mb.appendChild(h("div", { style: "display:flex;gap:8px;margin-top:8px" }, [noteIn, noteBtn]));
    left.appendChild(fxPanel("Mailbox", [mb]));
    left.lastChild.style.marginTop = "12px";
    // properties rail
    var pk = h("dl", { cls: "fx-kv" });
    function prop(k, v) { pk.appendChild(h("dt", { text: k })); pk.appendChild(h("dd", {}, [v])); }
    prop("State", fxPill(i.state));
    prop("Agent", i.agent ? h("span", { cls: "mono", text: a.label + " (" + (a.client || "agent") + ")" }) : h("span", { cls: "muted", text: "unclaimed" }));
    prop("Created", fxTime(i.created_at));
    prop("Session", h("span", { cls: "mono", text: ((i.session && i.session.repo) || "flare/session") + " @ " + i.id }));
    var ov = h("span", {});
    (i.overlaps || []).forEach(function (o) { ov.appendChild(fxLink(o.intent)); ov.appendChild(h("span", { cls: o.state === "conflict" ? "st-conflict" : "st-overlap", text: o.state === "conflict" ? " ✕ " : " ◐ " })); });
    prop("Overlaps", (i.overlaps || []).length ? ov : h("span", { cls: "muted", text: "none" }));
    prop("Train", i.train_id ? fxLink(i.train_id) : h("span", { cls: "muted", text: "—" }));
    var rk = h("div", { cls: "fx-terms-col" }, [fxRisk(i.risk)]);
    (i.risk_terms || []).forEach(function (t) { rk.appendChild(fxTermChip(t)); });
    prop("Risk", rk);
    right.appendChild(pk);
    var acts = h("div", { cls: "fx-actions" });
    if (i.state === "awaiting_plan") acts.appendChild(h("button", { type: "button", "data-action": "approve_plan", "data-target": i.id, "aria-keyshortcuts": "a", on: { click: function () { fxCall("approve_plan", i.id, {}).then(function () { fxLoadIntent(i.id); }); } } }, ["Approve plan ", h("kbd", { text: "a" })]));
    if (i.state === "working") acts.appendChild(h("button", { type: "button", "data-action": "mark_ready", "data-target": i.id, "aria-keyshortcuts": "m", on: { click: function () { fxCall("mark_ready", i.id, {}).then(function () { fxLoadIntent(i.id); }); } } }, ["Mark ready ", h("kbd", { text: "m" })]));
    acts.appendChild(h("button", { type: "button", cls: "ghost", "data-action": "fork_session", "data-target": i.id, "aria-keyshortcuts": "f", on: { click: function () { fxFork(i.id, right); } } }, ["Fork session ", h("kbd", { text: "f" })]));
    acts.appendChild(h("button", { type: "button", cls: "ghost", "data-action": "send_note", "data-target": i.id, on: { click: function () { var n = document.getElementById("fxNoteInput"); if (n) n.focus(); } } }, ["Send note"]));
    var whyPath = (i.footprint.actual && i.footprint.actual[0]) || i.footprint.declared[0];
    if (whyPath) acts.appendChild(h("button", { type: "button", cls: "ghost", "data-action": "why", "data-target": whyPath, "aria-keyshortcuts": "w", on: { click: function () { fxOpenWhy(FX.repo, whyPath, fxFirstLine(whyPath, i.id)); } } }, ["Why ", h("kbd", { text: "w" })]));
    right.appendChild(acts);
  }
  function fxFirstLine(path, intentId) {
    var w = fxFixtures().why || {};
    if (w.path === path && w.blame) { var keys = Object.keys(w.blame); for (var k = 0; k < keys.length; k++) if (w.blame[keys[k]] === intentId) return Number(keys[k]); }
    return 1;
  }
  function fxFork(id, mount) {
    fxCall("fork_session", id, {}).then(function (r) {
      var fork = (r && (r.fork || r.fork_repo)) || ("i-" + String(id).slice(2) + "-f" + (1 + (fxHash(id + Date.now()) % 9)));
      var remote = (r && r.fork_remote) || (location.origin + "/git/" + fork + ".git");
      var cmd = (r && r.command) || ("claude --mcp-config flare-forge.json \"continue intent " + id + " from fork " + fork + "\"");
      var old = document.getElementById("fxForkResult"); if (old && old.parentNode) old.parentNode.removeChild(old);
      var res = h("div", { id: "fxForkResult", cls: "fx-sec", role: "status", "data-kind": "fork", "data-id": fork }, [h("h4", { cls: "fx-sec-h", text: "Forked session" }), h("p", { cls: "mono", style: "margin:0 0 6px;font-size:12px", text: fork + " · " + remote }), fxCmd(cmd)]);
      if (mount) mount.appendChild(res);
    }, function () {});
  }

  // ---------- Trains ----------
  function fxLoadTrains() {
    var box = document.getElementById("fxTrains");
    fxSkeleton(box, 4);
    fxLoad("/v1/forge/trains?repo=" + encodeURIComponent(FX.repo), fxFxTrains, "trains").then(function (d) {
      fxRenderNotice("trains");
      var list = fxArr(d, "trains");
      fxClear(box);
      if (!list.length) { box.appendChild(fxEmpty("no_trains", "No trains yet.", "The first ready intent starts one.", "flare intents ready <id>")); return; }
      var ul = h("ul", { cls: "fx-list", role: "list" });
      list.forEach(function (t) {
        var n = 0; (t.lanes || []).forEach(function (l) { n += (l.intents || []).length; });
        var res = t.result || {};
        var tone = fxTone(t.state);
        var li = h("li", { cls: "fx-li", role: "listitem", tabindex: "0", "data-kind": "train", "data-id": t.id, "data-state": t.state }, [
          h("span", { cls: "st-" + tone, "aria-hidden": "true", text: t.state === "bisected" ? "✕→✓" : FX_GLYPH[tone] }), fxIdChip(t.id), fxPill(t.state),
          h("span", { cls: "title", text: n + " intents · " + (t.lanes || []).length + " lanes" + (res.landed !== undefined ? " · " + res.landed + " landed" : "") + (res.requeued ? " · " + res.requeued + " requeued" : "") }),
          res.sha ? fxSha(res.sha) : null,
          h("span", { cls: "r", text: fxClock(t.duration_s) }), fxTime(t.started_at)
        ]);
        li.addEventListener("click", function () { fxNav("#/trains/" + t.id); });
        li.addEventListener("keydown", function (ev) { if (ev.key === "Enter") fxNav("#/trains/" + t.id); });
        ul.appendChild(li);
      });
      box.appendChild(fxPanel("Trains", [ul], [h("span", { cls: "fx-path", text: "merge → push → CI on the exact combined SHA → CAS main" })]));
    }, function (err) { fxClear(box).appendChild(fxErrorCard(err, fxLoadTrains)); });
  }
  function fxLoadTrain(id, quiet) {
    var box = document.getElementById("fxTrains");
    if (!quiet) fxSkeleton(box, 4);
    fxLoad("/v1/forge/trains/" + encodeURIComponent(id), function () { return fxFxTrain(id); }, "trains").then(function (t) {
      if (FX.route.screen !== "trains" || FX.route.id !== id) return;
      fxRenderNotice("trains");
      fxClear(box);
      t = t && (t.train || t);
      if (!t) { box.appendChild(fxEmpty("train_not_found", "No train " + id + ".", "Train IDs look like t-142.", null)); return; }
      fxRenderTrain(box, t);
    }, function (err) { if (!quiet) fxClear(box).appendChild(fxErrorCard(err, function () { fxLoadTrain(id); })); });
  }
  function fxRenderTrain(box, t) {
    FX.current = { kind: "train", id: t.id, state: t.state };
    var n = 0; (t.lanes || []).forEach(function (l) { n += (l.intents || []).length; });
    box.appendChild(h("div", { cls: "fx-head", "data-kind": "train", "data-id": t.id, "data-state": t.state }, [
      h("h1", {}, [t.id + " ", h("span", { cls: "st-" + fxTone(t.state), text: t.state === "bisected" ? "✕→✓ bisected" : FX_GLYPH[fxTone(t.state)] + " " + fxWord(t.state) })]),
      h("div", { cls: "meta" }, [h("span", { cls: "mono muted", text: n + " intents · " + (t.lanes || []).length + " lanes · " + fxClock(t.duration_s) }), h("span", { cls: "mono muted", text: "base" }), t.base_sha ? fxSha(t.base_sha) : null, h("span", { cls: "mono muted", text: "combined" }), t.head_sha ? fxSha(t.head_sha) : null]),
      h("div", { cls: "fx-stages", style: "margin-top:10px" }, ["merge", "push train/" + String(t.id).slice(2), "CI on exact SHA", "CAS main", "why notes"].map(function (s, i) { return h("span", { cls: "fx-stage" + (i < 4 ? " done" : ""), text: s }); }))
    ]));
    var lanes = h("div", { cls: "fx-lanes" });
    (t.lanes || []).forEach(function (l) {
      var ci = (l.stages && l.stages.ci) || {};
      var red = ci.status === "failure";
      var right = h("div", { cls: "fx-cichip" }, [fxStageChain(l.stages, false)]);
      if (ci.run) right.appendChild(h("span", { cls: "mono muted", text: " " + ci.run }));
      lanes.appendChild(h("div", { cls: "fx-lanerow" + (red ? " red" : ""), "data-kind": "lane", "data-id": t.id + "/" + l.n, "data-state": ci.status || "pending" }, [
        h("div", {}, [h("div", { cls: "ln", text: "LANE " + l.n }), h("div", { cls: "lp", text: (l.paths || []).join(", ") })]),
        fxIntentChips(l.intents, 8, t.sim),
        right
      ]));
    });
    box.appendChild(fxPanel("Lanes", [lanes], [h("span", { cls: "fx-path", text: "lanes have disjoint footprints, so they verify in parallel" })]));
    if (t.bisect) {
      var tree = h("ul", { cls: "fx-bisect", "aria-label": "Bisect tree" });
      tree.appendChild(fxBisectNode(t.bisect));
      var body = h("div", { cls: "fx-pad", style: "overflow-x:auto" }, [tree]);
      var sec = fxPanel("Bisect", [body], [h("span", { cls: "fx-path", text: "lane " + t.bisect.lane + ", combined " + fxShort(t.bisect.sha) + " red" })]);
      sec.style.marginTop = "12px";
      box.appendChild(sec);
    }
    if (t.result) {
      var r = t.result;
      var rs = h("div", { cls: "fx-result", "data-kind": "result", "data-state": "landed" }, [h("span", { cls: "st-landed", text: "✓" }), h("span", { text: r.landed + " landed on main @" }), fxSha(r.sha), h("span", { text: "· CI " + (r.run || "") + " green on this exact SHA" + (r.tests ? " · " + r.tests + " tests" : "") + (r.requeued ? " · " + r.requeued + " requeued" : "") })]);
      var p = fxPanel("Result", [rs]);
      p.style.marginTop = "12px";
      box.appendChild(p);
    }
    var hist = h("div", { cls: "fx-hist" });
    (fxFixtures().trains || []).forEach(function (o) {
      if (!FX.demo && !FX.fallback.trains) return;
      var res = o.result || {};
      var tone = fxTone(o.state);
      hist.appendChild(h("a", { href: "#/trains/" + o.id, "data-kind": "train", "data-id": o.id, "aria-current": o.id === t.id ? "page" : null }, [h("span", { cls: "st-" + tone, text: (o.state === "bisected" ? "✕→✓" : FX_GLYPH[tone]) + " " }), o.id + " " + (res.landed !== undefined ? res.landed + " · " : "") + fxClock(o.duration_s)]));
    });
    if (hist.firstChild) { var hp = fxPanel("History", [hist]); hp.style.marginTop = "12px"; box.appendChild(hp); }
  }
  function fxBisectNode(n) {
    var cls = "fx-bnode " + (n.status || "") + (n.culprit ? " culprit" : "");
    var glyph = n.status === "success" ? "✓" : n.status === "failure" ? "✕" : "▶";
    var node = h("div", { cls: cls, "data-kind": "bisect", "data-state": n.status, "data-id": n.sha || "" }, [
      h("span", { cls: "c", text: n.count + " " + glyph }),
      n.sha ? fxSha(n.sha) : null,
      n.intents && n.intents.length <= 2 ? h("span", { cls: "n" }, n.intents.map(function (id) { return fxLink(id); })) : null,
      n.culprit ? h("span", { cls: "n st-conflict", text: "culprit · " + (n.note || "back to ready, owner notified") }) : null
    ]);
    var li = h("li", {}, [node]);
    if (n.children && n.children.length) {
      var ul = h("ul");
      n.children.forEach(function (c) { ul.appendChild(fxBisectNode(c)); });
      li.appendChild(ul);
    }
    return li;
  }

  // ---------- Conflicts ----------
  function fxLoadConflicts() {
    var box = document.getElementById("fxConflicts");
    fxSkeleton(box, 3);
    fxLoad("/v1/forge/conflicts?repo=" + encodeURIComponent(FX.repo), fxFxConflicts, "conflicts").then(function (d) {
      fxRenderNotice("conflicts");
      var list = fxArr(d, "conflicts");
      fxClear(box);
      var open = list.filter(function (c) { return c.state === "open" || c.state === "claimed"; });
      if (!open.length) box.appendChild(fxEmpty("no_conflicts", "No open conflicts.", fxNum((FX.snap && FX.snap.counters.overlaps_caught) || 0) + " overlaps were caught at declare time.", null));
      if (!list.length) return;
      var ul = h("ul", { cls: "fx-list", role: "list" });
      list.forEach(function (c) {
        var li = h("li", { cls: "fx-li", role: "listitem", tabindex: "0", "data-kind": "conflict", "data-id": c.id, "data-state": c.state }, [
          h("span", { cls: "st-" + fxTone(c.state === "claimed" ? "conflicted" : c.state), "aria-hidden": "true", text: c.state === "resolved" ? "✓" : "✕" }),
          fxIdChip(c.id), fxPill(c.state === "claimed" ? "replaying" : c.state, c.state),
          h("span", { cls: "title mono", text: (c.files || []).join(", ") + (c.lines ? ":" + c.lines : "") }),
          c.a ? fxLink(c.a.intent) : null, h("span", { cls: "muted", text: "vs" }), c.b ? fxLink(c.b.intent) : null
        ]);
        li.addEventListener("click", function () { fxNav("#/conflicts/" + c.id); });
        li.addEventListener("keydown", function (ev) { if (ev.key === "Enter") fxNav("#/conflicts/" + c.id); });
        ul.appendChild(li);
      });
      var p = fxPanel("Conflicts", [ul], [h("span", { cls: "fx-path", text: "resolved by replay with both intents' why in context" })]);
      p.style.marginTop = "12px";
      box.appendChild(p);
    }, function (err) { fxClear(box).appendChild(fxErrorCard(err, fxLoadConflicts)); });
  }
  function fxLoadConflict(id, quiet) {
    var box = document.getElementById("fxConflicts");
    if (!quiet) fxSkeleton(box, 4);
    fxLoad("/v1/forge/conflicts/" + encodeURIComponent(id), function () { return fxFxConflict(id); }, "conflicts").then(function (c) {
      if (FX.route.screen !== "conflicts" || FX.route.id !== id) return;
      fxRenderNotice("conflicts");
      fxClear(box);
      c = c && (c.conflict || c);
      if (!c) { box.appendChild(fxEmpty("conflict_not_found", "No conflict " + id + ".", "Conflict IDs look like c-9.", null)); return; }
      fxRenderConflict(box, c);
    }, function (err) { if (!quiet) fxClear(box).appendChild(fxErrorCard(err, function () { fxLoadConflict(id); })); });
  }
  function fxRenderConflict(box, c) {
    FX.current = { kind: "conflict", id: c.id, state: c.state };
    var claim = h("button", { type: "button", "data-action": "claim_conflict", "data-target": c.id, "aria-keyshortcuts": "Shift+C", disabled: c.state !== "open" ? true : null, on: { click: function () { fxCall("claim_conflict", c.id, {}).then(function () { fxLoadConflict(c.id); }); } } }, [c.state === "open" ? "Claim " : "Claimed ", h("kbd", { text: "⇧C" })]);
    box.appendChild(h("div", { cls: "fx-head", "data-kind": "conflict", "data-id": c.id, "data-state": c.state }, [
      h("h1", {}, [c.id + " ", h("span", { cls: "st-" + (c.state === "resolved" ? "landed" : "conflict"), text: (c.state === "resolved" ? "✓ resolved" : "✕ " + c.state) })]),
      h("div", { cls: "meta" }, [h("span", { cls: "fx-shared mono", text: (c.files || []).join(", ") + (c.lines ? ":" + c.lines : "") }), c.train_id ? h("span", { cls: "mono muted", text: "from train" }) : null, c.train_id ? fxLink(c.train_id) : null, h("span", { cls: "fx-spacer", style: "flex:1" }), claim])
    ]));
    function side(tag, s) {
      if (!s) return h("div", {});
      var kv = h("dl", { cls: "fx-kv" });
      function r(k, v) { kv.appendChild(h("dt", { text: k })); kv.appendChild(h("dd", {}, [v])); }
      r("Goal", h("span", {}, [fxLink(s.goal), " " + (s.goal_text || "")]));
      r("Why", h("span", { text: s.why || "—" }));
      var fpw = h("span", { cls: "mono" });
      (s.footprint || []).forEach(function (p, i) { if (i) fpw.appendChild(document.createTextNode(", ")); fpw.appendChild(h("span", { cls: (c.files || []).indexOf(p) >= 0 ? "fx-shared" : "", text: p })); });
      r("Footprint", fpw);
      var hunk = h("pre", { cls: "fx-hunk" });
      (s.hunk || []).forEach(function (ln) { hunk.appendChild(h("span", { cls: ln.charAt(0) === "+" ? "add" : ln.charAt(0) === "-" ? "del" : "", text: ln + "\n" })); });
      r("Hunk", hunk);
      return h("div", { "data-kind": "intent", "data-id": s.intent, "data-side": tag }, [
        h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap" }, [h("span", { cls: "side", text: tag }), fxLink(s.intent), fxMono(s.agent), h("span", { style: "font-weight:600", text: "“" + s.title + "”" }), s.landed ? fxPill("landed") : null]),
        kv
      ]);
    }
    box.appendChild(fxPanel("Both intents' why, side by side", [h("div", { cls: "fx-ab" }, [side("A", c.a), side("B", c.b)])]));
    if (c.replay) {
      var st = h("div", { cls: "fx-stepper", role: "list", "aria-label": "Replay progress" });
      (c.replay.stages || []).forEach(function (s, i) {
        if (i) st.appendChild(h("span", { cls: "fx-step-line" + (s.status === "done" ? " past" : ""), "aria-hidden": "true" }));
        var el2 = h("span", { cls: "fx-step" + (s.status === "done" ? " past" : s.status === "running" ? " cur" : ""), role: "listitem", "data-state": s.status, text: s.name + (s.at ? " " + new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "") });
        if (s.status === "running") { el2.style.setProperty("--step-c", "var(--st-train)"); el2.style.setProperty("--step-t", "var(--tint-train)"); }
        st.appendChild(el2);
      });
      var by = fxAgent(c.replay.by);
      var p = fxPanel("Resolution", [h("div", { cls: "fx-pad" }, [h("p", { style: "margin:0 0 4px;font-size:13px" }, ["Replay ", c.b ? fxLink(c.b.intent) : "", " on trunk with ", c.a ? fxLink(c.a.intent) : "", "'s why in context · claimed by " + by.label]), st])]);
      p.style.marginTop = "12px";
      box.appendChild(p);
    }
    if ((c.race || []).length) {
      var grid = h("div", { cls: "fx-race" });
      c.race.forEach(function (r) {
        var a = fxAgent(r.agent);
        var ok = r.ci && r.ci.status === "success";
        grid.appendChild(h("div", { cls: "fx-racecard" + (r.winner ? " win" : ""), "data-kind": "race-attempt", "data-id": c.id + "#" + r.attempt, "data-state": r.winner ? "winner" : (r.ci && r.ci.status) }, [
          h("div", { cls: "h" }, ["#" + r.attempt, fxMono(r.agent), a.label + (a.client ? " · " + a.client : "")]),
          h("span", { cls: ok ? "st-landed" : "st-conflict", text: (ok ? "✓ CI " : "✕ CI ") + fxClock(r.ci && r.ci.duration_s) + (r.ci && r.ci.failed ? " (" + r.ci.failed + " fail)" : "") }),
          h("span", {}, [h("span", { cls: "st-landed", text: "+" + r.diffstat.add }), " ", h("span", { cls: "st-conflict", text: "−" + r.diffstat.del })]),
          h("span", { text: "reviewer " + (r.reviewer === "agrees" ? "✓" : r.reviewer === "partial" ? "◐" : "—") }),
          r.winner ? h("span", { cls: "win-l", text: "★ winner (" + (r.rule || "picked") + ")" }) : null
        ]));
      });
      var rp = fxPanel("Race", [grid], [h("span", { cls: "fx-path", text: "race_k = " + (c.race_k || c.race.length) })]);
      rp.style.marginTop = "12px";
      box.appendChild(rp);
    }
  }

  // ---------- Agents ----------
  function fxMcpConfig() {
    var url = location.origin + "/mcp";
    return "{\n  \"mcpServers\": {\n    \"flare-forge\": {\n      \"type\": \"http\",\n      \"url\": \"" + url + "\",\n      \"headers\": { \"Authorization\": \"Bearer $FLARE_TOKEN\" }\n    }\n  }\n}";
  }
  function fxLoadAgents() {
    var box = document.getElementById("fxAgents");
    fxSkeleton(box, 4);
    fxLoad("/v1/forge/agents?repo=" + encodeURIComponent(FX.repo), fxFxAgents, "agents").then(function (d) {
      fxRenderNotice("agents");
      var list = fxArr(d, "agents");
      fxClear(box);
      var url = location.origin + "/mcp";
      var tabsDef = [
        ["Claude Code", "claude mcp add --transport http flare-forge " + url + " --header \"Authorization: Bearer $FLARE_TOKEN\""],
        ["Cursor", fxMcpConfig()],
        ["Codex", "codex mcp add flare-forge --url " + url + " --bearer-token-env-var FLARE_TOKEN"],
        ["curl", "curl -s " + url + " -H \"Authorization: Bearer $FLARE_TOKEN\" -H \"Content-Type: application/json\" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'"]
      ];
      var tabs = h("div", { cls: "fx-tabs", role: "tablist", "aria-label": "Client" });
      var pre = h("pre", { cls: "log", style: "margin:0;white-space:pre-wrap" });
      var copyB = h("button", { type: "button", cls: "ghost", "data-action": "copy_mcp_config", text: "Copy" });
      function pick(i) {
        var bs = tabs.querySelectorAll("button");
        for (var k = 0; k < bs.length; k++) bs[k].setAttribute("aria-selected", k === i ? "true" : "false");
        pre.textContent = tabsDef[i][1];
        copyB.onclick = function () { fxCopy(tabsDef[i][1], "Copied " + tabsDef[i][0] + " config"); };
      }
      tabsDef.forEach(function (t, i) { tabs.appendChild(h("button", { type: "button", role: "tab", on: { click: function () { pick(i); } } }, [t[0]])); });
      var card = fxPanel("Connect an agent", [h("div", { cls: "fx-pad" }, [h("p", { style: "margin:0 0 10px;font-size:13px;color:var(--soft)", text: "Plain git and MCP: any agent works. OAuth clients can skip the header; the server supports OAuth 2.1 dynamic clients." }), tabs, pre, h("div", { cls: "fx-actions" }, [copyB])])]);
      box.appendChild(card);
      pick(0);
      if (!list.length) { box.appendChild(fxEmpty("no_agents", "No agents connected.", "Add the MCP server above, then ask the agent to declare an intent.", "npx flare mcp-config --client claude-code")); return; }
      var real = list.filter(function (a) { return a.client !== "sim"; });
      var rows = h("div", {});
      rows.appendChild(h("div", { cls: "fx-agent-row h", "aria-hidden": "true" }, [h("span"), h("span", { text: "Agent" }), h("span", { text: "Client" }), h("span", { text: "Current intent" }), h("span", { text: "Last tool call" }), h("span", { text: "Lease" }), h("span", { text: "Landed" })]));
      real.forEach(function (a) {
        var it = a.intent ? fxIntentById(a.intent) : null;
        var lease = it && it.lease_expires_at ? Math.max(0, Math.round((Date.parse(it.lease_expires_at) - Date.now()) / 1000)) : null;
        rows.appendChild(h("div", { cls: "fx-agent-row", "data-kind": "agent", "data-id": a.id, "data-state": it ? it.state : "idle" }, [
          fxMono(a.id, it ? it.state : null), h("span", { cls: "mono", text: a.id }), h("span", { cls: "mono muted", text: a.client }),
          h("span", { style: "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, it ? [fxLink(it.id), " " + it.title] : [h("span", { cls: "muted", text: "idle" })]),
          h("span", { cls: "mono muted", text: a.last_tool + " · " + fxSecs(a.last_ago_s) + " ago" }),
          lease !== null ? h("span", { cls: "fx-lease" }, [h("span", { cls: "fx-ring", style: "--p:" + Math.round(lease / 3) }), lease + "s"]) : h("span", { cls: "muted", text: "—" }),
          h("span", { cls: "num", text: a.landed_today || 0 })
        ]));
      });
      var p = fxPanel("Agents", [rows], [h("span", { cls: "fx-path", text: real.length + " connected" })]);
      p.style.marginTop = "12px";
      box.appendChild(p);
      if (FX.snap && FX.snap.sim) {
        var det = h("details", { cls: "fx-panel fx-pad", style: "margin-top:12px" }, [h("summary", { cls: "mono", text: "AgentPool · " + fxNum(FX.snap.counters.agents) + " simulated agents" }), h("p", { cls: "muted", style: "font-size:13px", text: "Simulated agents run the same MCP calls from a Durable Object pool. They are grouped here so real agents stay visible and the simulation stays honest." })]);
        box.appendChild(det);
      }
    }, function (err) { fxClear(box).appendChild(fxErrorCard(err, fxLoadAgents)); });
  }

  // ---------- Bench (never shows fixture numbers outside ?demo=1) ----------
  function fxProbeBench() {
    var btn = document.getElementById("tabBench");
    if (FX.demo) { btn.hidden = false; FX.benchOk = true; return; }
    btn.hidden = true;
    fxFetch("/v1/forge/bench").then(function (d) { FX.benchOk = !!(d && (d.modes || []).length); btn.hidden = !FX.benchOk; }, function () { btn.hidden = true; });
  }
  function fxLoadBench() {
    var box = document.getElementById("fxBench");
    fxSkeleton(box, 3);
    var p = FX.demo ? Promise.resolve(fxFixtures().bench) : fxFetch("/v1/forge/bench");
    p.then(function (b) {
      fxRenderNotice("bench");
      fxClear(box);
      if (!b || !(b.modes || []).length) { box.appendChild(fxEmpty("bench_not_found", "No bench run recorded.", "Run the simulator to record one; this panel renders only measured runs.", "npm run forge:bench -- --agents 10000 --mode all")); return; }
      fxRenderBench(box, b);
    }, function (err) {
      fxClear(box);
      if (fxMissing(err)) box.appendChild(fxEmpty("bench_not_found", "No bench run recorded.", "GET /v1/forge/bench returned " + err.status + ". This panel never shows placeholder numbers outside demo mode.", "npm run forge:bench -- --agents 10000 --mode all"));
      else box.appendChild(fxErrorCard(err, fxLoadBench));
    });
  }
  function fxRenderBench(box, b) {
    box.appendChild(h("div", { cls: "fx-head", "data-kind": "bench", "data-id": b.run }, [
      h("h1", { text: "Bench · run " + b.run + " · " + fxNum(b.agents) + " agents" }),
      h("div", { cls: "meta" }, [h("span", { cls: "mono muted", text: (b.demo || FX.demo ? "demo fixture, not measured" : "measured") + " " + new Date(b.measured_at).toLocaleString() + " @" }), fxSha(b.sha), h("span", { cls: "mono muted", text: "· italic rows are projected" })])
    ]));
    var cols = [["changes_per_min", "Changes/min", function (v) { return fxNum(v); }], ["median_declare_to_land_s", "Median declare→land", function (v) { return fxSecs(v); }], ["conflicts_hit", "Conflicts hit", fxNum], ["conflicts_avoided", "Avoided", fxNum], ["red_main_min", "Red-main min", fxNum], ["human_min", "Human min", fxNum], ["usd_per_1k_agents", "$ / 1k agents", function (v) { return v === null || v === undefined ? "—" : "$" + Number(v).toFixed(2); }]];
    var thead = h("tr", {}, [h("th", { scope: "col", text: "Mode" })].concat(cols.map(function (c) { return h("th", { scope: "col", cls: "num", text: c[1] }); })));
    var tb = h("tbody");
    b.modes.forEach(function (m) {
      tb.appendChild(h("tr", { cls: m.projected ? "proj" : "", "data-kind": "bench-mode", "data-id": m.mode, "data-state": m.projected ? "projected" : "measured" }, [h("td", { text: m.label + (m.projected ? " (projected)" : "") })].concat(cols.map(function (c) { return h("td", { cls: "num", text: c[2](m.metrics[c[0]]) }); }))));
    });
    box.appendChild(fxPanel("Modes", [h("div", { cls: "table-scroll" }, [h("table", { cls: "fx-bench" }, [h("thead", {}, [thead]), tb])])]));
    var bars = h("div", { cls: "fx-bars" });
    [["changes_per_min", "Changes per minute", false], ["red_main_min", "Red-main minutes", true], ["human_min", "Human minutes", true], ["conflicts_hit", "Conflicts hit", true]].forEach(function (mt) {
      var mx = 1; b.modes.forEach(function (m) { var v = Number(m.metrics[mt[0]]) || 0; if (v > mx) mx = v; });
      var box2 = h("div", { cls: "fx-bar-m" }, [h("h4", { text: mt[1] + (mt[2] ? " (lower is better)" : "") })]);
      b.modes.forEach(function (m) {
        var v = Number(m.metrics[mt[0]]) || 0;
        var pct = Math.max(0.5, v / mx * 100);
        box2.appendChild(h("div", { cls: "fx-bar-r" }, [h("span", { text: m.mode + (m.projected ? "*" : "") }), h("span", { cls: "fx-bar-t" }, [h("span", { cls: "fx-bar-f" + (m.mode === "baseline" ? "" : " fx"), style: "width:" + pct.toFixed(1) + "%" }), h("span", { cls: "fx-bar-v" + (pct < 30 ? " out" : ""), text: fxNum(v) })])]));
      });
      bars.appendChild(box2);
    });
    var bp = fxPanel("Baseline vs Forge", [bars]);
    bp.style.marginTop = "12px";
    box.appendChild(bp);
    var dbm = b.declare_bench;
    var foot = h("div", { cls: "fx-pad" }, [dbm ? h("p", { cls: "mono", style: "margin:0 0 8px;font-size:12.5px", text: fxNum(dbm.intents) + " declare bench intents · p50 overlap query " + dbm.p50_ms + " ms · p99 " + dbm.p99_ms + " ms · " + dbm.shards + " LeaseShards" }) : null, fxCmd(b.command || "npm run forge:bench")]);
    var rp = fxPanel("Reproduce", [foot]);
    rp.style.marginTop = "12px";
    box.appendChild(rp);
  }

  // ---------- Why (drawer + file view) ----------
  function fxOpenWhy(repo, path, line) {
    var dr = document.getElementById("fxDrawer");
    var body = fxClear(document.getElementById("fxDrawerBody"));
    document.getElementById("fxDrawerTitle").textContent = "Why · line " + line;
    FX.drawerReturn = document.activeElement;
    dr.hidden = false;
    fxSkeleton(body, 4);
    fxLoad("/v1/forge/why?repo=" + encodeURIComponent(repo) + "&path=" + encodeURIComponent(path) + "&line=" + line, function () {
      if (FX.demo || repo === "flare/bookshelf") return fxFxWhy(repo, path, line);
      return { repo: repo, path: path, line: line, chain: [{ kind: "line", id: path + ":" + line, title: "Line " + line, text: path }], empty: { code: "why_unavailable", hint: "The Forge why endpoint is not deployed here yet.", command: "git log -L" + line + "," + line + ":" + path } };
    }, "why").then(function (d) {
      fxClear(body);
      fxRenderWhy(body, d || {}, path, line);
      document.getElementById("fxDrawerClose").focus();
    }, function (err) { fxClear(body).appendChild(fxErrorCard(err, function () { fxOpenWhy(repo, path, line); })); });
  }
  function fxCloseDrawer() {
    var dr = document.getElementById("fxDrawer");
    if (!dr || dr.hidden) return false;
    dr.hidden = true;
    if (FX.drawerReturn && FX.drawerReturn.focus) try { FX.drawerReturn.focus(); } catch (e) {}
    return true;
  }
  function fxRenderWhy(body, d, path, line) {
    body.appendChild(h("p", { cls: "mono muted", style: "margin:0 0 12px;font-size:12px", text: path + ":" + line }));
    var ol = h("ol", { cls: "fx-chain", "aria-label": "Why chain" });
    (d.chain || []).forEach(function (n) {
      var li = h("li", { "data-kind": n.kind, "data-id": n.id || "" }, [h("span", { cls: "dot", "aria-hidden": "true" }), h("span", { cls: "k", text: n.title || n.kind }), h("span", { cls: "v" + (n.kind === "line" ? " mono" : ""), text: n.text || "" })]);
      var sub = h("div", { cls: "s" });
      if (n.kind === "commit" && n.id) sub.appendChild(fxSha(n.id));
      if ((n.kind === "intent" || n.kind === "goal") && n.id) sub.appendChild(fxLink(n.id));
      if (n.meta) sub.appendChild(document.createTextNode(n.meta));
      if (sub.firstChild) li.appendChild(sub);
      ol.appendChild(li);
    });
    body.appendChild(ol);
    if (d.empty) body.appendChild(fxEmpty(d.empty.code, d.empty.hint, "Missing data is stated, never hidden. The plain commit history still has the answer.", d.empty.command));
    var acts = h("div", { cls: "fx-actions" });
    if (d.intent) acts.appendChild(h("button", { type: "button", "data-action": "fork_session", "data-target": d.intent, on: { click: function () { fxFork(d.intent, body); } } }, ["Fork session"]));
    acts.appendChild(h("button", { type: "button", cls: "ghost", "data-action": "copy_chain", on: { click: function () { fxCopy(JSON.stringify(d, null, 2), "Why chain copied as JSON"); } } }, ["Copy chain"]));
    acts.appendChild(h("a", { cls: "fx-json", href: "/v1/forge/why?repo=" + encodeURIComponent(FX.repo) + "&path=" + encodeURIComponent(path) + "&line=" + line, target: "_blank", rel: "noopener", text: "{} JSON" }));
    body.appendChild(acts);
    body.appendChild(h("div", { style: "margin-top:10px" }, [fxCmd(d.command || ("flare why " + path + ":" + line))]));
  }
  // Line-numbered code view with a clickable gutter (used by the Why
  // screen and the repository file view).
  function fxCodeView(text, repo, path, selLine, blame) {
    var pre = h("div", { cls: "fx-code", role: "table", "aria-label": path });
    String(text).split("\n").forEach(function (src, i) {
      var n = i + 1;
      var gut = h("button", { cls: "gut", type: "button", "data-action": "why", "data-target": path + ":" + n, "aria-label": "Why is line " + n + " here?", text: String(n) });
      gut.addEventListener("click", function () {
        var prev = pre.querySelector(".ln.sel"); if (prev) prev.classList.remove("sel");
        row.classList.add("sel");
        if (FX.route.screen === "why") { FX.route.q.set("line", String(n)); fxWriteHash(); fxSyncChrome(); }
        fxOpenWhy(repo, path, n);
      });
      var row = h("div", { cls: "ln" + (n === selLine ? " sel" : "") + (blame && blame[String(n)] ? " has" : ""), role: "row", "data-line": n }, [gut, h("span", { cls: "src", text: src || " " })]);
      pre.appendChild(row);
    });
    return pre;
  }
  function fxLoadWhyScreen() {
    var box = fxClear(document.getElementById("fxWhy"));
    var w = fxFixtures().why || {};
    var path = FX.route.q.get("path") || w.path || "";
    var line = Number(FX.route.q.get("line") || 0) || 0;
    if (!FX.route.q.get("path")) { FX.route.q.set("path", path); fxWriteHash(); fxSyncChrome(); }
    var head = h("div", { cls: "fx-head" }, [h("h1", { cls: "mono", style: "font-size:16px", text: path }), h("p", { cls: "muted", style: "margin:0;font-size:13px", text: "Click a line number (or focus one and press Enter) to see goal → intent → reasoning → alternatives → evidence → review → session." })]);
    box.appendChild(head);
    var mount = h("div", {});
    box.appendChild(mount);
    var useFixture = FX.demo || (path === w.path && FX.repo === "flare/bookshelf");
    var src = useFixture && w.path === path ? Promise.resolve({ text: (w.source || []).join("\n") }) : fxFetch("/v1/repos/" + encodeURIComponent(FX.repo) + "/blob?ref=main&path=" + encodeURIComponent(path));
    src.then(function (b) {
      if (b && typeof b.text === "string") mount.appendChild(fxCodeView(b.text, FX.repo, path, line, w.path === path ? w.blame : null));
      else mount.appendChild(fxEmpty("source_unavailable", "No preview for this file.", "Binary or too large to preview. The why chain still works per line.", "flare why " + path + ":1"));
      if (line) fxOpenWhy(FX.repo, path, line);
    }, function (err) {
      if (w.path === path) { mount.appendChild(fxCodeView((w.source || []).join("\n"), FX.repo, path, line, w.blame)); FX.fallback.why = "GET /v1/repos/.../blob returned " + (err.status || "an error"); fxRenderNotice("why"); if (line) fxOpenWhy(FX.repo, path, line); }
      else mount.appendChild(fxErrorCard(err, fxLoadWhyScreen));
    });
  }

  // ---------- Goal composer ----------
  function fxPreviewRisk(fp) {
    var hits = fxProtectedHits(fp);
    var w = 0;
    (fp || []).forEach(function (p) { w += p.indexOf("**") >= 0 ? 10 : 1; });
    var size = w ? Math.min(15, Math.round(15 * Math.log(1 + w) / Math.log(201))) : 0;
    var terms = [];
    if (hits.length) terms.push({ term: "protected_path", points: 40, detail: "touches " + hits.join(", ") });
    if (size) terms.push({ term: "footprint_size", points: size, detail: w + " file-equivalents" });
    var risk = 0; terms.forEach(function (t) { risk += t.points; });
    return { risk: Math.min(100, risk), terms: terms, protected: hits };
  }
  function fxOpenComposer() {
    var ov = document.getElementById("fxComposerOverlay");
    FX.composerReturn = document.activeElement;
    ov.hidden = false;
    fxRenderProposals();
    setTimeout(function () { document.getElementById("fxGoalText").focus(); }, 0);
  }
  function fxCloseComposer() {
    var ov = document.getElementById("fxComposerOverlay");
    if (ov.hidden) return false;
    ov.hidden = true;
    if (FX.composerReturn && FX.composerReturn.focus) try { FX.composerReturn.focus(); } catch (e) {}
    return true;
  }
  function fxPlan() {
    var text = document.getElementById("fxGoalText").value.trim();
    if (!text) { document.getElementById("fxGoalText").focus(); toast("Write the goal first", true); return; }
    var note = document.getElementById("fxPlannerNote");
    note.textContent = "planning…";
    var done = function (d, label) { FX.proposals = ((d && d.proposals) || []).map(function (p) { return { title: p.title, footprint: (p.footprint || []).slice() }; }); note.textContent = label; fxRenderProposals(); };
    if (FX.demo) { done(fxFxPlan(text), "demo planner: fixture proposals, edit freely"); return; }
    fxFetch("/v1/forge/goals/plan", { method: "POST", body: { repo: FX.repo, text: text } }).then(function (d) { done(d, "planner: " + ((d && d.planner) || "workers-ai") + " · proposes intents, you edit"); }, function (err) {
      if (fxMissing(err)) done(fxFxPlan(text), "planner endpoint returned " + err.status + ": showing demo proposals");
      else { note.textContent = "planner failed: " + err.message + " [" + err.code + "]"; }
    });
  }
  function fxRenderProposals() {
    var box = fxClear(document.getElementById("fxProposals"));
    var launch = document.getElementById("fxLaunchBtn");
    var props = FX.proposals;
    if (!props.length) { document.getElementById("fxComposerSummary").textContent = ""; launch.disabled = true; launch.textContent = "Launch intents"; return; }
    box.appendChild(h("div", { cls: "fx-prophead", "aria-hidden": "true" }, [h("span", { text: "#" }), h("span", { text: "Proposed intents (" + props.length + ")" }), h("span", { text: "Footprint" }), h("span", { text: "Risk" }), h("span", { text: "Needs" }), h("span")]));
    var needPlan = 0;
    props.forEach(function (p, idx) {
      var rk = fxPreviewRisk(p.footprint);
      if (rk.protected.length) needPlan++;
      var title = h("input", { cls: "t", type: "text", value: p.title, maxlength: "200", "aria-label": "Intent " + (idx + 1) + " title" });
      title.addEventListener("input", function () { p.title = title.value; });
      var fps = h("div", { cls: "fps" });
      p.footprint.forEach(function (fp, j) {
        var prot = fxProtectedHits([fp]).length > 0;
        fps.appendChild(h("span", { cls: "fx-fpchip" + (prot ? " prot" : ""), title: prot ? "protected path" : fp }, [fp + (prot ? " !" : ""), h("button", { type: "button", "aria-label": "Remove " + fp, text: "×", on: { click: function () { p.footprint.splice(j, 1); fxRenderProposals(); } } })]));
      });
      var add = h("input", { type: "text", placeholder: "+ path or glob", "aria-label": "Add footprint path to intent " + (idx + 1), list: "fxPathList" });
      add.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); var v = add.value.trim().replace(/^\.?\/+/, ""); if (v && p.footprint.indexOf(v) < 0) { p.footprint.push(v); fxRenderProposals(); var again = box.querySelectorAll(".fps input")[idx]; if (again) again.focus(); } } });
      fps.appendChild(add);
      var del = h("button", { type: "button", cls: "del", "aria-label": "Delete intent " + (idx + 1), text: "✕", on: { click: function () { props.splice(idx, 1); fxRenderProposals(); } } });
      box.appendChild(h("div", { cls: "fx-prop", "data-kind": "proposal", "data-id": String(idx + 1), "data-risk": rk.risk }, [h("span", { cls: "ix", text: String(idx + 1) }), title, fps, fxRisk(rk.risk), h("span", { cls: "needs", text: rk.protected.length ? "! plan" : "—" }), del]));
    });
    var dl = h("datalist", { id: "fxPathList" });
    var seen = {};
    ((FX.snap && (FX.snap.tree || FX.snap.cells)) || []).forEach(function (c) { if (!seen[c.path]) { seen[c.path] = 1; dl.appendChild(h("option", { value: c.path + "/**" })); } });
    box.appendChild(dl);
    // pre-launch overlap warnings
    var comps = props.map(function (_, i) { return i; });
    function root(i) { while (comps[i] !== i) i = comps[i]; return i; }
    for (var a = 0; a < props.length; a++) for (var b = a + 1; b < props.length; b++) {
      var hit = null;
      props[a].footprint.forEach(function (x) { props[b].footprint.forEach(function (y) { if (!hit && fxPathsOverlap(x, y)) hit = fxGlobBase(x).length >= fxGlobBase(y).length ? x : y; }); });
      if (hit) {
        comps[root(a)] = root(b);
        box.appendChild(h("p", { cls: "fx-warn", "data-kind": "overlap", "data-id": (a + 1) + "~" + (b + 1) }, [h("span", { cls: "g", text: "◐ " }), (a + 1) + " ↔ " + (b + 1) + " overlap on " + hit + " (advisory: both agents are told at declare time)"]));
      }
    }
    box.appendChild(h("div", { cls: "fx-actions" }, [h("button", { type: "button", cls: "ghost", text: "+ Add intent", on: { click: function () { props.push({ title: "", footprint: [] }); fxRenderProposals(); var ins = box.querySelectorAll("input.t"); if (ins.length) ins[ins.length - 1].focus(); } } })]));
    var lanes = {}; props.forEach(function (_, i) { lanes[root(i)] = 1; });
    document.getElementById("fxComposerSummary").textContent = props.length + " intents · " + needPlan + " need plan approval · est. 1 train, " + Object.keys(lanes).length + " lanes";
    launch.disabled = false;
    fxClear(launch).appendChild(document.createTextNode("Launch " + props.length + " intents "));
    launch.appendChild(h("kbd", { text: "⏎" }));
  }
  function fxLaunch() {
    var text = document.getElementById("fxGoalText").value.trim();
    var props = FX.proposals.filter(function (p) { return p.title.trim() && p.footprint.length; });
    if (!props.length) { toast("Each intent needs a title and at least one footprint path", true); return; }
    fxCall("declare_intent", null, { goal: text, intents: props }).then(function (r) {
      fxCloseComposer();
      FX.proposals = [];
      document.getElementById("fxGoalText").value = "";
      var gid = (r && (r.goal_id || (r.goal && r.goal.id))) || FX.lastGoal;
      fxNav(gid ? "#/intents?goal=" + gid : "#/intents");
    }, function () {});
  }

  // ---------- palette, keys, stage, theme ----------
  function fxPalCommands() {
    var cmds = [];
    var go = [["live", "l", "Repository map with agent dots, overlaps and the train track"], ["inbox", "i", "What needs a human, risk-sorted"], ["intents", "n", "Goals and their intents"], ["trains", "p", "Lanes, bisects, exact-SHA CI"], ["conflicts", "c", "Merging intents, not hunks"], ["agents", "a", "Connected agents and the MCP config"]];
    if (FX.benchOk) go.push(["bench", "b", "Measured baseline vs Forge"]);
    go.forEach(function (g) { cmds.push({ group: "Go to", label: "Go to " + FX_SCREENS[g[0]], key: "g " + g[1], desc: g[2], run: function () { fxNav("#/" + g[0]); } }); });
    cmds.push({ group: "Create", label: "New goal…", key: "c", desc: "Planner proposes intents; you edit before launch", mcp: "plan_goal", run: fxOpenComposer });
    var cur = FX.current;
    var focusId = FX.route.screen === "inbox" ? FX.inboxFocus : (cur && cur.kind === "intent" && FX.route.screen === "intents" && FX.route.id ? cur.id : "");
    if (focusId) {
      var it = fxFindItem(focusId) || { id: focusId, bucket: "", reason: (cur && cur.state === "awaiting_plan") ? "plan" : "" };
      cmds.push({ group: "Intent " + focusId, label: "Approve plan", key: "a", desc: "Protected-path plan, one keystroke with a 5s undo", mcp: "approve_plan", run: function () { if (it.bucket) fxApprove(it); else fxCall("approve_plan", focusId, {}); } });
      cmds.push({ group: "Intent " + focusId, label: "Send back with reason…", key: "x", desc: "Requires a one-line reason", mcp: "send_back", run: function () { if (FX.route.screen === "inbox" && it.bucket) fxOpenSendBack(it); else fxNav("#/inbox"); } });
      cmds.push({ group: "Intent " + focusId, label: "Mark ready", key: "m", desc: "Queue for the next train", mcp: "mark_ready", run: function () { fxCall("mark_ready", focusId, {}); } });
      cmds.push({ group: "Intent " + focusId, label: "Send note…", key: "n", desc: "Delivered on the recipient's next tool call", mcp: "send_note", run: function () { fxNav("#/intents/" + focusId); setTimeout(function () { var n = document.getElementById("fxNoteInput"); if (n) n.focus(); }, 400); } });
      cmds.push({ group: "Intent " + focusId, label: "Fork session", key: "f", desc: "Continue this work from its exact context", mcp: "fork_session", run: function () { fxNav("#/intents/" + focusId); setTimeout(function () { var b = document.querySelector("[data-action=fork_session]"); if (b) b.click(); }, 400); } });
    }
    if (cur && cur.kind === "conflict" && FX.route.screen === "conflicts") cmds.push({ group: "Conflict " + cur.id, label: "Claim conflict", key: "⇧C", desc: "Replay with both intents' why in context", mcp: "claim_conflict", run: function () { fxCall("claim_conflict", cur.id, {}).then(function () { fxLoadConflict(cur.id); }); } });
    cmds.push({ group: "Why", label: "Why is this line here?", key: "w", desc: "Line → goal → intent → reasoning → evidence → session", mcp: "why", run: function () { var w = fxFixtures().why || {}; fxNav("#/why?path=" + encodeURIComponent(w.path || "") + "&line=10"); } });
    cmds.push({ group: "View", label: FX.paused ? "Resume live" : "Pause live", key: "p", desc: "Freeze rendering while deltas buffer", run: function () { fxTogglePause(); } });
    cmds.push({ group: "View", label: "View as table", key: "t", desc: "The live map as an accessible table", run: function () { fxNav("#/live"); setTimeout(function () { fxToggleTable(true); }, 300); } });
    cmds.push({ group: "View", label: "Stage mode", key: "⇧S", desc: "1080p layout for video and demos", run: fxToggleStage });
    cmds.push({ group: "View", label: "Toggle light/dark theme", key: "", desc: "Dark is the default", run: fxToggleTheme });
    cmds.push({ group: "Copy", label: "Copy JSON URL", key: "⇧J", desc: fxEndpoint(), run: function () { fxCopy(location.origin + fxEndpoint(), "JSON URL copied"); } });
    cmds.push({ group: "Copy", label: "Copy MCP config", key: "", desc: "flare-forge server block for any MCP client", run: function () { fxCopy(fxMcpConfig(), "MCP config copied"); } });
    var f = fxFixtures();
    var ids = [];
    ((FX.snap && FX.snap.intents) || []).forEach(function (i) { ids.push([i.id, i.title]); });
    if (FX.demo || Object.keys(FX.fallback).length) {
      (f.intents || []).forEach(function (i) { if (!ids.some(function (x) { return x[0] === i.id; })) ids.push([i.id, i.title]); });
      (f.goals || []).forEach(function (g) { ids.push([g.id, g.text]); });
      (f.trains || []).forEach(function (t) { ids.push([t.id, fxWord(t.state)]); });
      (f.conflicts || []).forEach(function (c) { ids.push([c.id, (c.files || []).join(", ")]); });
      (f.agents || []).forEach(function (a) { ids.push([a.id, a.label + " " + a.client]); });
    }
    ids.forEach(function (x) { var href = fxHref(x[0]); if (href) cmds.push({ group: "Jump to ID", label: x[0] + " · " + x[1], key: "", desc: "", kind: fxKindOf(x[0]), mcp: "get_" + fxKindOf(x[0]), idMatch: x[0], run: function () { fxNav(href); } }); });
    return cmds;
  }
  function fxToggleStage(force) {
    FX.stage = typeof force === "boolean" ? force : !FX.stage;
    document.body.classList.toggle("fx-stagemode", FX.stage);
    var root = document.documentElement;
    if (FX.stage) { FX.preStageTheme = root.getAttribute("data-theme"); root.setAttribute("data-theme", "dark"); }
    else { if (FX.preStageTheme) root.setAttribute("data-theme", FX.preStageTheme); else root.removeAttribute("data-theme"); }
    document.getElementById("fxStageBtn").setAttribute("aria-pressed", FX.stage ? "true" : "false");
    if (FX.route.screen === "live" && FX.snap) setTimeout(function () { fxRenderLive(true); }, 30);
    toast(FX.stage ? "Stage mode on · ⇧S to exit" : "Stage mode off");
  }
  function fxEffectiveTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    try { return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch (e) { return "dark"; }
  }
  function fxToggleTheme() {
    var next = fxEffectiveTheme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("flare-theme", next); } catch (e) {}
    fxThemeMeta();
  }
  function fxThemeMeta() {
    var m = document.querySelector("meta[name=theme-color]");
    if (m) m.setAttribute("content", fxEffectiveTheme() === "light" ? "#fafafa" : "#0a0a0a");
    var b = document.getElementById("fxThemeBtn");
    if (b) b.textContent = fxEffectiveTheme() === "light" ? "Dark" : "Light";
  }
  var FX_KEYS = [
    ["Go to", [["g l", "Live"], ["g i", "Inbox"], ["g n", "Intents"], ["g p", "Trains"], ["g c", "Conflicts"], ["g a", "Agents"], ["g b", "Bench"], ["g r", "Runs"], ["g o", "Repositories"], ["g t", "Races"]]],
    ["Anywhere", [["⌘K", "Command palette"], ["c", "New goal"], ["?", "This sheet"], ["⇧S", "Stage mode"], ["p", "Pause live"], ["r", "Refresh"], ["esc", "Close / back"]]],
    ["Inbox", [["j / k", "Move"], ["⏎", "Open or approve plan"], ["a", "Approve / looks good"], ["x", "Send back"], ["z", "Undo (5s)"], ["e", "Toggle evidence"], ["w", "Why chain"], ["s", "Select"], ["1 2 3", "Needs you / sample / auto"]]],
    ["Live, intent, conflict", [["t", "View as table"], ["m", "Mark ready"], ["n", "Send note"], ["f", "Fork session"], ["w", "Why"], ["⇧C", "Claim conflict"]]]
  ];
  function fxShowKeys() {
    var grid = fxClear(document.getElementById("fxKeysGrid"));
    FX_KEYS.forEach(function (g) {
      grid.appendChild(h("h4", { text: g[0] }));
      g[1].forEach(function (k) { grid.appendChild(h("div", {}, [h("span", { text: k[1] }), h("kbd", { text: k[0] })])); });
    });
    document.getElementById("fxKeysOverlay").hidden = false;
    document.getElementById("fxKeysClose").focus();
  }
  function fxForgeKey(e) {
    if (e.defaultPrevented || palOpen || appPane.hidden) return;
    var composer = !document.getElementById("fxComposerOverlay").hidden;
    var keys = !document.getElementById("fxKeysOverlay").hidden;
    if (composer) {
      if (e.key === "Escape") { e.preventDefault(); fxCloseComposer(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fxPlan(); }
      else if (e.key === "Enter" && e.target && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON" && FX.proposals.length) { e.preventDefault(); fxLaunch(); }
      return;
    }
    if (keys) { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); document.getElementById("fxKeysOverlay").hidden = true; } return; }
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (Date.now() - gPending < 900) return;
    var k = e.key;
    var inForge = fxIsScreen(currentTab);
    if (k === "?") { e.preventDefault(); fxShowKeys(); return; }
    if (k === "c" && !e.shiftKey) { e.preventDefault(); fxOpenComposer(); return; }
    if (k === "S" && e.shiftKey) { e.preventDefault(); fxToggleStage(); return; }
    if (!inForge) return;
    if (k === "Escape") {
      if (fxCloseDrawer()) { e.preventDefault(); return; }
      if (FX.sendBack) { FX.sendBack = ""; fxRenderInbox(); return; }
      if (FX.pathFilter) { FX.pathFilter = ""; fxApplyPathFilter(); return; }
      if (FX.route.id) { e.preventDefault(); fxNav("#/" + FX.route.screen); }
      return;
    }
    if (k === "z" && FX.undo) { e.preventDefault(); fxCancelUndo(); return; }
    if (k === "p") { e.preventDefault(); fxTogglePause(); return; }
    if (k === "J" && e.shiftKey) { e.preventDefault(); fxCopy(location.origin + fxEndpoint(), "JSON URL copied"); return; }
    var s = FX.route.screen;
    if (s === "live" && k === "t") { e.preventDefault(); fxToggleTable(); return; }
    if (s === "inbox") {
      var it = fxFindItem(FX.inboxFocus);
      if (k === "j" || k === "ArrowDown") { e.preventDefault(); fxMoveFocus(1); return; }
      if (k === "k" || k === "ArrowUp") { e.preventDefault(); fxMoveFocus(-1); return; }
      if (k === "1" || k === "2" || k === "3") { e.preventDefault(); FX.inboxFilter = { "1": "needs_you", "2": "sample", "3": "auto" }[k]; fxRenderInbox(); return; }
      if (!it) return;
      if (k === "Enter") { e.preventDefault(); if (it.bucket === "needs_you" && it.reason === "plan" && !it.pending) fxApprove(it); else fxNav("#/intents/" + it.id); return; }
      if (k === "a" && !it.pending && it.bucket !== "auto") { e.preventDefault(); fxApprove(it); return; }
      if (k === "x" && !it.pending && it.bucket !== "auto") { e.preventDefault(); fxOpenSendBack(it); return; }
      if (k === "e") { e.preventDefault(); FX.expandEvidence[it.id] = !FX.expandEvidence[it.id]; fxRenderInbox(); return; }
      if (k === "s" || k === " ") { e.preventDefault(); fxToggleSelect(it.id); return; }
      if (k === "w") { e.preventDefault(); var p = (it.footprint || [])[0]; if (p) fxOpenWhy(FX.repo, p, fxFirstLine(p, it.id)); return; }
      return;
    }
    if (s === "intents" && FX.route.id && FX.current && FX.current.kind === "intent") {
      var map = { a: "approve_plan", m: "mark_ready", f: "fork_session", w: "why", n: "send_note" };
      var act = map[k];
      if (act) {
        var b = document.querySelector("#fxIntents [data-action=" + act + "]");
        if (b) { e.preventDefault(); if (act === "send_note") { var ni = document.getElementById("fxNoteInput"); if (ni) ni.focus(); } else b.click(); }
      }
      return;
    }
    if (s === "conflicts" && FX.route.id && k === "C" && e.shiftKey) {
      var cb = document.querySelector("#fxConflicts [data-action=claim_conflict]");
      if (cb && !cb.disabled) { e.preventDefault(); cb.click(); }
    }
  }
  document.addEventListener("keydown", fxForgeKey);

  // ---------- wiring ----------
  function fxInitChrome() {
    var q = fxQ();
    var dm = q.get("demo");
    FX.demo = dm === "1" || dm === "true" || dm === "scale";
    FX.demoScale = dm === "scale";
    var theme = null;
    try { theme = localStorage.getItem("flare-theme"); } catch (e) {}
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
    fxThemeMeta();
    if (q.get("stage") === "1") { FX.stage = true; document.body.classList.add("fx-stagemode"); FX.preStageTheme = document.documentElement.getAttribute("data-theme"); document.documentElement.setAttribute("data-theme", "dark"); }
    var btns = document.querySelectorAll(".side-link[data-tab]");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        var tab = b.getAttribute("data-tab");
        if (fxIsScreen(tab)) b.addEventListener("click", function () { fxNav("#/" + tab); });
      })(btns[i]);
    }
    document.getElementById("fxRepo").addEventListener("change", function () { fxSetRepo(this.value); });
    document.getElementById("fxPauseBtn").addEventListener("click", function () { fxTogglePause(); });
    document.getElementById("fxThemeBtn").addEventListener("click", fxToggleTheme);
    document.getElementById("fxStageBtn").addEventListener("click", function () { fxToggleStage(); });
    document.getElementById("fxKeysBtn").addEventListener("click", fxShowKeys);
    document.getElementById("fxKeysClose").addEventListener("click", function () { document.getElementById("fxKeysOverlay").hidden = true; });
    document.getElementById("fxKeysOverlay").addEventListener("click", function (ev) { if (ev.target === this) this.hidden = true; });
    document.getElementById("fxJsonLink").addEventListener("click", function (ev) { if (ev.shiftKey) { ev.preventDefault(); fxCopy(location.origin + fxEndpoint(), "JSON URL copied"); } });
    document.getElementById("fxTableBtn").addEventListener("click", function () { fxToggleTable(); });
    document.getElementById("fxClearPath").addEventListener("click", function () { FX.pathFilter = ""; fxApplyPathFilter(); });
    document.getElementById("fxDrawerClose").addEventListener("click", fxCloseDrawer);
    document.getElementById("fxComposerClose").addEventListener("click", fxCloseComposer);
    document.getElementById("fxComposerCancel").addEventListener("click", fxCloseComposer);
    document.getElementById("fxComposerOverlay").addEventListener("click", function (ev) { if (ev.target === this) fxCloseComposer(); });
    document.getElementById("fxPlanBtn").addEventListener("click", fxPlan);
    document.getElementById("fxLaunchBtn").addEventListener("click", fxLaunch);
    var rt = null;
    window.addEventListener("resize", function () { if (rt) clearTimeout(rt); rt = setTimeout(function () { if (FX.route.screen === "live" && FX.snap && !document.getElementById("forgePane").hidden && !FX.tableView) fxRenderMap(FX.snap); }, 150); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && FX.route.screen === "live" && !document.getElementById("forgePane").hidden && !FX.ws && !FX.simTimer) fxLoadLive(true); });
    setInterval(function () { if (!document.hidden && !document.getElementById("fxLiveBadge").hasAttribute("data-fixed") && (FX.ws || FX.simTimer) && !FX.paused) fxSetBadge("live", FX.simTimer ? "live · demo sim" + (fxHz() ? " · " + fxHz() + " Hz" : "") : null); }, 2000);
  }
  // Signed-out visitors with ?demo=1 get a read-only Forge tour on fixtures:
  // no API calls beyond /v1/admin/status, other tabs hidden.
  function fxShowAnonDemo() {
    FX.anon = true;
    authPane.hidden = true; invitePane.hidden = true; resetPane.hidden = true; resetConfirmPane.hidden = true; magicConfirmPane.hidden = true;
    appPane.hidden = false; logoutBtn.hidden = true; document.body.classList.add("app");
    userLabel.textContent = "Demo · signed out ";
    ["tabTournaments", "tabRepos", "tabMerge", "tabRuns", "tabSettings"].forEach(function (id) { var b = document.getElementById(id); if (b) b.hidden = true; });
    var groups = document.querySelectorAll(".side-group");
    for (var i = 1; i < groups.length; i++) groups[i].hidden = true;
    fxStartForge().then(function () { if (!applyHashRoute()) fxNav("#/live"); });
  }
  var fxStarted = null;
  function fxStartForge() {
    if (fxStarted) return fxStarted;
    fxStarted = fxInitRepos().then(function () {
      fxProbeBench();
      fxFillRepos();
      // nav badges without visiting the screens
      fxLoad("/v1/forge/inbox?repo=" + encodeURIComponent(FX.repo), function () { return fxFxInbox(FX.repo); }, "inbox").then(function (d) { FX.inbox = fxNormInbox(d); fxUpdateBadges(); }, function () {});
      if (!FX.snap) fxLoad("/v1/forge/snapshot?repo=" + encodeURIComponent(FX.repo), function () { return fxFxSnapshot(FX.repo); }, "live").then(function (d) { if (!FX.snap) FX.snap = fxNormSnapshot(d); fxUpdateBadges(); if (FX.fallback.live && !FX.simTimer && !document.getElementById("forgePane").hidden) fxStartFeed(); }, function () {});
    });
    return fxStarted;
  }
  fxInitChrome();
`;
