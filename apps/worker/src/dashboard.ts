export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Flare Actions dashboard: CI runs, job logs, access tokens, and GitHub App settings.">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231c2330'/%3E%3Ctext x='16' y='23' font-family='system-ui,sans-serif' font-size='19' font-weight='800' fill='white' text-anchor='middle'%3EF%3C/text%3E%3C/svg%3E">
<title>Flare Actions</title>
<style>
:root { color-scheme: light; --bg: #f6f7f9; --card: #ffffff; --line: #e3e6eb; --ink: #1c2330; --muted: #687182; --accent: #2563eb; --accent-ink: #1d4ed8; --danger: #dc2626; --ok: #15803d; --hover: #f0f3f8; --input-bg: #ffffff; }
@media (prefers-color-scheme: dark) {
:root { color-scheme: dark; --bg: #0d1117; --card: #161b22; --line: #2d333b; --ink: #e6e9ef; --muted: #9aa4b2; --accent: #4d7cfe; --accent-ink: #9db9ff; --danger: #f26d6d; --ok: #3fb950; --hover: #1c2128; --input-bg: #0d1117; }
.pill.queued { background: #2d333b; color: var(--muted); }
.pill.running { background: #1c2c52; color: #9db9ff; }
.pill.success { background: #12341f; color: #3fb950; }
.pill.failure, .pill.error { background: #3d1d1d; color: #f26d6d; }
.pill.blocked { background: #3a2c12; color: #d29922; }
.pill.cancelled, .pill.skipped { background: #2d333b; color: var(--muted); }
div.triage { background: var(--hover); }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; }
header h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
main { max-width: 960px; margin: 0 auto; padding: 20px 20px 40px; }
section.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
h2 { margin: 0 0 10px; font-size: 15px; font-weight: 650; letter-spacing: -0.005em; }
h2:not(:first-child) { margin-top: 24px; }
h3 { margin: 16px 0 6px; font-size: 13.5px; font-weight: 650; }
.muted { color: var(--muted); }
.err { color: var(--danger); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
input, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--input-bg); color: var(--ink); }
button { background: var(--accent); color: #fff; border: none; cursor: pointer; font-weight: 600; transition: filter 160ms ease, transform 60ms ease; }
button:hover:not(:disabled) { filter: brightness(1.08); }
button:active:not(:disabled) { transform: translateY(1px); }
button.ghost { background: var(--hover); color: var(--ink); }
button.danger { background: var(--danger); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
#runsFilterForm { margin-bottom: 6px; }
#dispatchBox { margin-bottom: 12px; }
#dispatchBox summary { cursor: pointer; color: var(--accent-ink); font-weight: 600; margin-bottom: 8px; }
#dispatchBox p { margin: 6px 0 0; }
.secret-row { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
#secretNames { margin: 4px 0 8px; }
#runsCount { margin: 0 0 8px; font-size: 12.5px; }
a { color: var(--accent); }
nav.tabs { display: flex; gap: 8px; margin-bottom: 16px; }
nav.tabs button { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
nav.tabs button.active { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 12px; font-weight: 650; color: var(--muted); letter-spacing: 0.01em; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr.clickable { cursor: pointer; }
tbody tr.clickable:hover { background: var(--hover); }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pill.queued { background: #eef1f5; color: var(--muted); }
.pill.running { background: #dbeafe; color: #1d4ed8; }
.pill.success { background: #dcfce7; color: var(--ok); }
.pill.failure, .pill.error { background: #fee2e2; color: var(--danger); }
.pill.blocked { background: #fef3c7; color: #92400e; }
.pill.cancelled, .pill.skipped { background: #eef1f5; color: var(--muted); text-decoration: line-through; }
pre.log { background: #0f1520; color: #d7e0ee; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; }
div.triage { border: 1px solid var(--line); background: var(--hover); padding: 10px 12px; border-radius: 8px; margin: 8px 0; white-space: pre-wrap; font-size: 13px; }
div.triage-label { font-size: 12px; font-weight: 700; color: var(--accent-ink); margin-bottom: 2px; }
div.empty { padding: 26px 8px; }
div.empty h3 { margin: 0 0 4px; font-size: 14px; }
div.empty p { margin: 0; color: var(--muted); font-size: 13px; max-width: 60ch; }
div.notice { border: 1px solid var(--line); background: var(--hover); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
div.notice h3 { margin: 0 0 2px; font-size: 14px; }
div.notice p { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
.run-row { display: flex; gap: 12px; align-items: center; padding: 11px 10px; border-bottom: 1px solid var(--line); cursor: pointer; }
.run-row:last-child { border-bottom: none; }
.run-row:hover, .run-row.selected { background: var(--hover); }
.run-main { flex: 1; min-width: 0; }
.run-repo { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-meta { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-time { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
details.step { border: 1px solid var(--line); border-radius: 8px; margin: 6px 0; }
details.step summary { cursor: pointer; padding: 8px 10px; }
details.step summary code { margin: 0 4px; }
details.step pre.log { margin: 0; border-top: 1px solid var(--line); border-radius: 0 0 8px 8px; }
details.fulllog { margin-top: 10px; }
details.fulllog summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600; margin-bottom: 6px; }
header h1.brand-head { display: flex; align-items: center; gap: 8px; }
code.token { display: block; background: #0f1520; color: #d7e0ee; padding: 12px; border-radius: 8px; word-break: break-all; font-size: 12.5px; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form.inline input { flex: 1; min-width: 180px; }
.auth-card { padding: 28px; }
.auth-narrow { max-width: 420px; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--ink); color: #fff; font-weight: 800; font-size: 17px; }
.brand-name { font-weight: 700; font-size: 16px; }
#connectBox, #githubBox { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
#emailBox h2, #connectBox h2 { margin: 0 0 4px; font-size: 16px; }
.auth-form { display: flex; flex-direction: column; gap: 12px; margin: 12px 0 4px; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 600; }
.field input { width: 100%; }
.btn-block { width: 100%; padding: 10px; font-weight: 600; }
.btn-github { background: #111418; color: #fff; border: none; cursor: pointer; border-radius: 8px; font: inherit; padding: 10px; }
.btn-github:hover { background: #000; }
</style>
</head>
<body>
<header>
<h1 class="brand-head"><span class="brand-mark">F</span><span>Flare Actions</span></h1>
<div><span id="userLabel" class="muted"></span> <button id="logoutBtn" class="ghost" hidden>Log out</button></div>
</header>
<main>
<section id="authPane" class="card auth-card" hidden>
<div class="auth-narrow">
<div class="brand"><span class="brand-mark">F</span><span class="brand-name">Flare Actions</span></div>
<div id="emailBox">
<h2 id="emailTitle">Log in with email</h2>
<p class="muted" id="emailDesc">Welcome back.</p>
<form id="emailForm" class="auth-form">
<label class="field"><span>Email</span><input id="emailInput" type="email" placeholder="you@example.com" autocomplete="email" maxlength="254"></label>
<label class="field"><span>Password</span><input id="emailPw" type="password" placeholder="Password" autocomplete="current-password"></label>
<label class="field" id="emailPw2Wrap" hidden><span>Confirm password</span><input id="emailPw2" type="password" placeholder="Confirm password" autocomplete="new-password"></label>
<button type="submit" id="emailBtn" class="btn-block">Log in</button>
</form>
<p id="emailErr" class="err"></p>
</div>
<div id="connectBox">
<h2>Connect GitHub</h2>
<p class="muted">One click creates the GitHub App: webhooks, commit statuses, and login.</p>
<form id="connectForm" class="auth-form">
<button type="submit" class="btn-block">Connect GitHub</button>
</form>
<p id="connectErr" class="err"></p>
</div>
<div id="githubBox">
<button id="githubLoginBtn" class="btn-github btn-block">Login with GitHub</button>
<p id="authInstallBox" hidden><a id="authInstallLink" href="#" target="_blank" rel="noopener">Install the App on your repos first</a></p>
<p id="loginMsg"></p>
<div id="breakGlassBox" hidden>
<p class="muted">Or use the recovery password.</p>
<form id="recoveryForm" class="auth-form">
<label class="field"><span>Recovery password</span><input id="recoveryInput" type="password" placeholder="Recovery password" autocomplete="current-password"></label>
<button type="submit" class="btn-block ghost">Log in</button>
</form>
<p id="recoveryErr" class="err"></p>
</div>
<p id="loginErr" class="err"></p>
</div>
</div>
</section>
<section id="invitePane" class="card auth-card" hidden>
<div class="auth-narrow">
<div class="brand"><span class="brand-mark">F</span><span class="brand-name">Flare Actions</span></div>
<h2>You've been invited</h2>
<p class="muted" id="inviteInfo"></p>
<form id="inviteForm" class="auth-form">
<label class="field"><span>New password</span><input id="invitePw1" type="password" placeholder="8+ characters" autocomplete="new-password"></label>
<label class="field"><span>Confirm password</span><input id="invitePw2" type="password" placeholder="Confirm password" autocomplete="new-password"></label>
<button type="submit" class="btn-block">Create account</button>
</form>
<p id="inviteErr" class="err"></p>
</div>
</section>
<section id="appPane" hidden>
<nav class="tabs">
<button id="tabRuns" class="active">Runs</button>
<button id="tabAccess">Access</button>
<button id="tabSettings">Settings</button>
</nav>
<section id="runsPane" class="card">
<div id="connectBanner" hidden>
<h2>Finish setup</h2>
<p class="muted">Connect GitHub to run pushes from your repos — one click, then install the App.</p>
<p><button id="connectBannerBtn">Connect GitHub</button></p>
<p id="connectBannerErr" class="err"></p>
</div>
<div id="installNotice" class="notice" hidden>
<h3 id="installNoticeTitle">GitHub App installed</h3>
<p>Push to a connected repo to trigger your first run.</p>
<p><button id="installNoticeBtn" class="ghost">Got it</button></p>
</div>
<h2>Runs</h2>
<details id="dispatchBox">
<summary>Dispatch a run…</summary>
<form id="dispatchForm" class="inline">
<input id="dispatchRepo" placeholder="owner/repo" maxlength="100" aria-label="Repository">
<input id="dispatchRef" placeholder="branch, tag, or SHA" maxlength="128" aria-label="Branch, tag, or SHA">
<button type="submit">Dispatch</button>
</form>
<p id="dispatchErr" class="err"></p>
<p id="dispatchOk"></p>
</details>
<form id="runsFilterForm" class="inline"><input id="runsFilter" placeholder="Filter by repo, branch, commit, status…" maxlength="64" aria-label="Filter runs"></form>
<p class="muted" id="runsCount"></p>
<div id="runsList"></div>
<div id="runDetail" hidden></div>
</section>
<section id="accessPane" class="card" hidden>
<h2>Access tokens</h2>
<p class="muted">Issue tokens for runners and teammates. Runner tokens can pull jobs and update status; readonly tokens can only view runs. Revoked tokens stop working immediately.</p>
<form id="tokenForm" class="inline">
<input id="tokenName" placeholder="Token name, e.g. ci-laptop" maxlength="64">
<select id="tokenScope"><option value="runner">runner</option><option value="readonly">readonly</option><option value="admin">admin</option></select>
<button type="submit">Create token</button>
</form>
<p id="tokenErr" class="err"></p>
<div id="newTokenBox" hidden>
<p><strong>Copy this token now — it is shown once.</strong></p>
<code class="token" id="newTokenVal"></code>
<p><button id="copyTokenBtn" class="ghost" type="button">Copy</button></p>
</div>
<div class="table-scroll"><table><thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody id="tokensBody"></tbody></table></div>
<h2>GitHub users</h2>
<p class="muted" id="usersInfo"></p>
<form id="userForm" class="inline">
<input id="userLogin" placeholder="GitHub username" maxlength="39">
<button type="submit">Allow user</button>
</form>
<p id="userErr" class="err"></p>
<div class="table-scroll"><table><thead><tr><th>Username</th><th></th></tr></thead><tbody id="usersBody"></tbody></table></div>
<h2>Email users</h2>
<p class="muted" id="emailUsersInfo"></p>
<form id="inviteFormBtn" class="inline">
<input id="inviteEmail" type="email" placeholder="teammate@example.com" maxlength="254">
<button type="submit">Invite by email</button>
</form>
<p id="inviteUserErr" class="err"></p>
<div id="inviteLinkBox" hidden>
<p><strong>Send this invite link — it works once and expires in 24h.</strong></p>
<code class="token" id="inviteLinkVal"></code>
<p><button id="copyInviteBtn" class="ghost" type="button">Copy</button></p>
</div>
<div class="table-scroll"><table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody id="emailUsersBody"></tbody></table></div>
<h2>Pending invites</h2>
<div class="table-scroll"><table><thead><tr><th>Email</th><th>Expires</th></tr></thead><tbody id="invitesBody"></tbody></table></div>
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
<h2>Run notifications</h2>
<p class="muted" id="notifyInfo"></p>
<form id="notifyForm" class="inline">
<input id="notifyFromInput" placeholder="Sender email, e.g. ci@example.com" maxlength="254">
<select id="notifyModeSelect"><option value="all">all completions</option><option value="failures">failures only</option><option value="off">off</option></select>
<button type="submit">Save notifications</button>
</form>
<p id="notifyErr" class="err"></p>
<p id="notifyOk"></p>
<h2>Repository secrets</h2>
<p class="muted">Write-only values for &#36;{{ secrets.NAME }} in steps and env. Only names are ever listed back; values decrypt inside job claims only.</p>
<form id="secretLoadForm" class="inline">
<input id="secretRepoInput" placeholder="owner/repo" maxlength="100" aria-label="Repository">
<button type="submit">Load secrets</button>
</form>
<div id="secretNames"></div>
<form id="secretForm" class="inline">
<input id="secretNameInput" placeholder="NAME" maxlength="64" aria-label="Secret name">
<input id="secretValueInput" type="password" placeholder="value (never shown again)" maxlength="65536" aria-label="Secret value">
<button type="submit">Save secret</button>
</form>
<p id="secretErr" class="err"></p>
<p id="secretOk"></p>
<h2>GitHub App</h2>
<p class="muted" id="githubInfo"></p>
<form id="githubForm" class="inline">
<button type="submit">Connect GitHub</button>
</form>
<p id="githubErr" class="err"></p>
<p id="githubOk"></p>
<div id="githubInstallBox" hidden>
<p><strong>App connected — install it on your repos to run pushes.</strong></p>
<p><a id="githubInstallLink" href="#" target="_blank" rel="noopener">Install the GitHub App</a></p>
</div>
</section>
</section>
</main>
<script>
(function () {
  var KEY = "flare-admin-token";
  function token() { return sessionStorage.getItem(KEY) || ""; }
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; return e; }
  function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }
  function fmtAgo(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return iso;
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 30) return d + "d ago";
    return fmtTime(iso);
  }
  function timeCell(iso) { var td = el("td", fmtAgo(iso)); td.title = fmtTime(iso); return td; }
  function fmtDur(ms) {
    if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return null;
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return (s % 60) === 0 ? m + "m" : m + "m " + (s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function runDuration(r) {
    var a = Date.parse(r.created_at), b = Date.parse(r.updated_at);
    if (!isFinite(a) || !isFinite(b)) return null;
    return fmtDur(b - a);
  }
  function stateRow(body, cols, text, cls) {
    body.textContent = "";
    var tr = el("tr"); var td = el("td", text); td.colSpan = cols;
    if (cls) td.className = cls;
    tr.appendChild(td); body.appendChild(tr);
  }
  function pill(status) { var s = el("span", status); s.className = "pill " + status; return s; }

  var authPane = document.getElementById("authPane");
  var invitePane = document.getElementById("invitePane");
  var appPane = document.getElementById("appPane");
  var logoutBtn = document.getElementById("logoutBtn");
  var userLabel = document.getElementById("userLabel");
  var lastStatus = null;
  var inviteToken = null;

  function showInvite() {
    invitePane.hidden = false; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = "";
  }

  function showAuth(st) {
    lastStatus = st;
    invitePane.hidden = true;
    authPane.hidden = false; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = "";
    document.getElementById("emailPw2Wrap").hidden = st.claimed;
    document.getElementById("emailBtn").textContent = st.claimed ? "Log in" : "Create admin account";
    document.getElementById("emailTitle").textContent = st.claimed ? "Log in with email" : "Create admin account";
    document.getElementById("emailDesc").textContent = st.claimed ? "Welcome back." : "First account claims admin.";
    document.getElementById("connectBox").hidden = st.githubConnected;
    document.getElementById("breakGlassBox").hidden = !st.breakGlass;
    var installBox = document.getElementById("authInstallBox");
    if (st.githubConnected && st.installUrl) {
      installBox.hidden = false;
      document.getElementById("authInstallLink").href = st.installUrl;
    } else {
      installBox.hidden = true;
    }
  }
  var isAdmin = false;
  function showApp(actor, admin, githubConnected) {
    isAdmin = !!admin;
    document.getElementById("dispatchBox").hidden = !admin;
    invitePane.hidden = true;
    authPane.hidden = true; appPane.hidden = false; logoutBtn.hidden = false;
    document.getElementById("connectBanner").hidden = !(admin && !githubConnected);
    userLabel.textContent = actor ? actor + " " : "";
    tabAccess.hidden = !admin;
    tabSettings.hidden = !admin;
    if (!admin) selectTab("runs");
    var justInstalled = null;
    try { justInstalled = sessionStorage.getItem("flare-installed"); sessionStorage.removeItem("flare-installed"); } catch (e) {}
    var notice = document.getElementById("installNotice");
    if (justInstalled && admin) {
      if (justInstalled === "update") document.getElementById("installNoticeTitle").textContent = "GitHub App updated";
      notice.hidden = false;
      selectTab("runs");
    } else {
      notice.hidden = true;
    }
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (token()) headers["Authorization"] = "Bearer " + token();
    if (opts.headers) { for (var k in opts.headers) headers[k] = opts.headers[k]; }
    opts.headers = headers;
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        return fetch("/v1/admin/status").then(function (s) { return s.json(); }).then(function (st) {
          if (!st.user) { sessionStorage.removeItem(KEY); route(st); }
          throw new Error("unauthorized");
        });
      }
      if (!res.ok) {
        return res.json().then(function (b) {
          throw new Error((b && b.error) || ("request failed: " + res.status));
        }, function () { throw new Error("request failed: " + res.status); });
      }
      return res.json();
    });
  }

  function route(st) {
    if (st.user) {
      showApp(st.user.actor, st.user.admin, st.githubConnected);
      loadRuns();
      if (st.user.admin) { loadTokens(); loadUsers(); }
    } else {
      showAuth(st);
    }
  }

  function boot() {
    fetch("/v1/admin/status").then(function (res) { return res.json(); }).then(function (st) {
      var q = new URLSearchParams(window.location.search);
      var g = q.get("github");
      var inv = q.get("invite");
      var installed = q.get("installation_id");
      var setupAction = q.get("setup_action");
      if ((g || inv || installed || setupAction) && window.history && window.history.replaceState) window.history.replaceState({}, "", "/dashboard");
      if (installed) {
        try { sessionStorage.setItem("flare-installed", setupAction || "install"); } catch (e) {}
      }
      if (inv && !st.user) {
        inviteToken = inv;
        fetch("/v1/admin/invite/" + encodeURIComponent(inv)).then(function (res) {
          if (!res.ok) throw new Error("bad");
          return res.json();
        }).then(function (data) {
          document.getElementById("inviteInfo").textContent = "Create a password for " + data.email + ".";
          showInvite();
        }).catch(function () {
          route(st);
          document.getElementById("loginErr").textContent = "Invite invalid or expired.";
        });
        return;
      }
      route(st);
      handleGithubQuery(st, g, q.get("reason"));
    }).catch(function () { showAuth({ claimed: true, githubConnected: false, breakGlass: false, installUrl: null }); });
  }

  document.getElementById("emailForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("emailErr");
    err.textContent = "";
    var email = document.getElementById("emailInput").value.trim();
    var pw = document.getElementById("emailPw").value;
    var bootstrap = lastStatus && !lastStatus.claimed;
    if (bootstrap) {
      var pw2 = document.getElementById("emailPw2").value;
      if (pw !== pw2) { err.textContent = "Passwords do not match."; return; }
      fetch("/v1/admin/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: pw }) })
        .then(function (res) {
          if (!res.ok) throw new Error("bad");
          document.getElementById("emailInput").value = "";
          document.getElementById("emailPw").value = "";
          document.getElementById("emailPw2").value = "";
          boot();
        })
        .catch(function () { err.textContent = "Could not create account (valid email, 8+ char password)."; });
      return;
    }
    fetch("/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: pw }) })
      .then(function (res) {
        if (!res.ok) throw new Error("bad");
        document.getElementById("emailPw").value = "";
        boot();
      })
      .catch(function () { err.textContent = "Invalid email or password."; });
  });

  document.getElementById("inviteForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("inviteErr");
    err.textContent = "";
    var a = document.getElementById("invitePw1").value;
    var b = document.getElementById("invitePw2").value;
    if (a !== b) { err.textContent = "Passwords do not match."; return; }
    fetch("/v1/admin/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: inviteToken, password: a }) })
      .then(function (res) {
        if (!res.ok) throw new Error("bad");
        document.getElementById("invitePw1").value = "";
        document.getElementById("invitePw2").value = "";
        boot();
      })
      .catch(function () { err.textContent = "Could not create account (invite expired, or 8+ char password needed)."; });
  });

  document.getElementById("githubLoginBtn").addEventListener("click", function () {
    if (lastStatus && !lastStatus.githubConnected) {
      document.getElementById("loginMsg").textContent = "Connect GitHub first (step 1 above).";
      return;
    }
    window.location.href = "/v1/admin/github/login";
  });
  document.getElementById("recoveryForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var pw = document.getElementById("recoveryInput").value;
    var err = document.getElementById("recoveryErr");
    err.textContent = "";
    sessionStorage.setItem(KEY, pw);
    fetch("/v1/admin/status", { headers: { "Authorization": "Bearer " + pw } }).then(function (res) { return res.json(); }).then(function (st) {
      if (!st.user) throw new Error("bad");
      document.getElementById("recoveryInput").value = "";
      route(st);
    }).catch(function () {
      sessionStorage.removeItem(KEY);
      err.textContent = "Wrong password.";
    });
  });
  function submitManifest(postUrl, manifest) {
    var form = document.createElement("form");
    form.method = "POST";
    form.action = postUrl;
    var input = document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify(manifest);
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }
  function startConnect(errEl) {
    errEl.textContent = "";
    api("/v1/admin/github/connect", { method: "POST", body: JSON.stringify({}) })
      .then(function (data) { submitManifest(data.postUrl, data.manifest); })
      .catch(function () { errEl.textContent = "Could not start connect (already managed via environment)."; });
  }
  document.getElementById("connectForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    startConnect(document.getElementById("connectErr"));
  });
  document.getElementById("connectBannerBtn").addEventListener("click", function () {
    startConnect(document.getElementById("connectBannerErr"));
  });
  document.getElementById("installNoticeBtn").addEventListener("click", function () {
    document.getElementById("installNotice").hidden = true;
  });
  logoutBtn.addEventListener("click", function () {
    sessionStorage.removeItem(KEY);
    fetch("/v1/admin/logout", { method: "POST" }).then(boot, boot);
  });

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
  document.getElementById("runsFilter").addEventListener("input", function () { renderRuns(); });
  document.getElementById("runsFilterForm").addEventListener("submit", function (ev) { ev.preventDefault(); });
  function copyText(text, btn) {
    function done(ok) {
      btn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { done(document.execCommand("copy")); } catch (e) { done(false); }
      document.body.removeChild(ta);
    }
  }
  document.getElementById("copyTokenBtn").addEventListener("click", function () {
    copyText(document.getElementById("newTokenVal").textContent, this);
  });
  document.getElementById("copyInviteBtn").addEventListener("click", function () {
    copyText(document.getElementById("inviteLinkVal").textContent, this);
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    var box = document.getElementById("runDetail");
    var back = document.getElementById("backToRuns");
    if (!box.hidden && back) back.click();
  });
  tabRuns.addEventListener("click", function () { selectTab("runs"); loadRuns(); });
  tabAccess.addEventListener("click", function () { selectTab("access"); loadTokens(); loadUsers(); });
  tabSettings.addEventListener("click", function () { selectTab("settings"); loadSettings(); });

  var selectedRunId = null;
  var lastRuns = [];
  function runMatches(r, q) {
    if (!q) return true;
    return ((r.repo || "") + " " + (r.branch || "") + " " + (r.sha || "") + " " + (r.status || "") + " " + (r.event || "")).toLowerCase().indexOf(q) !== -1;
  }
  function renderRuns() {
    var list = document.getElementById("runsList");
    list.textContent = "";
    var q = document.getElementById("runsFilter").value.trim().toLowerCase();
    var shown = 0;
    lastRuns.forEach(function (r) {
      if (runMatches(r, q)) { shown++; appendRunRow(list, r); }
    });
    var count = document.getElementById("runsCount");
    if (!lastRuns.length) { count.textContent = ""; }
    else if (shown === lastRuns.length) { count.textContent = lastRuns.length + " runs"; }
    else { count.textContent = "Showing " + shown + " of " + lastRuns.length + " runs"; }
    if (!list.children.length) {
      var empty = el("div"); empty.className = "empty";
      if (!lastRuns.length) {
        empty.appendChild(el("h3", "No runs yet"));
        empty.appendChild(el("p", "Push to a repo with the GitHub App installed, or dispatch one from this page."));
      } else {
        empty.appendChild(el("h3", "No runs match"));
        empty.appendChild(el("p", "Try a different filter."));
      }
      list.appendChild(empty);
    }
  }
  function loadRuns() {
    var list = document.getElementById("runsList");
    list.textContent = "";
    var loading = el("p", "Loading runs…"); loading.className = "muted"; list.appendChild(loading);
    api("/v1/runs").then(function (data) {
      lastRuns = data.runs || [];
      renderRuns();
    }).catch(function () {
      list.textContent = "";
      var err = el("p"); err.appendChild(el("span", "Could not load runs. "));
      var retry = el("button", "Retry"); retry.className = "ghost";
      retry.addEventListener("click", function () { loadRuns(); });
      err.appendChild(retry); list.appendChild(err);
    });
  }
  function appendRunRow(list, r) {
    var row = el("div");
    row.className = "run-row" + (r.id === selectedRunId ? " selected" : "");
    row.appendChild(pill(r.status));
    var main = el("div"); main.className = "run-main";
    var repo = el("div", r.repo); repo.className = "run-repo"; main.appendChild(repo);
    var meta = el("div"); meta.className = "run-meta";
    meta.appendChild(el("span", (r.branch || "—") + " · "));
    var code = el("code", String(r.sha).slice(0, 7)); code.className = "mono"; meta.appendChild(code);
    var dur = runDuration(r);
    meta.appendChild(el("span", " · " + r.event + (dur ? " · " + dur : "")));
    main.appendChild(meta);
    row.appendChild(main);
    var t = el("span", fmtAgo(r.updated_at)); t.className = "run-time"; t.title = fmtTime(r.updated_at); row.appendChild(t);
    row.addEventListener("click", function () { selectedRunId = r.id; loadRun(r.id, true); });
    list.appendChild(row);
  }

  var runDetailOpenId = null;
  var TERMINAL = { success: 1, failure: 1, error: 1, cancelled: 1, skipped: 1 };
  function detailIsTerminal() {
    var box = document.getElementById("runDetail");
    if (box.hidden) return true;
    var pills = box.getElementsByClassName("pill");
    if (!pills.length) return true;
    return !!TERMINAL[pills[0].textContent || ""];
  }
  function loadRun(id, scroll) {
    api("/v1/runs/" + encodeURIComponent(id)).then(function (data) {
      var box = document.getElementById("runDetail");
      box.textContent = "";
      box.hidden = false;
      runDetailOpenId = data.run.id;
      var head = el("h2");
      head.appendChild(el("span", data.run.repo + " @ "));
      var shaCode = el("code", String(data.run.sha).slice(0, 7)); shaCode.className = "mono"; head.appendChild(shaCode);
      head.appendChild(el("span", " "));
      head.appendChild(pill(data.run.status));
      box.appendChild(head);
      if (data.summary) {
        box.appendChild(el("p", data.summary.finishedJobs + "/" + data.summary.jobs + " jobs finished, " +
          data.summary.computeMinutes + " compute-min (~$" + data.summary.actionsListUsd + " at Actions list price)"));
      }
      (data.jobs || []).forEach(function (j) {
        var jhead = el("h3");
        jhead.appendChild(el("span", "Job " + (j.name ? j.name + " " : "") + j.id.slice(0, 8) + " "));
        jhead.appendChild(pill(j.status));
        var meta = [];
        if (j.labels) meta.push(j.labels);
        if (j.durationMs !== null && j.durationMs !== undefined) meta.push((j.durationMs / 1000) + "s");
        if (meta.length) { var mspan = el("span", " " + meta.join(" · ")); mspan.className = "muted"; jhead.appendChild(mspan); }
        box.appendChild(jhead);
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
        var hasSteps = false;
        try {
          var parsed = j.result ? JSON.parse(j.result) : null;
          if (parsed && Array.isArray(parsed.steps) && parsed.steps.length) {
            hasSteps = true;
            var failOpened = false;
            parsed.steps.forEach(function (s) {
              if (s.output) {
                var det = document.createElement("details"); det.className = "step";
                if (!failOpened && s.exitCode !== 0) { det.open = true; failOpened = true; }
                var sum = el("summary");
                sum.appendChild(el("span", "[" + (s.exitCode === 0 ? "ok" : "FAIL") + "] "));
                var cmd = el("code", s.command); cmd.className = "mono"; sum.appendChild(cmd);
                sum.appendChild(el("span", " (exit " + s.exitCode + ", " + s.durationMs + "ms)"));
                det.appendChild(sum);
                var out = el("pre", String(s.output)); out.className = "log"; det.appendChild(out);
                box.appendChild(det);
              } else {
                var line = el("p");
                line.appendChild(el("span", "[" + (s.exitCode === 0 ? "ok" : "FAIL") + "] "));
                var cmd2 = el("code", s.command); cmd2.className = "mono"; line.appendChild(cmd2);
                line.appendChild(el("span", " (exit " + s.exitCode + ", " + s.durationMs + "ms)"));
                box.appendChild(line);
              }
            });
          }
        } catch (e) { /* legacy jobs without structured results */ }
        if (j.triage) {
          var tri = el("div");
          tri.className = "triage";
          var tlabel = el("div", "AI triage"); tlabel.className = "triage-label"; tri.appendChild(tlabel);
          tri.appendChild(document.createTextNode("\\n" + j.triage));
          box.appendChild(tri);
        }
        var fdet = document.createElement("details"); fdet.className = "fulllog";
        if (!hasSteps) fdet.open = true;
        fdet.appendChild(el("summary", "Full log"));
        var pre = el("pre", j.log || "(no log output)");
        pre.className = "log"; fdet.appendChild(pre);
        box.appendChild(fdet);
      });
      var back = el("button", "Back to runs");
      back.id = "backToRuns";
      back.className = "ghost";
      back.addEventListener("click", function () { box.hidden = true; runDetailOpenId = null; selectedRunId = null; loadRuns(); });
      box.appendChild(back);
      if (scroll) box.scrollIntoView();
    }).catch(function () {});
  }
  document.getElementById("dispatchForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("dispatchErr");
    var ok = document.getElementById("dispatchOk");
    err.textContent = ""; ok.textContent = "";
    var repo = document.getElementById("dispatchRepo").value.trim();
    var ref = document.getElementById("dispatchRef").value.trim();
    if (!repo || !ref) { err.textContent = "Repository and branch, tag, or SHA are required."; return; }
    ok.textContent = "Dispatching…";
    api("/v1/runs/dispatch", { method: "POST", body: JSON.stringify({ repo: repo, sha: ref }) })
      .then(function (data) {
        ok.textContent = "Run dispatched.";
        document.getElementById("dispatchBox").open = false;
        selectedRunId = data.runId;
        loadRuns();
        loadRun(data.runId, true);
      })
      .catch(function (e) { ok.textContent = ""; err.textContent = "Dispatch failed: " + (e.message || "error"); });
  });
  var pollStarted = false;
  function startPoll() {
    if (pollStarted) return;
    pollStarted = true;
    setInterval(function () {
      if (document.hidden || appPane.hidden || runsPane.hidden) return;
      loadRuns();
      if (runDetailOpenId && !detailIsTerminal()) loadRun(runDetailOpenId, false);
    }, 15000);
  }

  function secretRepo() { return document.getElementById("secretRepoInput").value.trim(); }
  function loadSecrets() {
    var err = document.getElementById("secretErr");
    var box = document.getElementById("secretNames");
    err.textContent = "";
    document.getElementById("secretOk").textContent = "";
    var repo = secretRepo();
    if (!repo) { err.textContent = "Enter a repository first."; return; }
    box.textContent = "";
    var loading = el("p", "Loading…"); loading.className = "muted"; box.appendChild(loading);
    api("/v1/admin/secrets?repo=" + encodeURIComponent(repo)).then(function (data) {
      box.textContent = "";
      var names = data.secrets || [];
      if (!names.length) {
        var none = el("p", "No secrets for this repo yet.");
        none.className = "muted";
        box.appendChild(none);
        return;
      }
      names.forEach(function (name) {
        var row = el("div");
        row.className = "secret-row";
        var code = el("code", name); code.className = "mono"; row.appendChild(code);
        var del = el("button", "Delete");
        del.className = "danger";
        del.addEventListener("click", function () {
          api("/v1/admin/secrets?repo=" + encodeURIComponent(secretRepo()) + "&name=" + encodeURIComponent(name), { method: "DELETE" })
            .then(loadSecrets)
            .catch(function (e) { err.textContent = "Delete failed: " + (e.message || "error"); });
        });
        row.appendChild(del);
        box.appendChild(row);
      });
    }).catch(function (e) { box.textContent = ""; err.textContent = "Could not load secrets: " + (e.message || "error"); });
  }
  document.getElementById("secretLoadForm").addEventListener("submit", function (ev) { ev.preventDefault(); loadSecrets(); });
  document.getElementById("secretForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("secretErr");
    var ok = document.getElementById("secretOk");
    err.textContent = ""; ok.textContent = "";
    var repo = secretRepo();
    var name = document.getElementById("secretNameInput").value.trim();
    var value = document.getElementById("secretValueInput").value;
    if (!repo) { err.textContent = "Enter a repository first."; return; }
    if (!name) { err.textContent = "Enter a secret name."; return; }
    if (!value) { err.textContent = "Enter a secret value."; return; }
    api("/v1/admin/secrets", { method: "POST", body: JSON.stringify({ repo: repo, name: name, value: value }) })
      .then(function () {
        ok.textContent = "Secret saved.";
        document.getElementById("secretNameInput").value = "";
        document.getElementById("secretValueInput").value = "";
        loadSecrets();
      })
      .catch(function (e) { err.textContent = "Save failed: " + (e.message || "error"); });
  });
  function loadTokens() {
    var body = document.getElementById("tokensBody");
    stateRow(body, 5, "Loading tokens…", "muted");
    api("/v1/admin/tokens").then(function (data) {
      body.textContent = "";
      (data.tokens || []).forEach(function (t) {
        var tr = el("tr");
        tr.appendChild(el("td", t.name));
        tr.appendChild(el("td", t.scopes));
        tr.appendChild(timeCell(t.created_at));
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
      if (!body.children.length) stateRow(body, 5, "No tokens yet — create one above.", "muted");
    }).catch(function () { stateRow(body, 5, "Could not load tokens.", "err"); });
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

  function loadUsers() {
    stateRow(document.getElementById("usersBody"), 2, "Loading…", "muted");
    stateRow(document.getElementById("emailUsersBody"), 3, "Loading…", "muted");
    stateRow(document.getElementById("invitesBody"), 2, "Loading…", "muted");
    api("/v1/admin/users").then(function (data) {
      var adminLabel = data.admin ? "@" + data.admin : (data.adminEmail ? data.adminEmail : "—");
      document.getElementById("usersInfo").textContent =
        "Admin: " + adminLabel + ". Allowed users can view runs.";
      var body = document.getElementById("usersBody");
      body.textContent = "";
      (data.users || []).forEach(function (u) {
        var tr = el("tr");
        tr.appendChild(el("td", "@" + u));
        var tdBtn = el("td");
        var btn = el("button", "Remove");
        btn.className = "danger";
        btn.addEventListener("click", function () {
          api("/v1/admin/users", { method: "POST", body: JSON.stringify({ login: u, action: "remove" }) })
            .then(loadUsers).catch(function () {});
        });
        tdBtn.appendChild(btn);
        tr.appendChild(tdBtn);
        body.appendChild(tr);
      });
      if (!body.children.length) stateRow(body, 2, "No allowed GitHub users.", "muted");
      document.getElementById("emailUsersInfo").textContent =
        (data.emailUsers || []).length ? "" : "No email accounts yet — invite teammates below.";
      var ebody = document.getElementById("emailUsersBody");
      ebody.textContent = "";
      (data.emailUsers || []).forEach(function (u) {
        var tr = el("tr");
        tr.appendChild(el("td", u.email));
        tr.appendChild(el("td", u.isAdmin ? "admin" : "viewer"));
        var tdBtn = el("td");
        if (!u.isAdmin) {
          var btn = el("button", "Remove");
          btn.className = "danger";
          (function (email) {
            btn.addEventListener("click", function () {
              api("/v1/admin/users/email", { method: "POST", body: JSON.stringify({ email: email, action: "remove" }) })
                .then(loadUsers).catch(function () {});
            });
          })(u.email);
          tdBtn.appendChild(btn);
        }
        tr.appendChild(tdBtn);
        ebody.appendChild(tr);
      });
      var ibody = document.getElementById("invitesBody");
      ibody.textContent = "";
      (data.invites || []).forEach(function (inv) {
        var tr = el("tr");
        tr.appendChild(el("td", inv.email));
        tr.appendChild(timeCell(inv.expiresAt));
        ibody.appendChild(tr);
      });
      if (!ibody.children.length) {
        var tr = el("tr"); var td = el("td", "No pending invites."); td.colSpan = 2; td.className = "muted"; tr.appendChild(td); ibody.appendChild(tr);
      }
    }).catch(function () { document.getElementById("usersInfo").textContent = "Could not load users."; });
  }

  document.getElementById("inviteFormBtn").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("inviteUserErr");
    err.textContent = "";
    document.getElementById("inviteLinkBox").hidden = true;
    var v = document.getElementById("inviteEmail").value.trim();
    api("/v1/admin/users/invite", { method: "POST", body: JSON.stringify({ email: v }) })
      .then(function (data) {
        document.getElementById("inviteLinkVal").textContent = data.inviteUrl;
        document.getElementById("inviteLinkBox").hidden = false;
        document.getElementById("inviteEmail").value = "";
        loadUsers();
      })
      .catch(function () { err.textContent = "Could not invite (valid email, not already registered)."; });
  });

  document.getElementById("userForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("userErr");
    err.textContent = "";
    var v = document.getElementById("userLogin").value.trim();
    api("/v1/admin/users", { method: "POST", body: JSON.stringify({ login: v, action: "add" }) })
      .then(function () { document.getElementById("userLogin").value = ""; loadUsers(); })
      .catch(function () { err.textContent = "Could not add user (valid GitHub username required)."; });
  });

  function loadSettings() {
    api("/v1/admin/settings").then(function (s) {
      var info = document.getElementById("settingsInfo");
      info.textContent = "";
      var adminLabel = s.adminGithubUser ? "@" + s.adminGithubUser + " (GitHub)" : (s.adminEmail ? s.adminEmail + " (email)" : null);
      info.appendChild(el("span", "Admin: " + (adminLabel ? adminLabel + ". " : "not claimed. ")));
      info.appendChild(el("span", "Webhook secret: " + (s.webhookSecretSource === "none" ? "not set." : "managed via " + s.webhookSecretSource + ".")));
      document.getElementById("webhookForm").style.display = s.webhookSecretSource === "env" ? "none" : "flex";
      document.getElementById("settingsOk").textContent = "";
      document.getElementById("notifyInfo").textContent =
        "Emails go to all registered email users." +
        (s.notifyFromSource === "env" ? " Sender managed via environment." : " Sender domain must be enabled for Email Sending.");
      document.getElementById("notifyFromInput").value = s.notifyFrom || "";
      document.getElementById("notifyModeSelect").value = s.notifyMode || "all";
      document.getElementById("notifyForm").style.display = s.notifyFromSource === "env" ? "none" : "flex";
      document.getElementById("notifyOk").textContent = "";
      var g = s.githubApp || { source: "none", installUrl: null };
      document.getElementById("githubInfo").textContent =
        "GitHub App: " + (g.source === "none" ? "not connected." : "connected via " + g.source + ".");
      document.getElementById("githubForm").style.display = g.source === "none" ? "flex" : "none";
      var box = document.getElementById("githubInstallBox");
      if (g.installUrl) {
        box.hidden = false;
        document.getElementById("githubInstallLink").href = g.installUrl;
      } else {
        box.hidden = true;
      }
    }).catch(function () { document.getElementById("settingsErr").textContent = "Could not load settings."; });
  }

  document.getElementById("githubForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("githubErr");
    var ok = document.getElementById("githubOk");
    err.textContent = ""; ok.textContent = "";
    api("/v1/admin/github/connect", { method: "POST", body: JSON.stringify({}) })
      .then(function (data) { submitManifest(data.postUrl, data.manifest); })
      .catch(function () { err.textContent = "Could not start connect (already managed via environment)."; });
  });

  function handleGithubQuery(st, status, reason) {
    if (!status) return;
    if (st.user) {
      if (status === "connected") {
        selectTab("settings");
        loadSettings();
        document.getElementById("githubOk").textContent = "App created and connected. Install it on your repos.";
      }
      return;
    }
    if (status === "connected") {
      document.getElementById("loginMsg").textContent = "App connected — log in with GitHub to claim admin.";
    } else if (status === "forbidden") {
      document.getElementById("loginErr").textContent = "That GitHub user is not allowed. Ask the admin.";
    } else if (status === "error") {
      var msg = reason === "expired" ? "Login expired — try again."
        : reason === "exchange" ? "GitHub refused the exchange — try again."
        : reason === "noapp" ? "Connect GitHub first (step 1 above)."
        : "Something failed — try again.";
      document.getElementById("loginErr").textContent = msg;
    }
  }

  document.getElementById("notifyForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("notifyErr");
    var ok = document.getElementById("notifyOk");
    err.textContent = ""; ok.textContent = "";
    var from = document.getElementById("notifyFromInput").value.trim();
    var mode = document.getElementById("notifyModeSelect").value;
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify({ notifyFromEmail: from, notifyMode: mode }) })
      .then(function () {
        ok.textContent = "Saved.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (valid sender email required)."; });
  });

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

  boot();
  startPoll();
})();
</script>
</body>
</html>`;
