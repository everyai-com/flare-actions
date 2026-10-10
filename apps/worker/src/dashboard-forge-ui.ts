// Forge dashboard: tokens, nav, panes and overlays (docs/FORGE-UX.md).
// These fragments are concatenated into DASHBOARD_HTML (dashboard.ts).
// String.raw keeps backslashes literal; the fragments must never contain
// a backtick or a dollar-brace sequence (dashboard.test.ts enforces it).

const ICON = (body: string) =>
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  body +
  "</svg>";

export const FORGE_ICONS = {
  live: ICON('<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/>'),
  inbox: ICON('<path d="M2 9.5 3.8 3h8.4L14 9.5V13H2z"/><path d="M2 9.5h3.5l1 1.6h3l1-1.6H14"/>'),
  intents: ICON('<path d="M8 1.8 14.2 8 8 14.2 1.8 8z"/>'),
  trains: ICON('<path d="M2.5 4.5 7 8l-4.5 3.5zM8.5 4.5 13 8l-4.5 3.5z"/>'),
  conflicts: ICON('<path d="m4 4 8 8M12 4l-8 8"/>'),
  agents: ICON('<circle cx="5.5" cy="6" r="2.2"/><circle cx="11" cy="6" r="2.2"/><path d="M1.8 13c.4-2.2 1.9-3.4 3.7-3.4s3.3 1.2 3.7 3.4M8.6 10.2c.7-.4 1.5-.6 2.4-.6 1.8 0 3.3 1.2 3.7 3.4"/>'),
  bench: ICON('<path d="M3 13V8M8 13V3M13 13V6"/>'),
};

