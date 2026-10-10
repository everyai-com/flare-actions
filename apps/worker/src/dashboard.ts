import { FORGE_CSS, FORGE_NAV_HTML, FORGE_NAV_BENCH_HTML, FORGE_PANE_HTML, FORGE_OVERLAYS_HTML, FORGE_AUTH_DEMO_HTML, FORGE_HOME_CARD_HTML } from "./dashboard-forge-ui";
import { FORGE_JS } from "./dashboard-forge-js";
import { forgeFixturesJson } from "./forge-fixtures";

// Every data-action in the dashboard is either an MCP tool name (agents
// can do what humans click: docs/FORGE-UX.md §8.7) or a UI-only verb.
// FORGE_MCP_TOOL_NAMES lists the Forge tools the screens call (plan §3.3
// plus approve_plan/send_back/review_sample from the UX spec); stream B
// registers them in mcp.ts MCP_TOOL_RISK.
export const FORGE_MCP_TOOL_NAMES = [
  "plan_goal",
  "declare_intent",
  "whats_happening",
  "heartbeat",
  "report_push",
  "send_note",
  "mark_ready",
  "claim_conflict",
  "resolve_conflict",
  "why",
  "fork_session",
  "approve_plan",
  "send_back",
  "review_sample",
] as const;

export const DASHBOARD_UI_ACTIONS = [
  "pause_live",
  "view_as_table",
  "stage_mode",
  "toggle_theme",
  "copy_json_url",
  "copy_mcp_config",
  "copy_chain",
  "show_shortcuts",
  "select_item",
  "select_row",
  "filter_list",
  "open_detail",
  "highlight_agent",
  "tour_start",
  "tour_next",
  "tour_back",
  "tour_skip",
  "explore_demo",
] as const;

