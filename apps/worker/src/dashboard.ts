export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flare Actions</title>
<style>
:root { color-scheme: light; --bg: #f6f7f9; --card: #fff; --line: #e3e6eb; --ink: #1c2330; --muted: #687182; --accent: #2563eb; --danger: #dc2626; --ok: #15803d; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; background: var(--card); border-bottom: 1px solid var(--line); }
header h1 { font-size: 17px; margin: 0; }
main { max-width: 960px; margin: 0 auto; padding: 20px; }
section.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
h2 { margin: 0 0 10px; font-size: 15px; }
.muted { color: var(--muted); }
.err { color: var(--danger); }
input, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); }
button { background: var(--accent); color: #fff; border: none; cursor: pointer; }
button.ghost { background: #eef1f5; color: var(--ink); }
button.danger { background: var(--danger); }
button:disabled { opacity: 0.5; cursor: default; }
nav.tabs { display: flex; gap: 8px; margin-bottom: 16px; }
nav.tabs button { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
nav.tabs button.active { background: var(--ink); color: #fff; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr.clickable { cursor: pointer; }
tbody tr.clickable:hover { background: #f0f3f8; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.pill.queued { background: #eef1f5; color: var(--muted); }
.pill.running { background: #dbeafe; color: #1d4ed8; }
.pill.success { background: #dcfce7; color: var(--ok); }
.pill.failure, .pill.error { background: #fee2e2; color: var(--danger); }
.pill.blocked { background: #fef3c7; color: #92400e; }
.pill.cancelled, .pill.skipped { background: #eef1f5; color: var(--muted); text-decoration: line-through; }
pre.log { background: #0f1520; color: #d7e0ee; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; }
div.triage { border-left: 3px solid var(--accent); background: #eff6ff; padding: 10px 12px; border-radius: 0 8px 8px 0; margin: 8px 0; white-space: pre-wrap; font-size: 13px; }
code.token { display: block; background: #0f1520; color: #d7e0ee; padding: 12px; border-radius: 8px; word-break: break-all; font-size: 12.5px; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form.inline input { flex: 1; min-width: 180px; }
</style>
</head>
<body>
<header>
<h1>Flare Actions</h1>
<button id="logoutBtn" class="ghost" hidden>Log out</button>
</header>
<main>
<section id="setupPane" class="card" hidden>
<h2>First-run setup</h2>
<p class="muted">Create your admin password (12+ characters). This screen disappears forever once set.</p>
<form id="setupForm" class="inline">
<input id="setupPw1" type="password" placeholder="New admin password" autocomplete="new-password">
<input id="setupPw2" type="password" placeholder="Confirm password" autocomplete="new-password">
<button type="submit">Create password</button>
</form>
<p id="setupErr" class="err"></p>
</section>
<section id="loginPane" class="card">
<h2>Log in</h2>
<p class="muted">Use your admin password (ADMIN_TOKEN).</p>
<form id="loginForm" class="inline">
<input id="pwInput" type="password" placeholder="Admin password" autocomplete="current-password">
<button type="submit">Log in</button>
</form>
<p id="loginErr" class="err"></p>
</section>
<section id="appPane" hidden>
<nav class="tabs">
<button id="tabRuns" class="active">Runs</button>
<button id="tabAccess">Access</button>
<button id="tabSettings">Settings</button>
</nav>
<section id="runsPane" class="card">
<h2>Runs</h2>
<table><thead><tr><th>Status</th><th>Repo</th><th>Commit</th><th>Event</th><th>Updated</th></tr></thead><tbody id="runsBody"></tbody></table>
<div id="runDetail" hidden></div>
</section>
<section id="accessPane" class="card" hidden>
<h2>Access tokens</h2>
<p class="muted">Issue tokens for runners and teammates. Runner tokens can pull jobs and update status; readonly tokens can only view runs. Revoked tokens stop working immediately.</p>
<form id="tokenForm" class="inline">
<input id="tokenName" placeholder="Token name, e.g. ci-laptop" maxlength="64">
<select id="tokenScope"><option value="runner">runner</option><option value="readonly">readonly</option></select>
<button type="submit">Create token</button>
</form>
<p id="tokenErr" class="err"></p>
<div id="newTokenBox" hidden>
<p><strong>Copy this token now — it is shown once.</strong></p>
<code class="token" id="newTokenVal"></code>
</div>
<table><thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody id="tokensBody"></tbody></table>
</section>
<section id="settingsPane" class="card" hidden>
<h2>Settings</h2>
<p class="muted" id="settingsInfo"></p>
<form id="webhookForm" class="inline">
<input id="webhookInput" placeholder="GitHub webhook secret (16+ characters)">
<button type="submit">Save webhook secret</button>
</form>
<p id="settingsErr" class="err"></p>
<p id="settingsOk"></p>
</section>
</section>
</main>
<script>
(function () {
  var KEY = "flare-admin-token";
  function token() { return sessionStorage.getItem(KEY) || ""; }
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; return e; }
  function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }
  function pill(status) { var s = el("span", status); s.className = "pill " + status; return s; }

  var loginPane = document.getElementById("loginPane");
  var setupPane = document.getElementById("setupPane");
  var appPane = document.getElementById("appPane");
  var logoutBtn = document.getElementById("logoutBtn");

  function showSetup() {
    setupPane.hidden = false; loginPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true;
  }
  function showLogin() {
    setupPane.hidden = true; loginPane.hidden = false; appPane.hidden = true; logoutBtn.hidden = true;
  }
  function showApp() {
    setupPane.hidden = true; loginPane.hidden = true; appPane.hidden = false; logoutBtn.hidden = false;
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json", "Authorization": "Bearer " + token() };
    if (opts.headers) { for (var k in opts.headers) headers[k] = opts.headers[k]; }
    opts.headers = headers;
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { sessionStorage.removeItem(KEY); showLogin(); throw new Error("unauthorized"); }
      if (!res.ok) throw new Error("request failed: " + res.status);
      return res.json();
    });
  }

  document.getElementById("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var pw = document.getElementById("pwInput").value;
    var err = document.getElementById("loginErr");
    err.textContent = "";
    sessionStorage.setItem(KEY, pw);
    api("/v1/admin/tokens").then(function () {
      document.getElementById("pwInput").value = "";
      showApp(); loadRuns(); loadTokens();
    }).catch(function () {
      sessionStorage.removeItem(KEY);
      err.textContent = "Wrong password.";
    });
  });
  logoutBtn.addEventListener("click", function () { sessionStorage.removeItem(KEY); showLogin(); });

  var tabRuns = document.getElementById("tabRuns");
  var tabAccess = document.getElementById("tabAccess");
  var tabSettings = document.getElementById("tabSettings");
  var runsPane = document.getElementById("runsPane");
  var accessPane = document.getElementById("accessPane");
  var settingsPane = document.getElementById("settingsPane");
  function selectTab(name) {
    tabRuns.className = name === "runs" ? "active" : "";
    tabAccess.className = name === "access" ? "active" : "";
    tabSettings.className = name === "settings" ? "active" : "";
    runsPane.hidden = name !== "runs";
    accessPane.hidden = name !== "access";
    settingsPane.hidden = name !== "settings";
  }
  tabRuns.addEventListener("click", function () { selectTab("runs"); loadRuns(); });
  tabAccess.addEventListener("click", function () { selectTab("access"); loadTokens(); });
  tabSettings.addEventListener("click", function () { selectTab("settings"); loadSettings(); });

  function loadRuns() {
    api("/v1/runs").then(function (data) {
      var body = document.getElementById("runsBody");
      body.textContent = "";
      (data.runs || []).forEach(function (r) {
        var tr = el("tr");
        tr.className = "clickable";
        var tdS = el("td"); tdS.appendChild(pill(r.status)); tr.appendChild(tdS);
        tr.appendChild(el("td", r.repo));
        tr.appendChild(el("td", String(r.sha).slice(0, 7)));
        tr.appendChild(el("td", r.event));
        tr.appendChild(el("td", fmtTime(r.updated_at)));
        tr.addEventListener("click", function () { loadRun(r.id); });
        body.appendChild(tr);
      });
      if (!body.children.length) {
        var tr = el("tr"); var td = el("td", "No runs yet."); td.colSpan = 5; tr.appendChild(td); body.appendChild(tr);
      }
    }).catch(function () {});
  }

  function loadRun(id) {
    api("/v1/runs/" + encodeURIComponent(id)).then(function (data) {
      var box = document.getElementById("runDetail");
      box.textContent = "";
      box.hidden = false;
      var head = el("h2", data.run.repo + " @ " + String(data.run.sha).slice(0, 7) + " — " + data.run.status);
      box.appendChild(head);
      if (data.summary) {
        box.appendChild(el("p", data.summary.finishedJobs + "/" + data.summary.jobs + " jobs finished, " +
          data.summary.computeMinutes + " compute-min (~$" + data.summary.actionsListUsd + " at Actions list price)"));
      }
      (data.jobs || []).forEach(function (j) {
        var title = "Job " + (j.name ? j.name + " " : "") + j.id.slice(0, 8) + " — " + j.status;
        if (j.labels) title += " [" + j.labels + "]";
        if (j.durationMs !== null && j.durationMs !== undefined) title += " (" + (j.durationMs / 1000) + "s)";
        box.appendChild(el("h3", title));
        if (j.status === "failure" || j.status === "error" || j.status === "cancelled" || j.status === "success") {
          var rerun = el("button", "Re-run job");
          rerun.className = "ghost";
          (function (jobId) {
            rerun.addEventListener("click", function () {
              api("/v1/runs/" + encodeURIComponent(data.run.id) + "/jobs/" + encodeURIComponent(jobId) + "/rerun", { method: "POST" })
                .then(function () { loadRun(data.run.id); loadRuns(); }).catch(function () {});
            });
          })(j.id);
          box.appendChild(rerun);
        }
        try {
          var parsed = j.result ? JSON.parse(j.result) : null;
          if (parsed && Array.isArray(parsed.steps)) {
            parsed.steps.forEach(function (s) {
              var mark = s.exitCode === 0 ? "ok" : "FAIL";
              box.appendChild(el("p", "[" + mark + "] " + s.command + " (exit " + s.exitCode + ", " + s.durationMs + "ms)"));
            });
          }
        } catch (e) { /* legacy jobs without structured results */ }
        if (j.triage) {
          var tri = el("div");
          tri.className = "triage";
          tri.appendChild(el("strong", "AI triage"));
          tri.appendChild(document.createTextNode("\n" + j.triage));
          box.appendChild(tri);
        }
        var pre = el("pre", j.log || "(no log output)");
        pre.className = "log";
        box.appendChild(pre);
      });
      var back = el("button", "Back to runs");
      back.className = "ghost";
      back.addEventListener("click", function () { box.hidden = true; });
      box.appendChild(back);
      box.scrollIntoView();
    }).catch(function () {});
  }

  function loadTokens() {
    api("/v1/admin/tokens").then(function (data) {
      var body = document.getElementById("tokensBody");
      body.textContent = "";
      (data.tokens || []).forEach(function (t) {
        var tr = el("tr");
        tr.appendChild(el("td", t.name));
        tr.appendChild(el("td", t.scopes));
        tr.appendChild(el("td", fmtTime(t.created_at)));
        tr.appendChild(el("td", t.revoked_at ? "revoked" : "active"));
        var tdBtn = el("td");
        if (!t.revoked_at) {
          var btn = el("button", "Revoke");
          btn.className = "danger";
          btn.addEventListener("click", function () {
            api("/v1/admin/tokens/" + encodeURIComponent(t.id) + "/revoke", { method: "POST" })
              .then(loadTokens).catch(function () {});
          });
          tdBtn.appendChild(btn);
        }
        tr.appendChild(tdBtn);
        body.appendChild(tr);
      });
    }).catch(function () {});
  }

  document.getElementById("tokenForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("tokenErr");
    err.textContent = "";
    document.getElementById("newTokenBox").hidden = true;
    var name = document.getElementById("tokenName").value.trim();
    var scope = document.getElementById("tokenScope").value;
    api("/v1/admin/tokens", { method: "POST", body: JSON.stringify({ name: name, scopes: [scope] }) })
      .then(function (data) {
        document.getElementById("newTokenVal").textContent = data.token;
        document.getElementById("newTokenBox").hidden = false;
        document.getElementById("tokenName").value = "";
        loadTokens();
      })
      .catch(function () { err.textContent = "Could not create token. Name is required."; });
  });

  document.getElementById("setupForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("setupErr");
    err.textContent = "";
    var a = document.getElementById("setupPw1").value;
    var b = document.getElementById("setupPw2").value;
    if (a !== b) { err.textContent = "Passwords do not match."; return; }
    fetch("/v1/admin/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: a }) })
      .then(function (res) {
        if (!res.ok) throw new Error("setup failed: " + res.status);
        sessionStorage.setItem(KEY, a);
        document.getElementById("setupPw1").value = "";
        document.getElementById("setupPw2").value = "";
        showApp(); loadRuns(); loadTokens();
      })
      .catch(function () { err.textContent = "Could not create password (12+ characters)."; });
  });

  function loadSettings() {
    api("/v1/admin/settings").then(function (s) {
      var info = document.getElementById("settingsInfo");
      info.textContent = "";
      info.appendChild(el("span", "Admin password: managed via " + s.adminSource + ". "));
      info.appendChild(el("span", "Webhook secret: " + (s.webhookSecretSource === "none" ? "not set." : "managed via " + s.webhookSecretSource + ".")));
      document.getElementById("webhookForm").style.display = s.webhookSecretSource === "env" ? "none" : "flex";
      document.getElementById("settingsOk").textContent = "";
    }).catch(function () {});
  }

  document.getElementById("webhookForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("settingsErr");
    var ok = document.getElementById("settingsOk");
    err.textContent = ""; ok.textContent = "";
    var v = document.getElementById("webhookInput").value;
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify({ webhookSecret: v }) })
      .then(function () {
        document.getElementById("webhookInput").value = "";
        ok.textContent = "Saved.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (16+ characters)."; });
  });

  fetch("/v1/admin/status").then(function (res) { return res.json(); }).then(function (st) {
    if (!st.configured && !token()) { showSetup(); }
    else if (token()) { showApp(); loadRuns(); loadTokens(); }
    else { showLogin(); }
  }).catch(function () { showLogin(); });
})();
</script>
</body>
</html>`;