export const FORGE_CSS = String.raw`
:root { --st-working: #7db4f7; --st-overlap: #fbbf24; --st-conflict: #f87171; --st-landed: #4ade80; --st-train: #a78bfa; --st-human: #fb923c; --st-idle: #52525b;
  --risk-low: #4ade80; --risk-med: #fbbf24; --risk-high: #f87171;
  --tint-working: rgba(125,180,247,0.12); --tint-overlap: rgba(251,191,36,0.12); --tint-conflict: rgba(248,113,113,0.12); --tint-landed: rgba(74,222,128,0.12); --tint-train: rgba(167,139,250,0.12); --tint-human: rgba(251,146,60,0.12); --tint-idle: rgba(82,82,91,0.18);
  --accent-fg: #000; --code-bg: #101214; --code-ink: #d0d4dd; --shadow: 0 24px 64px rgba(0,0,0,0.5); --map-bg: #0d0d0f; --overlay: rgba(0,0,0,0.6);
  --t-micro: 600 11px/14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --bg: #fafafa; --card: #ffffff; --sidebar: #f4f4f5; --line: #e4e4e7; --line-strong: #d4d4d8; --ink: #09090b; --soft: #3f3f46; --muted: #71717a; --faint: #a1a1aa; --accent: #18181b; --accent-hover: #27272a; --accent-ink: #2563eb; --danger: #dc2626; --ok: #16a34a; --warn: #b45309; --info: #2563eb; --hover: #f4f4f5; --input-bg: #ffffff; --ring: #71717a;
  --st-working: #2563eb; --st-overlap: #b45309; --st-conflict: #dc2626; --st-landed: #16a34a; --st-train: #7c3aed; --st-human: #c2410c; --st-idle: #a1a1aa; --risk-low: #16a34a; --risk-med: #b45309; --risk-high: #dc2626;
  --tint-working: rgba(37,99,235,0.10); --tint-overlap: rgba(180,83,9,0.10); --tint-conflict: rgba(220,38,38,0.10); --tint-landed: rgba(22,163,74,0.10); --tint-train: rgba(124,58,237,0.10); --tint-human: rgba(194,65,12,0.10); --tint-idle: rgba(161,161,170,0.16);
  --accent-fg: #fff; --code-bg: #f4f4f5; --code-ink: #27272a; --shadow: 0 24px 64px rgba(0,0,0,0.16); --map-bg: #f4f4f5; --overlay: rgba(24,24,27,0.35); } }
:root[data-theme="light"] { color-scheme: light; --bg: #fafafa; --card: #ffffff; --sidebar: #f4f4f5; --line: #e4e4e7; --line-strong: #d4d4d8; --ink: #09090b; --soft: #3f3f46; --muted: #71717a; --faint: #a1a1aa; --accent: #18181b; --accent-hover: #27272a; --accent-ink: #2563eb; --danger: #dc2626; --ok: #16a34a; --warn: #b45309; --info: #2563eb; --hover: #f4f4f5; --input-bg: #ffffff; --ring: #71717a;
  --st-working: #2563eb; --st-overlap: #b45309; --st-conflict: #dc2626; --st-landed: #16a34a; --st-train: #7c3aed; --st-human: #c2410c; --st-idle: #a1a1aa; --risk-low: #16a34a; --risk-med: #b45309; --risk-high: #dc2626;
  --tint-working: rgba(37,99,235,0.10); --tint-overlap: rgba(180,83,9,0.10); --tint-conflict: rgba(220,38,38,0.10); --tint-landed: rgba(22,163,74,0.10); --tint-train: rgba(124,58,237,0.10); --tint-human: rgba(194,65,12,0.10); --tint-idle: rgba(161,161,170,0.16);
  --accent-fg: #fff; --code-bg: #f4f4f5; --code-ink: #27272a; --shadow: 0 24px 64px rgba(0,0,0,0.16); --map-bg: #f4f4f5; --overlay: rgba(24,24,27,0.35); }
:root[data-theme="dark"] { color-scheme: dark; }
button { color: var(--accent-fg); }
button.ghost { color: var(--ink); }
.brand-mark, .t-rank.first, .t-pos.first, ol.steps li.done::before { color: var(--accent-fg); }
pre.log, code.token { background: var(--code-bg); color: var(--code-ink); }
tbody tr.clickable:hover, .run-row:hover, .run-row.selected { background: var(--hover); }
#paletteOverlay { background: var(--overlay); }
#palette { box-shadow: var(--shadow); }
.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.num { font-variant-numeric: tabular-nums; }
.wrap.wide { max-width: none; padding: 0 20px 32px; }
.side-link .fx-badge { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--tint-human); color: var(--st-human); font: 600 11px/18px var(--mono); text-align: center; font-variant-numeric: tabular-nums; }
.side-link .fx-badge.conflict { background: var(--tint-conflict); color: var(--st-conflict); }
.side-link .fx-badge[hidden] { display: none; }
.fx-bar { position: sticky; top: 0; z-index: 15; display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 8px 0; margin-bottom: 12px; background: var(--bg); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.fx-crumbs { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; min-width: 0; }
.fx-crumbs a { color: var(--soft); text-decoration: none; font-weight: 500; }
.fx-crumbs a:hover { color: var(--ink); }
.fx-crumbs .sep { color: var(--faint); }
.fx-crumbs .cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-bar select { padding: 5px 8px; font: 500 12.5px var(--mono); border-radius: 6px; }
.fx-spacer { flex: 1; }
.fx-tb { padding: 6px 10px; font-size: 12px; display: inline-flex; gap: 6px; align-items: center; }
.fx-tb kbd { font-size: 10px; }
.fx-tb[aria-pressed="true"] { background: var(--tint-human); border-color: var(--st-human); }
.fx-json { display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 6px; font: 600 12px var(--mono); color: var(--soft); text-decoration: none; }
.fx-json:hover { color: var(--ink); background: var(--hover); }
.fx-livebadge { display: inline-flex; align-items: center; gap: 6px; font: 600 12px var(--mono); color: var(--muted); padding: 0 6px; white-space: nowrap; }
.fx-livebadge::before { content: ""; width: 8px; height: 8px; border-radius: 999px; background: var(--st-idle); }
.fx-livebadge[data-state="live"] { color: var(--st-landed); }
.fx-livebadge[data-state="live"]::before { background: var(--st-landed); animation: tPulse 1.6s ease-in-out infinite; }
.fx-livebadge[data-state="polling"] { color: var(--st-working); }
.fx-livebadge[data-state="polling"]::before { background: var(--st-working); }
.fx-livebadge[data-state="reconnecting"] { color: var(--st-overlap); }
.fx-livebadge[data-state="reconnecting"]::before { background: transparent; border: 1.5px solid var(--st-overlap); }
.fx-livebadge[data-state="paused"] { color: var(--st-human); }
.fx-livebadge[data-state="paused"]::before { border-radius: 1px; width: 7px; background: linear-gradient(90deg, var(--st-human) 0 35%, transparent 35% 65%, var(--st-human) 65%); }
.fx-demo-tag { font: 600 11px/18px var(--mono); letter-spacing: 0.06em; padding: 0 8px; border-radius: 4px; border: 1px dashed var(--st-human); color: var(--st-human); text-transform: uppercase; white-space: nowrap; }
.fx-notice { display: flex; gap: 10px; align-items: baseline; border: 1px dashed var(--st-human); background: var(--tint-human); border-radius: 8px; padding: 8px 12px; margin: 0 0 12px; font-size: 12.5px; color: var(--soft); }
.fx-notice strong { color: var(--st-human); font-weight: 600; }
.fx-notice code { font-family: var(--mono); font-size: 12px; }
.fx-screen[hidden] { display: none; }
.fx-counters { list-style: none; margin: 0 0 12px; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 8px; background: var(--card); overflow: hidden; }
.fx-counter { padding: 12px 16px 12px; border-left: 1px solid var(--line); min-width: 0; position: relative; transition: background-color 600ms ease-out; }
.fx-counter:first-child { border-left: none; }
.fx-counter.flash { background: var(--tint-working); transition: none; }
.fx-clabel { font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fx-cval { font-size: 32px; line-height: 36px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin: 4px 0 2px; white-space: nowrap; }
.fx-cval small { font-size: 13px; font-weight: 500; color: var(--muted); letter-spacing: 0; margin-left: 6px; }
.fx-csub { display: flex; align-items: center; gap: 8px; font: 500 12px var(--mono); color: var(--muted); min-height: 18px; white-space: nowrap; overflow: hidden; }
.fx-csub.ok { color: var(--st-landed); }
.fx-csub.bad { color: var(--st-conflict); }
.fx-spark { width: 64px; height: 18px; flex: none; }
.fx-spark polyline { fill: none; stroke: var(--soft); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.fx-counters.stale .fx-cval { color: var(--muted); }
.fx-live-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 12px; align-items: start; }
.fx-panel { background: var(--card); border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.fx-panel-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); min-height: 36px; }
.fx-panel-head .fx-path { font: 500 12px var(--mono); text-transform: none; letter-spacing: 0; color: var(--soft); }
.fx-panel-head button { padding: 4px 8px; font-size: 11.5px; text-transform: none; letter-spacing: 0; }
.fx-map { position: relative; height: calc(100vh - 286px); min-height: 420px; margin: 8px; background: var(--map-bg); border-radius: 6px; overflow: hidden; }
.fx-group { position: absolute; border: 1px solid var(--line-strong); border-radius: 6px; }
.fx-group-label { position: absolute; left: 8px; top: 4px; font: 600 11px/14px var(--mono); color: var(--faint); letter-spacing: 0.02em; pointer-events: none; text-transform: uppercase; }
.fx-cell { position: absolute; border: 1px solid var(--line); border-radius: 4px; background: var(--card); overflow: hidden; cursor: pointer; transition: box-shadow 150ms ease, background-color 600ms ease-out; padding: 0; text-align: left; color: inherit; font: inherit; }
.fx-cell:hover { border-color: var(--ring); }
.fx-cell:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.fx-cell.sel { box-shadow: inset 0 0 0 2px var(--soft); }
.fx-cell.dim { opacity: 0.45; }
.fx-cell.overlap { background-image: repeating-linear-gradient(45deg, var(--tint-overlap) 0 4px, transparent 4px 8px); border-color: var(--st-overlap); }
.fx-cell.conflict { box-shadow: inset 0 0 0 2px var(--st-conflict); background-color: var(--tint-conflict); }
.fx-cell-label { position: absolute; left: 8px; top: 6px; right: 26px; font: 500 12px/16px var(--mono); color: var(--soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; z-index: 2; }
.fx-cell-meta { position: absolute; left: 8px; bottom: 5px; font: 500 11px/14px var(--mono); color: var(--faint); pointer-events: none; z-index: 2; white-space: nowrap; }
.fx-cell-badges { position: absolute; right: 5px; top: 5px; display: flex; gap: 4px; z-index: 3; }
.fx-cbadge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; font: 700 11px/16px var(--mono); text-align: center; border: 1px solid currentColor; background: var(--card); }
.fx-cbadge.lock { color: var(--st-human); }
.fx-cbadge.x { color: var(--st-conflict); cursor: pointer; }
.fx-heat { position: absolute; inset: 0; background: var(--st-working); pointer-events: none; }
.fx-heat-count { position: absolute; left: 50%; top: 52%; transform: translate(-50%, -50%); font: 600 20px var(--mono); color: var(--ink); font-variant-numeric: tabular-nums; pointer-events: none; z-index: 2; letter-spacing: -0.02em; }
.fx-dots { position: absolute; inset: 22px 6px 18px 6px; pointer-events: none; }
.fx-sdot { position: absolute; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 999px; background: var(--st-working); opacity: 0.75; }
.fx-sdot.train { background: var(--st-train); }
.fx-sdot.human { background: var(--st-human); }
.fx-dot { position: absolute; z-index: 4; pointer-events: auto; display: inline-flex; align-items: center; gap: 4px; padding: 0; margin: -6px 0 0 -6px; border: none; background: transparent; cursor: pointer; transition: left 400ms ease-in-out, top 400ms ease-in-out; }
.fx-dot:hover, .fx-dot:focus-visible { z-index: 6; }
.fx-dot-core { width: 12px; height: 12px; border-radius: 999px; background: var(--st-working); box-shadow: 0 0 0 2px var(--card); flex: none; }
.fx-dot[data-state="working"] .fx-dot-core, .fx-dot[data-state="claimed"] .fx-dot-core, .fx-dot[data-state="replaying"] .fx-dot-core { animation: tPulse 1.6s ease-in-out infinite; }
.fx-dot[data-tone="train"] .fx-dot-core { background: var(--st-train); }
.fx-dot[data-tone="human"] .fx-dot-core { background: var(--st-human); }
.fx-dot[data-tone="conflict"] .fx-dot-core { background: var(--st-conflict); }
.fx-dot[data-tone="landed"] .fx-dot-core { background: var(--st-landed); }
.fx-dot[data-tone="idle"] .fx-dot-core { background: var(--st-idle); }
.fx-dot-tag { font: 600 11px/16px var(--mono); padding: 0 5px; border-radius: 4px; background: var(--card); border: 1px solid var(--line-strong); color: var(--ink); white-space: nowrap; }
.fx-dot.flash .fx-dot-core { box-shadow: 0 0 0 4px var(--tint-working); }
.fx-arcs { position: absolute; inset: 0; pointer-events: none; z-index: 5; overflow: visible; }
.fx-arcs path { fill: none; stroke: var(--st-overlap); stroke-width: 1.5; stroke-dasharray: 4 3; }
.fx-arcs path.conflict { stroke: var(--st-conflict); stroke-dasharray: none; stroke-width: 2; }
.fx-arcs text { font: 600 11px var(--mono); fill: var(--st-overlap); paint-order: stroke; stroke: var(--map-bg); stroke-width: 3px; }
.fx-tip { position: fixed; z-index: 70; max-width: 340px; background: var(--card); border: 1px solid var(--line-strong); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; box-shadow: var(--shadow); pointer-events: none; }
.fx-tip[hidden] { display: none; }
.fx-tip .mono { color: var(--soft); }
.fx-tip-title { font-weight: 600; margin: 2px 0; }
.fx-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin-top: 10px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); font: 500 12px var(--mono); color: var(--soft); }
.fx-legend .lg { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.fx-legend .sw { width: 10px; height: 10px; border-radius: 999px; }
.fx-legend .sw.hatch { border-radius: 2px; background-image: repeating-linear-gradient(45deg, var(--st-overlap) 0 2px, transparent 2px 4px); border: 1px solid var(--st-overlap); }
.fx-legend .sw.box { border-radius: 2px; border: 2px solid var(--st-conflict); }
.fx-legend .fx-spacer { min-width: 8px; }
.st-working { color: var(--st-working); } .st-overlap { color: var(--st-overlap); } .st-conflict { color: var(--st-conflict); } .st-landed { color: var(--st-landed); } .st-train { color: var(--st-train); } .st-human { color: var(--st-human); } .st-idle { color: var(--st-idle); }
.bg-working { background: var(--st-working); } .bg-overlap { background: var(--st-overlap); } .bg-conflict { background: var(--st-conflict); } .bg-landed { background: var(--st-landed); } .bg-train { background: var(--st-train); } .bg-human { background: var(--st-human); } .bg-idle { background: var(--st-idle); }
.fx-rail { display: flex; flex-direction: column; }
.fx-rail-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; overflow-y: auto; }
.fx-train-cur { border: 1px solid var(--line); border-left: 2px solid var(--st-train); border-radius: 6px; padding: 8px 10px; }
.fx-train-cur.red { border-left-color: var(--st-conflict); }
.fx-train-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; margin-bottom: 6px; }
.fx-lane { padding: 6px 0; border-top: 1px dashed var(--line); }
.fx-lane:first-of-type { border-top: none; }
.fx-lane-top { display: flex; align-items: center; gap: 6px; font: 500 11.5px var(--mono); color: var(--muted); }
.fx-lane-top .lp { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-stages { display: flex; align-items: center; gap: 2px; margin-top: 5px; flex-wrap: wrap; }
.fx-stage { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--line); font: 500 11px var(--mono); color: var(--faint); white-space: nowrap; }
.fx-stage.done { color: var(--soft); }
.fx-stage.done::before { content: "✓"; color: var(--st-landed); }
.fx-stage.running { color: var(--ink); border-color: var(--st-train); background: var(--tint-train); }
.fx-stage.running::before { content: "▶"; color: var(--st-train); font-size: 9px; }
.fx-stage.failure { color: var(--st-conflict); border-color: var(--st-conflict); background: var(--tint-conflict); }
.fx-stage.failure::before { content: "✕"; }
.fx-stage.skipped { text-decoration: line-through; }
.fx-stage-arrow { color: var(--faint); font-size: 10px; }
.fx-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.fx-recent { list-style: none; margin: 0; padding: 0; }
.fx-recent li { display: flex; align-items: center; gap: 8px; padding: 5px 0; font: 500 12px var(--mono); color: var(--soft); border-top: 1px solid var(--line); }
.fx-recent li:first-child { border-top: none; }
.fx-recent .r-right { margin-left: auto; color: var(--muted); }
.fx-main-rule { padding: 10px 12px 12px; border-top: 1px solid var(--line); }
.fx-main-rule .rule { position: relative; height: 4px; border-radius: 999px; background: var(--ink); margin: 6px 0; }
.fx-main-rule .rule::after { content: ""; position: absolute; right: -2px; top: -4px; width: 12px; height: 12px; border-radius: 999px; background: var(--st-landed); box-shadow: 0 0 0 3px var(--card); }
.fx-main-rule .meta { display: flex; justify-content: space-between; font: 500 12px var(--mono); color: var(--muted); }
.fx-main-rule .meta strong { color: var(--ink); }
.fx-landing { position: fixed; z-index: 65; width: 12px; height: 12px; border-radius: 999px; background: var(--st-train); pointer-events: none; transition: transform 700ms ease-in-out, opacity 700ms ease-in; }
.fx-table-twin { margin: 8px; max-height: calc(100vh - 286px); overflow: auto; }
.fx-table-twin table td, .fx-table-twin table th { font-size: 12.5px; padding: 7px 10px; }
.fx-idchip { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--line); background: var(--hover); font: 500 12px var(--mono); color: var(--soft); white-space: nowrap; cursor: copy; text-decoration: none; }
a.fx-idchip { cursor: pointer; }
.fx-idchip:hover { color: var(--ink); border-color: var(--line-strong); }
.fx-pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--line-strong); font-size: 12px; font-weight: 500; white-space: nowrap; color: var(--soft); }
.fx-pill .g { font-size: 11px; }
.fx-pill[data-tone="working"] .g { color: var(--st-working); } .fx-pill[data-tone="overlap"] .g { color: var(--st-overlap); } .fx-pill[data-tone="conflict"] .g { color: var(--st-conflict); } .fx-pill[data-tone="landed"] .g { color: var(--st-landed); } .fx-pill[data-tone="train"] .g { color: var(--st-train); } .fx-pill[data-tone="human"] .g { color: var(--st-human); } .fx-pill[data-tone="idle"] .g { color: var(--st-idle); }
.fx-pill[data-tone="conflict"] { border-color: var(--st-conflict); background: var(--tint-conflict); }
.fx-pill[data-tone="human"] { border-color: var(--st-human); background: var(--tint-human); }
.fx-risk { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 20px; padding: 0 4px; border-radius: 4px; font: 600 12px var(--mono); font-variant-numeric: tabular-nums; border: 1px solid; flex: none; }
.fx-risk.low { color: var(--risk-low); border-color: var(--risk-low); background: var(--tint-landed); }
.fx-risk.med { color: var(--risk-med); border-color: var(--risk-med); background: var(--tint-overlap); }
.fx-risk.high { color: var(--risk-high); border-color: var(--risk-high); background: var(--tint-conflict); }
.fx-term { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px; border-radius: 4px; background: var(--hover); border: 1px solid var(--line); font: 500 12px var(--mono); color: var(--soft); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.fx-term .w { font-weight: 700; white-space: nowrap; flex: none; }
.fx-term .w.low { color: var(--risk-low); } .fx-term .w.med { color: var(--risk-med); } .fx-term .w.high { color: var(--risk-high); }
.fx-mono-av { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--hover); font: 700 10px var(--mono); color: var(--soft); flex: none; }
.fx-mono-av::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: 7px; height: 7px; border-radius: 999px; background: var(--av-dot, transparent); box-shadow: 0 0 0 1.5px var(--card); }
.fx-evidence { display: inline-flex; align-items: center; gap: 6px; font: 500 12px var(--mono); color: var(--muted); flex-wrap: wrap; }
.fx-evidence .ok { color: var(--st-landed); } .fx-evidence .bad { color: var(--st-conflict); } .fx-evidence .weak { color: var(--st-overlap); } .fx-evidence .run { color: var(--st-working); }
.fx-empty { border: 1px dashed var(--line-strong); border-radius: 8px; padding: 28px 20px; text-align: left; background: var(--card); }
.fx-empty h3 { margin: 0 0 4px; font-size: 15px; }
.fx-empty p { margin: 0 0 10px; color: var(--muted); font-size: 13px; max-width: 70ch; }
.fx-empty .fx-cmd { margin-top: 10px; }
.fx-empty .fx-code { font: 500 11px var(--mono); color: var(--faint); margin-top: 8px; }
.fx-empty.hero { border-style: solid; border-color: var(--st-landed); background: var(--tint-landed); }
.fx-empty.hero h3 { color: var(--st-landed); font-size: 18px; }
.fx-error { border: 1px solid var(--st-conflict); border-radius: 8px; padding: 14px 16px; background: var(--tint-conflict); }
.fx-error h3 { margin: 0 0 4px; font-size: 14px; color: var(--st-conflict); }
.fx-error p { margin: 0 0 8px; font-size: 13px; color: var(--soft); }
.fx-cmd { display: flex; align-items: center; gap: 8px; background: var(--code-bg); color: var(--code-ink); border: 1px solid var(--line); border-radius: 6px; padding: 6px 6px 6px 10px; font: 500 12.5px var(--mono); }
.fx-cmd code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; }
.fx-cmd button { padding: 4px 8px; font-size: 11.5px; }
.fx-inbox-grid { display: grid; grid-template-columns: 188px minmax(0, 1fr) 360px; gap: 12px; align-items: start; }
.fx-filters { display: flex; flex-direction: column; gap: 2px; padding: 8px; position: sticky; top: 60px; }
.fx-filters .fx-fhead { font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); padding: 8px 8px 4px; }
.fx-filters button { display: flex; align-items: center; gap: 8px; width: 100%; background: transparent; color: var(--soft); border: 1px solid transparent; padding: 7px 8px; font-size: 13px; text-align: left; }
.fx-filters button.sub { padding-left: 24px; font-size: 12.5px; color: var(--muted); }
.fx-filters button:hover { background: var(--hover); color: var(--ink); }
.fx-filters button[aria-pressed="true"] { background: var(--hover); color: var(--ink); border-color: var(--line); }
.fx-filters .n { margin-left: auto; font: 600 12px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.fx-filters .g { width: 12px; text-align: center; }
.fx-story { margin-bottom: 12px; }
.fx-story-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.fx-story-head .t { font-weight: 600; font-size: 14px; min-width: 0; }
.fx-story-head .m { font: 500 12px var(--mono); color: var(--muted); }
.fx-rows { list-style: none; margin: 0; padding: 0; }
.fx-row { display: grid; grid-template-columns: 20px 34px minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--line); border-left: 2px solid transparent; cursor: pointer; transition: background-color 600ms ease-out; }
.fx-row:last-child { border-bottom: none; }
.fx-row:hover { background: var(--hover); }
.fx-row.focus { background: var(--hover); border-left-color: var(--ink); }
.fx-row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.fx-row[data-bucket="needs_you"] { border-left-color: var(--st-human); }
.fx-row.done { opacity: 0.5; }
.fx-row .sel { width: 14px; height: 14px; margin: 0; }
.fx-row .l1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fx-row .title { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-row .l2 { grid-column: 3 / 5; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.fx-row .acts { grid-column: 3 / 5; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.fx-row .acts button { padding: 6px 10px; font-size: 12px; }
.fx-row .acts button kbd { margin-left: 4px; font-size: 10px; }
.fx-row .reason { font: 500 11.5px var(--mono); color: var(--st-human); }
.fx-row .sendback { grid-column: 3 / 5; display: flex; gap: 6px; }
.fx-row .sendback input { flex: 1; padding: 6px 8px; font-size: 12.5px; }
.fx-autoline { padding: 8px 12px; }
.fx-autoline summary { cursor: pointer; font: 500 12.5px var(--mono); color: var(--muted); list-style: none; display: flex; align-items: center; gap: 8px; }
.fx-autoline summary::before { content: "▸"; color: var(--faint); }
.fx-autoline[open] summary::before { content: "▾"; }
.fx-autoline summary::after { content: ""; flex: 1; border-top: 1px dashed var(--line-strong); }
.fx-detail { padding: 14px 16px; position: sticky; top: 60px; max-height: calc(100vh - 80px); overflow-y: auto; }
.fx-detail h3 { margin: 0 0 6px; font-size: 15px; }
.fx-sec { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.fx-sec-h { font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
.fx-sec ol, .fx-sec ul { margin: 0; padding-left: 18px; font-size: 13px; color: var(--soft); }
.fx-sec li { margin: 2px 0; }
.fx-terms-col { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.fx-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
button kbd { margin-left: 6px; }
.fx-terms-col .fx-term { white-space: normal; height: auto; min-height: 22px; padding-top: 2px; padding-bottom: 2px; }
.fx-actions button, .fx-actions a.btn { padding: 7px 12px; font-size: 12.5px; }
.fx-foot { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); }
.fx-foot code { font-family: var(--mono); }
.fx-bulk { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 40; display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; background: var(--card); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: var(--shadow); font-size: 13px; animation: tRise 140ms ease; }
.fx-bulk[hidden] { display: none; }
.fx-bulk button { padding: 6px 10px; font-size: 12.5px; }
.toast .fx-undo { margin-left: 10px; padding: 4px 8px; font-size: 12px; }
.fx-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 12px; align-items: start; }
.fx-head { padding: 4px 0 14px; }
.fx-head h1 { font-size: 20px; line-height: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 8px; overflow-wrap: anywhere; }
.fx-head .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.fx-stepper { display: flex; align-items: center; gap: 0; margin: 12px 0 4px; flex-wrap: wrap; row-gap: 6px; }
.fx-step { display: inline-flex; align-items: center; gap: 6px; font: 500 12px var(--mono); color: var(--faint); white-space: nowrap; }
.fx-step::before { content: ""; width: 9px; height: 9px; border-radius: 999px; border: 1.5px solid var(--line-strong); background: var(--bg); }
.fx-step.past { color: var(--soft); }
.fx-step.past::before { background: var(--soft); border-color: var(--soft); }
.fx-step.cur { color: var(--ink); font-weight: 700; }
.fx-step.cur::before { width: 11px; height: 11px; background: var(--step-c, var(--st-working)); border-color: var(--step-c, var(--st-working)); box-shadow: 0 0 0 3px var(--step-t, var(--tint-working)); }
.fx-step-line { width: 22px; height: 1px; background: var(--line-strong); margin: 0 6px; }
.fx-step-line.past { background: var(--soft); }
.fx-branch { font: 500 11.5px var(--mono); color: var(--muted); margin-left: 6px; }
.fx-kv { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px 10px; font-size: 13px; }
.fx-kv dt { font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); padding-top: 2px; }
.fx-kv dd { margin: 0; color: var(--soft); min-width: 0; overflow-wrap: anywhere; }
.fx-fp { width: 100%; border-collapse: collapse; font: 500 12.5px var(--mono); }
.fx-fp td { padding: 5px 8px; border-bottom: 1px solid var(--line); }
.fx-fp tr:last-child td { border-bottom: none; }
.fx-fp .mk { width: 18px; font-weight: 700; text-align: center; }
.fx-fp tr.eq .mk { color: var(--st-landed); }
.fx-fp tr.miss { color: var(--faint); }
.fx-fp tr.drift { background: var(--tint-overlap); }
.fx-fp tr.drift .mk, .fx-fp tr.drift .st { color: var(--st-overlap); }
.fx-fp .st { color: var(--muted); text-align: right; white-space: nowrap; }
.fx-ticks { position: relative; height: 18px; border-bottom: 1px solid var(--line-strong); margin: 4px 0 8px; }
.fx-ticks span { position: absolute; bottom: 0; width: 2px; height: 12px; background: var(--soft); border-radius: 1px; }
.fx-ticks span.alert { background: var(--st-overlap); height: 16px; }
.fx-ticks span.push { background: var(--st-working); }
.fx-steplog { list-style: none; margin: 0; padding: 0; }
.fx-steplog li { display: grid; grid-template-columns: 48px 64px minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 4px 0; font-size: 13px; border-top: 1px solid var(--line); }
.fx-steplog li:first-child { border-top: none; }
.fx-steplog .t { font: 500 12px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.fx-steplog .k { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: 0.04em; color: var(--soft); }
.fx-steplog .k.alert { color: var(--st-overlap); } .fx-steplog .k.push { color: var(--st-working); } .fx-steplog .k.tool { color: var(--st-train); }
.fx-note { border: 1px dashed var(--line-strong); border-radius: 8px; padding: 10px 12px; margin: 6px 0; }
.fx-note-h { font: 500 11.5px var(--mono); color: var(--muted); margin-bottom: 4px; }
.fx-note-h::before { content: "\201C  "; color: var(--faint); font-weight: 700; }
.fx-note-b { font: 500 12.5px var(--mono); color: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
.fx-pad { padding: 14px 16px; }
.fx-list { list-style: none; margin: 0; padding: 0; }
.fx-li { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
.fx-li:last-child { border-bottom: none; }
.fx-li:hover, .fx-li:focus-visible { background: var(--hover); }
.fx-li .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-li .r { font: 500 12px var(--mono); color: var(--muted); white-space: nowrap; }
.fx-lanes { display: flex; flex-direction: column; }
.fx-lanerow { display: grid; grid-template-columns: 240px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.fx-lanerow:last-child { border-bottom: none; }
.fx-lanerow.red { background: var(--tint-conflict); }
.fx-lanerow .ln { font: 600 12px var(--mono); }
.fx-lanerow .lp { font: 500 11.5px var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.fx-cichip { display: inline-flex; gap: 6px; align-items: center; font: 500 12px var(--mono); }
.fx-sha { font: 600 12px var(--mono); color: var(--ink); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line-strong); cursor: copy; }
.fx-bisect, .fx-bisect ul { list-style: none; margin: 0; padding: 0; }
.fx-bisect ul { display: flex; justify-content: center; gap: 24px; padding-top: 18px; position: relative; }
.fx-bisect ul::before { content: ""; position: absolute; top: 0; left: 50%; height: 9px; border-left: 1px solid var(--line-strong); }
.fx-bisect li { position: relative; display: flex; flex-direction: column; align-items: center; }
.fx-bisect ul > li { padding-top: 9px; }
.fx-bisect ul > li::before { content: ""; position: absolute; top: 0; height: 9px; border-left: 1px solid var(--line-strong); left: 50%; }
.fx-bisect ul > li::after { content: ""; position: absolute; top: 0; border-top: 1px solid var(--line-strong); left: 0; right: 0; }
.fx-bisect ul > li:first-child::after { left: 50%; }
.fx-bisect ul > li:last-child::after { right: 50%; }
.fx-bisect ul > li:only-child::after { display: none; }
.fx-bnode { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 12px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--card); font: 500 12px var(--mono); min-width: 120px; }
.fx-bnode .c { font-weight: 700; font-size: 13px; }
.fx-bnode.success .c { color: var(--st-landed); }
.fx-bnode.failure .c { color: var(--st-conflict); }
.fx-bnode.culprit { border: 2px solid var(--st-conflict); background: var(--tint-conflict); }
.fx-bnode .n { color: var(--muted); font-size: 11.5px; max-width: 220px; text-align: center; }
.fx-result { padding: 10px 14px; border-top: 1px solid var(--line); font: 500 12.5px var(--mono); color: var(--soft); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.fx-hist { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 10px 14px; font: 500 12px var(--mono); color: var(--soft); }
.fx-hist a { color: var(--soft); text-decoration: none; }
.fx-hist a:hover { color: var(--ink); }
.fx-ab { display: grid; grid-template-columns: 1fr 1fr; }
.fx-ab > div { padding: 14px 16px; min-width: 0; }
.fx-ab > div + div { border-left: 1px solid var(--line); }
.fx-ab .side { font: 700 13px var(--mono); color: var(--muted); margin-right: 6px; }
.fx-ab .fx-kv { grid-template-columns: 88px minmax(0, 1fr); }
.fx-shared { background-image: repeating-linear-gradient(45deg, var(--tint-overlap) 0 4px, transparent 4px 8px); border: 1px solid var(--st-overlap); border-radius: 4px; padding: 0 4px; }
.fx-hunk { margin: 0; padding: 6px 8px; background: var(--code-bg); color: var(--code-ink); border-radius: 6px; font: 500 12px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.fx-hunk .add { color: var(--st-landed); } .fx-hunk .del { color: var(--st-conflict); }
.fx-race { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; padding: 12px 14px; }
.fx-racecard { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font: 500 12.5px var(--mono); color: var(--soft); display: flex; flex-direction: column; gap: 4px; }
.fx-racecard.win { border-color: var(--ink); }
.fx-racecard .h { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--ink); }
.fx-racecard .win-l { color: var(--ink); font-weight: 700; }
.fx-grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.fx-bench td.num, .fx-bench th.num { text-align: right; }
.fx-bench tr.proj td { font-style: italic; }
.fx-bars { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; padding: 14px; }
.fx-bar-m h4 { margin: 0 0 6px; font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.fx-bar-r { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 6px; align-items: center; font: 500 11.5px var(--mono); color: var(--muted); margin: 3px 0; }
.fx-bar-t { display: block; height: 16px; background: var(--hover); border-radius: 3px; position: relative; }
.fx-bar-f { display: block; height: 100%; border-radius: 3px; background: var(--faint); }
.fx-bar-f.fx { background: var(--ink); }
.fx-bar-v { position: absolute; left: 6px; top: 0; line-height: 16px; font: 600 11px var(--mono); color: var(--card); mix-blend-mode: normal; }
.fx-bar-t .fx-bar-v.out { left: auto; right: 6px; color: var(--soft); }
.fx-bar-f:not(.fx) + .fx-bar-v { color: var(--ink); }
.fx-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 440px; max-width: 100vw; z-index: 45; background: var(--card); border-left: 1px solid var(--line-strong); box-shadow: var(--shadow); display: flex; flex-direction: column; animation: tFadeIn 140ms ease; }
.fx-drawer[hidden] { display: none; }
.fx-drawer-h { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.fx-drawer-h h2 { margin: 0; font-size: 14px; flex: 1; }
.fx-drawer-b { padding: 14px 16px; overflow-y: auto; flex: 1; }
.fx-chain { list-style: none; margin: 0; padding: 0; }
.fx-chain li { position: relative; padding: 0 0 14px 22px; }
.fx-chain li::before { content: ""; position: absolute; left: 5px; top: 14px; bottom: 0; border-left: 1px dotted var(--line-strong); }
.fx-chain li:last-child::before { display: none; }
.fx-chain .dot { position: absolute; left: 0; top: 3px; width: 11px; height: 11px; border-radius: 999px; background: var(--soft); }
.fx-chain .k { font: 700 11px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink); margin-right: 6px; }
.fx-chain .v { font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }
.fx-chain .s { font: 500 12px var(--mono); color: var(--muted); margin-top: 2px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.fx-chain li[data-kind="rejected"] .dot { background: var(--st-conflict); }
.fx-chain li[data-kind="evidence"] .dot { background: var(--st-landed); }
.fx-chain li[data-kind="intent"] .dot { background: var(--st-train); }
.fx-chain li[data-kind="goal"] .dot { background: var(--st-human); }
.fx-chain li[data-kind="session"] .dot { background: var(--st-working); }
.fx-code { margin: 0; background: var(--code-bg); color: var(--code-ink); border: 1px solid var(--line); border-radius: 8px; padding: 8px 0; font: 500 12.5px/1.6 var(--mono); overflow-x: auto; }
.fx-code .ln { display: flex; min-width: max-content; }
.fx-code .ln:hover { background: var(--hover); }
.fx-code .ln.sel { background: var(--tint-working); }
.fx-code .gut { flex: none; width: 52px; padding: 0 10px 0 0; text-align: right; color: var(--faint); background: transparent; border: none; font: inherit; cursor: pointer; border-radius: 0; line-height: inherit; }
.fx-code .gut:hover { color: var(--accent-ink); }
.fx-code .ln.sel .gut { color: var(--st-working); font-weight: 700; }
.fx-code .ln.has .gut::after { content: " ●"; color: var(--st-train); font-size: 8px; }
.fx-code .src { white-space: pre; padding-right: 16px; }
.fx-overlay { position: fixed; inset: 0; z-index: 55; background: var(--overlay); display: flex; justify-content: center; align-items: flex-start; padding: 8vh 16px 16px; }
.fx-overlay[hidden] { display: none; }
.fx-modal { width: 100%; max-width: 880px; max-height: 84vh; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: var(--shadow); animation: tRise 140ms ease; overflow: hidden; }
.fx-modal-h { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.fx-modal-h h2 { margin: 0; font-size: 15px; flex: 1; }
.fx-modal-b { padding: 14px 16px; overflow-y: auto; }
.fx-modal-f { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); flex-wrap: wrap; }
.fx-modal-f .fx-spacer { min-width: 8px; }
.fx-prop { display: grid; grid-template-columns: 22px minmax(180px, 1.2fr) minmax(200px, 1.4fr) 48px 80px 32px; gap: 8px; align-items: center; padding: 7px 0; border-top: 1px solid var(--line); }
.fx-prop input.t { width: 100%; padding: 6px 8px; font-size: 13px; }
.fx-prop .fps { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.fx-prop .fps input { width: 130px; padding: 3px 6px; font: 500 12px var(--mono); }
.fx-fpchip { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 2px 0 7px; border-radius: 4px; background: var(--hover); border: 1px solid var(--line); font: 500 12px var(--mono); color: var(--soft); }
.fx-fpchip.prot { border-color: var(--st-human); color: var(--st-human); }
.fx-fpchip button { padding: 0 5px; min-height: 0; height: 18px; background: transparent; color: var(--muted); border: none; font-size: 12px; }
.fx-prop .ix { font: 600 12px var(--mono); color: var(--muted); }
.fx-prop .needs { font: 600 12px var(--mono); color: var(--muted); }
.fx-prop .needs.on { color: var(--st-human); }
.fx-prop .fx-risk { justify-self: start; }
.fx-prop .del { padding: 4px 8px; background: transparent; color: var(--muted); border: 1px solid var(--line); }
.fx-prophead { display: grid; grid-template-columns: 22px minmax(180px, 1.2fr) minmax(200px, 1.4fr) 48px 80px 32px; gap: 8px; font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); padding: 10px 0 4px; }
.fx-warn { margin: 8px 0 0; padding: 6px 10px; border-radius: 6px; background: var(--tint-overlap); color: var(--soft); font: 500 12.5px var(--mono); }
.fx-warn .g { color: var(--st-overlap); font-weight: 700; }
.fx-keys { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 4px 28px; }
.fx-keys h4 { margin: 10px 0 4px; font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); grid-column: 1 / -1; }
.fx-keys div { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.pal-row .pal-desc { color: var(--muted); font-size: 12px; flex: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal-row .pal-key { flex: none; }
#paletteFoot .pal-mcp { margin-left: auto; font-family: var(--mono); color: var(--soft); }
.fx-agent-row { display: grid; grid-template-columns: 26px 64px 104px minmax(0, 1fr) 220px 70px 70px; gap: 10px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
.fx-agent-row.h { font: var(--t-micro); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.fx-lease { display: inline-flex; align-items: center; gap: 6px; font: 500 12px var(--mono); color: var(--muted); }
.fx-ring { width: 14px; height: 14px; border-radius: 999px; background: conic-gradient(var(--st-working) calc(var(--p, 0) * 1%), var(--line-strong) 0); flex: none; }
.fx-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 10px; }
.fx-tabs button { background: transparent; color: var(--muted); border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 12px; font-size: 13px; }
.fx-tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.fx-flash { animation: fxFlash 600ms ease-out; }
@keyframes fxFlash { from { background-color: var(--tint-working); } to { background-color: transparent; } }
@media (prefers-reduced-motion: reduce) {
  .fx-dot, .fx-cell, .fx-counter, .fx-row { transition: none; }
  .fx-dot .fx-dot-core, .fx-livebadge::before { animation: none !important; }
  .fx-dot[data-state="working"] .fx-dot-core, .fx-dot[data-state="claimed"] .fx-dot-core, .fx-dot[data-state="replaying"] .fx-dot-core { box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--st-working); }
  .fx-counter.flash, .fx-flash { animation: none; background: transparent; outline: 1px solid var(--line-strong); }
  .fx-drawer, .fx-modal, .fx-bulk { animation: none; }
  .fx-landing { display: none; }
}
body.fx-stagemode header { width: 60px; padding: 14px 8px; }
body.fx-stagemode header h1.brand-head span:last-child, body.fx-stagemode .side-link span:not(.fx-badge), body.fx-stagemode .side-group, body.fx-stagemode .side-foot { display: none; }
body.fx-stagemode .side-link { justify-content: center; padding: 9px 0; position: relative; }
body.fx-stagemode .side-link .fx-badge { position: absolute; right: -4px; top: 0; margin: 0; }
body.fx-stagemode .side-link svg { width: 18px; height: 18px; }
body.fx-stagemode.app main { margin-left: 60px; }
body.fx-stagemode .fx-bar > *:not(.fx-crumbs):not(#fxLiveBadge):not(.fx-demo-tag):not(.fx-spacer) { display: none; }
body.fx-stagemode .fx-bar { min-height: 52px; }
body.fx-stagemode .fx-crumbs { font-size: 18px; }
body.fx-stagemode .fx-livebadge { font-size: 15px; }
body.fx-stagemode .fx-cval { font-size: 56px; line-height: 60px; letter-spacing: -0.03em; }
body.fx-stagemode .fx-clabel { font-size: 13px; }
body.fx-stagemode .fx-csub { font-size: 14px; }
body.fx-stagemode .fx-spark { width: 96px; height: 24px; }
body.fx-stagemode .fx-legend { font-size: 14px; position: sticky; bottom: 0; }
body.fx-stagemode .fx-map { height: calc(100vh - 330px); }
body.fx-stagemode .fx-cell-label { font-size: 13px; }
body.fx-stagemode .fx-notice { display: none; }
body.fx-stagemode .fx-live-grid { grid-template-columns: minmax(0, 1fr) 380px; }
@media (max-width: 1200px) {
  .fx-inbox-grid { grid-template-columns: 170px minmax(0, 1fr); }
  .fx-inbox-grid .fx-detail { grid-column: 1 / -1; position: static; max-height: none; }
  .fx-counters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .fx-counter:nth-child(4) { border-left: none; }
  .fx-counter:nth-child(n+4) { border-top: 1px solid var(--line); }
}
@media (max-width: 900px) {
  .wrap.wide { padding: 0 12px 32px; }
  .fx-live-grid, .fx-detail-grid, .fx-inbox-grid { grid-template-columns: minmax(0, 1fr); }
  .fx-filters { position: static; flex-direction: row; flex-wrap: wrap; }
  .fx-filters button { width: auto; }
  .fx-filters .fx-fhead { display: none; }
  .fx-map { height: 60vh; min-height: 320px; }
  .fx-ab { grid-template-columns: minmax(0, 1fr); }
  .fx-ab > div + div { border-left: none; border-top: 1px solid var(--line); }
  .fx-lanerow { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .fx-prop, .fx-prophead { grid-template-columns: 18px minmax(0, 1fr) 40px 32px; }
  .fx-prop .fps { grid-column: 2 / -1; grid-row: 2; }
  .fx-prop .needs, .fx-prophead span:nth-child(3), .fx-prophead span:nth-child(5) { display: none; }
  .fx-agent-row { grid-template-columns: 26px 60px minmax(0, 1fr) 60px; }
  .fx-agent-row > :nth-child(3), .fx-agent-row > :nth-child(5), .fx-agent-row > :nth-child(7) { display: none; }
  .fx-drawer { width: 100vw; }
  .side-link .fx-badge { margin-left: 4px; }
}
@media (max-width: 640px) {
  .fx-counters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fx-counter:nth-child(n) { border-left: none; border-top: 1px solid var(--line); }
  .fx-counter:nth-child(2n) { border-left: 1px solid var(--line); }
  .fx-counter:nth-child(-n+2) { border-top: none; }
  .fx-cval { font-size: 26px; line-height: 30px; }
  .fx-bar { gap: 6px; }
  .fx-tb kbd, #fxStageBtn { display: none; }
  .fx-row { grid-template-columns: 20px 34px minmax(0, 1fr); }
  .fx-row .l2, .fx-row .acts, .fx-row .sendback { grid-column: 2 / -1; }
  .fx-row > .fx-mono-av { display: none; }
  .fx-row .title { white-space: normal; }
  .fx-term { white-space: normal; height: auto; min-height: 22px; }
  .fx-legend { font-size: 11.5px; gap: 4px 10px; }
  table.fx-fp tr { display: table-row; border: none; padding: 0; margin: 0; }
  table.fx-fp td { display: table-cell; padding: 5px 6px; }
  table.fx-fp, table.fx-fp tbody { display: table; }
  .fx-bisect ul { gap: 8px; }
  .fx-bnode { min-width: 0; padding: 4px 6px; }
  .fx-modal { max-height: 92vh; }
  .fx-overlay { padding: 4vh 8px 8px; }
  button.fx-tb, .fx-row .acts button, .fx-actions button { min-height: 36px; }
}
`;

