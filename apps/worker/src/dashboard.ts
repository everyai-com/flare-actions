export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Flare Actions dashboard: CI runs, job logs, access tokens, and GitHub App settings.">
<meta name="theme-color" content="#161616">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234124fb'/%3E%3Ctext x='16' y='23' font-family='system-ui,sans-serif' font-size='19' font-weight='800' fill='white' text-anchor='middle'%3EF%3C/text%3E%3C/svg%3E">
<title>Flare Actions</title>
<style>
:root { color-scheme: dark; --bg: #161616; --card: #1b1d20; --sidebar: #171717; --line: #232323; --line-strong: #393939; --ink: #f9fbff; --soft: #a4a4a4; --muted: #7f7f7f; --faint: #454545; --accent: #4124fb; --accent-hover: #4b30ff; --accent-ink: #b7aee9; --danger: #f97373; --ok: #22c55e; --warn: #fbbf24; --hover: #222222; --input-bg: #161616; --ring: #676767; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: var(--sidebar); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; }
header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
main { max-width: 960px; margin: 0 auto; padding: 20px 20px 40px; }
section.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
h2 { margin: 0 0 10px; font-size: 16px; font-weight: 600; line-height: 1.2; letter-spacing: -0.005em; }
h2:not(:first-child) { margin-top: 24px; }
h3 { margin: 16px 0 6px; font-size: 14px; font-weight: 600; line-height: 1.2; }
.muted { color: var(--muted); }
.err { color: var(--danger); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
input, select, textarea { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--input-bg); color: var(--ink); }
textarea { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.feed-item { border-bottom: 1px solid var(--line); padding: 2px 0 10px; margin-bottom: 6px; }
.feed-item:last-child { border-bottom: none; }
.feed-actions { display: flex; gap: 8px; align-items: center; margin: 6px 0 0 10px; flex-wrap: wrap; }
.template-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 8px 0; }
.template-card h3 { margin: 0 0 4px; }
.template-card p { margin: 4px 0; }
input::placeholder { color: var(--faint); }
button { font: inherit; font-size: 14px; font-weight: 500; line-height: 1; padding: 9px 16px; border-radius: 999px; border: none; background: var(--accent); color: #fff; cursor: pointer; box-shadow: 0 0 0 1px #0e0e0e, inset 0 4px 6px 0 rgba(255,255,255,0.2), inset 0 0 0 1px rgba(255,255,255,0.15), inset 0 -8px 14px 0 rgba(0,0,0,0.15); transition: background-color 150ms ease; }
button:hover:not(:disabled) { background: var(--accent-hover); }
button.ghost { background: #232323; color: var(--ink); box-shadow: 0 0 0 1px #333333; }
button.ghost:hover:not(:disabled) { background: #2a2a2a; }
button.danger { background: #3e1d1e; color: #febfc6; box-shadow: inset 0 0 0 1px #4c2324; }
button.danger:hover:not(:disabled) { background: #4c2324; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
#runsFilterForm { margin-bottom: 6px; }
#dispatchBox { margin-bottom: 12px; }
#dispatchBox summary { cursor: pointer; color: var(--accent-ink); font-weight: 600; margin-bottom: 8px; }
#dispatchBox p { margin: 6px 0 0; }
.secret-row { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
.res-row { display: flex; gap: 8px; align-items: center; margin: 4px 0; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.res-row code { min-width: 140px; }
.res-bar { flex: 1 1 120px; max-width: 280px; height: 10px; background: var(--line); border-radius: 4px; overflow: hidden; }
.res-fill { height: 100%; background: var(--ring); }
#secretNames { margin: 4px 0 8px; }
#runsCount { margin: 0 0 8px; font-size: 12.5px; }
a { color: var(--accent-ink); }
nav.tabs { display: flex; gap: 4px; margin-bottom: 16px; }
nav.tabs button { background: transparent; color: var(--muted); box-shadow: none; border-radius: 8px; font-weight: 500; }
nav.tabs button:hover:not(:disabled) { background: rgba(255,255,255,0.06); color: var(--ink); }
nav.tabs button.active { background: #2a2a2a; color: var(--ink); box-shadow: 0 0 0 1px rgba(0,0,0,0.4), inset 0 1px 0 0 rgba(255,255,255,0.1), inset 0 0 0 1px rgba(255,255,255,0.06); }
.table-scroll { overflow-x: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 12px; font-weight: 500; color: var(--muted); letter-spacing: 0.01em; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr.clickable { cursor: pointer; }
tbody tr.clickable:hover { background: rgba(255,255,255,0.04); }
.pill { display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: 999px; border: 1px solid; font-size: 12px; font-weight: 500; line-height: 1; white-space: nowrap; }
.pill.queued { background: #2a2a2a; border-color: #363636; color: #cfcfcf; }
.pill.running { background: #1d2b3e; border-color: #23354c; color: #bfdbfe; }
.pill.success { background: #1f3a2d; border-color: #275137; color: #b1ebc5; }
.pill.failure, .pill.error { background: #3e1d1e; border-color: #4c2324; color: #febfc6; }
.pill.blocked { background: #31221b; border-color: #6c4830; color: #fed7aa; }
.pill.cancelled, .pill.skipped { background: #2a2a2a; border-color: #363636; color: #cfcfcf; text-decoration: line-through; }
pre.log { background: #101214; border: 1px solid var(--line); color: #d0d4dd; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent; }
div.triage { border: 1px solid #23354c; background: #1d2b3e; padding: 10px 12px; border-radius: 8px; margin: 8px 0; white-space: pre-wrap; font-size: 13px; color: #d0d4dd; }
div.triage-label { font-size: 12px; font-weight: 600; color: #bfdbfe; margin-bottom: 2px; }
div.empty { padding: 26px 8px; }
div.empty h3 { margin: 0 0 4px; font-size: 14px; }
div.empty p { margin: 0; color: var(--muted); font-size: 13px; max-width: 60ch; }
div.notice { border: 1px solid var(--line); background: var(--hover); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
div.notice h3 { margin: 0 0 2px; font-size: 14px; }
div.notice p { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
.run-row { display: flex; gap: 12px; align-items: center; padding: 11px 10px; border-bottom: 1px solid var(--line); cursor: pointer; border-radius: 8px; }
.run-row:last-child { border-bottom: none; }
.run-row:hover, .run-row.selected { background: rgba(255,255,255,0.04); }
.run-main { flex: 1; min-width: 0; }
.run-repo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-src { font-size: 11px; padding: 1px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); }
.run-src.actions { border-color: #23354c; color: #bfdbfe; }
.run-time { color: var(--muted); font-size: 12px; white-space: nowrap; }
details.step { border: 1px solid var(--line); border-radius: 8px; margin: 6px 0; }
details.step summary { cursor: pointer; padding: 8px 10px; }
details.step summary code { margin: 0 4px; }
details.step pre.log { margin: 0; border: none; border-top: 1px solid var(--line); border-radius: 0 0 8px 8px; }
details.fulllog { margin-top: 10px; }
details.fulllog summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600; margin-bottom: 6px; }
header h1.brand-head { display: flex; align-items: center; gap: 8px; }
code.token { display: block; background: #101214; border: 1px solid var(--line); color: #d0d4dd; padding: 12px; border-radius: 8px; word-break: break-all; font-size: 12.5px; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form.inline input { flex: 1; min-width: 180px; }
.auth-card { padding: 28px; }
.auth-narrow { max-width: 420px; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 800; font-size: 17px; box-shadow: 0 0 0 1px #0e0e0e, inset 0 2px 4px 0 rgba(255,255,255,0.25); }
.brand-name { font-weight: 600; font-size: 16px; }
#connectBox, #githubBox { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
#emailBox h2, #connectBox h2 { margin: 0 0 4px; font-size: 16px; }
.auth-form { display: flex; flex-direction: column; gap: 12px; margin: 12px 0 4px; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 600; }
.field input { width: 100%; }
.btn-block { width: 100%; padding: 10px; }
.btn-github { background: #232323; color: #fff; border: none; cursor: pointer; border-radius: 999px; font: inherit; padding: 10px; box-shadow: 0 0 0 1px #333333; }
.btn-github:hover { background: #2a2a2a; }
#githubBox .btn-block + .btn-block { margin-top: 8px; }
.divider { display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 12px; margin: 4px 0 2px; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
ol.steps { margin: 10px 0 0; padding: 0; list-style: none; counter-reset: step; max-width: 64ch; }
ol.steps li { counter-increment: step; display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; border-top: 1px solid var(--line); font-size: 13px; }
ol.steps li::before { content: counter(step); flex: none; width: 20px; height: 20px; border-radius: 999px; background: #2a2a2a; color: var(--ink); font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
ol.steps li.done::before { content: "✓"; background: #1f3a2d; color: #b1ebc5; }
ol.steps .step-body { flex: 1; min-width: 0; }
ol.steps .step-body p { margin: 0 0 6px; color: var(--muted); }
ol.steps .step-body p strong { color: var(--ink); font-weight: 600; }
@media (max-width: 640px) {
  html, body { overflow-x: hidden; }
  main { padding: 12px 12px 32px; }
  section.card { padding: 14px; }
  .auth-card { padding: 20px 16px; }
  header { padding: 10px 12px; gap: 8px; flex-wrap: wrap; }
  header h1 { font-size: 14px; }
  h2, h3 { overflow-wrap: anywhere; }
  nav.tabs { flex-wrap: wrap; }
  nav.tabs button { padding: 8px 12px; font-size: 13px; min-height: 44px; }
  .run-row { flex-wrap: wrap; }
  .run-time { width: 100%; }
  form.inline { flex-direction: column; align-items: stretch; }
  form.inline input, form.inline select { min-width: 0; width: 100%; font-size: 16px; }
  form.inline button, button { min-height: 44px; }
  .secret-row { flex-wrap: wrap; }
  .table-scroll { overflow-x: visible; }
  table, tbody { display: block; width: 100%; }
  thead { display: none; }
  table tr { display: block; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; padding: 6px 10px; }
  table td { display: block; border-bottom: none; padding: 5px 2px; text-align: left; overflow-wrap: anywhere; }
  table td:empty { display: none; }
  table td:first-child { font-weight: 600; }
  table td button { width: 100%; }
  .feed-actions { margin-left: 0; }
  .feed-actions button { flex: 1 1 100%; }
  .template-card { overflow-wrap: anywhere; }
  #tournamentsList button { white-space: normal; text-align: left; width: 100%; }
  #scheduleList > div, #monitorList > div, #ghRunnerList > div { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin: 8px 0; overflow-wrap: anywhere; }
  details.step summary { overflow-wrap: anywhere; }
  pre.log { white-space: pre-wrap; overflow-wrap: anywhere; }
}
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
<div id="tsEmail"></div>
<button type="submit" id="emailBtn" class="btn-block">Log in</button>
</form>
<p id="emailErr" class="err"></p>
<p class="muted"><button id="forgotBtn" class="ghost" type="button">Forgot password?</button></p>
<p class="muted"><button id="registerToggleBtn" class="ghost" type="button" hidden>No account? Create one</button></p>
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
<div class="divider" id="oauthDivider">or continue with</div>
<button id="githubLoginBtn" class="btn-github btn-block">Login with GitHub</button>
<p class="muted" id="githubOpenHint" hidden>Open registration is on — any GitHub user can log in (reader access).</p>
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
<div id="tsInvite"></div>
<button type="submit" class="btn-block">Create account</button>
</form>
<p id="inviteErr" class="err"></p>
</div>
</section>
<section id="resetPane" class="card auth-card" hidden>
<div class="auth-narrow">
<div class="brand"><span class="brand-mark">F</span><span class="brand-name">Flare Actions</span></div>
<h2>Reset your password</h2>
<p class="muted">If that account exists, we'll email a single-use reset link (1 hour).</p>
<form id="resetRequestForm" class="auth-form">
<label class="field"><span>Email</span><input id="resetEmailInput" type="email" placeholder="you@example.com" autocomplete="email" maxlength="254"></label>
<div id="tsReset"></div>
<button type="submit" class="btn-block">Send reset link</button>
</form>
<p id="resetRequestErr" class="err"></p>
<p id="resetRequestOk"></p>
<p class="muted"><button id="resetBackBtn" class="ghost" type="button">Back to login</button></p>
</div>
</section>
<section id="resetConfirmPane" class="card auth-card" hidden>
<div class="auth-narrow">
<div class="brand"><span class="brand-mark">F</span><span class="brand-name">Flare Actions</span></div>
<h2>Choose a new password</h2>
<form id="resetConfirmForm" class="auth-form">
<label class="field"><span>New password</span><input id="resetPw1" type="password" placeholder="8+ characters" autocomplete="new-password"></label>
<label class="field"><span>Confirm password</span><input id="resetPw2" type="password" placeholder="Confirm password" autocomplete="new-password"></label>
<button type="submit" class="btn-block">Update password</button>
</form>
<p id="resetConfirmErr" class="err"></p>
</div>
</section>
<section id="appPane" hidden>
<nav class="tabs">
<button id="tabRuns" class="active">Runs</button>
<button id="tabFeed">Feed</button>
<button id="tabTournaments">Tournaments</button>
<button id="tabSearch">Search</button>
<button id="tabFlaky">Flaky</button>
<button id="tabMerge">Merge queue</button>
<button id="tabTemplates">Templates</button>
<button id="tabApps">Apps</button>
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
<p id="usageStrip" class="muted"></p>
<p id="cacheStatsStrip" class="muted"></p>
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
<details id="bottlenecksBox" hidden>
<summary>Slowest checks (last 14 days)</summary>
<div id="bottlenecksBody" class="muted"></div>
</details>
<div id="runDetail" hidden></div>
</section>
<section id="feedPane" class="card" hidden>
<h2>Feed</h2>
<p class="muted">Latest runs across every repo, newest first — rerun failures, open the pull request, or follow the fix without leaving this page.</p>
<p><button id="feedRefresh" class="ghost">Refresh</button></p>
<p id="feedErr" class="err"></p>
<div id="feedList"></div>
</section>
<section id="accessPane" class="card" hidden>
<h2>Access tokens</h2>
<p class="muted">Issue tokens for runners and teammates. Runner tokens can pull jobs and update status; readonly tokens can only view runs. Revoked tokens stop working immediately.</p>
<form id="tokenForm" class="inline">
<input id="tokenName" placeholder="Token name, e.g. ci-laptop" maxlength="64">
<select id="tokenScope"><option value="runner">runner</option><option value="readonly">readonly</option><option value="admin">admin</option></select>
<input id="tokenRepos" placeholder="optional: owner/repo, owner/repo2 (blank = all repos)" maxlength="2000">
<button type="submit">Create token</button>
</form>
<p id="tokenErr" class="err"></p>
<div id="newTokenBox" hidden>
<p><strong>Copy this token now — it is shown once.</strong></p>
<code class="token" id="newTokenVal"></code>
<p><button id="copyTokenBtn" class="ghost" type="button">Copy</button></p>
</div>
<div class="table-scroll"><table><thead><tr><th>Name</th><th>Scopes</th><th>Repos</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody id="tokensBody"></tbody></table></div>
<h2>Pair a runner</h2>
<p class="muted">Zero-config machines: mint a code, paste one command on the fresh box, and it exchanges the code for a runner token and starts polling. Single use, expires in 10 minutes.</p>
<form id="pairForm" class="inline">
<input id="pairName" placeholder="Runner name, e.g. ci-metal-01" maxlength="64">
<button type="submit">Create pairing code</button>
</form>
<p id="pairErr" class="err"></p>
<div id="pairBox" hidden>
<p><strong>Run this on the new machine — the code works once.</strong></p>
<code class="token" id="pairCmd"></code>
<p><button id="copyPairBtn" class="ghost" type="button">Copy</button></p>
</div>
<h2>Connected apps</h2>
<p class="muted">OAuth apps teammates authorized on the MCP endpoint (Claude, ChatGPT, Cursor, …). Revoking disconnects the app immediately.</p>
<div class="table-scroll"><table><thead><tr><th>App</th><th>User</th><th>Scopes</th><th>Granted</th><th></th></tr></thead><tbody id="grantsBody"></tbody></table></div>
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
<h2>Audit log</h2>
<p class="muted">Who did what, most recent first (last 100 entries).</p>
<div class="table-scroll"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody id="auditBody"></tbody></table></div>
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
<details id="actionsHelp">
<summary>Coming from GitHub Actions?</summary>
<p class="muted">Repos without a <span class="mono">flare.yml</span> run their existing <span class="mono">.github/workflows</span> files as-is: matching <span class="mono">on:</span> triggers, run steps, matrices, needs, cache, and artifacts translate automatically, and anything unsupported is dropped with a note in the worker log instead of being guessed at. Each run is tagged in the list with which pipeline ran. <a href="https://github.com/everyai-com/flare-actions/blob/main/docs/GITHUB-ACTIONS-COMPAT.md" target="_blank" rel="noopener">Support matrix</a></p>
<p class="muted">No GitHub App? For public repos, add a plain repo webhook pointing at <span class="mono">https://&lt;this-worker&gt;/webhooks/github</span> with the secret above and pushes become runs. The App adds private repos, commit statuses, check runs, PR comments, and GitHub login.</p>
</details>
<h2>Run notifications</h2>
<p class="muted" id="notifyInfo"></p>
<form id="notifyForm" class="inline">
<input id="notifyFromInput" placeholder="Sender email, e.g. ci@example.com" maxlength="254">
<select id="notifyModeSelect"><option value="all">all completions</option><option value="failures">failures only</option><option value="off">off</option></select>
<button type="submit">Save notifications</button>
</form>
<p id="notifyErr" class="err"></p>
<p id="notifyOk"></p>
<form id="notifyWebhookForm" class="inline">
<input id="notifyWebhookInput" placeholder="Slack/Discord webhook URL (https, write-only)" maxlength="512">
<button type="submit">Save webhook</button>
</form>
<p class="muted" id="notifyWebhookInfo"></p>
<p id="notifyWebhookErr" class="err"></p>
<p id="notifyWebhookOk"></p>
<h2>Cloudflare billing</h2>
<p class="muted">A Billing-Read API token + account id lets <span class="mono">cli usage</span> show real Cloudflare dollars next to compute minutes. The token is write-only.</p>
<form id="billingForm" class="inline">
<input id="billingTokenInput" type="password" placeholder="Billing-Read API token (write-only)" maxlength="512" aria-label="Billing API token">
<input id="billingAccountInput" placeholder="Account id (32 hex chars)" maxlength="32" aria-label="Cloudflare account id">
<button type="submit">Save billing</button>
</form>
<p class="muted" id="billingInfo"></p>
<p id="billingErr" class="err"></p>
<p id="billingOk"></p>
<h2>Status badges</h2>
<p class="muted">Badge SVGs are public. Repos listed here (comma-separated owner/name) serve &quot;unknown&quot; instead, so private repositories never leak pass&#47;fail.</p>
<form id="badgeHiddenForm" class="inline">
<input id="badgeHiddenInput" placeholder="Private repos to hide, e.g. org/secret, org/private">
<button type="submit">Save badge visibility</button>
</form>
<p id="badgeErr" class="err"></p>
<p id="badgeOk"></p>
<h2>Bot protection (Turnstile)</h2>
<p class="muted" id="turnstileInfo"></p>
<form id="turnstileForm" class="inline">
<input id="turnstileSiteInput" placeholder="Site key (public)" maxlength="128">
<input id="turnstileSecretInput" type="password" placeholder="Secret key (write-only, blank keeps current)" maxlength="512">
<button type="submit">Save Turnstile</button>
</form>
<p id="turnstileErr" class="err"></p>
<p id="turnstileOk"></p>
<h2>Scheduling and AI</h2>
<p class="muted" id="schedInfo"></p>
<form id="schedForm" class="inline">
<input id="fairShareInput" placeholder="fair share per repo (0 = off)" maxlength="3" size="8">
<input id="agentShareInput" placeholder="fair share per agent (0 = off)" maxlength="3" size="8" aria-label="Fair share per agent">
<input id="budgetInput" placeholder="monthly budget: owner/name=1200, other=600" maxlength="512" size="40" aria-label="Monthly compute budgets">
<select id="budgetModeSelect" aria-label="Budget mode"><option value="warn">warn over budget</option><option value="block">block over budget</option></select>
<input id="killMultiplierInput" placeholder="kill at Nx cap (0 = off)" maxlength="3" size="8" aria-label="Kill switch multiplier">
<div id="pausedBox" class="muted"></div>
<label class="muted"><input id="supersedeCheck" type="checkbox"> one run per branch head (cancel superseded pushes)</label>
<input id="gatewayInput" placeholder="AI gateway id (blank = direct)" maxlength="64">
<input id="triageModelInput" placeholder="triage model (blank = default)" maxlength="128" size="30">
<label><input type="checkbox" id="writeConfirmCheck"> MCP write-confirm</label>
<label><input type="checkbox" id="webSearchCheck"> triage web search</label>
<label><input type="checkbox" id="healCheck"> heal on failure (draft PR + verify run)</label>
<label><input type="checkbox" id="openRegCheck"> open registration (anyone can join)</label>
<button type="submit">Save</button>
</form>
<p id="schedErr" class="err"></p>
<p id="schedOk"></p>
<h2>GitHub runners (the flare lane)</h2>
<p class="muted">GitHub keeps orchestrating; Flare registers one ephemeral JIT runner per job whose runs-on includes a managed label. Off by default. Needs the App's actions:read + administration:write — existing installs re-run Connect GitHub to accept the permission change.</p>
<form id="ghRunnerForm" class="inline">
<label><input type="checkbox" id="ghRunnerCheck"> runner mode on</label>
<input id="ghRunnerLabelsInput" placeholder="labels, e.g. flare, gpu" maxlength="128" size="30">
<button type="submit">Save</button>
</form>
<p id="ghRunnerErr" class="err"></p>
<p id="ghRunnerOk"></p>
<p class="muted">Workflow change, one line: <code>runs-on: flare</code> — checks and logs stay on GitHub. Executors run <code>npm run runner -- --github</code>.</p>
<div id="ghRunnerList"></div>
<h2>Schedules</h2>
<p class="muted">Run a repo on a cron schedule (UTC). &quot;last&quot; shows the most recent dispatch attempt, so a schedule that silently stops is visible instead of invisible.</p>
<form id="scheduleForm" class="inline">
<input id="scheduleRepoInput" placeholder="owner/repo" maxlength="100">
<input id="scheduleRefInput" placeholder="branch or tag (e.g. main)" maxlength="128">
<input id="scheduleCronInput" placeholder="cron (UTC), e.g. 0 3 * * *" maxlength="128">
<button type="submit">Add schedule</button>
</form>
<p id="scheduleErr" class="err"></p>
<div id="scheduleList"></div>
<h2>Monitors</h2>
<p class="muted">Rule-based alerts to the chat webhook (or a per-monitor URL): consecutive failing results, log text, or jobs running past a duration. Empty branch/job matches everything; job accepts * and ? globs.</p>
<form id="monitorForm" class="inline">
<input id="monitorRepoInput" placeholder="owner/repo" maxlength="100">
<input id="monitorBranchInput" placeholder="branch (optional)" maxlength="128">
<input id="monitorJobInput" placeholder="job glob (optional)" maxlength="128">
<select id="monitorTriggerSelect"><option value="result">result</option><option value="duration">duration</option></select>
<select id="monitorResultSelect"><option value="failure">failure</option><option value="error">error</option><option value="cancelled">cancelled</option><option value="skipped">skipped</option><option value="success">success</option></select>
<input id="monitorNInput" placeholder="consecutive (1-100)" maxlength="3" size="6">
<input id="monitorDurInput" placeholder="seconds (60+, duration only)" maxlength="5" size="8">
<input id="monitorPatternInput" placeholder="log text (optional)" maxlength="200">
<button type="submit">Add monitor</button>
</form>
<p id="monitorErr" class="err"></p>
<div id="monitorList"></div>
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
<h2>Egress allowlists</h2>
<p class="muted">Per-repo outbound floor policy for managed seats: every job inherits the repo list, jobs may narrow it, anything outside rejects the dispatch. BYO runners fail closed on confined jobs. Deleting a repo returns it to observe-only.</p>
<form id="egressForm" class="inline">
<input id="egressRepoInput" placeholder="owner/repo" maxlength="100" aria-label="Repository">
<input id="egressDomainsInput" placeholder="github.com, registry.npmjs.org" maxlength="2000" size="40" aria-label="Allowed domains">
<button type="submit">Save allowlist</button>
</form>
<p id="egressErr" class="err"></p>
<p id="egressOk"></p>
<div id="egressList"></div>
<h2>Artifacts mirrors</h2>
<p class="muted">Hands-free GitHub mirrors: the first push imports the repo into the Artifacts namespace, seats sync missing shas lazily. Failures retry on the next push; checkouts always fall back to GitHub.</p>
<div id="mirrorList"></div>
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
<section id="tournamentsPane" class="card" hidden>
<h2>Tournaments</h2>
<p class="muted">One task races N agents in isolated forks. Open a tournament, agents claim slots, every push is verified, the verdict picks a winner.</p>
<form id="tournamentForm" class="inline">
<input id="tournamentIntent" placeholder="task intent, e.g. fix the login redirect" maxlength="200" size="40" aria-label="Task intent">
<input id="tournamentSource" placeholder="source repo" maxlength="100" size="20" aria-label="Source repo">
<button type="submit">Open tournament</button>
</form>
<p id="tournamentsErr" class="err"></p>
<div id="tournamentsList"></div>
<div id="tournamentDetail" hidden>
<h3 id="tournamentTitle"></h3>
<p><button id="backToTournaments" class="ghost">Back to list</button> <button id="refreshTournament" class="ghost">Refresh</button></p>
<div id="tournamentAttempts"></div>
<div id="tournamentVerdict"></div>
<h4>Ledger</h4>
<div id="tournamentLedger"></div>
</div>
</section>
<section id="searchPane" class="card" hidden>
<h2>Log search</h2>
<p class="muted">Terms, "phrases", (parens OR brackets), -negation, and repo: branch: level: run: job: filters. Example: branch:main level:error (failure OR panic) -flaky</p>
<form id="searchForm" class="inline">
<input id="searchInput" placeholder="search all job logs" maxlength="500" size="48" aria-label="Log search query">
<button type="submit">Search</button>
</form>
<p id="searchErr" class="err"></p>
<div id="searchList"></div>
</section>
<section id="flakyPane" class="card" hidden>
<h2>Flaky tests</h2>
<p class="muted">Per-job failure rates plus the quarantine list. Quarantined tests stop blocking the merge, land the run as green, and are named on the PR comment. Adding or reinstating needs admin.</p>
<form id="flakyForm" class="inline">
<input id="flakyRepo" placeholder="owner/repo" maxlength="100" aria-label="Repository">
<button type="submit">Load</button>
</form>
<p id="flakyErr" class="err"></p>
<h3>Failure rates (30 days)</h3>
<div class="table-scroll"><table><thead><tr><th>Job</th><th>Runs</th><th>Failures</th><th>Rate</th></tr></thead><tbody id="flakyBody"></tbody></table></div>
<h3>Quarantined</h3>
<div class="table-scroll"><table><thead><tr><th>Test</th><th>Status</th><th>Reason</th><th>Green streak</th><th>Updated</th><th></th></tr></thead><tbody id="quarantineBody"></tbody></table></div>
<form id="quarantineForm" class="inline" hidden>
<input id="quarantineName" placeholder="test name to quarantine" maxlength="200" aria-label="Test name">
<button type="submit">Quarantine</button>
</form>
</section>
<section id="mergePane" class="card" hidden>
<h2>Merge queue</h2>
<p class="muted">Agent PRs land one at a time: each entry rebases onto the current head, verifies with real CI, and merges on green. One verification runs per repo; entries whose base moves re-queue instead of landing stale.</p>
<form id="mergeForm" class="inline">
<input id="mergeRepo" placeholder="owner/repo" maxlength="100" aria-label="Repository">
<button type="submit">Load</button>
</form>
<p id="mergeErr" class="err"></p>
<h3>Entries</h3>
<div class="table-scroll"><table><thead><tr><th>PR</th><th>Status</th><th>Agent</th><th>Head</th><th>Note</th><th></th></tr></thead><tbody id="mergeBody"></tbody></table></div>
<h3>Collisions</h3>
<p class="muted">Live entries touching the same files — land order matters here.</p>
<div id="mergeCollisions"></div>
<form id="mergeEnqueueForm" class="inline">
<input id="mergePr" placeholder="PR number" maxlength="7" size="10" aria-label="PR number">
<input id="mergeSha" placeholder="head SHA" maxlength="64" size="16" aria-label="Head SHA">
<button type="submit">Enqueue</button>
</form>
</section>
<section id="templatesPane" class="card" hidden>
<h2>Template gallery</h2>
<p class="muted">One starter flare.yml per stack. Copy the YAML into your repo, or scaffold it with the init command on each card.</p>
<div id="templatesList"></div>
<h2>Migration wizard</h2>
<p class="muted">Three steps from GitHub Actions to flare.yml: paste a workflow, convert it with the same importer cli import uses, then review the warnings and save the YAML.</p>
<form id="migrateForm" class="auth-form">
<textarea id="migrateInput" rows="10" placeholder="Paste .github/workflows/ci.yml here" aria-label="GitHub Actions workflow YAML"></textarea>
<input id="migrateFilename" placeholder="workflow filename (optional)" maxlength="128" aria-label="Workflow filename">
<button type="submit">Convert to flare.yml</button>
</form>
<p id="migrateErr" class="err"></p>
<div id="migrateOut" hidden>
<h3>Converted flare.yml</h3>
<pre id="migrateYaml" class="log"></pre>
<p><button id="migrateCopy" class="ghost" type="button">Copy</button></p>
<h3>Warnings</h3>
<div id="migrateWarnings" class="muted"></div>
</div>
</section>
<section id="appsPane" class="card" hidden>
<h2>My apps</h2>
<p class="muted">OAuth apps you authorized on the MCP endpoint (Claude, ChatGPT, Cursor, …). Revoking disconnects the app immediately.</p>
<div class="table-scroll"><table><thead><tr><th>App</th><th>Scopes</th><th>Granted</th><th></th></tr></thead><tbody id="myAppsBody"></tbody></table></div>
<h2>My notifications</h2>
<p class="muted">Attention prefs for your run emails, on top of the global notify mode. Quiet hours (UTC) drop emails inside the window — nothing queues. New-failure dedup skips repeat reds on the same repo and branch, so a long red streak pages once; recovery always notifies.</p>
<form id="notifyPrefsForm" class="inline">
<input id="quietStartInput" placeholder="quiet from, UTC HH:MM (blank = off)" maxlength="5" size="12" aria-label="Quiet hours start (UTC HH:MM)">
<input id="quietEndInput" placeholder="quiet until, UTC HH:MM" maxlength="5" size="12" aria-label="Quiet hours end (UTC HH:MM)">
<label><input type="checkbox" id="newFailuresCheck"> only new failures (skip repeat reds)</label>
<button type="submit">Save</button>
</form>
<p id="notifyPrefsErr" class="err"></p>
<p id="notifyPrefsOk"></p>
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
  function fmtBytes(bytes) {
    if (!isFinite(bytes) || bytes < 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var n = bytes; var u = 0;
    while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
    return (u === 0 ? Math.round(n) : Math.round(n * 10) / 10) + " " + units[u];
  }
  // Mirror of rightsize.ts — keep thresholds + blurbs in sync.
  function sizeClassForPeak(peak) {
    if (!isFinite(peak) || peak < 512 * 1024 * 1024) return "s";
    if (peak < 2 * 1024 * 1024 * 1024) return "m";
    if (peak < 8 * 1024 * 1024 * 1024) return "l";
    return "xl";
  }
  var SIZE_CLASS_BLURB = {
    s: "fits small runners",
    m: "fits standard runners",
    l: "needs 8gb+ runners",
    xl: "needs 16gb+ runners"
  };
  function peakRssOf(j) {
    try {
      var parsed = j.result ? JSON.parse(j.result) : null;
      var peak = parsed && parsed.peakRssBytes;
      return (typeof peak === "number" && isFinite(peak) && peak > 0) ? Math.floor(peak) : null;
    } catch (e) { return null; }
  }
  function stateRow(body, cols, text, cls) {
    body.textContent = "";
    var tr = el("tr"); var td = el("td", text); td.colSpan = cols;
    if (cls) td.className = cls;
    tr.appendChild(td); body.appendChild(tr);
  }
  function pill(status) { var s = el("span", status); s.className = "pill " + status; return s; }

  // Turnstile widgets render lazily per auth pane (the site key arrives
  // with /v1/admin/status, and hidden panes break widget execution).
  var turnstileWidgets = {};
  function ensureTurnstileScript(cb) {
    if (window.turnstile) { cb(); return; }
    if (document.getElementById("turnstileScript")) {
      setTimeout(function () { ensureTurnstileScript(cb); }, 300);
      return;
    }
    var s = document.createElement("script");
    s.id = "turnstileScript";
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.defer = true;
    s.onload = cb;
    document.head.appendChild(s);
  }
  function ensureTurnstile(id) {
    var siteKey = lastStatus && lastStatus.turnstileSiteKey;
    if (!siteKey || turnstileWidgets[id] !== undefined) return;
    var target = document.getElementById(id);
    if (!target) return;
    ensureTurnstileScript(function () {
      if (turnstileWidgets[id] !== undefined || !window.turnstile) return;
      try {
        turnstileWidgets[id] = window.turnstile.render("#" + id, { sitekey: siteKey });
      } catch (e) {
        turnstileWidgets[id] = null;
      }
    });
  }
  function turnstileToken(id) {
    try {
      var wid = turnstileWidgets[id];
      if (window.turnstile && wid !== undefined && wid !== null) return window.turnstile.getResponse(wid) || "";
    } catch (e) { /* widget failed; server reports the missing token */ }
    return "";
  }

  var authPane = document.getElementById("authPane");
  var invitePane = document.getElementById("invitePane");
  var appPane = document.getElementById("appPane");
  var logoutBtn = document.getElementById("logoutBtn");
  var userLabel = document.getElementById("userLabel");
  var lastStatus = null;
  var inviteToken = null;
  var resetPane = document.getElementById("resetPane");
  var resetConfirmPane = document.getElementById("resetConfirmPane");
  var resetToken = null;

  function showInvite() {
    invitePane.hidden = false; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = "";
    resetPane.hidden = true; resetConfirmPane.hidden = true;
    ensureTurnstile("tsInvite");
  }

  function showReset() {
    resetPane.hidden = false; resetConfirmPane.hidden = true; invitePane.hidden = true; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = "";
    document.getElementById("resetRequestOk").textContent = "";
    document.getElementById("resetRequestErr").textContent = "";
    ensureTurnstile("tsReset");
  }

  function showResetConfirm(token) {
    resetToken = token;
    resetConfirmPane.hidden = false; resetPane.hidden = true; invitePane.hidden = true; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = "";
  }

  var emailMode = "login";
  function setEmailMode(mode) {
    emailMode = mode;
    var registering = mode === "register";
    document.getElementById("emailPw2Wrap").hidden = !registering;
    document.getElementById("emailBtn").textContent = registering ? "Create account" : "Log in";
    document.getElementById("emailTitle").textContent = registering ? "Create your account" : "Log in with email";
    document.getElementById("emailDesc").textContent = registering ? "Reader access — invites still work too." : "Welcome back.";
    document.getElementById("registerToggleBtn").textContent = registering ? "Have an account? Log in" : "No account? Create one";
    document.getElementById("emailErr").textContent = "";
  }
  function showAuth(st) {
    lastStatus = st;
    invitePane.hidden = true;
    resetPane.hidden = true; resetConfirmPane.hidden = true;
    authPane.hidden = false; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = "";
    document.getElementById("emailPw2Wrap").hidden = st.claimed;
    document.getElementById("emailBtn").textContent = st.claimed ? "Log in" : "Create admin account";
    document.getElementById("emailTitle").textContent = st.claimed ? "Log in with email" : "Create admin account";
    document.getElementById("emailDesc").textContent = st.claimed ? "Welcome back." : "First account claims admin.";
    document.getElementById("connectBox").hidden = st.githubConnected;
    document.getElementById("breakGlassBox").hidden = !st.breakGlass;
    var openReg = st.claimed && st.openRegistration;
    emailMode = "login";
    document.getElementById("registerToggleBtn").hidden = !openReg;
    document.getElementById("registerToggleBtn").textContent = "No account? Create one";
    document.getElementById("githubOpenHint").hidden = !openReg;
    var installBox = document.getElementById("authInstallBox");
    if (st.githubConnected && st.installUrl) {
      installBox.hidden = false;
      document.getElementById("authInstallLink").href = st.installUrl;
    } else {
      installBox.hidden = true;
    }
    ensureTurnstile("tsEmail");
  }
  var isAdmin = false;
  function showApp(actor, admin, githubConnected) {
    isAdmin = !!admin;
    document.getElementById("dispatchBox").hidden = !admin;
    invitePane.hidden = true;
    resetPane.hidden = true; resetConfirmPane.hidden = true;
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

  // WebMCP: expose dashboard actions to browser agents (Chrome 146+,
  // Cloudflare Browser Run) via document/navigator.modelContext.
  // Feature-detected progressive enhancement: no-ops on browsers without
  // the API and for logged-out visitors. Tools call the same same-origin
  // JSON APIs the page uses, so the visitor's session is the credential;
  // write tools register for admins only.
  var webMcpReadsDone = false;
  var webMcpWritesDone = false;
  function registerWebMcpTools(isAdmin) {
    var mc = null;
    try {
      mc =
        (typeof document !== "undefined" && document.modelContext) ||
        (typeof navigator !== "undefined" && navigator.modelContext) ||
        null;
    } catch (e) { mc = null; }
    if (!mc || typeof mc.registerTool !== "function") return;
    function add(tool) {
      try { mc.registerTool(tool); } catch (e) { /* draft API drift: skip */ }
    }
    function num(v, dflt) { v = Number(v); return isFinite(v) ? v : dflt; }
    if (!webMcpReadsDone) {
      webMcpReadsDone = true;
      add({ name: "flare_list_runs", description: "List recent CI runs, newest first.",
        inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max runs, 1-50 (default 10)" } } },
        execute: function (args) {
          args = args || {};
          return api("/v1/runs?limit=" + num(args.limit, 10));
        } });
      add({ name: "flare_get_run_digest", description: "Compact run result: per-job status, failing step command/exit code, bounded output tail, AI triage. Prefer over raw logs.",
        inputSchema: { type: "object", properties: { runId: { type: "string", description: "Run id" } }, required: ["runId"] },
        execute: function (args) {
          args = args || {};
          if (!args.runId) return Promise.reject(new Error("runId is required"));
          return api("/v1/runs/" + encodeURIComponent(args.runId) + "/digest");
        } });
      add({ name: "flare_get_flaky", description: "Per-job failure rates for a repo over the trailing window, worst first.",
        inputSchema: { type: "object", properties: { repo: { type: "string", description: "owner/name" }, days: { type: "number", description: "1-365 (default 30)" } }, required: ["repo"] },
        execute: function (args) {
          args = args || {};
          if (!args.repo) return Promise.reject(new Error("repo is required"));
          return api("/v1/flaky?repo=" + encodeURIComponent(args.repo) + "&days=" + num(args.days, 30));
        } });
    }
    if (!isAdmin || webMcpWritesDone) return;
    webMcpWritesDone = true;
    add({ name: "flare_dispatch_run", description: "Trigger a CI run for repo@sha.",
      inputSchema: { type: "object", properties: { repo: { type: "string", description: "owner/name" }, sha: { type: "string", description: "commit sha or branch" }, ref: { type: "string", description: "optional branch label" } }, required: ["repo", "sha"] },
      execute: function (args) {
        args = args || {};
        if (!args.repo || !args.sha) return Promise.reject(new Error("repo and sha are required"));
        return api("/v1/runs/dispatch", { method: "POST", body: JSON.stringify({ repo: args.repo, sha: args.sha, ref: args.ref || "" }) });
      } });
    add({ name: "flare_rerun_job", description: "Reset a finished job to queued so a runner picks it up again.",
      inputSchema: { type: "object", properties: { runId: { type: "string", description: "Run id" }, jobId: { type: "string", description: "Job id" } }, required: ["runId", "jobId"] },
      execute: function (args) {
        args = args || {};
        if (!args.runId || !args.jobId) return Promise.reject(new Error("runId and jobId are required"));
        return api("/v1/runs/" + encodeURIComponent(args.runId) + "/jobs/" + encodeURIComponent(args.jobId) + "/rerun", { method: "POST", body: "{}" });
      } });
  }

  function route(st) {
    if (st.user) {
      showApp(st.user.actor, st.user.admin, st.githubConnected);
      loadRuns();
      loadMyApps();
      loadNotifyPrefs();
      registerWebMcpTools(st.user.admin);
      if (st.user.admin) { loadTokens(); loadUsers(); loadAudit(); loadOAuthGrants(); }
    } else {
      showAuth(st);
    }
  }

  function boot() {
    fetch("/v1/admin/status").then(function (res) { return res.json(); }).then(function (st) {
      lastStatus = st;
      var q = new URLSearchParams(window.location.search);
      var g = q.get("github");
      var inv = q.get("invite");
      var rt = q.get("reset");
      var installed = q.get("installation_id");
      var setupAction = q.get("setup_action");
      if ((g || inv || rt || installed || setupAction) && window.history && window.history.replaceState) window.history.replaceState({}, "", "/dashboard");
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
      if (rt && rt !== "done" && !st.user) {
        showResetConfirm(rt);
        return;
      }
      route(st);
      handleGithubQuery(st, g, q.get("reason"));
      if (rt === "done") document.getElementById("loginMsg").textContent = "Password updated — log in.";
    }).catch(function () { showAuth({ claimed: true, githubConnected: false, breakGlass: false, installUrl: null, openRegistration: false }); });
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
      fetch("/v1/admin/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: pw, turnstileToken: turnstileToken("tsEmail") }) })
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
    if (emailMode === "register") {
      var pwAgain = document.getElementById("emailPw2").value;
      if (pw !== pwAgain) { err.textContent = "Passwords do not match."; return; }
      fetch("/v1/admin/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: pw, turnstileToken: turnstileToken("tsEmail") }) })
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
    fetch("/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: pw, turnstileToken: turnstileToken("tsEmail") }) })
      .then(function (res) {
        if (!res.ok) throw new Error("bad");
        document.getElementById("emailPw").value = "";
        boot();
      })
      .catch(function () { err.textContent = "Invalid email or password."; });
  });

  document.getElementById("forgotBtn").addEventListener("click", function (ev) {
    ev.preventDefault();
    showReset();
  });

  document.getElementById("registerToggleBtn").addEventListener("click", function (ev) {
    ev.preventDefault();
    setEmailMode(emailMode === "register" ? "login" : "register");
  });

  document.getElementById("resetBackBtn").addEventListener("click", function (ev) {
    ev.preventDefault();
    route(lastStatus || { claimed: true, githubConnected: false, breakGlass: false, installUrl: null, openRegistration: false });
  });

  document.getElementById("resetRequestForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("resetRequestErr");
    var ok = document.getElementById("resetRequestOk");
    err.textContent = ""; ok.textContent = "";
    var email = document.getElementById("resetEmailInput").value.trim();
    fetch("/v1/admin/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, turnstileToken: turnstileToken("tsReset") }) })
      .then(function (res) {
        if (!res.ok) throw new Error("bad");
        document.getElementById("resetEmailInput").value = "";
        ok.textContent = "If that account exists, a reset link is on its way.";
      })
      .catch(function () { err.textContent = "Could not send (check the address, or try again later)."; });
  });

  document.getElementById("resetConfirmForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("resetConfirmErr");
    err.textContent = "";
    var a = document.getElementById("resetPw1").value;
    var b = document.getElementById("resetPw2").value;
    if (a !== b) { err.textContent = "Passwords do not match."; return; }
    fetch("/v1/admin/reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: resetToken, password: a }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("bad");
        window.location.href = "/dashboard?reset=done";
      })
      .catch(function () { err.textContent = "Could not reset (link expired, or 8+ char password needed)."; });
  });

  document.getElementById("inviteForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("inviteErr");
    err.textContent = "";
    var a = document.getElementById("invitePw1").value;
    var b = document.getElementById("invitePw2").value;
    if (a !== b) { err.textContent = "Passwords do not match."; return; }
    fetch("/v1/admin/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: inviteToken, password: a, turnstileToken: turnstileToken("tsInvite") }) })
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
  var tabFeed = document.getElementById("tabFeed");
  var tabTournaments = document.getElementById("tabTournaments");
  var tabSearch = document.getElementById("tabSearch");
  var tabFlaky = document.getElementById("tabFlaky");
  var tabMerge = document.getElementById("tabMerge");
  var tabTemplates = document.getElementById("tabTemplates");
  var tabApps = document.getElementById("tabApps");
  var tabAccess = document.getElementById("tabAccess");
  var tabSettings = document.getElementById("tabSettings");
  var runsPane = document.getElementById("runsPane");
  var feedPane = document.getElementById("feedPane");
  var tournamentsPane = document.getElementById("tournamentsPane");
  var searchPane = document.getElementById("searchPane");
  var flakyPane = document.getElementById("flakyPane");
  var mergePane = document.getElementById("mergePane");
  var templatesPane = document.getElementById("templatesPane");
  var appsPane = document.getElementById("appsPane");
  var accessPane = document.getElementById("accessPane");
  var settingsPane = document.getElementById("settingsPane");
  function selectTab(name) {
    tabRuns.className = name === "runs" ? "active" : "";
    tabFeed.className = name === "feed" ? "active" : "";
    tabTournaments.className = name === "tournaments" ? "active" : "";
    tabSearch.className = name === "search" ? "active" : "";
    tabFlaky.className = name === "flaky" ? "active" : "";
    tabMerge.className = name === "merge" ? "active" : "";
    tabTemplates.className = name === "templates" ? "active" : "";
    tabApps.className = name === "apps" ? "active" : "";
    tabAccess.className = name === "access" ? "active" : "";
    tabSettings.className = name === "settings" ? "active" : "";
    runsPane.hidden = name !== "runs";
    feedPane.hidden = name !== "feed";
    tournamentsPane.hidden = name !== "tournaments";
    searchPane.hidden = name !== "search";
    flakyPane.hidden = name !== "flaky";
    mergePane.hidden = name !== "merge";
    templatesPane.hidden = name !== "templates";
    appsPane.hidden = name !== "apps";
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
  tabFeed.addEventListener("click", function () { selectTab("feed"); loadFeed(); });
  document.getElementById("feedRefresh").addEventListener("click", function () { loadFeed(); });
  tabTournaments.addEventListener("click", function () { selectTab("tournaments"); loadTournaments(); });
  tabSearch.addEventListener("click", function () { selectTab("search"); });
  tabFlaky.addEventListener("click", function () { selectTab("flaky"); });
  var currentTournamentId = "";
  var tournamentTimer = null;
  function stopTournamentTimer() {
    if (tournamentTimer) { clearInterval(tournamentTimer); tournamentTimer = null; }
  }
  document.getElementById("tournamentForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("tournamentsErr");
    err.textContent = "";
    var intent = document.getElementById("tournamentIntent").value.trim();
    var source = document.getElementById("tournamentSource").value.trim();
    if (!intent || !source) { err.textContent = "intent and source repo are required"; return; }
    api("/v1/tournaments", { method: "POST", body: JSON.stringify({ intent: intent, sourceRepo: source }) }).then(function (b) {
      document.getElementById("tournamentIntent").value = "";
      showTournament(b.id);
    }, function (e) { err.textContent = e.message; });
  });
  function loadTournaments() {
    stopTournamentTimer();
    var err = document.getElementById("tournamentsErr");
    var list = document.getElementById("tournamentsList");
    err.textContent = "";
    list.textContent = "";
    document.getElementById("tournamentDetail").hidden = true;
    api("/v1/tournaments").then(function (b) {
      var tournaments = b.tournaments || [];
      if (tournaments.length === 0) { list.textContent = "No tournaments yet."; return; }
      tournaments.forEach(function (t) {
        var row = document.createElement("p");
        var btn = document.createElement("button");
        btn.className = "ghost";
        btn.textContent = t.intent + " (" + t.state + ")";
        btn.addEventListener("click", function () { showTournament(t.id); });
        row.appendChild(btn);
        list.appendChild(row);
      });
    }, function (e) { err.textContent = e.message; });
  }
  document.getElementById("backToTournaments").addEventListener("click", function () {
    stopTournamentTimer();
    document.getElementById("tournamentDetail").hidden = true;
    loadTournaments();
  });
  document.getElementById("refreshTournament").addEventListener("click", function () {
    if (currentTournamentId) showTournament(currentTournamentId);
  });
  function showTournament(id) {
    stopTournamentTimer();
    currentTournamentId = id;
    var err = document.getElementById("tournamentsErr");
    err.textContent = "";
    api("/v1/tournaments/" + encodeURIComponent(id)).then(function (b) {
      document.getElementById("tournamentsList").textContent = "";
      document.getElementById("tournamentDetail").hidden = false;
      document.getElementById("tournamentTitle").textContent = b.tournament.intent + " (" + b.tournament.state + ")";
      var att = document.getElementById("tournamentAttempts");
      att.textContent = "";
      (b.attempts || []).forEach(function (a) {
        var p = document.createElement("p");
        var line = a.agent + ": " + a.state;
        if (a.run_id) line += " run " + String(a.run_id).slice(0, 8);
        if (a.verdict_rank) line += " rank " + a.verdict_rank;
        p.textContent = line;
        att.appendChild(p);
      });
      if ((b.attempts || []).length === 0) att.textContent = "No claims yet.";
      var v = document.getElementById("tournamentVerdict");
      v.textContent = "";
      if (b.verdict) {
        var h = document.createElement("h4");
        h.textContent = "Verdict";
        v.appendChild(h);
        var p = document.createElement("p");
        p.textContent = b.verdict.rationale || "";
        v.appendChild(p);
      }
      var led = document.getElementById("tournamentLedger");
      led.textContent = "";
      (b.ledger || []).forEach(function (l) {
        var lp = document.createElement("p");
        lp.textContent = l.kind + ": " + l.body;
        led.appendChild(lp);
      });
      if (b.tournament.state !== "decided") {
        tournamentTimer = setInterval(function () {
          if (document.getElementById("tournamentDetail").hidden || tournamentsPane.hidden) { stopTournamentTimer(); return; }
          showTournament(id);
        }, 5000);
      }
    }, function (e) { err.textContent = e.message; });
  }
  tabApps.addEventListener("click", function () { selectTab("apps"); loadMyApps(); loadNotifyPrefs(); });
  document.getElementById("searchForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    runLogSearch();
  });
  function runLogSearch() {
    var q = document.getElementById("searchInput").value.trim();
    var err = document.getElementById("searchErr");
    var list = document.getElementById("searchList");
    err.textContent = "";
    list.textContent = "";
    if (!q) return;
    api("/v1/search/logs?q=" + encodeURIComponent(q) + "&limit=50").then(function (res) {
      var hits = (res && res.hits) || [];
      if (hits.length === 0) {
        list.textContent = "No matching log lines.";
        return;
      }
      var table = el("table");
      var head = el("tr");
      ["when", "repo", "branch", "level", "line"].forEach(function (h) { head.appendChild(el("th", h)); });
      var thead = el("thead"); thead.appendChild(head); table.appendChild(thead);
      var body = el("tbody");
      hits.forEach(function (h) {
        var tr = el("tr");
        tr.appendChild(timeCell(h.created_at));
        tr.appendChild(el("td", h.repo + " / " + h.run_id.slice(0, 8)));
        tr.appendChild(el("td", h.branch || "-"));
        tr.appendChild(el("td", h.level));
        var line = el("td", h.line); line.className = "mono";
        tr.appendChild(line);
        body.appendChild(tr);
      });
      table.appendChild(body);
      var wrap = el("div"); wrap.className = "table-scroll"; wrap.appendChild(table);
      list.appendChild(wrap);
    }, function (e) {
      err.textContent = (e && e.message) || "Search failed";
    });
  }
  document.getElementById("flakyForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    loadFlaky();
  });
  document.getElementById("quarantineForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var repo = document.getElementById("flakyRepo").value.trim();
    var name = document.getElementById("quarantineName").value.trim();
    var err = document.getElementById("flakyErr");
    err.textContent = "";
    if (!repo || !name) { err.textContent = "repo and test name are required"; return; }
    api("/v1/quarantine", { method: "POST", body: JSON.stringify({ repo: repo, name: name, action: "add" }) }).then(function () {
      document.getElementById("quarantineName").value = "";
      loadFlaky();
    }, function (e) {
      err.textContent = (e && e.message) || "Quarantine failed";
    });
  });
  function loadFlaky() {
    var repo = document.getElementById("flakyRepo").value.trim();
    var err = document.getElementById("flakyErr");
    var flakyBody = document.getElementById("flakyBody");
    var quarantineBody = document.getElementById("quarantineBody");
    err.textContent = "";
    flakyBody.textContent = "";
    quarantineBody.textContent = "";
    document.getElementById("quarantineForm").hidden = !isAdmin;
    if (!repo) return;
    api("/v1/flaky?repo=" + encodeURIComponent(repo) + "&days=30").then(function (res) {
      var stats = (res && res.stats) || [];
      if (stats.length === 0) {
        var empty = el("tr"); var td = el("td", "No finished jobs in the last 30 days."); td.colSpan = 4; empty.appendChild(td); flakyBody.appendChild(empty);
      }
      stats.forEach(function (s) {
        var tr = el("tr");
        tr.appendChild(el("td", s.job));
        tr.appendChild(el("td", String(s.runs)));
        tr.appendChild(el("td", String(s.failures)));
        var pct = typeof s.rate === "number" ? Math.round(s.rate * 100) + "%" : "-";
        tr.appendChild(el("td", pct));
        flakyBody.appendChild(tr);
      });
    }, function (e) {
      err.textContent = (e && e.message) || "Flaky stats failed";
    });
    api("/v1/quarantine?repo=" + encodeURIComponent(repo)).then(function (res) {
      var tests = (res && res.tests) || [];
      if (tests.length === 0) {
        var empty = el("tr"); var td = el("td", "Nothing quarantined."); td.colSpan = 6; empty.appendChild(td); quarantineBody.appendChild(empty);
        return;
      }
      tests.forEach(function (t) {
        var tr = el("tr");
        var name = el("td", t.name); name.className = "mono"; tr.appendChild(name);
        tr.appendChild(el("td", t.status));
        tr.appendChild(el("td", t.reason || "-"));
        tr.appendChild(el("td", String(t.green_streak)));
        tr.appendChild(timeCell(t.updated_at));
        var act = el("td");
        if (isAdmin && t.status === "active") {
          var btn = el("button", "Reinstate");
          btn.className = "ghost";
          btn.addEventListener("click", function () {
            api("/v1/quarantine", { method: "POST", body: JSON.stringify({ repo: repo, name: t.name, action: "remove" }) }).then(loadFlaky, function (e) {
              err.textContent = (e && e.message) || "Reinstate failed";
            });
          });
          act.appendChild(btn);
        }
        tr.appendChild(act);
        quarantineBody.appendChild(tr);
      });
    }, function (e) {
      err.textContent = (e && e.message) || "Quarantine list failed";
    });
  }
  tabMerge.addEventListener("click", function () { selectTab("merge"); });
  tabTemplates.addEventListener("click", function () { selectTab("templates"); loadTemplates(); });
  document.getElementById("migrateForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("migrateErr");
    var out = document.getElementById("migrateOut");
    err.textContent = "";
    out.hidden = true;
    var workflow = document.getElementById("migrateInput").value;
    var filename = document.getElementById("migrateFilename").value.trim();
    if (!workflow.trim()) { err.textContent = "paste a workflow first"; return; }
    var payload = { workflow: workflow };
    if (filename) payload.filename = filename;
    api("/v1/migrate", { method: "POST", body: JSON.stringify(payload) }).then(function (b) {
      out.hidden = false;
      document.getElementById("migrateYaml").textContent = b.yaml || "";
      var warns = document.getElementById("migrateWarnings");
      warns.textContent = "";
      (b.warnings || []).forEach(function (w) { warns.appendChild(el("p", String(w))); });
      if (!(b.warnings || []).length) warns.textContent = "No warnings — clean conversion.";
    }, function (e) { err.textContent = e.message; });
  });
  document.getElementById("migrateCopy").addEventListener("click", function () {
    copyText(document.getElementById("migrateYaml").textContent, this);
  });
  document.getElementById("mergeForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    loadMergeQueue();
  });
  document.getElementById("mergeEnqueueForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var repo = document.getElementById("mergeRepo").value.trim();
    var pr = Number(document.getElementById("mergePr").value.trim());
    var headSha = document.getElementById("mergeSha").value.trim();
    var err = document.getElementById("mergeErr");
    err.textContent = "";
    if (!repo || !Number.isInteger(pr) || pr < 1 || !headSha) { err.textContent = "repo, PR number, and head SHA are required"; return; }
    api("/v1/merge-queue", { method: "POST", body: JSON.stringify({ repo: repo, pr: pr, headSha: headSha }) }).then(function () {
      document.getElementById("mergePr").value = "";
      document.getElementById("mergeSha").value = "";
      loadMergeQueue();
    }, function (e) {
      err.textContent = (e && e.message) || "Enqueue failed";
    });
  });
  function loadMergeQueue() {
    var repo = document.getElementById("mergeRepo").value.trim();
    var err = document.getElementById("mergeErr");
    var body = document.getElementById("mergeBody");
    var radar = document.getElementById("mergeCollisions");
    err.textContent = "";
    body.textContent = "";
    radar.textContent = "";
    if (!repo) return;
    api("/v1/merge-queue?repo=" + encodeURIComponent(repo)).then(function (res) {
      var entries = (res && res.entries) || [];
      if (entries.length === 0) {
        var empty = el("tr"); var td = el("td", "Queue is empty."); td.colSpan = 6; empty.appendChild(td); body.appendChild(empty);
      }
      entries.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "#" + e.pr));
        tr.appendChild(el("td", e.status));
        tr.appendChild(el("td", e.agent || "-"));
        var head = el("td", (e.headSha || "").slice(0, 7)); head.className = "mono"; tr.appendChild(head);
        tr.appendChild(el("td", e.note || "-"));
        var act = el("td");
        if (e.status === "queued" || e.status === "verifying") {
          var btn = el("button", "Cancel");
          btn.className = "ghost";
          btn.addEventListener("click", function () {
            api("/v1/merge-queue/" + encodeURIComponent(e.id), { method: "DELETE" }).then(loadMergeQueue, function (fail) {
              err.textContent = (fail && fail.message) || "Cancel failed";
            });
          });
          act.appendChild(btn);
        }
        tr.appendChild(act);
        body.appendChild(tr);
      });
      var collisions = (res && res.collisions) || [];
      if (collisions.length === 0) { radar.textContent = "No file collisions between live entries."; return; }
      collisions.forEach(function (c) {
        var row = el("p", "#" + c.prs[0] + " x #" + c.prs[1] + ": " + (c.paths || []).join(", "));
        row.className = "mono";
        radar.appendChild(row);
      });
    }, function (e) {
      err.textContent = (e && e.message) || "Merge queue failed";
    });
  }
  tabAccess.addEventListener("click", function () { selectTab("access"); loadTokens(); loadUsers(); loadAudit(); loadOAuthGrants(); });
  tabSettings.addEventListener("click", function () { selectTab("settings"); loadSettings(); });

  var selectedRunId = null;
  var lastRuns = [];
  function runMatches(r, q) {
    if (!q) return true;
    return ((r.repo || "") + " " + (r.branch || "") + " " + (r.sha || "") + " " + (r.status || "") + " " + (r.event || "") + " " + (r.pipeline_source || "")).toLowerCase().indexOf(q) !== -1;
  }
  function pipelineSourceLabel(s) {
    if (s === "flare") return "flare.yml";
    if (s === "actions") return "Actions";
    if (s === "inline") return "inline";
    if (s === "source") return "source";
    if (s === "default") return "default";
    return "";
  }
  function setupStep(title, desc, done, action) {
    var li = el("li");
    if (done) li.className = "done";
    var body = el("div"); body.className = "step-body";
    var p = el("p");
    p.appendChild(el("strong", title));
    p.appendChild(document.createTextNode(" — " + desc));
    body.appendChild(p);
    if (action) {
      var btn = el("button", action.label);
      btn.className = "ghost";
      btn.type = "button";
      btn.addEventListener("click", action.fn);
      body.appendChild(btn);
    }
    li.appendChild(body);
    return li;
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
    document.getElementById("runsFilterForm").style.display = lastRuns.length ? "" : "none";
    if (!list.children.length) {
      var empty = el("div"); empty.className = "empty";
      if (!lastRuns.length) {
        empty.appendChild(el("h3", "No runs yet — three steps to the first one"));
        var appDone = !!(lastStatus && lastStatus.githubConnected);
        var steps = el("ol"); steps.className = "steps";
        steps.appendChild(setupStep(
          "Connect a repo",
          appDone ? "GitHub App connected." : "Connect the App, or add a repo webhook for public repos.",
          appDone,
          isAdmin && !appDone ? { label: "Open Settings", fn: function () { selectTab("settings"); loadSettings(); } } : null,
        ));
        steps.appendChild(setupStep(
          "Start an executor",
          "Runs wait for a machine: npm run runner from the Flare checkout, or managed seats.",
          false,
          null,
        ));
        steps.appendChild(setupStep(
          "Trigger the first run",
          "Push to a connected repo — flare.yml or existing .github/workflows both run — or dispatch from this page.",
          false,
          isAdmin ? { label: "Dispatch a run", fn: function () {
            document.getElementById("dispatchBox").open = true;
            document.getElementById("dispatchRepo").focus();
          } } : null,
        ));
        empty.appendChild(steps);
      } else {
        empty.appendChild(el("h3", "No runs match"));
        empty.appendChild(el("p", "Try a different filter."));
      }
      list.appendChild(empty);
    }
  }
  var usageStripAt = 0;
  function loadUsageStrip() {
    // Usage moves slowly; the runs poll is fast — refetch at most
    // once a minute so the strip never hammers the rollup query.
    var now = Date.now();
    if (now - usageStripAt < 60000 && document.getElementById("usageStrip").textContent) return;
    usageStripAt = now;
    api("/v1/usage?days=30").then(function (u) {
      var list = (typeof u.actionsListUsd === "number" ? u.actionsListUsd : 0) +
        (typeof u.githubRunnerListUsd === "number" ? u.githubRunnerListUsd : 0);
      var base = "Last 30d: " + u.runs + " runs · " + u.computeMinutes + " compute-min · ≈$" +
        list.toFixed(2) + " spend avoided vs Actions list price";
      document.getElementById("usageStrip").textContent = base;
      // Real dollars for admins (401/502 keep the list-price line).
      api("/v1/usage/billable?days=30").then(function (b) {
        if (!b || b.configured !== true || typeof b.totalCost !== "number") return;
        var extra = " · $" + b.totalCost.toFixed(2) + " real Cloudflare spend";
        if (b.truncated === true) extra += " (partial)";
        document.getElementById("usageStrip").textContent = base + extra;
      }).catch(function () { /* list-price line stands alone */ });
    }).catch(function () { /* strip stays empty when usage is unreachable */ });
  }
  var cacheStatsAt = 0;
  function loadCacheStats() {
    // Same 60s cadence as the usage strip; the rollup query is cheap
    // but the runs poll is not. Empty when there are no reads yet.
    var now = Date.now();
    if (now - cacheStatsAt < 60000) return;
    cacheStatsAt = now;
    var strip = document.getElementById("cacheStatsStrip");
    api("/v1/cache/stats").then(function (s) {
      var hits = typeof s.hits === "number" ? s.hits : 0;
      var misses = typeof s.misses === "number" ? s.misses : 0;
      var total = hits + misses;
      if (!total) { strip.textContent = ""; return; }
      var scopes = (s.scopes || []).length;
      strip.textContent = "Shared cache (" + s.days + "d): " + (100 * hits / total).toFixed(1) +
        "% hit rate · " + hits + " hits, " + misses + " misses across " + scopes +
        " scope" + (scopes === 1 ? "" : "s") + " — one warm cache, every agent";
    }).catch(function () { strip.textContent = ""; });
  }
  function loadRuns() {
    var list = document.getElementById("runsList");
    list.textContent = "";
    var loading = el("p", "Loading runs…"); loading.className = "muted"; list.appendChild(loading);
    loadUsageStrip();
    loadCacheStats();
    api("/v1/runs").then(function (data) {
      lastRuns = data.runs || [];
      renderRuns();
      loadBottlenecks();
    }).catch(function () {
      list.textContent = "";
      var err = el("p"); err.appendChild(el("span", "Could not load runs. "));
      var retry = el("button", "Retry"); retry.className = "ghost";
      retry.addEventListener("click", function () { loadRuns(); });
      err.appendChild(retry); list.appendChild(err);
    });
  }
  function loadBottlenecks() {
    var box = document.getElementById("bottlenecksBox");
    var body = document.getElementById("bottlenecksBody");
    if (!lastRuns.length) { box.hidden = true; return; }
    var repo = lastRuns[0].repo;
    box.hidden = false;
    body.textContent = "Loading…";
    api("/v1/bottlenecks?repo=" + encodeURIComponent(repo) + "&days=14").then(function (data) {
      body.textContent = "";
      var checks = data.checks || [];
      if (!checks.length) { body.textContent = repo + ": no finished jobs in the last 14 days."; return; }
      var head = el("p", repo + " — run time p50/p95, median queue wait");
      head.className = "muted";
      body.appendChild(head);
      checks.forEach(function (c) {
        var row = el("p");
        row.appendChild(el("code", c.check));
        row.appendChild(el("span", " " + (c.p50Ms / 1000).toFixed(1) + "s p50 · " + (c.p95Ms / 1000).toFixed(1) + "s p95 · " +
          (c.queueP50Ms / 1000).toFixed(1) + "s queue · " + c.jobs + " jobs" + (c.failures ? " · " + c.failures + " failed" : "")));
        body.appendChild(row);
      });
    }).catch(function () {
      body.textContent = "Could not load check timings for " + repo + ".";
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
    var srcLabel = pipelineSourceLabel(r.pipeline_source);
    if (srcLabel) {
      meta.appendChild(el("span", " · "));
      var tag = el("span", srcLabel);
      tag.className = "run-src" + (r.pipeline_source === "actions" ? " actions" : "");
      meta.appendChild(tag);
    }
    main.appendChild(meta);
    row.appendChild(main);
    var t = el("span", fmtAgo(r.updated_at)); t.className = "run-time"; t.title = fmtTime(r.updated_at); row.appendChild(t);
    row.addEventListener("click", function () { selectedRunId = r.id; loadRun(r.id, true); });
    list.appendChild(row);
  }
  function openRunDetail(id) {
    selectedRunId = id;
    selectTab("runs");
    loadRun(id, true);
  }
  function loadFeed() {
    var list = document.getElementById("feedList");
    var err = document.getElementById("feedErr");
    err.textContent = "";
    list.textContent = "";
    var loading = el("p", "Loading feed…"); loading.className = "muted"; list.appendChild(loading);
    api("/v1/feed").then(function (data) {
      list.textContent = "";
      var items = data.items || [];
      if (!items.length) { list.appendChild(el("p", "No runs yet — push to a connected repo to start the feed.")); return; }
      items.forEach(function (item) { appendFeedItem(list, item); });
    }).catch(function (e) {
      list.textContent = "";
      err.textContent = e.message;
    });
  }
  function appendFeedItem(list, item) {
    var r = item.run;
    var failed = item.failedJobs || [];
    var wrap = el("div"); wrap.className = "feed-item";
    var top = el("div"); top.className = "run-row";
    top.appendChild(pill(r.status));
    var main = el("div"); main.className = "run-main";
    var repo = el("div", r.repo); repo.className = "run-repo"; main.appendChild(repo);
    var meta = el("div"); meta.className = "run-meta";
    meta.appendChild(el("span", (r.branch || "—") + " · "));
    var code = el("code", String(r.sha).slice(0, 7)); code.className = "mono"; meta.appendChild(code);
    var dur = runDuration(r);
    meta.appendChild(el("span", " · " + r.event + (dur ? " · " + dur : "") + (failed.length ? " · " + failed.length + " failed" : "")));
    main.appendChild(meta);
    top.appendChild(main);
    var t = el("span", fmtAgo(r.updated_at)); t.className = "run-time"; t.title = fmtTime(r.updated_at); top.appendChild(t);
    (function (id) { top.addEventListener("click", function () { openRunDetail(id); }); })(r.id);
    wrap.appendChild(top);
    var actions = el("div"); actions.className = "feed-actions";
    if (isAdmin && failed.length) {
      var rerun = el("button", "Rerun failed (" + failed.length + ")");
      rerun.className = "ghost";
      (function (runId, jobs, btn) {
        btn.addEventListener("click", function () {
          btn.disabled = true;
          var chain = Promise.resolve();
          jobs.forEach(function (f) {
            chain = chain.then(function () {
              return api("/v1/runs/" + encodeURIComponent(runId) + "/jobs/" + encodeURIComponent(f.id) + "/rerun", { method: "POST" });
            });
          });
          chain.then(function () { loadFeed(); }, function (e) {
            document.getElementById("feedErr").textContent = e.message;
            btn.disabled = false;
          });
        });
      })(r.id, failed, rerun);
      actions.appendChild(rerun);
    }
    if (r.pr_number) {
      var pr = el("a", "Open PR #" + r.pr_number);
      pr.href = "https://github.com/" + r.repo + "/pull/" + r.pr_number;
      pr.target = "_blank";
      pr.rel = "noopener";
      actions.appendChild(pr);
    }
    if (r.heal_pr_url) {
      var fix = el("a", "Open fix PR");
      fix.href = r.heal_pr_url;
      fix.target = "_blank";
      fix.rel = "noopener";
      actions.appendChild(fix);
    } else if (failed.length) {
      var open = el("button", "Open run");
      open.className = "ghost";
      (function (id) { open.addEventListener("click", function () { openRunDetail(id); }); })(r.id);
      actions.appendChild(open);
    }
    if (actions.children.length) wrap.appendChild(actions);
    list.appendChild(wrap);
  }
  function loadTemplates() {
    var list = document.getElementById("templatesList");
    list.textContent = "";
    var loading = el("p", "Loading templates…"); loading.className = "muted"; list.appendChild(loading);
    api("/v1/templates").then(function (data) {
      list.textContent = "";
      (data.templates || []).forEach(function (t) { appendTemplateCard(list, t); });
      if (!list.children.length) list.appendChild(el("p", "No templates published."));
    }).catch(function (e) {
      list.textContent = "";
      var err = el("p", "Could not load templates: " + e.message); err.className = "err"; list.appendChild(err);
    });
  }
  function appendTemplateCard(list, t) {
    var card = el("div"); card.className = "template-card";
    card.appendChild(el("h3", t.name));
    card.appendChild(el("p", t.description));
    var meta = el("p"); meta.className = "muted";
    var tag = el("span", t.stack); tag.className = "run-src"; meta.appendChild(tag);
    meta.appendChild(el("span", "  "));
    var hint = el("code", "npx flare init --template " + t.id); hint.className = "mono"; meta.appendChild(hint);
    card.appendChild(meta);
    var view = el("button", "View YAML"); view.className = "ghost";
    var body = el("div");
    (function (id, btn, box) {
      btn.addEventListener("click", function () {
        if (box.children.length) { box.textContent = ""; btn.textContent = "View YAML"; return; }
        btn.disabled = true;
        api("/v1/templates/" + encodeURIComponent(id)).then(function (full) {
          btn.disabled = false;
          btn.textContent = "Hide YAML";
          var pre = el("pre", full.yaml || ""); pre.className = "log"; box.appendChild(pre);
          var copy = el("button", "Copy"); copy.className = "ghost";
          copy.addEventListener("click", function () { copyText(full.yaml || "", copy); });
          box.appendChild(copy);
        }, function (e) {
          btn.disabled = false;
          var err = el("p", e.message); err.className = "err"; box.appendChild(err);
        });
      });
    })(t.id, view, body);
    card.appendChild(view);
    card.appendChild(body);
    list.appendChild(card);
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
      var srcLabel = pipelineSourceLabel(data.run.pipeline_source);
      if (srcLabel) {
        var srcLine = el("p");
        srcLine.className = "muted";
        srcLine.textContent = srcLabel === "Actions"
          ? "Pipeline: .github/workflows (GitHub Actions drop-in)"
          : "Pipeline: " + srcLabel;
        box.appendChild(srcLine);
      }
      var testsBox = document.createElement("div");
      box.appendChild(testsBox);
      (function renderTests(runId) {
        api("/v1/runs/" + encodeURIComponent(runId) + "/tests").then(function (t) {
          if (!t || !t.totals || !t.totals.total) return;
          testsBox.appendChild(el("h3", "Tests: " + t.totals.passed + " passed, " + t.totals.failed + " failed, " +
            t.totals.errors + " errors, " + t.totals.skipped + " skipped"));
          (t.failing || []).forEach(function (f) {
            var line = el("p");
            var where = [f.jobName, f.suite].filter(function (x) { return !!x; }).join(" / ");
            line.appendChild(el("code", String(f.name)));
            if (where) line.appendChild(el("span", " — " + where));
            testsBox.appendChild(line);
            if (f.message) {
              var msg = el("div", String(f.message).slice(0, 300));
              msg.className = "muted";
              testsBox.appendChild(msg);
            }
          });
        }).catch(function () {});
      })(data.run.id);
      var egressBox = document.createElement("div");
      box.appendChild(egressBox);
      (function renderEgress(runId) {
        api("/v1/runs/" + encodeURIComponent(runId) + "/egress").then(function (e) {
          if (!e || !e.totals || (e.totals.reqBytes === 0 && e.totals.respBytes === 0)) return;
          egressBox.appendChild(el("h3", "Egress: " + e.totals.reqBytes + "b up, " + e.totals.respBytes + "b down"));
          (e.jobs || []).slice(0, 20).forEach(function (r) {
            egressBox.appendChild(el("p", String(r.jobId).slice(0, 8) + " " + r.host + ": " + r.reqBytes + "b up / " + r.respBytes + "b down"));
          });
        }).catch(function () {});
      })(data.run.id);
      var resBox = document.createElement("div");
      box.appendChild(resBox);
      (function renderResources(jobs) {
        var measured = [];
        (jobs || []).forEach(function (j) {
          var peak = peakRssOf(j);
          if (peak !== null) measured.push({ job: j, peak: peak });
        });
        if (!measured.length) return;
        var max = 0;
        measured.forEach(function (m) { if (m.peak > max) max = m.peak; });
        resBox.appendChild(el("h3", "Resources (peak RSS per job)"));
        measured.forEach(function (m) {
          var row = el("div");
          row.className = "res-row";
          var name = el("code", m.job.name || String(m.job.id).slice(0, 8)); name.className = "mono"; row.appendChild(name);
          var bar = el("div"); bar.className = "res-bar";
          var fill = el("div"); fill.className = "res-fill";
          fill.style.width = Math.max(2, Math.round(m.peak / max * 100)) + "%";
          bar.appendChild(fill); row.appendChild(bar);
          var cls = sizeClassForPeak(m.peak);
          row.appendChild(el("span", fmtBytes(m.peak) + " · size-" + cls + " (" + SIZE_CLASS_BLURB[cls] + ")"));
          resBox.appendChild(row);
        });
        var legend = el("p", "Size classes: size-s <512 MB · size-m <2 GB · size-l <8 GB · size-xl ≥8 GB — tag job labels + runner FLARE_LABELS to segment the fleet.");
        legend.className = "muted";
        resBox.appendChild(legend);
      })(data.jobs);
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
        if (j.retained_until) {
          var ret = el("p", "Retained for debugging until " + j.retained_until + " (seat job-" + j.id + ").");
          ret.className = "muted";
          box.appendChild(ret);
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
  function loadEgress() {
    var err = document.getElementById("egressErr");
    var box = document.getElementById("egressList");
    err.textContent = "";
    document.getElementById("egressOk").textContent = "";
    box.textContent = "";
    var loading = el("p", "Loading…"); loading.className = "muted"; box.appendChild(loading);
    api("/v1/admin/egress-allowlist").then(function (data) {
      box.textContent = "";
      var lists = data.allowlists || [];
      if (!lists.length) {
        var none = el("p", "No repo allowlists yet — every repo runs observe-only.");
        none.className = "muted";
        box.appendChild(none);
        return;
      }
      lists.forEach(function (a) {
        var row = el("div");
        row.className = "secret-row";
        var code = el("code", a.repo + ": " + (a.domains || []).join(", ")); code.className = "mono"; row.appendChild(code);
        var del = el("button", "Delete");
        del.className = "danger";
        del.addEventListener("click", function () {
          api("/v1/admin/egress-allowlist?repo=" + encodeURIComponent(a.repo), { method: "DELETE" })
            .then(loadEgress)
            .catch(function (e) { err.textContent = "Delete failed: " + (e.message || "error"); });
        });
        row.appendChild(del);
        box.appendChild(row);
      });
    }).catch(function (e) { box.textContent = ""; err.textContent = "Could not load allowlists: " + (e.message || "error"); });
  }
  document.getElementById("egressForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("egressErr");
    var ok = document.getElementById("egressOk");
    err.textContent = ""; ok.textContent = "";
    var repo = document.getElementById("egressRepoInput").value.trim();
    var domains = document.getElementById("egressDomainsInput").value.split(",").map(function (d) { return d.trim(); }).filter(function (d) { return !!d; });
    if (!repo) { err.textContent = "Enter a repository."; return; }
    if (!domains.length) { err.textContent = "Enter at least one domain."; return; }
    api("/v1/admin/egress-allowlist", { method: "POST", body: JSON.stringify({ repo: repo, domains: domains }) })
      .then(function () {
        ok.textContent = "Allowlist saved.";
        document.getElementById("egressDomainsInput").value = "";
        loadEgress();
      })
      .catch(function (e) { err.textContent = "Save failed: " + (e.message || "error"); });
  });
  function loadMirrors() {
    var box = document.getElementById("mirrorList");
    box.textContent = "";
    var loading = el("p", "Loading…"); loading.className = "muted"; box.appendChild(loading);
    api("/v1/admin/mirrors").then(function (data) {
      box.textContent = "";
      var mirrors = data.mirrors || [];
      if (!mirrors.length) {
        var none = el("p", "No mirrors yet — the first push for a repo provisions one automatically.");
        none.className = "muted";
        box.appendChild(none);
        return;
      }
      mirrors.forEach(function (m) {
        var row = el("div");
        row.className = "secret-row";
        var code = el("code", m.repo + " → " + m.mirror); code.className = "mono"; row.appendChild(code);
        var p = pill(m.status);
        p.className = "pill " + (m.status === "ready" ? "success" : m.status === "failed" ? "failure" : "running");
        row.appendChild(p);
        if (m.detail) { var d = el("span", m.detail); d.className = "muted"; row.appendChild(d); }
        var when = el("span", "updated " + fmtAgo(m.updatedAt)); when.className = "muted"; row.appendChild(when);
        box.appendChild(row);
      });
    }).catch(function () {
      box.textContent = "";
      var err = el("p", "Could not load mirrors."); err.className = "err"; box.appendChild(err);
    });
  }
  function loadTokens() {
    var body = document.getElementById("tokensBody");
    stateRow(body, 6, "Loading tokens…", "muted");
    api("/v1/admin/tokens").then(function (data) {
      body.textContent = "";
      (data.tokens || []).forEach(function (t) {
        var tr = el("tr");
        tr.appendChild(el("td", t.name));
        tr.appendChild(el("td", t.scopes));
        tr.appendChild(el("td", t.repos ? t.repos : "all"));
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
      if (!body.children.length) stateRow(body, 6, "No tokens yet — create one above.", "muted");
    }).catch(function () { stateRow(body, 6, "Could not load tokens.", "err"); });
  }

  document.getElementById("tokenForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("tokenErr");
    err.textContent = "";
    document.getElementById("newTokenBox").hidden = true;
    var name = document.getElementById("tokenName").value.trim();
    var scope = document.getElementById("tokenScope").value;
    var repos = document.getElementById("tokenRepos").value.trim();
    api("/v1/admin/tokens", { method: "POST", body: JSON.stringify({ name: name, scopes: [scope], repos: repos }) })
      .then(function (data) {
        document.getElementById("newTokenVal").textContent = data.token;
        document.getElementById("newTokenBox").hidden = false;
        document.getElementById("tokenName").value = "";
        document.getElementById("tokenRepos").value = "";
        loadTokens();
      })
      .catch(function () { err.textContent = "Could not create token (name required; repos must be owner/name entries)."; });
  });

  document.getElementById("copyPairBtn").addEventListener("click", function () {
    copyText(document.getElementById("pairCmd").textContent, this);
  });
  document.getElementById("pairForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("pairErr");
    err.textContent = "";
    document.getElementById("pairBox").hidden = true;
    var name = document.getElementById("pairName").value.trim();
    api("/v1/admin/pair-codes", { method: "POST", body: JSON.stringify({}) })
      .then(function (data) {
        var cmd = "FLARE_ACTIONS_URL=" + window.location.origin +
          " npm run runner -- --pair " + data.code +
          (name ? " --pair-name " + name : "");
        document.getElementById("pairCmd").textContent = cmd;
        document.getElementById("pairBox").hidden = false;
        document.getElementById("pairName").value = "";
      })
      .catch(function () { err.textContent = "Could not create a pairing code."; });
  });

  function loadMyApps() {
    var body = document.getElementById("myAppsBody");
    if (!body) return;
    stateRow(body, 4, "Loading your apps…", "muted");
    api("/v1/oauth/grants").then(function (data) {
      body.textContent = "";
      (data.grants || []).forEach(function (g) {
        var tr = el("tr");
        tr.appendChild(el("td", g.clientName || g.clientId));
        tr.appendChild(el("td", (g.scopeDescriptions || g.scope || []).join("; ")));
        tr.appendChild(g.createdAt ? timeCell(new Date(g.createdAt * 1000).toISOString()) : el("td", "—"));
        var tdBtn = el("td");
        var btn = el("button", "Revoke");
        btn.className = "danger";
        btn.addEventListener("click", function () {
          api("/v1/oauth/grants?grantId=" + encodeURIComponent(g.grantId), { method: "DELETE" })
            .then(loadMyApps).catch(function () {});
        });
        tdBtn.appendChild(btn);
        tr.appendChild(tdBtn);
        body.appendChild(tr);
      });
      if (!body.children.length) stateRow(body, 4, "No connected apps.", "muted");
    }).catch(function () { stateRow(body, 4, "Could not load your apps.", "err"); });
  }

  function loadNotifyPrefs() {
    var err = document.getElementById("notifyPrefsErr");
    err.textContent = "";
    document.getElementById("notifyPrefsOk").textContent = "";
    api("/v1/notify/prefs").then(function (p) {
      document.getElementById("quietStartInput").value = p.quietStart || "";
      document.getElementById("quietEndInput").value = p.quietEnd || "";
      document.getElementById("newFailuresCheck").checked = !!p.newFailuresOnly;
      document.getElementById("notifyPrefsForm").style.display = "";
    }, function (e) {
      // GitHub logins have no email recipient; the API says so.
      document.getElementById("notifyPrefsForm").style.display = "none";
      err.textContent = (e && e.message) || "Could not load notification prefs.";
    });
  }

  document.getElementById("notifyPrefsForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("notifyPrefsErr");
    var ok = document.getElementById("notifyPrefsOk");
    err.textContent = ""; ok.textContent = "";
    var payload = {
      quietStart: document.getElementById("quietStartInput").value.trim(),
      quietEnd: document.getElementById("quietEndInput").value.trim(),
      newFailuresOnly: document.getElementById("newFailuresCheck").checked,
    };
    api("/v1/notify/prefs", { method: "POST", body: JSON.stringify(payload) })
      .then(function () {
        ok.textContent = "Saved.";
        loadNotifyPrefs();
      })
      .catch(function () { err.textContent = "Could not save (quiet hours are UTC HH:MM, both or neither)."; });
  });

  function loadOAuthGrants() {
    var body = document.getElementById("grantsBody");
    stateRow(body, 5, "Loading connected apps…", "muted");
    api("/v1/admin/oauth-grants").then(function (data) {
      body.textContent = "";
      (data.grants || []).forEach(function (g) {
        var tr = el("tr");
        tr.appendChild(el("td", g.clientName || g.clientId));
        tr.appendChild(el("td", g.userId));
        tr.appendChild(el("td", (g.scopeDescriptions || g.scope || []).join("; ")));
        tr.appendChild(g.createdAt ? timeCell(new Date(g.createdAt * 1000).toISOString()) : el("td", "—"));
        var tdBtn = el("td");
        var btn = el("button", "Revoke");
        btn.className = "danger";
        btn.addEventListener("click", function () {
          api("/v1/admin/oauth-grants?grantId=" + encodeURIComponent(g.grantId) + "&userId=" + encodeURIComponent(g.userId), { method: "DELETE" })
            .then(loadOAuthGrants).catch(function () {});
        });
        tdBtn.appendChild(btn);
        tr.appendChild(tdBtn);
        body.appendChild(tr);
      });
      if (!body.children.length) stateRow(body, 5, "No connected apps.", "muted");
    }).catch(function () { stateRow(body, 5, "Could not load connected apps.", "err"); });
  }

  function loadAudit() {
    var body = document.getElementById("auditBody");
    stateRow(body, 4, "Loading audit log…", "muted");
    api("/v1/admin/audit").then(function (data) {
      body.textContent = "";
      (data.entries || []).forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(timeCell(e.created_at));
        tr.appendChild(el("td", e.actor));
        tr.appendChild(el("td", e.action));
        tr.appendChild(el("td", e.target || "—"));
        body.appendChild(tr);
      });
      if (!body.children.length) stateRow(body, 4, "No audit entries yet.", "muted");
    }).catch(function () { stateRow(body, 4, "Could not load audit log.", "err"); });
  }

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
      document.getElementById("notifyWebhookInput").value = "";
      document.getElementById("notifyWebhookInfo").textContent =
        "Chat webhook: " + (s.notifyWebhookSet ? "configured (write-only)." : "not set.") + " Works with Slack, Discord, and Mattermost-compatible URLs.";
      document.getElementById("billingTokenInput").value = "";
      document.getElementById("billingAccountInput").value = s.cloudflareAccountId || "";
      lastBillingAccount = s.cloudflareAccountId || "";
      document.getElementById("billingInfo").textContent =
        "Billable usage: " + (s.billingTokenSet && s.cloudflareAccountId ? "configured." : "not set.") + " A typed token saves; emptying the account id clears it.";
      document.getElementById("billingOk").textContent = "";
      document.getElementById("notifyWebhookOk").textContent = "";
      document.getElementById("badgeHiddenInput").value = s.badgeHiddenRepos || "";
      document.getElementById("badgeOk").textContent = "";
      document.getElementById("turnstileInfo").textContent =
        "Bot check on login, register, bootstrap, and reset: " +
        (s.turnstileSiteSource === "env" ? "managed via environment." :
          s.turnstileSiteKey ? ("site key set" + (s.turnstileSecretSet ? " + secret set." : ", secret missing.")) : "off.");
      document.getElementById("turnstileSiteInput").value = s.turnstileSiteKey || "";
      document.getElementById("turnstileSecretInput").value = "";
      document.getElementById("turnstileForm").style.display = s.turnstileSiteSource === "env" ? "none" : "flex";
      document.getElementById("turnstileOk").textContent = "";
      document.getElementById("schedInfo").textContent =
        "Fair share caps concurrently running jobs per repo for the shared poll pool. " +
        "The AI gateway fronts triage/generate (unified billing/logs)" +
        (s.aiGatewaySource === "env" ? ", managed via environment." : ".") +
        " Web search grounds triage in live results (bills gateway credits).";
      document.getElementById("fairShareInput").value = String(s.fairSharePerRepo ?? 0);
      document.getElementById("agentShareInput").value = String(s.fairSharePerAgent ?? 0);
      var budgetPairs = [];
      try {
        var parsedBudget = JSON.parse(s.budgetMinutes || "{}");
        Object.keys(parsedBudget).forEach(function (k) { budgetPairs.push(k + "=" + parsedBudget[k]); });
      } catch (e) { /* leave empty on malformed stored value */ }
      document.getElementById("budgetInput").value = budgetPairs.join(", ");
      document.getElementById("budgetModeSelect").value = s.budgetMode || "warn";
      document.getElementById("killMultiplierInput").value = (s.budgetKillMultiplier && s.budgetKillMultiplier !== "0") ? s.budgetKillMultiplier : "";
      loadPaused();
      loadEgress();
      loadMirrors();
      document.getElementById("supersedeCheck").checked = s.supersedeBranchRuns === "push";
      document.getElementById("gatewayInput").value = s.aiGatewayId || "";
      document.getElementById("gatewayInput").disabled = s.aiGatewaySource === "env";
      document.getElementById("triageModelInput").value = s.triageModelSource === "default" ? "" : (s.triageModel || "");
      document.getElementById("triageModelInput").disabled = s.triageModelSource === "env";
      document.getElementById("triageModelInput").title = "effective: " + (s.triageModel || "default");
      document.getElementById("writeConfirmCheck").checked = !!s.mcpWriteConfirm;
      document.getElementById("webSearchCheck").checked = !!s.triageWebSearch;
      document.getElementById("healCheck").checked = !!s.healOnFailure;
      document.getElementById("openRegCheck").checked = !!s.openRegistration;
      document.getElementById("schedOk").textContent = "";
      document.getElementById("ghRunnerCheck").checked = s.githubRunnerMode === "on";
      document.getElementById("ghRunnerLabelsInput").value = s.githubRunnerLabels || "flare";
      document.getElementById("ghRunnerOk").textContent = "";
      loadGhRunnerJobs();
      loadSchedules();
      loadMonitors();
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

  document.getElementById("notifyWebhookForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("notifyWebhookErr");
    var ok = document.getElementById("notifyWebhookOk");
    err.textContent = ""; ok.textContent = "";
    var url = document.getElementById("notifyWebhookInput").value.trim();
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify({ notifyWebhookUrl: url }) })
      .then(function () {
        document.getElementById("notifyWebhookInput").value = "";
        ok.textContent = url ? "Saved." : "Cleared.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (a 12-512 char https URL is required; empty clears)."; });
  });

  var lastBillingAccount = "";
  document.getElementById("billingForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("billingErr");
    var ok = document.getElementById("billingOk");
    err.textContent = ""; ok.textContent = "";
    var body = {};
    var token = document.getElementById("billingTokenInput").value.trim();
    var account = document.getElementById("billingAccountInput").value.trim();
    // Password field renders empty: only a typed token is sent (empty
    // never clears here — clear via the API). Account id saves when
    // changed; emptying it clears the stored id.
    if (token) body.billingApiToken = token;
    if (account !== lastBillingAccount) body.cloudflareAccountId = account;
    if (Object.keys(body).length === 0) { ok.textContent = "Nothing to save."; return; }
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify(body) })
      .then(function () {
        document.getElementById("billingTokenInput").value = "";
        ok.textContent = "Saved.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (token 20-512 chars, account id 32 hex)."; });
  });

  document.getElementById("badgeHiddenForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("badgeErr");
    var ok = document.getElementById("badgeOk");
    err.textContent = ""; ok.textContent = "";
    var repos = document.getElementById("badgeHiddenInput").value;
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify({ badgeHiddenRepos: repos }) })
      .then(function () {
        ok.textContent = "Saved.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (entries must be owner/name)."; });
  });

  document.getElementById("turnstileForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("turnstileErr");
    var ok = document.getElementById("turnstileOk");
    err.textContent = ""; ok.textContent = "";
    var payload = { turnstileSiteKey: document.getElementById("turnstileSiteInput").value.trim() };
    var secret = document.getElementById("turnstileSecretInput").value;
    if (secret) payload.turnstileSecretKey = secret;
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify(payload) })
      .then(function () {
        ok.textContent = "Saved.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (site key required to enable)."; });
  });

  document.getElementById("schedForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("schedErr");
    var ok = document.getElementById("schedOk");
    err.textContent = ""; ok.textContent = "";
    var cap = parseInt(document.getElementById("fairShareInput").value.trim(), 10);
    if (isNaN(cap) || cap < 0 || cap > 100) {
      err.textContent = "Fair share must be an integer 0-100.";
      return;
    }
    var agentCapRaw = document.getElementById("agentShareInput").value.trim();
    var agentCap = agentCapRaw === "" ? 0 : parseInt(agentCapRaw, 10);
    if (isNaN(agentCap) || agentCap < 0 || agentCap > 100) {
      err.textContent = "Per-agent share must be an integer 0-100.";
      return;
    }
    var killRaw = document.getElementById("killMultiplierInput").value.trim();
    var kill = killRaw === "" ? 0 : parseInt(killRaw, 10);
    if (isNaN(kill) || kill < 0 || kill > 100 || (killRaw !== "" && kill < 1)) {
      err.textContent = "Kill multiplier must be blank/0 (off) or 1-100.";
      return;
    }
    var payload = {
      fairSharePerRepo: cap,
      fairSharePerAgent: agentCap,
      budgetMinutes: document.getElementById("budgetInput").value.trim(),
      budgetMode: document.getElementById("budgetModeSelect").value,
      budgetKillMultiplier: kill,
      supersedeBranchRuns: document.getElementById("supersedeCheck").checked ? "push" : "off",
      mcpWriteConfirm: document.getElementById("writeConfirmCheck").checked,
      triageWebSearch: document.getElementById("webSearchCheck").checked,
      healOnFailure: document.getElementById("healCheck").checked,
      openRegistration: document.getElementById("openRegCheck").checked,
    };
    if (!document.getElementById("gatewayInput").disabled) {
      payload.aiGatewayId = document.getElementById("gatewayInput").value.trim();
    }
    if (!document.getElementById("triageModelInput").disabled) {
      payload.triageModel = document.getElementById("triageModelInput").value.trim();
    }
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify(payload) })
      .then(function () {
        ok.textContent = "Saved.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (budgets: owner/name=minutes; gateway id a 1-64 char slug; model a Workers AI id)."; });
  });

  function loadPaused() {
    var box = document.getElementById("pausedBox");
    box.textContent = "";
    api("/v1/admin/paused").then(function (res) {
      var paused = (res && res.paused) || [];
      if (paused.length === 0) {
        box.textContent = "Kill switch: no repos paused.";
        return;
      }
      box.appendChild(el("strong", "Paused for runaway spend: "));
      paused.forEach(function (p) {
        var line = el("div");
        var actors = (p.topActors || []).map(function (a) { return a.actor + " (" + a.dispatches + ")"; }).join(", ");
        line.appendChild(el("span", p.repo + " — " + p.usedMinutes + "/" + (p.cap === null ? "?" : p.cap) + " compute-min since " + fmtAgo(p.pausedAt) + (actors ? ", top: " + actors : "") + " "));
        var btn = el("button", "Resume");
        btn.className = "ghost";
        btn.addEventListener("click", function () {
          api("/v1/admin/paused?repo=" + encodeURIComponent(p.repo), { method: "DELETE" }).then(function () {
            loadPaused();
          }, function (e) {
            document.getElementById("schedErr").textContent = (e && e.message) || "Resume failed";
          });
        });
        line.appendChild(btn);
        box.appendChild(line);
      });
    }, function () {
      box.textContent = "Kill switch: could not load paused repos.";
    });
  }

  document.getElementById("ghRunnerForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("ghRunnerErr");
    var ok = document.getElementById("ghRunnerOk");
    err.textContent = ""; ok.textContent = "";
    var payload = {
      githubRunnerMode: document.getElementById("ghRunnerCheck").checked ? "on" : "off",
      githubRunnerLabels: document.getElementById("ghRunnerLabelsInput").value.trim(),
    };
    api("/v1/admin/settings", { method: "POST", body: JSON.stringify(payload) })
      .then(function () {
        ok.textContent = "Saved.";
        loadSettings();
      })
      .catch(function () { err.textContent = "Could not save (labels: comma-separated, 1-5, e.g. flare, gpu)."; });
  });

  function loadGhRunnerJobs() {
    return api("/v1/github/jobs?limit=5").then(function (data) {
      var list = document.getElementById("ghRunnerList");
      list.textContent = "";
      var rows = data.jobs || [];
      if (rows.length === 0) {
        var empty = el("p", "No runner-mode jobs yet.");
        empty.className = "muted";
        list.appendChild(empty);
        return;
      }
      rows.forEach(function (j) {
        var row = el("div");
        row.className = "inline";
        var info = el("span", j.repo + " " + j.jobName + " [" + (j.labels || []).join(", ") + "]");
        info.className = "muted";
        var state = el("span", j.status + (j.conclusion ? " / " + j.conclusion : "") + (j.runnerName ? " on " + j.runnerName : ""));
        state.className = "muted";
        row.appendChild(info);
        row.appendChild(state);
        list.appendChild(row);
      });
    }).catch(function () {
      document.getElementById("ghRunnerErr").textContent = "Could not load runner-mode jobs.";
    });
  }

  function scheduleAction(path, method, body) {
    var err = document.getElementById("scheduleErr");
    err.textContent = "";
    api(path, { method: method, body: body ? JSON.stringify(body) : undefined })
      .then(loadSchedules)
      .catch(function () { err.textContent = "Could not update the schedule."; });
  }

  function loadSchedules() {
    return api("/v1/admin/schedules").then(function (data) {
      var list = document.getElementById("scheduleList");
      list.textContent = "";
      var rows = data.schedules || [];
      if (rows.length === 0) {
        var empty = el("p", "No schedules yet.");
        empty.className = "muted";
        list.appendChild(empty);
        return;
      }
      rows.forEach(function (s) {
        var row = el("div");
        row.className = "inline";
        var info = el("span", s.repo + "@" + s.ref + "  " + s.cron + (s.enabled ? "" : " (disabled)"));
        info.className = "muted";
        var last = el("span", s.lastRunAt ? "last: " + fmtAgo(s.lastRunAt) : "never ran");
        last.className = "muted";
        var toggle = el("button", s.enabled ? "Disable" : "Enable");
        toggle.type = "button";
        toggle.addEventListener("click", function () {
          scheduleAction("/v1/admin/schedules/" + encodeURIComponent(s.id), "POST", { enabled: !s.enabled });
        });
        var del = el("button", "Delete");
        del.type = "button";
        del.addEventListener("click", function () {
          scheduleAction("/v1/admin/schedules/" + encodeURIComponent(s.id), "DELETE");
        });
        row.appendChild(info);
        row.appendChild(last);
        row.appendChild(toggle);
        row.appendChild(del);
        list.appendChild(row);
      });
    }).catch(function () {
      document.getElementById("scheduleErr").textContent = "Could not load schedules.";
    });
  }

  document.getElementById("scheduleForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("scheduleErr");
    err.textContent = "";
    var repo = document.getElementById("scheduleRepoInput").value.trim();
    var ref = document.getElementById("scheduleRefInput").value.trim();
    var cron = document.getElementById("scheduleCronInput").value.trim();
    api("/v1/admin/schedules", { method: "POST", body: JSON.stringify({ repo: repo, ref: ref, cron: cron }) })
      .then(function () {
        document.getElementById("scheduleForm").reset();
        loadSchedules();
      })
      .catch(function () {
        err.textContent = "Could not add schedule (owner/name, branch or tag, and a valid 5-field UTC cron required).";
      });
  });

  function monitorAction(path, method, body) {
    var err = document.getElementById("monitorErr");
    err.textContent = "";
    api(path, { method: method, body: body ? JSON.stringify(body) : undefined })
      .then(loadMonitors)
      .catch(function () { err.textContent = "Could not update the monitor."; });
  }

  function loadMonitors() {
    return api("/v1/admin/monitors").then(function (data) {
      var list = document.getElementById("monitorList");
      list.textContent = "";
      var rows = data.monitors || [];
      if (rows.length === 0) {
        var empty = el("p", "No monitors yet.");
        empty.className = "muted";
        list.appendChild(empty);
        return;
      }
      rows.forEach(function (m) {
        var row = el("div");
        row.className = "inline";
        var desc = m.repo + (m.branch ? "@" + m.branch : "") + (m.job ? " job:" + m.job : "") + "  " +
          (m.trigger === "duration" ? "over " + m.durationSeconds + "s" : m.result + " x" + m.consecutive) +
          (m.logPattern ? " log:" + m.logPattern : "") + (m.enabled ? "" : " (disabled)") +
          (m.mutedUntil && Date.parse(m.mutedUntil) > Date.now() ? " (muted)" : "");
        var info = el("span", (m.name ? m.name + ": " : "") + desc);
        info.className = "muted";
        var last = el("span", m.lastFiredAt ? "fired " + fmtAgo(m.lastFiredAt) : "never fired");
        last.className = "muted";
        var toggle = el("button", m.enabled ? "Disable" : "Enable");
        toggle.type = "button";
        toggle.addEventListener("click", function () {
          monitorAction("/v1/admin/monitors/" + encodeURIComponent(m.id), "POST", { enabled: !m.enabled });
        });
        var mute = el("button", "Mute 1h");
        mute.type = "button";
        mute.addEventListener("click", function () {
          monitorAction("/v1/admin/monitors/" + encodeURIComponent(m.id), "POST", { muteMinutes: 60 });
        });
        var del = el("button", "Delete");
        del.type = "button";
        del.addEventListener("click", function () {
          monitorAction("/v1/admin/monitors/" + encodeURIComponent(m.id), "DELETE");
        });
        row.appendChild(info);
        row.appendChild(last);
        row.appendChild(toggle);
        row.appendChild(mute);
        row.appendChild(del);
        list.appendChild(row);
      });
    }).catch(function () {
      document.getElementById("monitorErr").textContent = "Could not load monitors.";
    });
  }

  document.getElementById("monitorForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = document.getElementById("monitorErr");
    err.textContent = "";
    var payload = {
      repo: document.getElementById("monitorRepoInput").value.trim(),
      branch: document.getElementById("monitorBranchInput").value.trim(),
      job: document.getElementById("monitorJobInput").value.trim(),
      trigger: document.getElementById("monitorTriggerSelect").value,
      result: document.getElementById("monitorResultSelect").value,
      consecutive: parseInt(document.getElementById("monitorNInput").value.trim() || "1", 10),
      durationSeconds: parseInt(document.getElementById("monitorDurInput").value.trim() || "0", 10),
      logPattern: document.getElementById("monitorPatternInput").value
    };
    api("/v1/admin/monitors", { method: "POST", body: JSON.stringify(payload) })
      .then(function () {
        document.getElementById("monitorForm").reset();
        loadMonitors();
      })
      .catch(function () {
        err.textContent = "Could not add monitor (owner/name required; duration needs 60+ seconds).";
      });
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
