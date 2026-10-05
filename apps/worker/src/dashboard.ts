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
input, select { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--input-bg); color: var(--ink); }
input::placeholder { color: var(--faint); }
button { font: inherit; font-size: 14px; font-weight: 500; line-height: 1; padding: 9px 16px; border-radius: 999px; border: none; background: var(--accent); color: #fff; cursor: pointer; box-shadow: 0 0 0 1px #0e0e0e, inset 0 4px 6px 0 rgba(255,255,255,0.2), inset 0 0 0 1px rgba(255,255,255,0.15), inset 0 -8px 14px 0 rgba(0,0,0,0.15); transition: background-color 150ms ease; }
button:hover:not(:disabled) { background: var(--accent-hover); }
button.ghost { background: #232323; color: var(--ink); box-shadow: 0 0 0 1px #333333; }
button.ghost:hover:not(:disabled) { background: #2a2a2a; }
button.danger { background: #3e1d1e; color: #febfc6; box-shadow: inset 0 0 0 1px #4c2324; }
button.danger:hover:not(:disabled) { background: #4c2324; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
#runsFilterForm { margin-bottom: 6px; }
#dispatchBox { margin-bottom: 12px; }
#dispatchBox summary { cursor: pointer; color: var(--accent-ink); font-weight: 600; margin-bottom: 8px; }
#dispatchBox p { margin: 6px 0 0; }
.secret-row { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
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
<button id="tabSearch">Search</button>
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
<input id="gatewayInput" placeholder="AI gateway id (blank = direct)" maxlength="64">
<input id="triageModelInput" placeholder="triage model (blank = default)" maxlength="128" size="30">
<label><input type="checkbox" id="writeConfirmCheck"> MCP write-confirm</label>
<label><input type="checkbox" id="webSearchCheck"> triage web search</label>
<label><input type="checkbox" id="healCheck"> heal on failure (draft PR + verify run)</label>
<button type="submit">Save</button>
</form>
<p id="schedErr" class="err"></p>
<p id="schedOk"></p>
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
<section id="appsPane" class="card" hidden>
<h2>My apps</h2>
<p class="muted">OAuth apps you authorized on the MCP endpoint (Claude, ChatGPT, Cursor, …). Revoking disconnects the app immediately.</p>
<div class="table-scroll"><table><thead><tr><th>App</th><th>Scopes</th><th>Granted</th><th></th></tr></thead><tbody id="myAppsBody"></tbody></table></div>
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

  document.getElementById("resetBackBtn").addEventListener("click", function (ev) {
    ev.preventDefault();
    route(lastStatus || { claimed: true, githubConnected: false, breakGlass: false, installUrl: null });
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
  var tabSearch = document.getElementById("tabSearch");
  var tabApps = document.getElementById("tabApps");
  var tabAccess = document.getElementById("tabAccess");
  var tabSettings = document.getElementById("tabSettings");
  var runsPane = document.getElementById("runsPane");
  var searchPane = document.getElementById("searchPane");
  var appsPane = document.getElementById("appsPane");
  var accessPane = document.getElementById("accessPane");
  var settingsPane = document.getElementById("settingsPane");
  function selectTab(name) {
    tabRuns.className = name === "runs" ? "active" : "";
    tabSearch.className = name === "search" ? "active" : "";
    tabApps.className = name === "apps" ? "active" : "";
    tabAccess.className = name === "access" ? "active" : "";
    tabSettings.className = name === "settings" ? "active" : "";
    runsPane.hidden = name !== "runs";
    searchPane.hidden = name !== "search";
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
  tabSearch.addEventListener("click", function () { selectTab("search"); });
  tabApps.addEventListener("click", function () { selectTab("apps"); loadMyApps(); });
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
      list.appendChild(table);
    }, function (e) {
      err.textContent = (e && e.message) || "Search failed";
    });
  }
  tabAccess.addEventListener("click", function () { selectTab("access"); loadTokens(); loadUsers(); loadAudit(); loadOAuthGrants(); });
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

  function loadMyApps() {
    var body = document.getElementById("myAppsBody");
    if (!body) return;
    stateRow(body, 4, "Loading your apps…", "muted");
    api("/v1/oauth/grants").then(function (data) {
      body.textContent = "";
      (data.grants || []).forEach(function (g) {
        var tr = el("tr");
        tr.appendChild(el("td", g.clientName || g.clientId));
        tr.appendChild(el("td", (g.scope || []).join(" ")));
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

  function loadOAuthGrants() {
    var body = document.getElementById("grantsBody");
    stateRow(body, 5, "Loading connected apps…", "muted");
    api("/v1/admin/oauth-grants").then(function (data) {
      body.textContent = "";
      (data.grants || []).forEach(function (g) {
        var tr = el("tr");
        tr.appendChild(el("td", g.clientName || g.clientId));
        tr.appendChild(el("td", g.userId));
        tr.appendChild(el("td", (g.scope || []).join(" ")));
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
      document.getElementById("gatewayInput").value = s.aiGatewayId || "";
      document.getElementById("gatewayInput").disabled = s.aiGatewaySource === "env";
      document.getElementById("triageModelInput").value = s.triageModelSource === "default" ? "" : (s.triageModel || "");
      document.getElementById("triageModelInput").disabled = s.triageModelSource === "env";
      document.getElementById("triageModelInput").title = "effective: " + (s.triageModel || "default");
      document.getElementById("writeConfirmCheck").checked = !!s.mcpWriteConfirm;
      document.getElementById("webSearchCheck").checked = !!s.triageWebSearch;
      document.getElementById("healCheck").checked = !!s.healOnFailure;
      document.getElementById("schedOk").textContent = "";
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
    var payload = {
      fairSharePerRepo: cap,
      mcpWriteConfirm: document.getElementById("writeConfirmCheck").checked,
      triageWebSearch: document.getElementById("webSearchCheck").checked,
      healOnFailure: document.getElementById("healCheck").checked,
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
      .catch(function () { err.textContent = "Could not save (gateway id must be a 1-64 char slug; model a Workers AI id)."; });
  });

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