const NAV_BTN = (id: string, tab: string, icon: string, label: string, badge = "") =>
  `<button id="${id}" class="side-link" data-tab="${tab}" type="button">${icon}<span>${label}</span>${badge}</button>`;

export const FORGE_NAV_HTML =
  '<div class="side-group">Agent forge</div>' +
  NAV_BTN("tabLive", "live", FORGE_ICONS.live, "Live") +
  NAV_BTN("tabInbox", "inbox", FORGE_ICONS.inbox, "Inbox", '<span class="fx-badge" id="fxBadgeInbox" hidden></span>') +
  NAV_BTN("tabIntents", "intents", FORGE_ICONS.intents, "Intents") +
  NAV_BTN("tabTrains", "trains", FORGE_ICONS.trains, "Trains") +
  NAV_BTN("tabConflicts", "conflicts", FORGE_ICONS.conflicts, "Conflicts", '<span class="fx-badge conflict" id="fxBadgeConflicts" hidden></span>') +
  NAV_BTN("tabAgents", "agents", FORGE_ICONS.agents, "Agents");

export const FORGE_NAV_BENCH_HTML = NAV_BTN("tabBench", "bench", FORGE_ICONS.bench, "Bench").replace("<button ", "<button hidden ");

export const FORGE_PANE_HTML = String.raw`
<section id="forgePane" class="fx-root" hidden aria-label="Forge">
<div class="fx-bar" role="toolbar" aria-label="Forge toolbar">
<nav class="fx-crumbs" id="fxCrumbs" aria-label="Breadcrumb"></nav>
<label><span class="sr">Repository</span><select id="fxRepo" aria-label="Repository"></select></label>
<span class="fx-demo-tag" id="fxDemoTag" hidden title="Fixture data: not measurements">Demo data</span>
<span class="fx-spacer"></span>
<span class="fx-livebadge" id="fxLiveBadge" data-state="off" role="status">offline</span>
<button class="ghost fx-tb" id="fxPauseBtn" type="button" data-action="pause_live" aria-pressed="false" aria-keyshortcuts="p">Pause <kbd>p</kbd></button>
<button class="ghost fx-tb" id="fxThemeBtn" type="button" data-action="toggle_theme" aria-label="Toggle light or dark theme">Theme</button>
<button class="ghost fx-tb" id="fxStageBtn" type="button" data-action="stage_mode" aria-pressed="false" aria-keyshortcuts="Shift+S">Stage <kbd>⇧S</kbd></button>
<a class="fx-json" id="fxJsonLink" href="/v1/forge/snapshot" target="_blank" rel="noopener" data-action="copy_json_url" title="Open this screen's JSON (shift-click copies the URL)">{} JSON</a>
<button class="ghost fx-tb" id="fxKeysBtn" type="button" data-action="show_shortcuts" aria-label="Keyboard shortcuts" aria-keyshortcuts="?">?</button>
</div>
<div class="fx-notice" id="fxNotice" hidden></div>
<div class="fx-screen" id="fxLive" data-screen="live" hidden>
<ul class="fx-counters" id="fxLiveCounters" aria-label="Live counters"></ul>
<div class="fx-live-grid">
<div class="fx-panel" role="region" aria-label="Live map">
<div class="fx-panel-head"><span>Repository map</span><span class="fx-path" id="fxMapPath"></span><span class="fx-spacer"></span><button class="ghost" id="fxClearPath" type="button" hidden>Clear filter</button><button class="ghost" id="fxTableBtn" type="button" data-action="view_as_table" aria-pressed="false" aria-keyshortcuts="t">View as table <kbd>t</kbd></button></div>
<div class="fx-map" id="fxMap" role="img" aria-label="Live map: repository paths sized by file count, one dot per active intent" aria-describedby="fxLiveTableWrap"></div>
<div class="fx-table-twin" id="fxLiveTableWrap" hidden><div class="table-scroll"><table id="fxLiveTable"><caption class="sr">Live map as a table: paths, intents, owners, state, overlaps</caption><thead><tr><th scope="col">Path</th><th scope="col">Files</th><th scope="col">Intents</th><th scope="col">Owners</th><th scope="col">State</th><th scope="col">Overlaps with</th></tr></thead><tbody></tbody></table></div></div>
</div>
<aside class="fx-panel fx-rail" id="fxTrack" aria-label="Train track into main"></aside>
</div>
<div class="fx-legend" id="fxLegend" aria-label="Legend"></div>
</div>
<div class="fx-screen" id="fxInbox" data-screen="inbox" hidden>
<ul class="fx-counters" id="fxInboxCounters" aria-label="Review counters"></ul>
<div class="fx-inbox-grid">
<nav class="fx-panel fx-filters" id="fxInboxFilters" aria-label="Inbox filters"></nav>
<div id="fxStories" role="region" aria-label="Stories"></div>
<aside class="fx-panel fx-detail" id="fxInboxDetail" aria-label="Detail"></aside>
</div>
<p class="fx-foot" id="fxInboxFoot"></p>
<div class="fx-bulk" id="fxBulk" role="region" aria-label="Bulk actions" hidden></div>
</div>
<div class="fx-screen" id="fxIntents" data-screen="intents" hidden></div>
<div class="fx-screen" id="fxTrains" data-screen="trains" hidden></div>
<div class="fx-screen" id="fxConflicts" data-screen="conflicts" hidden></div>
<div class="fx-screen" id="fxAgents" data-screen="agents" hidden></div>
<div class="fx-screen" id="fxBench" data-screen="bench" hidden></div>
<div class="fx-screen" id="fxWhy" data-screen="why" hidden></div>
</section>
`;