// GET / -> /dashboard keeping the query string: ?demo=1, ?stage=1 and
// ?tour=1 must survive the hop (a judge's /?demo=1#/live link). The
// #fragment never reaches the server; browsers re-attach it to a
// Location without one (RFC 9110 §10.2.2).
export function dashboardRedirectUrl(url: URL): string {
  const dest = new URL("/dashboard", url);
  dest.search = url.search;
  return dest.toString();
}

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Flare Actions dashboard: agent tournaments, CI runs, merge queue, and settings.">
<meta name="theme-color" content="#0a0a0a">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23fafafa'/%3E%3Ctext x='16' y='23' font-family='system-ui,sans-serif' font-size='19' font-weight='800' fill='black' text-anchor='middle'%3EF%3C/text%3E%3C/svg%3E">
<title>Flare Actions</title>
<link rel="alternate" type="application/json" id="fxAltLink" href="/v1/forge/snapshot">
<style>
:root { color-scheme: dark; --bg: #0a0a0a; --card: #111113; --sidebar: #0a0a0a; --line: #1f1f23; --line-strong: #2e2e33; --ink: #fafafa; --soft: #a1a1aa; --muted: #71717a; --faint: #3f3f46; --accent: #fafafa; --accent-hover: #e4e4e7; --accent-ink: #7aa8f0; --danger: #f87171; --ok: #4ade80; --warn: #fbbf24; --info: #7db4f7; --hover: #17171a; --input-bg: #0a0a0a; --ring: #52525b; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
header { display: flex; flex-direction: column; align-items: stretch; gap: 2px; padding: 14px 12px; background: var(--sidebar); border-right: 1px solid var(--line); position: fixed; left: 0; top: 0; bottom: 0; width: 228px; z-index: 20; }
header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
header h1.brand-head { padding: 2px 8px 12px; }
main { margin: 0; }
body.app main { margin-left: 228px; }
.wrap { max-width: 960px; margin: 0 auto; padding: 20px 20px 40px; }
nav.side-nav { display: none; flex-direction: column; gap: 2px; }
body.app nav.side-nav { display: flex; }
.side-link { display: flex; align-items: center; gap: 10px; width: 100%; background: transparent; color: var(--muted); border: 1px solid transparent; border-radius: 6px; padding: 7px 10px; font-size: 13px; font-weight: 500; text-align: left; }
.side-link[hidden] { display: none; }
.side-link svg { flex: none; opacity: 0.85; }
.side-link:hover:not(:disabled) { background: var(--hover); color: var(--ink); }
.side-link.active { background: var(--hover); color: var(--ink); border-color: var(--line); }
body:not(.app) #paletteBtn { display: none; }
body:not(.app) header { display: none; }
.side-group { font-size: 11px; font-weight: 600; color: var(--faint); padding: 10px 10px 2px; }
.side-nav .side-group:first-child { padding-top: 2px; }
.side-foot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 12px 8px 0; border-top: 1px solid var(--line); overflow: hidden; }
.side-foot #userLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
section.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
.settings-jump { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px; margin: -4px 0 14px; padding: 6px 0; background: var(--card, var(--bg)); }
.settings-jump button { height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
#teamPane h2[id], #settingsPane h2[id] { scroll-margin-top: 56px; }
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
button { font: inherit; font-size: 13px; font-weight: 500; line-height: 1; padding: 8px 14px; border-radius: 6px; border: 1px solid transparent; background: var(--accent); color: #000; cursor: pointer; transition: background-color 150ms ease; }
button:hover:not(:disabled) { background: var(--accent-hover); }
button.ghost { background: transparent; color: var(--ink); border-color: var(--line-strong); }
button.ghost:hover:not(:disabled) { background: var(--hover); }
button.danger { background: transparent; color: var(--danger); border-color: #7f1d1d; }
button.danger:hover:not(:disabled) { background: #1c1214; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } .pane-enter, .t-enter > *, .pill.running::before, .skel, .toast, #palette { animation: none; } }
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
@media (max-width: 900px) {
  header { position: sticky; top: 0; width: auto; flex-direction: row; align-items: center; gap: 8px; padding: 10px 12px; border-right: none; border-bottom: 1px solid var(--line); }
  header h1.brand-head { padding: 0; }
  header h1.brand-head span:last-child { display: none; }
  body.app nav.side-nav { flex-direction: row; overflow-x: auto; flex: 1; min-width: 0; scrollbar-width: none; -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); padding-right: 24px; }
  body.app nav.side-nav::-webkit-scrollbar { display: none; }
  .side-link { width: auto; flex: none; }
  .side-group { display: none; }
  .side-foot { margin-top: 0; margin-left: auto; padding: 0; border-top: none; }
  .side-foot #paletteBtn { display: none; }
  body.app main { margin-left: 0; }
}
.table-scroll { overflow-x: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 12px; font-weight: 500; color: var(--muted); letter-spacing: 0.01em; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr.clickable { cursor: pointer; }
tbody tr.clickable:hover { background: rgba(255,255,255,0.04); }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line-strong); background: transparent; font-size: 12px; font-weight: 500; line-height: 1; white-space: nowrap; color: var(--soft); }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: var(--muted); flex: none; }
.pill.running::before { background: var(--info); }
.pill.success::before { background: var(--ok); }
.pill.failure::before, .pill.error::before { background: var(--danger); }
.pill.blocked::before { background: var(--warn); }
pre.log { background: #101214; border: 1px solid var(--line); color: #d0d4dd; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent; }
div.triage { border: 1px solid var(--line-strong); background: transparent; padding: 10px 12px; border-radius: 8px; margin: 8px 0; white-space: pre-wrap; font-size: 13px; color: var(--soft); }
div.triage-label { font-size: 12px; font-weight: 600; color: var(--ink); margin-bottom: 2px; }
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
.auth-card { padding: 32px 28px; max-width: 480px; margin: 6vh auto 0; }
.auth-narrow { max-width: 420px; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 6px; background: var(--accent); color: #000; font-weight: 800; font-size: 16px; }
.brand-name { font-weight: 600; font-size: 16px; }
#connectBox, #githubBox { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
#emailBox h2, #connectBox h2 { margin: 0 0 4px; font-size: 16px; }
.auth-form { display: flex; flex-direction: column; gap: 12px; margin: 12px 0 4px; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 600; }
.field[hidden], form.inline[hidden], form.auth-form[hidden] { display: none; }
.field input { width: 100%; }
.btn-block { width: 100%; padding: 10px; }
.btn-github { background: transparent; color: var(--ink); border: 1px solid var(--line-strong); cursor: pointer; border-radius: 6px; font: inherit; padding: 10px; }
.btn-github:hover { background: var(--hover); }
#githubBox .btn-block + .btn-block { margin-top: 8px; }
.divider { display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 12px; margin: 4px 0 2px; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
ol.steps { margin: 10px 0 0; padding: 0; list-style: none; counter-reset: step; max-width: 64ch; }
ol.steps li { counter-increment: step; display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; border-top: 1px solid var(--line); font-size: 13px; }
ol.steps li::before { content: counter(step); flex: none; width: 20px; height: 20px; border-radius: 999px; background: transparent; border: 1px solid var(--line-strong); color: var(--muted); font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
ol.steps li.done::before { content: "✓"; background: var(--accent); border-color: transparent; color: #000; }
ol.steps .step-body { flex: 1; min-width: 0; }
ol.steps .step-body p { margin: 0 0 6px; color: var(--muted); }
ol.steps .step-body p strong { color: var(--ink); font-weight: 600; }
.t-hero { padding: 2px 0 14px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.t-intent { font-size: 20px; font-weight: 700; letter-spacing: -0.015em; line-height: 1.3; margin: 0 0 10px; overflow-wrap: anywhere; }
.t-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chip { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 10px; border-radius: 6px; background: var(--hover); border: 1px solid var(--line); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--soft); overflow-wrap: anywhere; }
.t-zone { margin: 0 0 20px; }
.t-zone-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--soft); }
.t-zone-title .t-count { font-weight: 500; color: var(--muted); font-size: 12px; }
.t-lane { padding: 12px 2px; border-top: 1px solid var(--line); }
.t-lane:first-child { border-top: none; padding-top: 2px; }
.t-lane-head { display: flex; align-items: center; gap: 10px; }
.t-avatar { flex: none; width: 30px; height: 30px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; font-size: 13px; color: var(--soft); background: var(--hover); border: 1px solid var(--line-strong); }
.t-agent { font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.t-lane-sub { color: var(--muted); font-size: 12px; margin: 6px 0 0 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-lane-foot { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 8px 0 0 40px; }
.t-rank { display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: transparent; border: 1px solid var(--line-strong); color: var(--soft); white-space: nowrap; }
.t-rank.first { background: var(--accent); border-color: transparent; color: #000; }
.t-radar-card { background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 8px 0; }
.t-radar-pair { font-weight: 700; font-size: 14px; margin-bottom: 6px; }
.t-radar-pair .t-count { font-weight: 500; color: var(--muted); font-size: 12px; margin-left: 8px; }
.t-paths { display: flex; gap: 6px; flex-wrap: wrap; }
.t-crumb { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; color: var(--faint); font-size: 12px; margin: 0 0 6px; }
.t-crumb button { padding: 4px 10px; font-size: 12px; }
.t-clean { color: var(--muted); font-size: 13px; margin: 4px 0; }
.t-verdict { background: transparent; border: 1px solid var(--line-strong); border-radius: 8px; padding: 14px 16px; }
.t-winner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.t-winner-name { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.t-rationale { white-space: pre-wrap; font-size: 13px; color: var(--soft); margin: 8px 0; overflow-wrap: anywhere; }
.t-model { color: var(--muted); font-size: 12px; }
.t-ranklist { margin: 10px 0 0; padding: 0; list-style: none; }
.t-ranklist li { display: flex; gap: 10px; align-items: center; padding: 7px 0; border-top: 1px solid var(--line); font-size: 13px; flex-wrap: wrap; }
.t-ranklist li:first-child { border-top: none; }
.t-pos { flex: none; width: 26px; height: 26px; border-radius: 999px; background: transparent; border: 1px solid var(--line-strong); color: var(--muted); display: inline-flex; align-items: center; justify-content: center; font-weight: 600; font-size: 12px; }
.t-pos.first { background: var(--accent); border-color: transparent; color: #000; }
.t-timeline { margin: 0; padding: 0; list-style: none; }
.t-timeline li { position: relative; padding: 0 0 14px 22px; }
.t-timeline li::before { content: ""; position: absolute; left: 5px; top: 16px; bottom: -2px; width: 1px; background: var(--line-strong); }
.t-timeline li:last-child { padding-bottom: 2px; }
.t-timeline li:last-child::before { display: none; }
.t-dot { position: absolute; left: 0; top: 4px; width: 11px; height: 11px; border-radius: 999px; background: var(--faint); }
.t-dot.opened { background: var(--accent-hover); }
.t-dot.claimed, .t-dot.pushed { background: var(--info); }
.t-dot.collision { background: var(--warn); }
.t-dot.verdict, .t-dot.resolved, .t-dot.promoted, .t-dot.terminal { background: var(--ok); }
.t-dot.promote-failed { background: var(--danger); }
.t-event-kind { font-weight: 600; font-size: 13px; }
.t-event-body { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.t-event-time { color: var(--faint); font-size: 12px; margin-left: 8px; white-space: nowrap; }
@keyframes tFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes tRise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes tPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes tShimmer { from { background-position: -200px 0; } to { background-position: 200px 0; } }
.pane-enter { animation: tFadeIn 160ms ease; }
.t-enter > * { animation: tRise 180ms ease; }
.pill.running::before { animation: tPulse 1.6s ease-in-out infinite; }
.skel { border-radius: 6px; background: linear-gradient(90deg, var(--hover) 25%, #1e1e22 50%, var(--hover) 75%); background-size: 400px 100%; animation: tShimmer 1.2s ease infinite; }
.skel-row { height: 52px; margin: 8px 0; }
.skel-line { height: 14px; margin: 8px 0; }
#paletteOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 50; display: flex; justify-content: center; padding: 12vh 16px 16px; }
#paletteOverlay[hidden] { display: none; }
#palette { width: 100%; max-width: 620px; height: fit-content; max-height: 62vh; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line-strong); border-radius: 10px; overflow: hidden; box-shadow: 0 24px 64px rgba(0,0,0,0.5); animation: tRise 140ms ease; }
#paletteInput { border: none; background: transparent; padding: 14px 16px; font-size: 14px; outline: none; }
#paletteInput:focus-visible { outline: none; }
#paletteList { overflow-y: auto; padding: 6px; border-top: 1px solid var(--line); }
.pal-group { font-size: 11px; font-weight: 600; color: var(--faint); padding: 8px 10px 4px; letter-spacing: 0.04em; }
.pal-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.pal-row .pal-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal-row .pal-kind { color: var(--faint); font-size: 11px; flex: none; }
.pal-row.active { background: var(--hover); }
#paletteFoot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--line); color: var(--faint); font-size: 11px; }
kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; background: var(--hover); border: 1px solid var(--line-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; color: var(--soft); }
#toasts { position: fixed; left: 16px; bottom: 16px; z-index: 60; display: flex; flex-direction: column; gap: 8px; max-width: min(360px, calc(100vw - 32px)); }
.toast { background: var(--card); border: 1px solid var(--line-strong); border-radius: 8px; padding: 10px 14px; font-size: 13px; box-shadow: 0 12px 32px rgba(0,0,0,0.45); animation: tRise 160ms ease; }
.toast.err { border-color: #7f1d1d; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.home h2 { font-size: 24px; letter-spacing: -0.02em; margin: 0 0 6px; }
.home-lead { color: var(--soft); font-size: 15px; line-height: 1.55; margin: 0 0 18px; max-width: 60ch; }
.home-progress { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; }
.home-bar { flex: 1; max-width: 320px; height: 8px; border-radius: 999px; background: var(--hover); border: 1px solid var(--line); overflow: hidden; }
.home-bar span { display: block; height: 100%; width: 0; background: var(--ok, #16a34a); border-radius: 999px; transition: width 300ms ease; }
.home-progress-text { color: var(--muted); font-size: 13px; font-weight: 600; }
.home-steps { list-style: none; margin: 0 0 20px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.home-step { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.home-step.current { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--hover); }
.home-step.done { opacity: 0.75; padding: 8px 16px; align-items: center; }
.home-step.done .home-dot { width: 22px; height: 22px; font-size: 12px; }
.home-step.done .home-step-title { font-size: 13.5px; font-weight: 600; margin: 0; }
.home-dot { flex: none; width: 30px; height: 30px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; border: 2px solid var(--line-strong); color: var(--muted); }
.home-step.done .home-dot { background: var(--ok, #16a34a); border-color: transparent; color: #fff; }
.home-step.current .home-dot { border-color: var(--ink); color: var(--ink); }
.home-step-body { flex: 1; min-width: 0; }
.home-step-title { font-weight: 700; font-size: 15px; margin: 2px 0 2px; }
.home-step-text { color: var(--muted); margin: 0 0 8px; font-size: 13.5px; line-height: 1.5; }
.home-step.done .home-step-text { margin: 0; }
.home-step-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button.home-btn, a.home-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 8px 18px; font-size: 14px; font-weight: 600; border-radius: 8px; text-decoration: none; background: var(--accent); color: var(--accent-fg, #000); border: 1px solid transparent; }
a.home-btn:hover, button.home-btn:hover { background: var(--accent-hover); }
.home-alert { border: 1px solid var(--warn, #b45309); border-radius: 10px; padding: 14px 16px; margin: 0 0 18px; background: var(--tint-overlap, rgba(251,191,36,0.12)); }
.home-alert h3 { margin: 0 0 6px; font-size: 15px; }
.home-alert p { margin: 0 0 8px; }
.home-cmd { display: flex; gap: 8px; align-items: stretch; margin: 6px 0; }
.home-cmd code { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 8px; background: var(--code-bg); color: var(--code-ink); font-size: 12.5px; overflow-x: auto; white-space: nowrap; }
.home-verdict { display: flex; gap: 14px; align-items: center; padding: 18px; border-radius: 12px; border: 1px solid var(--line-strong); margin: 0 0 18px; flex-wrap: wrap; }
.home-verdict .big { font-size: 34px; line-height: 1; }
.home-verdict .what { flex: 1; min-width: 200px; }
.home-verdict .what strong { display: block; font-size: 18px; letter-spacing: -0.01em; }
.home-verdict .what span { color: var(--muted); font-size: 13px; }
.home-verdict.ok { border-color: var(--ok, #16a34a); background: var(--tint-landed, rgba(74,222,128,0.12)); }
.home-verdict.bad { border-color: var(--danger, #dc2626); background: var(--tint-conflict, rgba(248,113,113,0.12)); }
.home-verdict.busy { border-color: var(--info, #2563eb); background: var(--tint-working, rgba(125,180,247,0.12)); }
.home-sub { font-size: 14px; margin: 18px 0 8px; }
.home-agent .home-cmd code { white-space: normal; overflow-wrap: anywhere; }
#runDetail { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
.run-summary { margin: 4px 0 16px; align-items: flex-start; }
.run-summary .big { font-size: 26px; }
.run-summary-line { margin: 6px 0 0; font-size: 13px; color: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
.run-summary-line code { font-size: 12.5px; }
.home-runs { list-style: none; margin: 0 0 8px; padding: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.home-runs li { border-top: 1px solid var(--line); }
.home-runs li:first-child { border-top: none; }
.home-runs button { display: flex; gap: 12px; align-items: center; width: 100%; padding: 10px 14px; background: transparent; color: var(--ink); border: none; border-radius: 0; text-align: left; font-weight: 500; }
.home-runs button:hover { background: var(--hover); }
.home-runs .icon { flex: none; width: 22px; text-align: center; }
.home-runs .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-runs .word { flex: none; font-size: 12.5px; font-weight: 600; }
.home-runs .when { flex: none; color: var(--muted); font-size: 12px; }
.home-run-form { display: flex; gap: 8px; flex-wrap: wrap; }
.home-run-form select, .home-run-form input { flex: 1; min-width: 200px; min-height: 40px; font-size: 14px; }
.home-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 22px 0 0; }
.home-card { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; text-align: left; padding: 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--ink); font-weight: 400; }
.home-card:hover { border-color: var(--line-strong); background: var(--hover); }
.home-card[hidden] { display: none; }
.home-card strong { font-size: 14px; }
.home-card span { color: var(--muted); font-size: 12.5px; line-height: 1.45; }
@media (max-width: 640px) {
  html, body { overflow-x: hidden; }
  .wrap { padding: 12px 12px 32px; }
  section.card { padding: 14px; }
  .auth-card { padding: 20px 16px; }
  header { padding: 10px 12px; gap: 8px; }
  header h1 { font-size: 14px; }
  h2, h3 { overflow-wrap: anywhere; }
  .side-link { min-height: 44px; }
  #userLabel { display: none; }
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
  .t-lane-sub, .t-lane-foot { margin-left: 0; }
  .t-intent { font-size: 17px; }
  details.step summary { overflow-wrap: anywhere; }
  pre.log { white-space: pre-wrap; overflow-wrap: anywhere; }
}
${FORGE_CSS}</style>
</head>
<body>
<header>
<h1 class="brand-head"><span class="brand-mark">F</span><span>Flare Actions</span></h1>
<nav class="side-nav" id="sideNav" aria-label="Primary">
${FORGE_NAV_HTML}
<div class="side-group">Flare CI</div>
<button id="tabHome" class="side-link" data-tab="home" type="button"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.2 8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H9.6V10H6.4v3.5H3a.5.5 0 0 1-.5-.5z"/></svg><span>Home</span></button>
<button id="tabRuns" class="side-link" data-tab="runs" type="button"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M6.6 5.4 11 8l-4.4 2.6z" fill="currentColor" stroke="none"/></svg><span>Runs</span></button>
<button id="tabMerge" class="side-link" data-tab="merge" type="button"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="4" r="1.7"/><circle cx="4" cy="12" r="1.7"/><circle cx="12" cy="8" r="1.7"/><path d="M4 5.7v4.6M5.6 4.6c2.8.3 2.4 3.4 4.7 3.4"/></svg><span>Merge queue</span></button>
<div class="side-group">Code</div>
<button id="tabRepos" class="side-link" data-tab="repos" type="button"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 8 2l5 2.5v7L8 14l-5-2.5z"/><path d="M3 4.5 8 7l5-2.5M8 7v7"/></svg><span>Repositories</span></button>
<button id="tabTournaments" class="side-link" data-tab="tournaments" type="button"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.8" r="3.2"/><path d="M6.2 8.4 5.2 13.8 8 12.2l2.8 1.6-1-5.4"/></svg><span>Races</span></button>
<div class="side-group">Manage</div>
<button id="tabSettings" class="side-link" data-tab="settings" type="button"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.5h12M2 10.5h12"/><circle cx="10" cy="5.5" r="1.8" style="fill:var(--sidebar)"/><circle cx="6" cy="10.5" r="1.8" style="fill:var(--sidebar)"/></svg><span>Settings</span></button>
${FORGE_NAV_BENCH_HTML}
</nav>
<div class="side-foot"><span id="userLabel" class="muted"></span> <button id="paletteBtn" class="ghost" type="button" aria-label="Open command palette">⌘K</button> <button id="logoutBtn" class="ghost" hidden>Log out</button></div>
</header>
<main><div class="wrap">
<section id="authPane" class="card auth-card" hidden>
<div class="auth-narrow">
<div class="brand"><span class="brand-mark">F</span><span class="brand-name">Flare Actions</span></div>
<div id="emailBox">
<h2 id="emailTitle">Log in with email</h2>
<p class="muted" id="emailDesc">Welcome back.</p>
<form id="emailForm" class="auth-form">
<label class="field"><span>Email</span><input id="emailInput" type="email" placeholder="you@example.com" autocomplete="email" maxlength="254"></label>
<label class="field"><span>Password</span><input id="emailPw" type="password" placeholder="At least 8 characters" autocomplete="current-password"></label>
<label class="field" id="emailPw2Wrap" hidden><span>Type the password again</span><input id="emailPw2" type="password" placeholder="Same password again" autocomplete="new-password"></label>
<div id="tsEmail"></div>
<button type="submit" id="emailBtn" class="btn-block">Log in</button>
</form>
<p id="emailErr" class="err"></p>
<p class="muted"><button id="forgotBtn" class="ghost" type="button">Forgot password?</button></p>
<p class="muted"><button id="registerToggleBtn" class="ghost" type="button" hidden>No account? Create one</button></p>
<form id="magicForm" class="auth-form">
<label class="field">No password? Get a login link by email<input id="magicEmail" type="email" placeholder="you@example.com" autocomplete="email" maxlength="254"></label>
<button type="submit" class="btn-block ghost">Email me a link</button>
</form>
<p id="magicOk"></p>
<p id="magicErr" class="err"></p>
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
${FORGE_AUTH_DEMO_HTML}
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
<section id="magicConfirmPane" class="card auth-card" hidden>
<div class="auth-narrow">
<div class="brand"><span class="brand-mark">F</span><span class="brand-name">Flare Actions</span></div>
<h2>Finish logging in</h2>
<p class="muted">This link works once. Continue only if you requested it.</p>
<form id="magicConfirmForm" class="auth-form">
<button type="submit" class="btn-block">Continue to Flare Actions</button>
</form>
<p id="magicConfirmErr" class="err"></p>
</div>
</section>
<section id="appPane" hidden>
<section id="homePane" class="card home" hidden aria-labelledby="homeTitle">
<div class="home-hero">
<h2 id="homeTitle">Welcome to Flare 👋</h2>
<p class="home-lead" id="homeLead">Flare checks your code for you. Every time you save your work to GitHub, Flare runs your tests and tells you if anything broke.</p>
</div>
<div id="homeSetup" hidden>
<div class="home-progress" aria-hidden="true"><span class="home-bar"><span id="homeBarFill"></span></span><span id="homeProgressText" class="home-progress-text"></span></div>
<ol class="home-steps" id="homeSteps" aria-label="Setup steps"></ol>
</div>
<div id="homeWaiting" class="home-alert" role="status" hidden>
<h3>⏳ Your tests are waiting for a computer</h3>
<p>Flare needs a computer to run your tests. You can use the one you're on right now — it takes one command.</p>
<p><button id="homePairBtn" type="button" class="home-btn">Use my computer</button></p>
<div id="homePairBox" hidden>
<p class="muted">1. Open the Terminal app (Mac or Linux). 2. Paste this line and press Enter. 3. Keep the window open while your tests run.</p>
<div class="home-cmd"><code id="homePairCmd"></code><button id="homePairCopy" type="button" class="ghost">Copy</button></div>
<p class="muted">It checks for git and Node.js and tells you what to install if one is missing. The code works once and expires in 10 minutes. Next time, run the same line without the code to start again.</p>
</div>
<p id="homePairErr" class="err"></p>
</div>
<div id="homeStatus" hidden>
<div class="home-verdict" id="homeVerdict"></div>
<h3 class="home-sub">Latest runs</h3>
<ul class="home-runs" id="homeRuns"></ul>
<p><button id="homeAllRuns" type="button" class="ghost">See all runs →</button></p>
</div>
<div class="home-run-now" id="homeRunNow" hidden>
<h3 class="home-sub">Run my tests now</h3>
<form id="homeRunForm" class="home-run-form">
<label class="sr" for="homeRepo">Project</label>
<select id="homeRepo" aria-label="Project"></select>
<input id="homeRepoText" placeholder="owner/repo" maxlength="100" aria-label="Project (owner/repo)" hidden>
<button type="submit" class="home-btn">▶ Run tests</button>
</form>
<p id="homeRunMsg" class="muted"></p>
</div>
${FORGE_HOME_CARD_HTML}
<div class="home-agent" id="homeAgent">
<h3 class="home-sub">🤖 Using an AI coding agent?</h3>
<p class="muted">Paste this into Claude Code, Codex, or Cursor inside your project. It reads this Flare's instructions and sets up your tests here.</p>
<div class="home-cmd"><code id="homeAgentPrompt"></code><button id="homeAgentCopy" type="button" class="ghost">Copy</button></div>
</div>
<div class="home-cards">
<button type="button" class="home-card" id="homeCardRuns"><strong>📋 All runs</strong><span>Every test run, newest first, with logs and the reason anything failed.</span></button>
<button type="button" class="home-card" id="homeCardRaces"><strong>🏁 Agent races</strong><span>Give one task to several AI agents and let real tests pick the winner.</span></button>
<button type="button" class="home-card" id="homeCardInvite" hidden><strong>👋 Invite a teammate</strong><span>Send a link so a friend can see your runs.</span></button>
</div>
<p id="homeErr" class="err"></p>
</section>
<section id="runsPane" class="card" hidden>
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
<details id="cacheBox" hidden>
<summary>Cache browser…</summary>
<form id="cacheForm" class="inline">
<input id="cachePrefix" placeholder="key prefix (empty = all)" maxlength="100" aria-label="Cache key prefix">
<button type="submit">List</button>
<button id="cachePurgeBtn" type="button">Purge prefix</button>
</form>
<p id="cacheErr" class="err"></p>
<p id="cacheNote" class="muted"></p>
<div class="table-scroll"><table><thead><tr><th>Key</th><th>Size</th><th>Uploaded</th></tr></thead><tbody id="cacheBody"></tbody></table></div>
</details>
<details id="dispatchBox">
<summary>Dispatch a run…</summary>
<form id="dispatchForm" class="inline">
<input id="dispatchRepo" list="ghRepoList" autocomplete="off" placeholder="owner/repo" maxlength="100" aria-label="Repository">
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
<section id="teamPane" class="card" hidden>
<nav class="settings-jump" aria-label="Settings sections">
<button type="button" class="ghost" data-jump="setTokens">Tokens</button>
<button type="button" class="ghost" data-jump="setRunner">Runners</button>
<button type="button" class="ghost" data-jump="setPeople">People</button>
<button type="button" class="ghost" data-jump="setWebhook">Webhook</button>
<button type="button" class="ghost" data-jump="setNotify">Notifications</button>
<button type="button" class="ghost" data-jump="setGithub">GitHub App</button>
</nav>
<h2 id="setTokens">Access tokens</h2>
<p class="muted">Issue tokens for runners and teammates. Runner tokens can pull jobs and update status; readonly tokens can only view runs. Revoked tokens stop working immediately.</p>
<form id="tokenForm" class="inline">
<input id="tokenName" placeholder="Token name, e.g. ci-laptop" maxlength="64">
<select id="tokenScope"><option value="runner">runner</option><option value="readonly">readonly</option><option value="admin">admin</option></select>
<input id="tokenRepos" placeholder="optional: owner/repo, org/* (blank = all repos)" maxlength="2000">
<button type="submit">Create token</button>
</form>
<p id="tokenErr" class="err"></p>
<div id="newTokenBox" hidden>
<p><strong>Copy this token now — it is shown once.</strong></p>
<code class="token" id="newTokenVal"></code>
<p><button id="copyTokenBtn" class="ghost" type="button">Copy</button></p>
</div>
<div class="table-scroll"><table><thead><tr><th>Name</th><th>Scopes</th><th>Repos</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody id="tokensBody"></tbody></table></div>
<h2 id="setRunner">Pair a runner</h2>
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
<h2 id="setPeople">GitHub users</h2>
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
<h2 id="setWebhook">Webhook &amp; admin</h2>
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
<h2 id="setNotify">Run notifications</h2>
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
<h2 id="setGithub">GitHub App</h2>
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
<h2>Agent races</h2>
<p class="muted">One task races N agents in isolated forks. Open a tournament, agents claim slots, every push is verified, the verdict picks a winner. Press ⌘K to jump anywhere.</p>
<form id="tournamentForm" class="inline">
<input id="tournamentIntent" placeholder="task intent, e.g. fix the login redirect" maxlength="200" size="40" aria-label="Task intent">
<input id="tournamentSource" list="flareRepoList" autocomplete="off" placeholder="source repo" maxlength="100" size="20" aria-label="Source repo">
<button type="submit">Open tournament</button>
</form>
<p id="tournamentsErr" class="err"></p>
<div id="tournamentsList"></div>
<div id="tournamentDetail" hidden>
<p><button id="backToTournaments" class="ghost">Back to list</button> <button id="refreshTournament" class="ghost">Refresh</button></p>
<div id="tWhy"></div>
<div id="tReview"></div>
<div id="tLanes"></div>
<div id="tRadar"></div>
<div id="tActivity"></div>
</div>
</section>
<section id="reposPane" class="card" hidden>
<h2>Repositories</h2>
<p class="muted">Every codebase lives in one place. Open a repo to browse files and history — or race agents on it.</p>
<p id="reposErr" class="err"></p>
<div id="reposList"></div>
<div id="repoDetail" hidden>
<p><button id="backToRepos" class="ghost">Back to list</button></p>
<div id="repoHead"></div>
<div id="repoFiles"></div>
<div id="repoRuns"></div>
<div id="repoCommits"></div>
</div>
</section>
<section id="mergePane" class="card" hidden>
<h2>Merge queue</h2>
<p class="muted">Agent PRs land one at a time: each entry rebases onto the current head, verifies with real CI, and merges on green. One verification runs per repo; entries whose base moves re-queue instead of landing stale.</p>
<form id="mergeForm" class="inline">
<input id="mergeRepo" list="ghRepoList" autocomplete="off" placeholder="owner/repo" maxlength="100" aria-label="Repository">
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
${FORGE_PANE_HTML}</section>
</div></main>
<div id="paletteOverlay" hidden>
<div id="palette" role="dialog" aria-label="Command palette">
<input id="paletteInput" placeholder="Type a command or search…" autocomplete="off" aria-label="Command palette">
<div id="paletteList"></div>
<div id="paletteFoot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span><kbd>esc</kbd> close</span><span><kbd>i-</kbd> jump to ID</span><span class="pal-mcp" id="palMcp"></span></div>
</div>
</div>
<div id="toasts" aria-live="polite"></div>
${FORGE_OVERLAYS_HTML}<script type="application/json" id="fxFixtures">${forgeFixturesJson()}</script>
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
  // Plain words for run/job statuses; anything else (tournament states,
  // custom strings) shows as-is. The raw value stays in class + tooltip.
  var PILL_WORDS = { success: "passed", failure: "failed", error: "couldn't run", running: "running", queued: "waiting", blocked: "waiting", cancelled: "stopped", skipped: "skipped" };
  function pill(status) { var s = el("span", PILL_WORDS[status] || status); s.className = "pill " + status; s.title = status; return s; }

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
  var magicConfirmPane = document.getElementById("magicConfirmPane");
  var magicToken = null;

  function showInvite() {
    invitePane.hidden = false; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = ""; document.body.classList.remove("app");
    resetPane.hidden = true; resetConfirmPane.hidden = true; magicConfirmPane.hidden = true;
    ensureTurnstile("tsInvite");
  }

  function showReset() {
    resetPane.hidden = false; resetConfirmPane.hidden = true; magicConfirmPane.hidden = true; invitePane.hidden = true; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = ""; document.body.classList.remove("app");
    document.getElementById("resetRequestOk").textContent = "";
    document.getElementById("resetRequestErr").textContent = "";
    ensureTurnstile("tsReset");
  }

  function showResetConfirm(token) {
    resetToken = token;
    resetConfirmPane.hidden = false; magicConfirmPane.hidden = true; resetPane.hidden = true; invitePane.hidden = true; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = ""; document.body.classList.remove("app");
  }

  function showMagicConfirm(token) {
    magicToken = token;
    magicConfirmPane.hidden = false; resetConfirmPane.hidden = true; resetPane.hidden = true; invitePane.hidden = true; authPane.hidden = true; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = ""; document.body.classList.remove("app");
    document.getElementById("magicConfirmErr").textContent = "";
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
    resetPane.hidden = true; resetConfirmPane.hidden = true; magicConfirmPane.hidden = true;
    authPane.hidden = false; appPane.hidden = true; logoutBtn.hidden = true; userLabel.textContent = ""; document.body.classList.remove("app");
    document.getElementById("emailPw2Wrap").hidden = st.claimed;
    document.getElementById("emailBtn").textContent = st.claimed ? "Log in" : "Create my account";
    document.getElementById("emailTitle").textContent = st.claimed ? "Log in" : "Welcome! Let's set up Flare";
    document.getElementById("emailDesc").textContent = st.claimed
      ? "Welcome back 👋"
      : "Step 1 of 2: make your account. You'll be the owner of this Flare. Next, you'll connect GitHub.";
    // First run is account-only: no reset or magic link for an account
    // that doesn't exist yet, and GitHub connects from Home once signed in.
    document.getElementById("forgotBtn").hidden = !st.claimed;
    document.getElementById("magicForm").hidden = !st.claimed;
    document.getElementById("githubBox").hidden = !st.claimed;
    document.getElementById("connectBox").hidden = true;
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
    resetPane.hidden = true; resetConfirmPane.hidden = true; magicConfirmPane.hidden = true;
    authPane.hidden = true; appPane.hidden = false; logoutBtn.hidden = false; document.body.classList.add("app");
    // Home's checklist owns "Connect GitHub"; the Runs pane stays about runs.
    document.getElementById("connectBanner").hidden = true;
    // "email:pat@x" / "github:pat" are API actor ids; people read a name.
    userLabel.textContent = actor ? String(actor).replace(/^email:/, "").replace(/^github:/, "@") + " " : "";
    userLabel.title = actor || "";
    tabSettings.hidden = !admin;
    if (!admin) selectTab("home");
    var justInstalled = null;
    try { justInstalled = sessionStorage.getItem("flare-installed"); sessionStorage.removeItem("flare-installed"); } catch (e) {}
    var notice = document.getElementById("installNotice");
    notice.hidden = true;
    fxStartForge();
    if (justInstalled && admin) {
      toast(justInstalled === "update" ? "GitHub App updated ✓" : "GitHub is connected 🎉 Next: pick the projects to test.");
      palGoTab("home");
    } else if (!applyHashRoute()) palGoTab("home");
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
      registerWebMcpTools(st.user.admin);
      if (st.user.admin) { loadTokens(); loadUsers(); }
    } else if (FX.demo) {
      fxShowAnonDemo();
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
      var m = q.get("magic");
      var mt = q.get("magic_token");
      var installed = q.get("installation_id");
      var setupAction = q.get("setup_action");
      if ((g || inv || rt || m || mt || installed || setupAction) && window.history && window.history.replaceState) {
        // Drop one-shot params; keep the view params (demo, stage, tour) and the hash route.
        var keep = new URLSearchParams();
        ["demo", "stage", "tour"].forEach(function (k) { if (q.get(k)) keep.set(k, q.get(k)); });
        var ks = keep.toString();
        window.history.replaceState({}, "", "/dashboard" + (ks ? "?" + ks : "") + (location.hash || ""));
      }
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
      if (mt && !st.user) {
        showMagicConfirm(mt);
        return;
      }
      if (rt && rt !== "done" && !st.user) {
        showResetConfirm(rt);
        return;
      }
      route(st);
      handleGithubQuery(st, g, q.get("reason"));
      if (rt === "done") document.getElementById("loginMsg").textContent = "Password updated — log in.";
      if (m === "expired") document.getElementById("magicErr").textContent = "That link expired or was already used — request a new one.";
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

  document.getElementById("magicForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var em = document.getElementById("magicEmail").value.trim();
    var ok = document.getElementById("magicOk");
    var err = document.getElementById("magicErr");
    ok.textContent = "";
    err.textContent = "";
    fetch("/v1/admin/magic/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: em, turnstileToken: turnstileToken("tsEmail") }) })
      .then(function (res) {
        if (!res.ok) throw new Error("bad");
        document.getElementById("magicEmail").value = "";
        ok.textContent = "If an account exists for that email, a login link is on its way (15 min).";
      })
      .catch(function () { err.textContent = "Could not send a link. Try again later."; });
  });

  document.getElementById("magicConfirmForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var token = magicToken;
    magicToken = null;
    fetch("/v1/admin/magic/consume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token }) })
      .then(function (res) {
        if (!res.ok) throw new Error("bad");
        boot();
      })
      .catch(function () {
        route(lastStatus || { claimed: true, githubConnected: false, breakGlass: false, installUrl: null, openRegistration: false });
        document.getElementById("magicErr").textContent = "That link expired or was already used — request a new one.";
      });
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
  var tabTournaments = document.getElementById("tabTournaments");
  var tabRepos = document.getElementById("tabRepos");
  var tabMerge = document.getElementById("tabMerge");
  var tabSettings = document.getElementById("tabSettings");
  var runsPane = document.getElementById("runsPane");
  var tournamentsPane = document.getElementById("tournamentsPane");
  var teamPane = document.getElementById("teamPane");
  var reposPane = document.getElementById("reposPane");
  var mergePane = document.getElementById("mergePane");
  var settingsPane = document.getElementById("settingsPane");
  var tabHome = document.getElementById("tabHome");
  var homePane = document.getElementById("homePane");
  // ---------- Home: guided setup + plain-language status ----------
  // Words a newcomer understands for every run status.
  var FRIENDLY = {
    success: ["✅", "Passed"], failure: ["❌", "Failed"], error: ["⚠️", "Couldn't run"],
    running: ["⏳", "Running"], queued: ["🕐", "Waiting"], blocked: ["🕐", "Waiting"],
    cancelled: ["⏹️", "Stopped"], skipped: ["➖", "Skipped"]
  };
  function friendly(status) { return FRIENDLY[status] || ["•", status || "unknown"]; }
  var STEP_COPY = {
    account: ["Make your account", ""],
    github: ["Connect GitHub", "So Flare can see your code. One click, and GitHub asks you to confirm."],
    repos: ["Pick the projects to test", "Choose which GitHub repos Flare should watch. You can change this any time."],
    first_run: ["Run your tests for the first time", "Press the button below — or just push code to GitHub and Flare starts on its own."],
    green: ["Get your first green check", "When your tests pass you'll see ✅ here and on GitHub. If they fail, Flare shows exactly what broke."]
  };
  var homeState = null, homeRuns = [], homeTimer = null;
  function homeStepActions(id, st, box) {
    if (id === "github") {
      if (!st.admin) { box.appendChild(el("span", "Ask the person who set up Flare to connect GitHub.")); return; }
      var b = el("button", "Connect GitHub"); b.type = "button"; b.className = "home-btn";
      b.addEventListener("click", function () { startConnect(document.getElementById("homeErr")); });
      box.appendChild(b);
    } else if (id === "repos") {
      if (st.installUrl) {
        var a = el("a", "Choose repos on GitHub ↗"); a.href = st.installUrl; a.target = "_blank"; a.rel = "noopener"; a.className = "home-btn";
        box.appendChild(a);
      }
      var again = el("button", "I've done it — check again"); again.type = "button"; again.className = "ghost";
      again.addEventListener("click", function () { loadHome(); });
      box.appendChild(again);
    } else if (id === "first_run") {
      var go = el("button", "▶ Run my tests"); go.type = "button"; go.className = "home-btn";
      go.addEventListener("click", function () { var f = document.getElementById("homeRepo"); document.getElementById("homeRunNow").scrollIntoView({ behavior: "smooth", block: "center" }); if (f && !f.hidden) f.focus(); });
      box.appendChild(go);
    } else if (id === "green" && st.latest && (st.latest.status === "failure" || st.latest.status === "error")) {
      var see = el("button", "See what broke"); see.type = "button"; see.className = "home-btn";
      see.addEventListener("click", function () { selectTab("runs"); loadRuns(); loadRun(st.latest.id, true); });
      box.appendChild(see);
      box.appendChild(el("span", "Failing at first is normal — the details tell you what to fix."));
    }
  }
  function renderHomeSteps(st) {
    var list = document.getElementById("homeSteps");
    list.textContent = "";
    st.steps.forEach(function (step, i) {
      var copy = STEP_COPY[step.id] || [step.id, ""];
      var current = step.id === st.next;
      var li = el("li"); li.className = "home-step" + (step.done ? " done" : "") + (current ? " current" : "");
      if (current) li.setAttribute("aria-current", "step");
      var dot = el("span", step.done ? "✓" : String(i + 1)); dot.className = "home-dot"; dot.setAttribute("aria-hidden", "true");
      li.appendChild(dot);
      var body = el("div"); body.className = "home-step-body";
      var title = el("p", copy[0] + (step.done ? " — done" : "")); title.className = "home-step-title";
      body.appendChild(title);
      if (!step.done) { var t = el("p", copy[1]); t.className = "home-step-text"; body.appendChild(t); }
      if (current) { var acts = el("div"); acts.className = "home-step-actions"; homeStepActions(step.id, st, acts); body.appendChild(acts); }
      li.appendChild(body);
      list.appendChild(li);
    });
    document.getElementById("homeBarFill").style.width = Math.round((st.done / st.total) * 100) + "%";
    document.getElementById("homeProgressText").textContent = st.done + " of " + st.total + " done";
  }
  function renderHomeRepos(st) {
    var box = document.getElementById("homeRunNow");
    var sel = document.getElementById("homeRepo");
    var txt = document.getElementById("homeRepoText");
    var canRun = st.admin && (st.githubConnected || st.runs > 0);
    box.hidden = !canRun;
    if (!canRun) return;
    var prev = sel.value;
    sel.textContent = "";
    var repos = st.repos || [];
    repos.forEach(function (r) {
      var o = el("option", r.fullName + (r.private ? " 🔒" : ""));
      o.value = r.fullName; o.setAttribute("data-branch", r.defaultBranch || "main");
      sel.appendChild(o);
    });
    sel.hidden = repos.length === 0;
    txt.hidden = repos.length > 0;
    fillDatalist("ghRepoList", repos.map(function (r) { return r.fullName; }));
    if (prev) sel.value = prev;
  }
  function renderHomeStatus(st) {
    var box = document.getElementById("homeStatus");
    box.hidden = st.runs === 0;
    if (box.hidden) return;
    var v = document.getElementById("homeVerdict");
    v.textContent = "";
    var latest = st.latest;
    var f = friendly(latest ? latest.status : "");
    var cls = "home-verdict", head = "", sub = "";
    if (latest && latest.status === "success") { cls += " ok"; head = "All good! Your latest tests passed."; }
    else if (latest && (latest.status === "failure" || latest.status === "error")) { cls += " bad"; head = "Something broke in " + latest.repo + "."; }
    else if (latest && latest.status === "running") { cls += " busy"; head = "Running your tests right now…"; }
    else if (latest && (latest.status === "queued" || latest.status === "blocked")) { cls += " busy"; head = st.waitingForComputer ? "Waiting for a computer to start your tests…" : "Starting your tests…"; }
    else { head = "Latest run: " + f[1]; }
    if (latest) sub = latest.repo + (latest.branch ? " · " + latest.branch : "") + " · " + fmtAgo(latest.createdAt);
    v.className = cls;
    var big = el("span", f[0]); big.className = "big"; big.setAttribute("aria-hidden", "true");
    var what = el("div"); what.className = "what";
    what.appendChild(el("strong", head)); what.appendChild(el("span", sub));
    v.appendChild(big); v.appendChild(what);
    if (latest) {
      var open = el("button", latest.status === "failure" || latest.status === "error" ? "See what broke" : "Open");
      open.type = "button"; open.className = latest.status === "failure" || latest.status === "error" ? "home-btn" : "ghost";
      open.addEventListener("click", function () { selectTab("runs"); loadRuns(); loadRun(latest.id, true); });
      v.appendChild(open);
    }
    var list = document.getElementById("homeRuns");
    list.textContent = "";
    homeRuns.slice(0, 5).forEach(function (r) {
      var fr = friendly(r.status);
      var li = el("li"); var b = el("button"); b.type = "button";
      var ic = el("span", fr[0]); ic.className = "icon"; ic.setAttribute("aria-hidden", "true");
      var nm = el("span", (r.repo || "local upload") + (r.branch ? " · " + r.branch : "") + " @ " + String(r.sha || "").slice(0, 7)); nm.className = "name";
      var wd = el("span", fr[1]); wd.className = "word";
      var wh = el("span", fmtAgo(r.created_at)); wh.className = "when";
      b.appendChild(ic); b.appendChild(nm); b.appendChild(wd); b.appendChild(wh);
      b.setAttribute("aria-label", fr[1] + ": " + nm.textContent + ", " + wh.textContent);
      b.addEventListener("click", function () { selectTab("runs"); loadRuns(); loadRun(r.id, true); });
      li.appendChild(b); list.appendChild(li);
    });
  }
  function renderHome(st) {
    homeState = st;
    document.getElementById("homeErr").textContent = "";
    document.getElementById("homeTitle").textContent = st.complete ? "Your projects" : "Welcome to Flare 👋";
    document.getElementById("homeLead").textContent = st.complete
      ? "Flare runs your tests every time you push to GitHub. Here's how things look right now."
      : "Flare checks your code for you. Every time you save your work to GitHub, Flare runs your tests and tells you if anything broke. Let's get you set up — it takes about two minutes.";
    document.getElementById("homeSetup").hidden = st.complete;
    if (!st.complete) renderHomeSteps(st);
    document.getElementById("homeWaiting").hidden = !(st.waitingForComputer && st.admin);
    renderHomeRepos(st);
    renderHomeStatus(st);
    document.getElementById("homeCardInvite").hidden = !st.admin;
  }
  function loadHome() {
    return Promise.all([
      api("/v1/setup"),
      api("/v1/runs?limit=5").then(function (d) { return d.runs || []; }, function () { return []; })
    ]).then(function (out) { homeRuns = out[1]; renderHome(out[0]); })
      .catch(function (e) { if (String(e && e.message) !== "unauthorized") document.getElementById("homeErr").textContent = "Couldn't load your setup — try refreshing the page."; });
  }
  function startHomePoll() {
    if (homeTimer) return;
    homeTimer = setInterval(function () { if (!document.hidden && !homePane.hidden) loadHome(); }, 10000);
  }
  document.getElementById("homeRunForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var msg = document.getElementById("homeRunMsg");
    var sel = document.getElementById("homeRepo");
    var repo = "", branch = "main";
    if (!sel.hidden && sel.value) { repo = sel.value; var opt = sel.options[sel.selectedIndex]; branch = (opt && opt.getAttribute("data-branch")) || "main"; }
    else repo = document.getElementById("homeRepoText").value.trim();
    if (!repo) { msg.textContent = "Pick a project first."; return; }
    msg.textContent = "Starting your tests…";
    api("/v1/runs/dispatch", { method: "POST", body: JSON.stringify({ repo: repo, sha: branch }) })
      .then(function () { msg.textContent = "Started! Watch it below — this page updates by itself."; toast("Tests started for " + repo); return loadHome(); })
      .catch(function (e) { msg.textContent = "Couldn't start the tests: " + (e.message || "error") + ". Does the repo have a flare.yml or a .github/workflows file?"; });
  });
  document.getElementById("homePairBtn").addEventListener("click", function () {
    var err = document.getElementById("homePairErr");
    err.textContent = "";
    api("/v1/admin/pair-codes", { method: "POST", body: JSON.stringify({}) })
      .then(function (data) {
        document.getElementById("homePairCmd").textContent =
          "curl -fsSL " + window.location.origin + "/runner.sh | FLARE_PAIR_CODE=" + data.code + " sh";
        document.getElementById("homePairBox").hidden = false;
      })
      .catch(function () { err.textContent = "Couldn't make a setup code. Only the owner (admin) can do this."; });
  });
  document.getElementById("homePairCopy").addEventListener("click", function () { copyText(document.getElementById("homePairCmd").textContent, this); });
  document.getElementById("homeAllRuns").addEventListener("click", function () { selectTab("runs"); loadRuns(); });
  document.getElementById("homeCardRuns").addEventListener("click", function () { selectTab("runs"); loadRuns(); });
  document.getElementById("homeCardRaces").addEventListener("click", function () { selectTab("tournaments"); loadTournaments(); });
  document.getElementById("homeCardInvite").addEventListener("click", function () { palGoTab("settings"); setTimeout(function () { var i = document.getElementById("inviteEmail") || document.querySelector("#teamPane input[type=email]"); if (i) { i.scrollIntoView({ behavior: "smooth", block: "center" }); i.focus(); } }, 300); });
  tabHome.addEventListener("click", function () { palGoTab("home"); });
  var NAV_HINTS = {
    home: "Start here: setup steps and how your tests are doing",
    live: "Agent forge: a live map of which AI agents are working on which files",
    inbox: "Agent forge: changes that need a human to look at them",
    intents: "Agent forge: every planned change, who's doing it, and why",
    trains: "Agent forge: groups of changes being tested together before they land",
    conflicts: "Agent forge: places where two changes clash, and how they get fixed",
    agents: "Agent forge: the AI agents connected right now",
    repos: "Browse the code in your forge repositories",
    tournaments: "Give one task to several AI agents; real tests pick the winner",
    runs: "Every test run, newest first, with logs and why anything failed",
    merge: "Changes waiting to be merged after their tests pass",
    settings: "Accounts, access tokens, runners and other options"
  };
  (function () {
    var links = document.querySelectorAll(".side-link[data-tab]");
    for (var i = 0; i < links.length; i++) {
      var hint = NAV_HINTS[links[i].getAttribute("data-tab")];
      if (hint) links[i].title = hint;
    }
  })();
  function selectTab(name) {
    tabHome.className = "side-link" + (name === "home" ? " active" : "");
    homePane.hidden = name !== "home";
    tabRuns.className = "side-link" + (name === "runs" ? " active" : "");
    tabTournaments.className = "side-link" + (name === "tournaments" ? " active" : "");
    tabRepos.className = "side-link" + (name === "repos" ? " active" : "");
    tabMerge.className = "side-link" + (name === "merge" ? " active" : "");
    tabSettings.className = "side-link" + (name === "settings" ? " active" : "");
    runsPane.hidden = name !== "runs";
    tournamentsPane.hidden = name !== "tournaments";
    reposPane.hidden = name !== "repos";
    mergePane.hidden = name !== "merge";
    settingsPane.hidden = name !== "settings";
    teamPane.hidden = name !== "settings";
    currentTab = name;
    document.title = (TAB_TITLES[name] || "Dashboard") + " · Flare Actions";
    var panes = { home: homePane, runs: runsPane, tournaments: tournamentsPane, repos: reposPane, merge: mergePane, settings: settingsPane };
    if (panes[name]) {
      panes[name].classList.remove("pane-enter");
      void panes[name].offsetWidth;
      panes[name].classList.add("pane-enter");
    }
    fxOnSelect(name);
    // Narrow screens: the nav is a scroll strip, so keep the active tab in view.
    var activeLink = document.querySelector('.side-link[data-tab="' + name + '"]');
    if (activeLink && window.innerWidth <= 900 && activeLink.scrollIntoView) activeLink.scrollIntoView({ block: "nearest", inline: "center" });
    syncHash();
  }
  document.getElementById("runsFilter").addEventListener("input", function () { renderRuns(); });
  document.getElementById("runsFilterForm").addEventListener("submit", function (ev) { ev.preventDefault(); });
  (function () {
    var prompt = "Read " + location.origin + "/llms.txt and move this repo's CI to Flare. Start with the cheapest path that works, and ask me before changing anything on GitHub.";
    document.getElementById("homeAgentPrompt").textContent = prompt;
    document.getElementById("homeAgentCopy").addEventListener("click", function (e) { copyText(prompt, e.currentTarget); });
  })();
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
  tabTournaments.addEventListener("click", function () { selectTab("tournaments"); loadTournaments(); });
  tabRepos.addEventListener("click", function () { selectTab("repos"); loadRepos(); });
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
      toast("Tournament opened — agents can claim slots");
      showTournament(b.id);
    }, function (e) { err.textContent = e.message; toast(e.message, true); });
  });
  var TOURNAMENT_STATE_CLASS = { open: "queued", verifying: "running", decided: "success" };
  function tournamentStatePill(state) {
    var s = el("span", state);
    s.className = "pill " + (TOURNAMENT_STATE_CLASS[state] || "queued");
    return s;
  }
  var ATTEMPT_STATE_CLASS = { claimed: "queued", pushing: "running", verifying: "running", terminal: "blocked" };
  function attemptStatePill(state) {
    var s = el("span", state);
    s.className = "pill " + (ATTEMPT_STATE_CLASS[state] || "queued");
    return s;
  }
  function chip(text) { var c = el("span", text); c.className = "chip"; return c; }
  function zoneTitle(title, count) {
    var h = el("h3"); h.className = "t-zone-title";
    h.appendChild(el("span", title));
    if (count !== undefined && count !== null) { var c = el("span", count); c.className = "t-count"; h.appendChild(c); }
    return h;
  }
  function agentAvatar(name) {
    var d = el("span", (name || "?").slice(0, 1).toUpperCase());
    d.className = "t-avatar";
    return d;
  }
  var LEDGER_LABEL = { opened: "Tournament opened", claimed: "Slot claimed", pushed: "Pushed for verification", terminal: "Verification finished", collision: "File overlap", verdict: "Verdict", resolved: "Winner resolved", promoted: "Promoted to main", "promote-failed": "Promotion held" };
  function parseCollision(body) {
    var cut = (body || "").indexOf(": ");
    if (cut < 0) return null;
    var pair = body.slice(0, cut).split(" x ");
    if (pair.length !== 2 || !pair[0] || !pair[1]) return null;
    var paths = body.slice(cut + 2).split(", ").filter(function (p) { return !!p; });
    return { a: pair[0], b: pair[1], paths: paths };
  }
  // Autocomplete for free-text repo inputs; best-effort, never blocks.
  (function () {
    var jumps = document.querySelectorAll(".settings-jump [data-jump]");
    for (var i = 0; i < jumps.length; i++) {
      jumps[i].addEventListener("click", function (e) {
        var target = document.getElementById(e.currentTarget.getAttribute("data-jump"));
        if (target && !target.closest("[hidden]")) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  })();
  function fillDatalist(id, names) {
    var dl = document.getElementById(id);
    if (!dl) return;
    dl.textContent = "";
    names.forEach(function (n) { var o = document.createElement("option"); o.value = n; dl.appendChild(o); });
  }
  function loadTournaments() {
    stopTournamentTimer();
    api("/v1/repos?limit=100").then(function (b) {
      fillDatalist("flareRepoList", ((b && b.repos) || []).map(function (r) { return r.name; }));
    }, function () {});
    var err = document.getElementById("tournamentsErr");
    var list = document.getElementById("tournamentsList");
    err.textContent = "";
    list.textContent = "";
    document.getElementById("tournamentDetail").hidden = true;
    document.title = "Tournaments · Flare Actions";
    list.className = "t-enter";
    skeleton(list, 3, "skel-row");
    api("/v1/tournaments").then(function (b) {
      var tournaments = b.tournaments || [];
      lastTournaments = tournaments;
      list.textContent = "";
      syncHash();
      if (tournaments.length === 0) {
        var empty = el("div"); empty.className = "empty";
        empty.appendChild(el("h3", "No races yet — here's the whole model"));
        var steps = el("ol"); steps.className = "steps";
        steps.appendChild(setupStep("Open a task", "Write the intent above. That sentence is the why every agent shares.", false, null));
        steps.appendChild(setupStep("Agents race in isolated forks", "Each agent gets its own repo. Watch them all on one board.", false, null));
        steps.appendChild(setupStep("Overlaps surface on their own", "The radar shows who touched the same files — no merge surprises.", false, null));
        steps.appendChild(setupStep("A verdict picks the winner", "Ranked by real verification runs, recorded forever.", false, null));
        empty.appendChild(steps);
        list.appendChild(empty);
        return;
      }
      tournaments.forEach(function (t) {
        var row = el("div");
        row.className = "run-row";
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        var main = el("div"); main.className = "run-main";
        var title = el("div", t.intent); title.className = "run-repo"; main.appendChild(title);
        var meta = el("div"); meta.className = "run-meta";
        meta.appendChild(document.createTextNode((t.source_repo || "") + " · opened "));
        var metaTime = el("span", fmtAgo(t.created_at)); metaTime.setAttribute("data-ago", t.created_at); meta.appendChild(metaTime);
        main.appendChild(meta);
        row.appendChild(main);
        row.appendChild(tournamentStatePill(t.state));
        row.addEventListener("click", function () { showTournament(t.id); });
        row.addEventListener("keydown", function (kev) { if (kev.key === "Enter") showTournament(t.id); });
        list.appendChild(row);
      });
    }, function (e) { err.textContent = e.message; });
  }
  document.getElementById("backToTournaments").addEventListener("click", function () {
    stopTournamentTimer();
    currentTournamentId = "";
    document.getElementById("tournamentDetail").hidden = true;
    loadTournaments();
  });
  document.getElementById("refreshTournament").addEventListener("click", function () {
    if (currentTournamentId) showTournament(currentTournamentId);
  });
  function renderTournamentWhy(b) {
    var box = document.getElementById("tWhy");
    box.textContent = "";
    var hero = el("div"); hero.className = "t-hero";
    hero.appendChild(zoneTitle("Why this race exists", null));
    var intent = el("p", b.tournament.intent); intent.className = "t-intent"; hero.appendChild(intent);
    var meta = el("div"); meta.className = "t-meta";
    meta.appendChild(tournamentStatePill(b.tournament.state));
    var repoChip = chip("repo " + b.tournament.source_repo);
    repoChip.setAttribute("role", "button"); repoChip.setAttribute("tabindex", "0");
    repoChip.setAttribute("title", "Open in Repositories"); repoChip.style.cursor = "pointer";
    (function (rn) {
      var go = function () { selectTab("repos"); openRepo(rn); };
      repoChip.addEventListener("click", go);
      repoChip.addEventListener("keydown", function (kev) { if (kev.key === "Enter") go(); });
    })(b.tournament.source_repo);
    meta.appendChild(repoChip);
    meta.appendChild(chip("base " + (b.tournament.base_ref || "main") + "@" + String(b.tournament.base_sha || "").slice(0, 7)));
    var ago = el("span", "opened " + fmtAgo(b.tournament.created_at)); ago.className = "muted"; ago.setAttribute("data-ago", b.tournament.created_at); ago.setAttribute("data-prefix", "opened "); meta.appendChild(ago);
    if (b.tournament.resolved_sha) meta.appendChild(chip("resolved " + String(b.tournament.resolved_sha).slice(0, 12)));
    hero.appendChild(meta);
    box.appendChild(hero);
  }
  function renderTournamentLanes(b) {
    var box = document.getElementById("tLanes");
    box.textContent = "";
    var zone = el("div"); zone.className = "t-zone";
    var attempts = b.attempts || [];
    zone.appendChild(zoneTitle("Agent activity", attempts.length === 1 ? "1 agent racing" : attempts.length + " agents racing"));
    if (attempts.length === 0) {
      var none = el("p", "No claims yet — agents claim slots and their forks appear here live."); none.className = "t-clean"; zone.appendChild(none);
    }
    attempts.forEach(function (a) {
      var lane = el("div"); lane.className = "t-lane";
      var head = el("div"); head.className = "t-lane-head";
      head.appendChild(agentAvatar(a.agent));
      var name = el("span", a.agent); name.className = "t-agent"; head.appendChild(name);
      head.appendChild(attemptStatePill(a.state));
      if (a.verdict_rank) {
        var rank = el("span", a.verdict_rank === 1 ? "Winner" : "#" + a.verdict_rank);
        rank.className = "t-rank" + (a.verdict_rank === 1 ? " first" : "");
        head.appendChild(rank);
      }
      lane.appendChild(head);
      var sub = el("p"); sub.className = "t-lane-sub mono";
      sub.appendChild(document.createTextNode("fork " + a.fork_repo + " · updated "));
      var subTime = el("span", fmtAgo(a.updated_at)); subTime.setAttribute("data-ago", a.updated_at); sub.appendChild(subTime);
      lane.appendChild(sub);
      var foot = el("div"); foot.className = "t-lane-foot";
      if (a.last_seen_sha) foot.appendChild(chip("@" + String(a.last_seen_sha).slice(0, 7)));
      if (a.run_status) foot.appendChild(pill(a.run_status));
      else if (a.run_id) foot.appendChild(chip("run " + String(a.run_id).slice(0, 8)));
      if (a.run_id) {
        var open = el("button", "Open verification run");
        open.className = "ghost";
        open.type = "button";
        (function (runId) {
          open.addEventListener("click", function () { selectTab("runs"); loadRun(runId, true); });
        })(a.run_id);
        foot.appendChild(open);
      }
      lane.appendChild(foot);
      zone.appendChild(lane);
    });
    box.appendChild(zone);
  }
  function renderTournamentRadar(b) {
    var box = document.getElementById("tRadar");
    box.textContent = "";
    var zone = el("div"); zone.className = "t-zone";
    var collisions = [];
    (b.ledger || []).forEach(function (l) {
      if (l.kind !== "collision") return;
      var c = parseCollision(l.body || "");
      collisions.push(c || { a: "", b: "", paths: [], raw: l.body });
    });
    zone.appendChild(zoneTitle("Collision radar", collisions.length === 0 ? "clean" : collisions.length + " overlapping"));
    if (collisions.length === 0) {
      var clean = el("p", "Clean race — no two agents touched the same files."); clean.className = "t-clean"; zone.appendChild(clean);
    }
    collisions.forEach(function (c) {
      var card = el("div"); card.className = "t-radar-card";
      if (!c.paths || c.paths.length === 0) {
        card.appendChild(el("p", c.raw || ""));
      } else {
        var pair = el("p"); pair.className = "t-radar-pair";
        pair.appendChild(el("span", c.a + " × " + c.b));
        var n = el("span", c.paths.length === 1 ? "1 shared file" : c.paths.length + " shared files"); n.className = "t-count"; pair.appendChild(n);
        card.appendChild(pair);
        var paths = el("div"); paths.className = "t-paths";
        c.paths.forEach(function (p) { paths.appendChild(chip(p)); });
        card.appendChild(paths);
      }
      zone.appendChild(card);
    });
    box.appendChild(zone);
  }
  function verdictOrder(b) {
    var attempts = b.attempts || [];
    var byId = {};
    attempts.forEach(function (a) { byId[a.id] = a; });
    try {
      var ordered = [];
      JSON.parse((b.verdict && b.verdict.ranking) || "[]").forEach(function (id) { if (byId[id]) ordered.push(byId[id]); });
      attempts.forEach(function (a) { if (ordered.indexOf(a) < 0) ordered.push(a); });
      return ordered;
    } catch (e) {
      return attempts.slice().sort(function (x, y) { return (x.verdict_rank || 99) - (y.verdict_rank || 99); });
    }
  }
  function renderTournamentReview(b) {
    var box = document.getElementById("tReview");
    box.textContent = "";
    var zone = el("div"); zone.className = "t-zone";
    var attempts = b.attempts || [];
    if (!b.verdict) {
      var terminal = attempts.filter(function (a) { return a.state === "terminal"; }).length;
      zone.appendChild(zoneTitle("Review", "racing"));
      var wait = el("p", attempts.length === 0
        ? "The verdict lands once agents push and every attempt verifies."
        : "Verdict lands when every attempt is terminal — " + terminal + " of " + attempts.length + " in.");
      wait.className = "t-clean";
      zone.appendChild(wait);
      box.appendChild(zone);
      return;
    }
    zone.appendChild(zoneTitle("Review", "decided"));
    var panel = el("div"); panel.className = "t-verdict";
    var order = verdictOrder(b);
    var winner = order.length ? order[0] : null;
    var banner = el("div"); banner.className = "t-winner";
    if (winner) banner.appendChild(agentAvatar(winner.agent));
    banner.appendChild(el("span", winner ? winner.agent : "—")).className = "t-winner-name";
    var tag = el("span", "Winner"); tag.className = "t-rank first"; banner.appendChild(tag);
    panel.appendChild(banner);
    var rat = el("p", b.verdict.rationale || ""); rat.className = "t-rationale"; panel.appendChild(rat);
    var model = el("p", "Deterministic ranking · rationale by " + (b.verdict.model || "unknown model")); model.className = "t-model"; panel.appendChild(model);
    if (order.length > 1) {
      var list = el("ol"); list.className = "t-ranklist";
      order.forEach(function (a, i) {
        var li = el("li");
        var pos = el("span", String(i + 1)); pos.className = "t-pos" + (i === 0 ? " first" : ""); li.appendChild(pos);
        li.appendChild(el("span", a.agent));
        li.appendChild(attemptStatePill(a.state));
        if (a.run_status) li.appendChild(pill(a.run_status));
        list.appendChild(li);
      });
      panel.appendChild(list);
    }
    zone.appendChild(panel);
    box.appendChild(zone);
  }
  function renderTournamentActivity(b) {
    var box = document.getElementById("tActivity");
    box.textContent = "";
    var zone = el("div"); zone.className = "t-zone";
    var ledger = (b.ledger || []).slice().reverse();
    zone.appendChild(zoneTitle("History", ledger.length + " events"));
    var list = el("ol"); list.className = "t-timeline";
    ledger.forEach(function (l) {
      var li = el("li");
      var dot = el("span"); dot.className = "t-dot " + l.kind; dot.setAttribute("aria-hidden", "true"); li.appendChild(dot);
      var kind = el("span", LEDGER_LABEL[l.kind] || l.kind); kind.className = "t-event-kind"; li.appendChild(kind);
      var time = el("span", fmtAgo(l.created_at)); time.className = "t-event-time"; time.title = fmtTime(l.created_at); time.setAttribute("data-ago", l.created_at); li.appendChild(time);
      if (l.body) { var body = el("div", l.body); body.className = "t-event-body mono"; li.appendChild(body); }
      list.appendChild(li);
    });
    zone.appendChild(list);
    box.appendChild(zone);
  }
  function showTournament(id) {
    stopTournamentTimer();
    var fresh = currentTournamentId !== id || document.getElementById("tournamentDetail").hidden;
    currentTournamentId = id;
    var err = document.getElementById("tournamentsErr");
    err.textContent = "";
    if (fresh) {
      skeleton(document.getElementById("tWhy"), 2, "skel-line");
      skeleton(document.getElementById("tReview"), 2, "skel-line");
      skeleton(document.getElementById("tLanes"), 3, "skel-row");
      skeleton(document.getElementById("tRadar"), 1, "skel-row");
      skeleton(document.getElementById("tActivity"), 4, "skel-line");
    }
    api("/v1/tournaments/" + encodeURIComponent(id)).then(function (b) {
      document.getElementById("tournamentsList").textContent = "";
      document.getElementById("tournamentDetail").hidden = false;
      document.title = String(b.tournament.intent).slice(0, 60) + " · Flare Actions";
      syncHash();
      renderTournamentWhy(b);
      renderTournamentReview(b);
      renderTournamentLanes(b);
      renderTournamentRadar(b);
      renderTournamentActivity(b);
      if (b.tournament.state !== "decided") {
        tournamentTimer = setInterval(function () {
          if (document.getElementById("tournamentDetail").hidden || tournamentsPane.hidden) { stopTournamentTimer(); return; }
          showTournament(id);
        }, 5000);
      }
    }, function (e) { err.textContent = e.message; });
  }
  var currentRepo = "";
  var currentRepoRef = "main";
  var currentRepoPath = "";
  function loadRepos() {
    var err = document.getElementById("reposErr");
    var list = document.getElementById("reposList");
    err.textContent = "";
    list.textContent = "";
    document.getElementById("repoDetail").hidden = true;
    currentRepo = "";
    document.title = "Repositories · Flare Actions";
    list.className = "t-enter";
    skeleton(list, 4, "skel-row");
    api("/v1/repos?limit=50").then(function (b) {
      list.textContent = "";
      syncHash();
      var repos = (b && b.repos) || [];
      if (repos.length === 0) {
        var empty = el("div"); empty.className = "empty";
        empty.appendChild(el("h3", "No repositories yet"));
        empty.appendChild(el("p", "Push code to the Artifacts namespace or import a repo — it shows up here, ready to browse and race on."));
        list.appendChild(empty);
        return;
      }
      repos.forEach(function (r) {
        var row = el("div"); row.className = "run-row";
        row.setAttribute("role", "button"); row.setAttribute("tabindex", "0");
        var main = el("div"); main.className = "run-main";
        var title = el("div", r.name); title.className = "run-repo mono"; main.appendChild(title);
        var meta = el("div"); meta.className = "run-meta";
        meta.appendChild(document.createTextNode(r.defaultBranch || "main"));
        if (r.lastPushAt) {
          meta.appendChild(document.createTextNode(" · pushed "));
          var t = el("span", fmtAgo(r.lastPushAt)); t.setAttribute("data-ago", r.lastPushAt); meta.appendChild(t);
        } else meta.appendChild(document.createTextNode(" · never pushed"));
        main.appendChild(meta);
        row.appendChild(main);
        if (r.source) row.appendChild(chip("fork"));
        row.addEventListener("click", function () { openRepo(r.name); });
        row.addEventListener("keydown", function (kev) { if (kev.key === "Enter") openRepo(r.name); });
        list.appendChild(row);
      });
    }, function (e) { list.textContent = ""; err.textContent = e.message; });
  }
  document.getElementById("backToRepos").addEventListener("click", function () {
    currentRepo = "";
    document.getElementById("repoDetail").hidden = true;
    loadRepos();
  });
  function openRepo(name) {
    var err = document.getElementById("reposErr");
    err.textContent = "";
    currentRepo = name;
    currentRepoPath = "";
    document.getElementById("reposList").textContent = "";
    document.getElementById("repoDetail").hidden = false;
    document.title = name + " · Flare Actions";
    syncHash();
    skeleton(document.getElementById("repoHead"), 1, "skel-line");
    skeleton(document.getElementById("repoFiles"), 3, "skel-row");
    skeleton(document.getElementById("repoRuns"), 2, "skel-row");
    skeleton(document.getElementById("repoCommits"), 3, "skel-line");
    api("/v1/repos/" + encodeURIComponent(name)).then(function (info) {
      currentRepoRef = info.defaultBranch || "main";
      renderRepoHead(info);
      if (!info.head) {
        var files = document.getElementById("repoFiles");
        files.textContent = "";
        var empty = el("p", "Empty repository — push code to " + currentRepoRef + ", or race agents to fill it.");
        empty.className = "t-clean"; files.appendChild(empty);
        document.getElementById("repoCommits").textContent = "";
        return;
      }
      loadRepoTree();
      loadRepoRuns();
      loadRepoCommits();
    }, function (e) { err.textContent = e.message; });
  }
  function renderRepoHead(info) {
    var box = document.getElementById("repoHead");
    box.textContent = "";
    var hero = el("div"); hero.className = "t-hero";
    var title = el("p", info.name); title.className = "t-intent mono"; hero.appendChild(title);
    var meta = el("div"); meta.className = "t-meta"; meta.id = "repoHeadMeta";
    meta.appendChild(chip("branch " + (info.defaultBranch || "main")));
    if (info.head) meta.appendChild(chip("@" + String(info.head.hash).slice(0, 7)));
    if (info.source) meta.appendChild(chip("forked from " + info.source));
    if (info.lastPushAt) {
      var ago = el("span", "pushed " + fmtAgo(info.lastPushAt)); ago.className = "muted";
      ago.setAttribute("data-ago", info.lastPushAt); ago.setAttribute("data-prefix", "pushed ");
      meta.appendChild(ago);
    }
    hero.appendChild(meta);
    var actions = el("p");
    var race = el("button", "Race agents on this repo"); race.type = "button";
    race.addEventListener("click", function () {
      document.getElementById("tournamentSource").value = info.name;
      selectTab("tournaments"); loadTournaments();
      document.getElementById("tournamentIntent").focus();
      toast("Describe the task, then open the race");
    });
    actions.appendChild(race);
    hero.appendChild(actions);
    box.appendChild(hero);
  }
  function repoCrumbs() {
    var nav = el("p"); nav.className = "t-crumb";
    var root = el("button", currentRepo); root.type = "button"; root.className = "ghost";
    root.addEventListener("click", function () { currentRepoPath = ""; loadRepoTree(); });
    nav.appendChild(root);
    var acc = "";
    currentRepoPath.split("/").forEach(function (seg) {
      if (!seg) return;
      nav.appendChild(document.createTextNode(" / "));
      acc = acc ? acc + "/" + seg : seg;
      (function (p, label) {
        var b = el("button", label); b.type = "button"; b.className = "ghost";
        b.addEventListener("click", function () { currentRepoPath = p; loadRepoTree(); });
        nav.appendChild(b);
      })(acc, seg);
    });
    return nav;
  }
  function loadRepoTree() {
    var box = document.getElementById("repoFiles");
    var err = document.getElementById("reposErr");
    skeleton(box, 3, "skel-row");
    api("/v1/repos/" + encodeURIComponent(currentRepo) + "/tree?ref=" + encodeURIComponent(currentRepoRef) + "&path=" + encodeURIComponent(currentRepoPath)).then(function (t) {
      box.textContent = "";
      if (!t.path && !document.getElementById("repoCiChip")) {
        var hasPipeline = t.entries.some(function (e) { return e.name === "flare.yml"; });
        var hm = document.getElementById("repoHeadMeta");
        if (hm) {
          var cic = chip(hasPipeline ? "CI ready" : "no pipeline");
          cic.id = "repoCiChip";
          hm.appendChild(cic);
        }
      }
      var zone = el("div"); zone.className = "t-zone";
      zone.appendChild(zoneTitle("Files", t.entries.length + " items"));
      zone.appendChild(repoCrumbs());
      if (t.entries.length === 0) {
        var none = el("p", "Empty directory."); none.className = "t-clean"; zone.appendChild(none);
      }
      t.entries.forEach(function (e) {
        var row = el("div"); row.className = "run-row";
        row.setAttribute("role", "button"); row.setAttribute("tabindex", "0");
        var main = el("div"); main.className = "run-main";
        var nm = el("div", e.name + (e.type === "tree" ? "/" : "")); nm.className = "run-repo mono"; main.appendChild(nm);
        row.appendChild(main);
        var open = function () {
          if (e.type === "tree") { currentRepoPath = currentRepoPath ? currentRepoPath + "/" + e.name : e.name; loadRepoTree(); }
          else openRepoFile(currentRepoPath ? currentRepoPath + "/" + e.name : e.name);
        };
        row.addEventListener("click", open);
        row.addEventListener("keydown", function (kev) { if (kev.key === "Enter") open(); });
        zone.appendChild(row);
      });
      if (t.truncated) {
        var more = el("p", "Showing the first " + t.entries.length + " entries."); more.className = "t-clean"; zone.appendChild(more);
      }
      box.appendChild(zone);
    }, function (e) { box.textContent = ""; err.textContent = e.message; });
  }
  function openRepoFile(path) {
    var box = document.getElementById("repoFiles");
    var err = document.getElementById("reposErr");
    skeleton(box, 4, "skel-line");
    api("/v1/repos/" + encodeURIComponent(currentRepo) + "/blob?ref=" + encodeURIComponent(currentRepoRef) + "&path=" + encodeURIComponent(path)).then(function (b) {
      box.textContent = "";
      var zone = el("div"); zone.className = "t-zone";
      var head = el("p");
      var back = el("button", "Back to files"); back.type = "button"; back.className = "ghost";
      back.addEventListener("click", loadRepoTree);
      head.appendChild(back);
      head.appendChild(document.createTextNode(" "));
      head.appendChild(chip(path));
      zone.appendChild(head);
      if (b.binary) {
        var bin = el("p", "Binary file — " + fmtBytes(b.size) + "."); bin.className = "t-clean"; zone.appendChild(bin);
      } else if (b.text === null || b.text === undefined) {
        var big = el("p", "File too large to preview — " + fmtBytes(b.size) + "."); big.className = "t-clean"; zone.appendChild(big);
      } else {
        zone.appendChild(fxCodeView(b.text, currentRepo, path, 0, null));
        if (b.truncated) {
          var note = el("p", "Truncated preview of " + fmtBytes(b.size) + "."); note.className = "t-clean"; zone.appendChild(note);
        }
      }
      box.appendChild(zone);
    }, function (e) { box.textContent = ""; err.textContent = e.message; });
  }
  function loadRepoRuns() {
    var box = document.getElementById("repoRuns");
    api("/v1/runs?repo=" + encodeURIComponent(currentRepo) + "&limit=5").then(function (b) {
      box.textContent = "";
      var zone = el("div"); zone.className = "t-zone";
      var runs = (b && b.runs) || [];
      zone.appendChild(zoneTitle("Verifications", runs.length === 0 ? "none yet" : "latest " + runs.length));
      if (runs.length === 0) {
        var none = el("p", "No verification runs yet — race agents on this repo to produce the first one.");
        none.className = "t-clean"; zone.appendChild(none);
      }
      runs.forEach(function (r) {
        var row = el("div"); row.className = "run-row";
        row.setAttribute("role", "button"); row.setAttribute("tabindex", "0");
        var main = el("div"); main.className = "run-main";
        var title = el("div", "@" + String(r.sha || "").slice(0, 7)); title.className = "run-repo mono"; main.appendChild(title);
        var meta = el("div"); meta.className = "run-meta";
        meta.appendChild(document.createTextNode((r.event || "run") + " · "));
        var t = el("span", fmtAgo(r.created_at)); t.setAttribute("data-ago", r.created_at); meta.appendChild(t);
        main.appendChild(meta);
        row.appendChild(main);
        row.appendChild(pill(r.status));
        row.addEventListener("click", function () { selectTab("runs"); loadRun(r.id, true); });
        row.addEventListener("keydown", function (kev) { if (kev.key === "Enter") { selectTab("runs"); loadRun(r.id, true); } });
        zone.appendChild(row);
      });
      box.appendChild(zone);
    }, function () { box.textContent = ""; });
  }
  function loadRepoCommits() {
    var box = document.getElementById("repoCommits");
    api("/v1/repos/" + encodeURIComponent(currentRepo) + "/commits?ref=" + encodeURIComponent(currentRepoRef) + "&limit=20").then(function (b) {
      box.textContent = "";
      var zone = el("div"); zone.className = "t-zone";
      var commits = (b && b.commits) || [];
      zone.appendChild(zoneTitle("History", commits.length + " commits"));
      commits.forEach(function (c) {
        var lane = el("div"); lane.className = "t-lane";
        var head = el("div"); head.className = "t-lane-head";
        head.appendChild(agentAvatar(c.authorName || "?"));
        var msg = el("span", String(c.message || "").split(String.fromCharCode(10))[0] || "(no message)"); msg.className = "t-agent"; head.appendChild(msg);
        head.appendChild(chip(String(c.hash).slice(0, 7)));
        lane.appendChild(head);
        var sub = el("p"); sub.className = "t-lane-sub";
        sub.appendChild(document.createTextNode((c.authorName || "unknown") + " · "));
        var iso = new Date((c.committedAt || 0) * 1000).toISOString();
        var t = el("span", fmtAgo(iso)); t.setAttribute("data-ago", iso); sub.appendChild(t);
        lane.appendChild(sub);
        zone.appendChild(lane);
      });
      box.appendChild(zone);
    }, function () { box.textContent = ""; });
  }
  document.getElementById("cacheForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    loadCacheEntries();
  });
  document.getElementById("cachePurgeBtn").addEventListener("click", function () {
    purgeCachePrefix();
  });
  tabMerge.addEventListener("click", function () { selectTab("merge"); openMergeQueue(); });
  // Merge queue is per repo: reload the last loaded repo, or put the
  // cursor in the repo field so the pane never opens blank and inert.
  function openMergeQueue() {
    var input = document.getElementById("mergeRepo");
    if (!input.value.trim()) {
      try { input.value = localStorage.getItem("flare.mergeRepo") || ""; } catch (e) { input.value = ""; }
    }
    if (input.value.trim()) loadMergeQueue();
    else input.focus();
  }
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
      toast("PR #" + pr + " enqueued for verified landing");
      loadMergeQueue();
    }, function (e) {
      err.textContent = (e && e.message) || "Enqueue failed";
      toast(err.textContent, true);
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
    try { localStorage.setItem("flare.mergeRepo", repo); } catch (e) { /* storage unavailable */ }
    api("/v1/merge-queue?repo=" + encodeURIComponent(repo)).then(function (res) {
      var entries = (res && res.entries) || [];
      if (entries.length === 0) {
        var empty = el("tr"); var td = el("td", "Queue is empty."); td.colSpan = 6; empty.appendChild(td); body.appendChild(empty);
      }
      entries.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "#" + e.pr));
        var mqStatus = el("td");
        var mqPill = el("span", e.status);
        mqPill.className = "pill " + (e.status === "landed" ? "success" : e.status === "failed" ? "failure" : e.status === "verifying" ? "running" : e.status === "queued" ? "queued" : "cancelled");
        mqStatus.appendChild(mqPill);
        tr.appendChild(mqStatus);
        tr.appendChild(el("td", e.agent || "-"));
        var head = el("td", (e.headSha || "").slice(0, 7)); head.className = "mono"; tr.appendChild(head);
        tr.appendChild(el("td", e.note || "-"));
        var act = el("td");
        if (e.status === "queued" || e.status === "verifying") {
          var btn = el("button", "Cancel");
          btn.className = "ghost";
          btn.addEventListener("click", function () {
            api("/v1/merge-queue/" + encodeURIComponent(e.id), { method: "DELETE" }).then(function () { toast("Queue entry cancelled"); loadMergeQueue(); }, function (fail) {
              err.textContent = (fail && fail.message) || "Cancel failed";
              toast(err.textContent, true);
            });
          });
          act.appendChild(btn);
        }
        tr.appendChild(act);
        body.appendChild(tr);
      });
      var collisions = (res && res.collisions) || [];
      if (collisions.length === 0) {
        var mqClean = el("p", "No file collisions between live entries — land order is free.");
        mqClean.className = "t-clean";
        radar.appendChild(mqClean);
        return;
      }
      collisions.forEach(function (c) {
        var card = el("div"); card.className = "t-radar-card";
        var pair = el("p"); pair.className = "t-radar-pair";
        pair.appendChild(el("span", "#" + c.prs[0] + " × #" + c.prs[1]));
        var shared = c.paths || [];
        var mqN = el("span", shared.length === 1 ? "1 shared file" : shared.length + " shared files"); mqN.className = "t-count"; pair.appendChild(mqN);
        card.appendChild(pair);
        var wrap = el("div"); wrap.className = "t-paths";
        shared.forEach(function (p) { wrap.appendChild(chip(p)); });
        card.appendChild(wrap);
        radar.appendChild(card);
      });
    }, function (e) {
      err.textContent = (e && e.message) || "Merge queue failed";
    });
  }
  tabSettings.addEventListener("click", function () { selectTab("settings"); loadSettings(); loadTokens(); loadUsers(); });

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
        // One setup story: Home owns the guided checklist, so this
        // empty state points there instead of repeating it.
        empty.appendChild(el("h3", "No runs yet"));
        empty.appendChild(el("p", "Push to GitHub and your tests show up here. Flare runs your flare.yml, or your existing .github/workflows unchanged."));
        var acts = el("p");
        var toHome = el("button", "Finish setup on Home");
        toHome.type = "button";
        toHome.addEventListener("click", function () { location.hash = "#/home"; });
        acts.appendChild(toHome);
        if (isAdmin) {
          var dispatchNow = el("button", "Dispatch a run");
          dispatchNow.type = "button"; dispatchNow.className = "ghost";
          dispatchNow.addEventListener("click", function () {
            document.getElementById("dispatchBox").open = true;
            document.getElementById("dispatchRepo").focus();
          });
          acts.appendChild(document.createTextNode(" "));
          acts.appendChild(dispatchNow);
        }
        empty.appendChild(acts);
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
  function cachePrefix() { return document.getElementById("cachePrefix").value.trim(); }
  function loadCacheEntries() {
    var err = document.getElementById("cacheErr");
    var note = document.getElementById("cacheNote");
    var body = document.getElementById("cacheBody");
    err.textContent = "";
    note.textContent = "";
    body.textContent = "";
    api("/v1/admin/cache?prefix=" + encodeURIComponent(cachePrefix()) + "&limit=100").then(function (data) {
      var entries = data.entries || [];
      entries.sort(function (a, b) { return String(b.uploaded || "") < String(a.uploaded || "") ? -1 : 1; });
      if (!entries.length) { note.textContent = "No cache entries under this prefix."; return; }
      note.textContent = entries.length + " entr" + (entries.length === 1 ? "y" : "ies") + " (newest first, max 100).";
      entries.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", e.key));
        tr.appendChild(el("td", fmtBytes(e.size)));
        tr.appendChild(el("td", e.uploaded ? String(e.uploaded).slice(0, 19).replace("T", " ") : ""));
        body.appendChild(tr);
      });
    }).catch(function (e) { err.textContent = e && e.message ? e.message : "Could not load cache entries."; });
  }
  function purgeCachePrefix() {
    var err = document.getElementById("cacheErr");
    var note = document.getElementById("cacheNote");
    err.textContent = "";
    api("/v1/admin/cache?prefix=" + encodeURIComponent(cachePrefix()), { method: "DELETE" }).then(function (out) {
      note.textContent = "Purged " + out.deleted + " entr" + (out.deleted === 1 ? "y" : "ies") +
        (out.truncated ? " (more remain — purge again)" : "") + ".";
      loadCacheEntries();
    }).catch(function (e) { err.textContent = e && e.message ? e.message : "Could not purge cache."; });
  }
  function loadRuns() {
    var list = document.getElementById("runsList");
    list.textContent = "";
    var loading = el("p", "Loading runs…"); loading.className = "muted"; list.appendChild(loading);
    loadUsageStrip();
    loadCacheStats();
    document.getElementById("cacheBox").hidden = !isAdmin;
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

  var runDetailOpenId = null;
  var TERMINAL = { success: 1, failure: 1, error: 1, cancelled: 1, skipped: 1 };
  function detailIsTerminal() {
    var box = document.getElementById("runDetail");
    if (box.hidden) return true;
    var pills = box.getElementsByClassName("pill");
    if (!pills.length) return true;
    return !!TERMINAL[pills[0].textContent || ""];
  }
  // One plain-language box above the technical details: what happened,
  // which command failed, and the AI's suggested fix when there is one.
  function failedStepOf(job) {
    try {
      var parsed = job.result ? JSON.parse(job.result) : null;
      var steps = (parsed && parsed.steps) || [];
      for (var i = 0; i < steps.length; i++) if (steps[i].exitCode !== 0) return steps[i];
    } catch (e) {}
    return null;
  }
  function runSummaryBox(run, jobs) {
    var box = el("div"); box.className = "home-verdict run-summary";
    var icon = "•", headText = "", lines = [];
    if (run.status === "success") { box.className += " ok"; icon = "✅"; headText = "Everything passed."; }
    else if (run.status === "failure" || run.status === "error") {
      box.className += " bad"; icon = "❌"; headText = "This run failed. Here's what went wrong:";
      var bad = null;
      for (var i = 0; i < jobs.length; i++) if (jobs[i].status === "failure" || jobs[i].status === "error") { bad = jobs[i]; break; }
      if (bad) {
        var step = failedStepOf(bad);
        if (step) lines.push(["Failed step", (step.command || "").slice(0, 200) + (step.exitCode === 124 ? " (took too long)" : "")]);
        else lines.push(["Failed job", bad.name || bad.id]);
        if (bad.triage) lines.push(["💡 Try this", String(bad.triage).slice(0, 600)]);
        else lines.push(["Next", "Open the job's log below and look for the first red error line."]);
      }
    } else if (run.status === "running") { box.className += " busy"; icon = "⏳"; headText = "Your tests are running right now. This page updates by itself."; }
    else if (run.status === "queued" || run.status === "blocked") { box.className += " busy"; icon = "🕐"; headText = "Waiting for a computer to pick this up. If it waits a long time, go Home and press “Use my computer”."; }
    else { headText = "Status: " + (PILL_WORDS[run.status] || run.status); }
    var big = el("span", icon); big.className = "big"; big.setAttribute("aria-hidden", "true");
    var what = el("div"); what.className = "what";
    what.appendChild(el("strong", headText));
    lines.forEach(function (l) {
      var p = el("p"); p.className = "run-summary-line";
      var k = el("b", l[0] + ": "); p.appendChild(k);
      var v = el(l[0] === "Failed step" ? "code" : "span", l[1]); p.appendChild(v);
      what.appendChild(p);
    });
    box.appendChild(big); box.appendChild(what);
    return box;
  }
  function loadRun(id, scroll) {
    api("/v1/runs/" + encodeURIComponent(id)).then(function (data) {
      var box = document.getElementById("runDetail");
      box.textContent = "";
      box.hidden = false;
      runDetailOpenId = data.run.id;
      document.title = (data.run.repo || "run") + " @ " + String(data.run.sha || "").slice(0, 7) + " · Flare Actions";
      syncHash();
      var head = el("h2");
      head.appendChild(el("span", data.run.repo + " @ "));
      var shaCode = el("code", String(data.run.sha).slice(0, 7)); shaCode.className = "mono"; head.appendChild(shaCode);
      head.appendChild(el("span", " "));
      head.appendChild(pill(data.run.status));
      box.appendChild(head);
      box.appendChild(runSummaryBox(data.run, data.jobs || []));
      if (data.race && data.race.tournament_id) {
        var raceLine = el("p"); raceLine.className = "t-crumb";
        raceLine.appendChild(el("span", "Verifying " + (data.race.agent || "an agent") + " in race "));
        var raceBtn = el("button", "Open race"); raceBtn.type = "button"; raceBtn.className = "ghost";
        (function (tid) {
          raceBtn.addEventListener("click", function () { selectTab("tournaments"); showTournament(tid); });
        })(data.race.tournament_id);
        raceLine.appendChild(raceBtn);
        if (data.race.verdict_rank === 1) {
          var wtag = el("span", "Winner"); wtag.className = "t-rank first"; raceLine.appendChild(wtag);
        } else if (data.race.verdict_rank) {
          raceLine.appendChild(el("span", "ranked #" + data.race.verdict_rank));
        }
        box.appendChild(raceLine);
      }
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
      back.addEventListener("click", function () { box.hidden = true; runDetailOpenId = null; selectedRunId = null; document.title = "Runs · Flare Actions"; loadRuns(); syncHash(); });
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
  // The secrets card was removed from the markup (b067b21); guard so the
  // rest of the script (palette, keys, boot) still runs.
  if (document.getElementById("secretLoadForm")) document.getElementById("secretLoadForm").addEventListener("submit", function (ev) { ev.preventDefault(); loadSecrets(); });
  if (document.getElementById("secretForm")) document.getElementById("secretForm").addEventListener("submit", function (ev) {
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
        var safeName = /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : "";
        var cmd = "curl -fsSL " + window.location.origin + "/runner.sh | FLARE_PAIR_CODE=" + data.code + (safeName ? " FLARE_PAIR_NAME=" + safeName : "") + " sh";
        document.getElementById("pairCmd").textContent = cmd;
        document.getElementById("pairBox").hidden = false;
        document.getElementById("pairName").value = "";
      })
      .catch(function () { err.textContent = "Could not create a pairing code."; });
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
      document.getElementById("notifyWebhookInput").value = "";
      document.getElementById("notifyWebhookInfo").textContent =
        "Chat webhook: " + (s.notifyWebhookSet ? "configured (write-only)." : "not set.") + " Works with Slack, Discord, and Mattermost-compatible URLs.";
      document.getElementById("notifyWebhookOk").textContent = "";
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

  var currentTab = "tournaments";
  var TAB_TITLES = { home: "Home", runs: "Runs", tournaments: "Races", repos: "Repositories", merge: "Merge queue", settings: "Settings" };
  function toast(msg, isErr) {
    var box = document.getElementById("toasts");
    var t = el("div", msg);
    t.className = "toast" + (isErr ? " err" : "");
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4200);
  }
  function skeleton(parent, rows, cls) {
    parent.textContent = "";
    for (var i = 0; i < rows; i++) { var s = el("div"); s.className = "skel " + cls; parent.appendChild(s); }
  }
  function syncHash() {
    if (fxIsScreen(currentTab)) { fxWriteHash(); return; }
    try {
      var h = "#/" + currentTab;
      if (currentTab === "tournaments" && currentTournamentId && !document.getElementById("tournamentDetail").hidden) h += "/" + currentTournamentId;
      if (currentTab === "repos" && currentRepo && !document.getElementById("repoDetail").hidden) h += "/" + currentRepo;
      if (currentTab === "runs" && runDetailOpenId) h += "/" + runDetailOpenId;
      history.replaceState(null, "", h);
    } catch (e) {}
  }
  function palGoTab(name) {
    if (fxIsScreen(name)) {
      if ((location.hash || "").split("?")[0] === "#/" + name) fxStartForge().then(function () { fxGo(name, "", FX.route.screen === name ? FX.route.q : null); });
      else fxNav("#/" + name);
      return;
    }
    selectTab(name);
    if (name === "home") { loadHome(); startHomePoll(); }
    else if (name === "runs") loadRuns();
    else if (name === "tournaments") loadTournaments();
    else if (name === "repos") loadRepos();
    else if (name === "merge") openMergeQueue();
    else if (name === "settings") { loadSettings(); loadTokens(); loadUsers(); }
  }
  function refreshCurrent() {
    if (fxIsScreen(currentTab)) { fxRenderScreen(); return; }
    if (currentTab === "tournaments") {
      if (currentTournamentId && !document.getElementById("tournamentDetail").hidden) showTournament(currentTournamentId);
      else loadTournaments();
    } else if (currentTab === "runs" && runDetailOpenId) loadRun(runDetailOpenId, false);
    else if (currentTab === "repos" && currentRepo && !document.getElementById("repoDetail").hidden) openRepo(currentRepo);
    else palGoTab(currentTab);
  }
  function applyHashRoute() {
    var fxr = fxRouteFromHash();
    if (fxr) { fxStartForge().then(function () { fxGo(fxr.screen, fxr.id, fxr.q); }); return true; }
    if (FX.anon) return false;
    var hash = location.hash || "";
    if (hash.slice(0, 2) !== "#/") return false;
    var parts = hash.slice(2).split("/");
    var tab = parts[0] || "";
    if (!TAB_TITLES[tab]) return false;
    if (!isAdmin && tab === "settings") return false;
    var id = parts[1] ? decodeURIComponent(parts[1]) : "";
    if (tab === "tournaments" && id) { selectTab("tournaments"); showTournament(id); }
    else if (tab === "repos" && id) { selectTab("repos"); openRepo(id); }
    else if (tab === "runs" && id) { selectTab("runs"); loadRuns(); loadRun(id, false); }
    else palGoTab(tab);
    return true;
  }
  window.addEventListener("hashchange", function () { if (!appPane.hidden) applyHashRoute(); });
  var lastTournaments = [];
  var palOpen = false, palItems = [], palActive = 0;
  function palCommands() {
    var cmds = [];
    ["home", "tournaments", "repos", "merge", "runs", "settings"].forEach(function (name) {
      if (FX.anon) return;
      if (!isAdmin && name === "settings") return;
      cmds.push({ group: "Go to", label: "Go to " + TAB_TITLES[name], run: (function (n) { return function () { palGoTab(n); }; })(name) });
    });
    lastTournaments.forEach(function (t) {
      cmds.push({ group: "Tournaments", label: t.intent, kind: t.state, run: (function (id) { return function () { selectTab("tournaments"); showTournament(id); }; })(t.id) });
    });
    lastRuns.slice(0, 8).forEach(function (r) {
      cmds.push({ group: "Runs", label: (r.repo || "") + " @ " + String(r.sha || "").slice(0, 7), kind: r.status, run: (function (id) { return function () { selectTab("runs"); loadRun(id, true); }; })(r.id) });
    });
    cmds.push({ group: "Actions", label: "Refresh current view", kind: "R", run: function () { refreshCurrent(); } });
    if (currentTournamentId && !document.getElementById("tournamentDetail").hidden) {
      cmds.push({ group: "Actions", label: "Copy board link", kind: "", run: function () {
        var href = location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(href).then(function () { toast("Board link copied"); }, function () { toast("Copy failed", true); });
        else toast("Clipboard unavailable", true);
      } });
    }
    if (FX.anon) cmds = cmds.filter(function (c) { return c.group === "Actions"; });
    return fxPalCommands().concat(cmds);
  }
  function palMarkActive() {
    var rows = document.getElementById("paletteList").children;
    var seen = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].className.indexOf("pal-row") < 0) continue;
      seen++;
      if (seen === palActive) {
        rows[i].className = "pal-row active";
        var mcpFoot = document.getElementById("palMcp");
        if (mcpFoot) { var am = palItems[palActive] && palItems[palActive].mcp; mcpFoot.textContent = am ? "→ mcp: " + am : ""; }
        if (rows[i].scrollIntoView) rows[i].scrollIntoView({ block: "nearest" });
      } else rows[i].className = "pal-row";
    }
  }
  function renderPalette(q) {
    var list = document.getElementById("paletteList");
    list.textContent = "";
    q = (q || "").toLowerCase();
    var idq = /^[igtca]-[0-9a-z]*$/.test(q);
    palItems = palCommands().filter(function (c) {
      if (c.idMatch && !q) return false;
      return !q || c.label.toLowerCase().indexOf(q) !== -1 || (c.desc && c.desc.toLowerCase().indexOf(q) !== -1) || (c.mcp && c.mcp.indexOf(q) !== -1);
    });
    if (idq) palItems.sort(function (a, b) { return (b.idMatch && b.idMatch.indexOf(q) === 0 ? 1 : 0) - (a.idMatch && a.idMatch.indexOf(q) === 0 ? 1 : 0); });
    var grouped = [], gseen = {};
    palItems.forEach(function (c) { if (!gseen[c.group]) { gseen[c.group] = []; grouped.push(gseen[c.group]); } gseen[c.group].push(c); });
    palItems = [].concat.apply([], grouped).slice(0, 40);
    palActive = 0;
    var lastGroup = "";
    palItems.forEach(function (c) {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        var g = el("div", c.group); g.className = "pal-group"; list.appendChild(g);
      }
      var row = el("div"); row.className = "pal-row";
      var label = el("span", c.label); label.className = "pal-label"; row.appendChild(label);
      if (c.desc) { var dsc = el("span", c.desc); dsc.className = "pal-desc"; row.appendChild(dsc); }
      if (c.kind) { var k = el("span", c.kind); k.className = "pal-kind"; row.appendChild(k); }
      if (c.key) { var kk = el("kbd", c.key); kk.className = "pal-key"; row.appendChild(kk); }
      if (c.mcp) row.setAttribute("data-mcp", c.mcp);
      (function (cmd) { row.addEventListener("click", function () { closePalette(); cmd.run(); }); })(c);
      list.appendChild(row);
    });
    if (palItems.length === 0) {
      var none = el("div", "No matching commands."); none.className = "pal-group"; list.appendChild(none);
    }
    palMarkActive();
  }
  function openPalette() {
    palOpen = true;
    document.getElementById("paletteOverlay").hidden = false;
    var input = document.getElementById("paletteInput");
    input.value = "";
    renderPalette("");
    setTimeout(function () { input.focus(); }, 0);
  }
  function closePalette() { palOpen = false; document.getElementById("paletteOverlay").hidden = true; }
  function palMove(d) {
    if (!palItems.length) return;
    palActive = (palActive + d + palItems.length) % palItems.length;
    palMarkActive();
  }
  function palRunActive() {
    var c = palItems[palActive];
    if (!c) return;
    closePalette();
    c.run();
  }
  document.getElementById("paletteBtn").addEventListener("click", function () { if (!appPane.hidden) openPalette(); });
  document.getElementById("paletteOverlay").addEventListener("click", function (ev) { if (ev.target === this) closePalette(); });
  document.getElementById("paletteInput").addEventListener("input", function () { renderPalette(this.value); });
  var gPending = 0;
  document.addEventListener("keydown", function (e) {
    var tag = (e.target && e.target.tagName) || "";
    var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!(e.target && e.target.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (appPane.hidden) return;
      if (palOpen) closePalette(); else openPalette();
      return;
    }
    if (palOpen) {
      if (e.key === "Escape") closePalette();
      else if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
      else if (e.key === "Enter") { e.preventDefault(); palRunActive(); }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || appPane.hidden) return;
    if (e.key === "Escape" && fxIsScreen(currentTab)) return;
    if (e.key === "Escape") {
      if (!document.getElementById("tournamentDetail").hidden) document.getElementById("backToTournaments").click();
      else if (!document.getElementById("repoDetail").hidden) document.getElementById("backToRepos").click();
      return;
    }
    if (e.key === "g" || e.key === "G") { gPending = Date.now(); return; }
    if (Date.now() - gPending < 900) {
      var m = { r: "runs", t: "tournaments", o: "repos", m: "merge", e: "settings", l: "live", i: "inbox", n: "intents", p: "trains", c: "conflicts", a: "agents", b: "bench" };
      var tab = m[String(e.key || "").toLowerCase()];
      gPending = 0;
      e.preventDefault();
      if (tab && FX.anon && !fxIsScreen(tab)) return;
      if (tab) palGoTab(tab);
      return;
    }
    if (e.key === "r" || e.key === "R") refreshCurrent();
    else if (e.key === "/") { e.preventDefault(); openPalette(); }
  });
  setInterval(function () {
    if (document.hidden || appPane.hidden) return;
    var nodes = document.querySelectorAll("[data-ago]");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = (nodes[i].getAttribute("data-prefix") || "") + fmtAgo(nodes[i].getAttribute("data-ago"));
  }, 30000);

${FORGE_JS}
  boot();
  startPoll();
})();
</script>
<datalist id="ghRepoList"></datalist>
<datalist id="flareRepoList"></datalist>
</body>
</html>`;