export const FORGE_OVERLAYS_HTML = String.raw`
<div class="fx-tip" id="fxTip" role="tooltip" hidden></div>
<aside class="fx-drawer" id="fxDrawer" aria-label="Why chain" hidden>
<div class="fx-drawer-h"><h2 id="fxDrawerTitle">Why</h2><button class="ghost fx-tb" id="fxDrawerClose" type="button" aria-label="Close why panel">Close <kbd>esc</kbd></button></div>
<div class="fx-drawer-b" id="fxDrawerBody"></div>
</aside>
<div class="fx-overlay" id="fxComposerOverlay" hidden>
<div class="fx-modal" role="dialog" aria-modal="true" aria-labelledby="fxComposerTitle">
<div class="fx-modal-h"><h2 id="fxComposerTitle">New goal</h2><button class="ghost fx-tb" id="fxComposerClose" type="button" aria-label="Close composer">esc</button></div>
<div class="fx-modal-b">
<label class="field" for="fxGoalText"><span>What should change?</span></label>
<textarea id="fxGoalText" rows="3" maxlength="4000" placeholder="Let clients cache catalog reads (ETag and Cache-Control), and require an API key for author writes." style="font-family: inherit; font-size: 14px;"></textarea>
<div class="fx-actions"><button id="fxPlanBtn" type="button" data-action="plan_goal">Plan <kbd>⌘↵</kbd></button><span class="muted" id="fxPlannerNote" style="align-self:center;font-size:12.5px">planner proposes intents; you edit them before launch</span></div>
<div id="fxProposals"></div>
</div>
<div class="fx-modal-f"><span id="fxComposerSummary" class="num"></span><span class="fx-spacer" style="flex:1"></span><button class="ghost" id="fxComposerCancel" type="button">Cancel</button><button id="fxLaunchBtn" type="button" data-action="declare_intent" disabled>Launch intents</button></div>
</div>
</div>
<div class="fx-overlay" id="fxKeysOverlay" hidden>
<div class="fx-modal" role="dialog" aria-modal="true" aria-labelledby="fxKeysTitle" style="max-width: 760px">
<div class="fx-modal-h"><h2 id="fxKeysTitle">Keyboard shortcuts</h2><button class="ghost fx-tb" id="fxKeysClose" type="button" aria-label="Close shortcuts">esc</button></div>
<div class="fx-modal-b"><div class="fx-keys" id="fxKeysGrid"></div></div>
</div>
</div>
`;
