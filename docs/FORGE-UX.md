# Flare Forge: UX and dashboard design spec

> Provenance: agent-drafted 2026-10-10 (product-design pass).
> - Product model, primitives, lifecycle, risk terms and MCP tools come
>   from `docs/COMPETITION-PLAN.md` revision 2 (read 2026-10-10).
> - Current visual language comes from a read of
>   `apps/worker/src/dashboard.ts` at `f798f8e` (2026-10-10): `:root`
>   tokens, side nav, hash routes, `palGoTab`, the ⌘K palette and the
>   `g`-chord shortcuts.
> - Reference patterns come from 15 Mobbin web searches run 2026-10-10
>   (screen links in §12). Mobbin had no screens for Figma multiplayer,
>   Railway, Datadog, Graphite or Superhuman, so the closest equivalents
>   it did have are used instead (Shopify Live View, MagicPath, AirOps,
>   Browserbase, Linear, Vercel). Those substitutions are marked.
> - Endpoint names under `/v1/forge/*` are **contract proposals** for
>   stream B. If B ships different names, B's names win and this table
>   gets updated.

---

## 0. The job of this UI, in one paragraph

A judge has two minutes. In that time the screen has to answer
Cloudflare's four questions without anyone explaining it: **who is
doing what** (Live map), **what happens when they collide**
(Conflicts and Trains), **what a human actually reviews** (Inbox), and
**why a line exists** (Why panel). Every one of those screens must also
work for a browser agent or an MCP client, with the same IDs and the
same data. The UI is not a skin over the API. It **is** the API,
rendered.

---

## 1. Design principles

1. **Color means state, never identity.** The only hues on screen are
   working (blue), overlap (amber), conflict (red), landed (green),
   train (violet) and needs-human (orange). Agents are neutral
   monograms. If something is colored, it's telling you something.
2. **Attention is the scarce resource, so default to the exception.**
   Every list sorts by "needs a human" and then by risk. Quiet,
   auto-landed work collapses into a count. (Plan A5: humans see about
   2% of changes.)
3. **Show the reason next to the number.** A risk score never appears
   alone; the terms that produced it sit right beside it ("+40
   protected `src/auth/**`"). A red train shows the bisect result, not
   just "failed". This is what *explainable* looks like on screen.
4. **One ID, everywhere.** `i-7f3a`, `g-12`, `t-142`, `c-9`, `a-04`
   mean the same thing in the URL, the JSON, the MCP tool, the CLI and
   the `data-id` attribute. You can copy an ID from anywhere and paste
   it anywhere.
5. **Live but calm.** Updates arrive as batched deltas (4–10 Hz from
   the Feed DO). Motion only says "this changed". Nothing loops except
   the "working" dot, and with reduced motion nothing moves at all.
6. **Keyboard first, palette complete.** Every action on a screen is
   reachable from ⌘K, and every palette action has an MCP tool with the
   same name. If a human can click it, an agent can call it.
7. **Measured or labelled.** Any number on screen is either live,
   carries a "measured <date> @ <sha>" footnote, or carries the word
   *projected*. No exceptions, including the demo.

**Tone.** Plain and precise, like a good commit message. Verbs first
("Approve plan", "Fork session", "Claim conflict"). No exclamation
marks, no mascots, no "Oops". Empty states say what's missing, why, and
the one command that fixes it. Mailbox text from peer agents is always
shown as *quoted data*, never as UI copy.

---

## 2. Visual foundation

The dashboard today is dark-only (`color-scheme: dark`, zinc neutrals,
`#0a0a0a` background, system UI font, a `ui-monospace` stack). Forge
keeps that look and adds semantic state tokens plus a light theme.
Dark stays the default and is the theme used in the video.

### 2.1 Color tokens

Add these to the existing `:root`. Keep every existing token so current
tabs don't change. Light theme:
`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {…} }`
and `:root[data-theme="light"] {…}`.

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--bg` | `#0a0a0a` | `#fafafa` | page (existing) |
| `--card` | `#111113` | `#ffffff` | surfaces (existing) |
| `--line` / `--line-strong` | `#1f1f23` / `#2e2e33` | `#e4e4e7` / `#d4d4d8` | borders (existing) |
| `--ink` / `--soft` / `--muted` | `#fafafa` / `#a1a1aa` / `#71717a` | `#09090b` / `#3f3f46` / `#71717a` | text (existing) |
| `--st-working` | `#7db4f7` | `#2563eb` | an agent holds a lease and is pushing |
| `--st-overlap` | `#fbbf24` | `#b45309` | footprints intersect (advisory, not blocking) |
| `--st-conflict` | `#f87171` | `#dc2626` | a real merge conflict, a red train, or a failed CI |
| `--st-landed` | `#4ade80` | `#16a34a` | on `main`, CI green on the exact SHA |
| `--st-train` | `#a78bfa` | `#7c3aed` | in a train, being merged or verified |
| `--st-human` | `#fb923c` | `#c2410c` | waiting on a person (plan approval, escalation) |
| `--st-idle` | `#52525b` | `#a1a1aa` | expired lease, draft, skipped |
| `--risk-low` (0–30) | `#4ade80` | `#16a34a` | auto-land eligible |
| `--risk-med` (31–60) | `#fbbf24` | `#b45309` | sampled or reviewed |
| `--risk-high` (61–100) | `#f87171` | `#dc2626` | a human must look |
| `--tint-*` | the state color at 12% alpha | the state color at 10% alpha | cell and row fills |

Rules:
- A state color fills at most a **dot, a 2px left border, a pill
  dot, or a 12% tint**. Large solid fills are reserved for the single
  primary button (`--accent`, white on dark), as today.
- Every color is paired with a glyph or a word, so the UI still works
  in grayscale and for color-blind viewers: working `●`, overlap `◐`,
  conflict `✕`, landed `✓`, train `▶`, human `!`.
- Overlap cells also get a 45° hatch
  (`repeating-linear-gradient(45deg, var(--tint-overlap) 0 4px, transparent 4px 8px)`)
  so overlap and conflict stay distinguishable even without color.
- Risk reuses the three state hues on purpose: amber means "be
  careful" and red means "stop" everywhere.

### 2.2 Type scale

There's no web font; keep the existing system stack. Use
`font-variant-numeric: tabular-nums` on every number.

| Token | Size / line height / weight | Use |
|---|---|---|
| `--t-micro` | 11 / 14 / 600, +0.04em, uppercase | counter labels, legend, column heads |
| `--t-meta` | 12 / 16 / 400 | timestamps, secondary rows |
| `--t-body` | 13 / 18 / 400 | rows, chips (the existing default is 14) |
| `--t-base` | 14 / 20 / 400 | prose, detail panes |
| `--t-h2` | 16 / 20 / 600 | section titles (existing `h2`) |
| `--t-h1` | 20 / 26 / 600, −0.01em | screen titles |
| `--t-stat` | 32 / 36 / 600, −0.02em | counters on cards |
| `--t-hero` | 56 / 56 / 600, −0.03em | stage-mode counters (§9) |
| mono | `ui-monospace` 12.5 (existing `.mono`) | IDs, SHAs, paths, risk terms |

### 2.3 Spacing, radius, density

- A 4px base: `4 8 12 16 24 32 48`.
- Row height: 32px for dense lists (Linear) and 44px for inbox stories
  (two lines).
- Radius: 6px for controls, 8px for cards (as today), 999px for pills
  and dots.
- The content max width of 960px (`.wrap`) is lifted on Forge screens,
  which use the full width (`.wrap.wide { max-width: none; }`). Maps
  and lanes need the room.

### 2.4 Motion

| Event | Motion | Duration |
|---|---|---|
| A delta arrives on a row or cell | background flashes to `--tint-*` and fades back | 600ms ease-out |
| An agent dot moves to a new path | `transform` translate | 400ms ease-in-out |
| A working dot | the existing `tPulse` opacity 1→0.35 | 1.6s loop |
| An intent lands (a dot reaches the `main` track) | the dot shrinks into the track, and the landed counter ticks | 300ms |
| Panes, palette | the existing `tRise` / `tFadeIn` | 140ms |
| Counter change | **no rolling digits**. Swap the text and flash a tint | 600ms |

Under `prefers-reduced-motion: reduce`, extend the existing media
query with: no translate (dots jump), no pulse (the working dot is
solid with a ring), no flash (a 1px outline persists for 2s instead).
Every live screen has a **Pause live** toggle (`p`) that freezes
rendering while deltas buffer, for humans reading and for
screenshots.

---

## 3. Information architecture

### 3.1 Navigation

The side nav keeps the house pattern (`.side-group` labels and
`.side-link` buttons with 14px stroke icons). Forge becomes the first
group, and **Live** becomes the default landing tab, replacing Races.

```
FORGE
  ◉ Live              g l   #/live
  ▤ Inbox      (3)    g i   #/inbox            badge = items needing a human
  ◇ Intents           g n   #/intents
  ▶ Trains            g p   #/trains
  ✕ Conflicts  (1)    g c   #/conflicts        badge = open conflicts
  ◍ Agents            g a   #/agents
CODE
  ▢ Repositories      g o   #/repos            the Why panel lives here
  ★ Races             g t   #/races            existing tournaments
CI
  ▷ Runs              g r   #/runs
  ⇄ Merge queue       g m   #/merge            existing GitHub queue
MANAGE
  ⚙ Settings          g e   #/settings
  ◫ Bench             g b   #/bench            the scale panel (§5.8)
```

- Goals have no nav item of their own. They're the top level inside
  Intents (`#/intents?goal=g-12`) and are created from the **Goal
  composer** (`c` anywhere, or "New goal" in ⌘K).
- The existing `g` map (`r t o m e`) is unchanged. New chords use
  letters that aren't taken yet.
- At ≤900px the existing horizontal-scroll nav applies. The badges
  stay, and the group labels hide, as today.

### 3.2 Routes and deep links

Hash routes extend the existing `applyHashRoute`. Every entity has
exactly one canonical route:

| Entity | Hash route | Canonical page path (server) | JSON |
|---|---|---|---|
| Live map | `#/live?repo=o/r` | `/forge/live?repo=o/r` | `GET /v1/forge/live?repo=o/r` |
| Inbox | `#/inbox?filter=needs_you` | `/forge/inbox` | `GET /v1/forge/inbox` |
| Goal | `#/goals/g-12` | `/forge/goals/g-12` | `GET /v1/goals/g-12` |
| Intent | `#/intents/i-7f3a` | `/forge/intents/i-7f3a` | `GET /v1/intents/i-7f3a` |
| Train | `#/trains/t-142` | `/forge/trains/t-142` | `GET /v1/trains/t-142` |
| Conflict | `#/conflicts/c-9` | `/forge/conflicts/c-9` | `GET /v1/conflicts/c-9` |
| Why | `#/repos/o/r/blob/main/src/app.ts?line=42&why=1` | `/forge/why/o/r/src/app.ts:42` | `GET /v1/why?repo=o/r&path=src/app.ts&line=42` |
| Agent | `#/agents/a-04` | `/forge/agents/a-04` | `GET /v1/agents/a-04` |
| Bench | `#/bench` | `/forge/bench` | `GET /v1/forge/bench` |

`/forge/*` serves the same dashboard HTML. It boots, then rewrites to
the hash route. That gives judges, Slack unfurls and agents clean,
shareable URLs without a client router. §8 covers `?format=json`.

### 3.3 Global chrome on Forge screens

```
┌ sidebar ┬──────────────────────────────────────────────────────────────────────────┐
│         │ Live · acme/shop ▾          ● live 8 Hz   ⏸ p   {} JSON   ⌘K   ? keys    │  ← 48px toolbar
│         ├──────────────────────────────────────────────────────────────────────────┤
│         │ COUNTERS STRIP (Live, Inbox and Bench only)                              │
│         ├──────────────────────────────────────────────────────────────────────────┤
│         │ screen body                                         │ optional right rail│
└─────────┴──────────────────────────────────────────────────────────────────────────┘
```

- **Repo switcher** (`repo ▾`): Forge screens are repo-scoped, so it
  writes `?repo=` into the hash.
- **Live badge**: shows the Feed WebSocket state (`● live 8 Hz` /
  `◌ reconnecting` / `‖ paused`). It degrades to 2s polling with a
  visible "polling" label.
- **`{} JSON`**: copies the screen's JSON URL. Shift-click opens it.
  (This replaces the need to find the API docs.)

---

## 4. Shared components

| Component | Spec |
|---|---|
| **State pill** | The existing `.pill` plus `data-state`. The `::before` dot takes `--st-*`, followed by a glyph and a word: `● working`, `◐ overlap`, `✕ conflicted`, `▶ in train`, `✓ landed`, `! awaiting plan`. |
| **Risk badge** | 28×20, mono 12/600, number 0–100. A 1px border plus a tint in the `--risk-*` band. Always followed by its term chips, or by a `+3 terms` toggle when space is tight. |
| **Risk term chip** | The existing `.chip`, mono: `+40 protected src/auth/**`, `+15 drift 2 files`, `+10 weak CI`, `+15 LLM replay`, `+15 reviewer disagrees`, `+8 size 23 files`. The weight is colored by band, and the text is `--soft`. |
| **Agent monogram** | A 20px circle with a `--line-strong` ring and two letters (`C4` = Claude #4, `CX` = Codex). Neutral fill. The state is shown by a 6px corner dot. |
| **ID chip** | Mono, click to copy, with a `title` that shows the full ID. Every rendered ID uses it. |
| **Evidence row** | `✓ CI run r-881 · exact SHA 9f2c1e0 · 41 tests · 38s`. If it's weak: `◐ CI green but 0 tests touched footprint`. |
| **Peer note** | Dashed `--line-strong` border, a `“` glyph, a mono body, and the header `Peer note · from i-31c2 · untrusted data`. It's never rendered as a link or a button. |
| **Lifecycle stepper** | Seven compact nodes (`draft · claimed · working · ready · in train · landed`) with branch-offs drawn under them (`conflicted → replaying`, `bisected`). The current node gets a state color, past nodes are `--soft`, future nodes `--faint`. |
| **Empty state** | The existing `div.empty`, plus a mono command block with a copy button and a machine code (§8.6). |

---

## 5. Screens

### 5.1 Live map (`#/live`): "who is doing what"

**Reference:** Shopify **Live View**, which puts KPI cards in a column
over a full-bleed live map with a legend pinned bottom-right and a
"Just now" live badge. Also MagicPath's **name-tagged cursor** and
**Connect Agent** card (substituting for Figma multiplayer).

**Layout at 1440×900 or 1920×1080:**

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ AGENTS ACTIVE   INTENTS LIVE   OVERLAPS CAUGHT   CONFLICTS OPEN   LANDED TODAY   MAIN RED MIN │
│   1,024           612             87 at declare     2               4,318          0          │
│   ▁▂▄▆▇           ▃▅▆▆▇           ▲ 14/min          ✕               ▲ 31/min       ✓ always   │
├──────────────────────────────────────────────────────────────┬───────────────────────────────┤
│ TREEMAP of repo (area ∝ files, depth 2, ≤64 cells)           │ TRACK → main                  │
│ ┌───────────────────────┬──────────────┬────────────────────┐│  t-143 ▶ ▶ ▶  lane 1  CI 0:21 │
│ │ src/routes            │ src/auth  !  │ src/middleware ◐◐  ││  t-143 ▶ ▶    lane 2  CI 0:21 │
│ │  ● ● C4  ●  ●         │  (locked:    │ ◐ C2 ↔ C7          ││  t-143 ▶      lane 3  merge   │
│ │  ●   ●                │   awaiting   │ hatch = overlap    ││  ───────────────────────────  │
│ │       ●  ●            │   plan)      │                    ││  t-142 ✓ landed 41 · 0:38     │
│ ├────────────┬──────────┴───┬──────────┴──────┬─────────────┤│  t-141 ✕→bisect → 39 ✓ 1 ✕    │
│ │ src/lib    │ src/db  ✕    │ test/           │ docs/       ││  t-140 ✓ landed 50 · 0:41     │
│ │  ● ●       │  C9 ✕ C3     │  ● ● ● ● ●      │  ●          ││                               │
│ │            │  red outline │                 │             ││  main ════════════● 9f2c1e0   │
│ └────────────┴──────────────┴─────────────────┴─────────────┘│                               │
├──────────────────────────────────────────────────────────────┴───────────────────────────────┤
│ LEGEND ● working  ◐ overlap  ✕ conflict  ▶ train  ✓ landed  ! needs human   ·  1 dot = 1 agent │
│ (above 200 agents per cell: a count badge "×143" plus a heat tint)    ⏸ p   ▦ view as table  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- **Treemap**: squarified, two levels deep, capped at 64 cells. Smaller
  directories roll into `other/`. Cell borders are `--line`, and the
  label is mono 12. Hover shows the path, the intents touching it, and
  their owners. Clicking filters the right rail and the table to that
  path (`?path=src/db`). Double-click zooms one level deeper (the
  breadcrumb shows `acme/shop › src › db`).
- **Dots**: one per active intent, placed by the intent's primary
  footprint path, jittered deterministically by an ID hash so they
  don't jump between renders. Dot states: working (blue, pulsing),
  in train (violet), awaiting plan (orange, inside the locked cell).
  Hovering a dot shows a monogram tooltip: `C4 · i-7f3a · "Add rate
  limit to /checkout" · lease 42s`.
- **Overlap**: a cell with two or more intents whose footprints
  intersect gets the amber hatch, and the overlapping pair is linked by
  a thin amber arc (`C2 ↔ C7`). That arc is the visual payoff for
  "overlap caught at declare time".
- **Conflict**: a 2px red outline on the cell and a `✕` badge.
  Clicking opens `#/conflicts/c-9`.
- **Protected paths** (from `.flare/policy.yml`) show a `!` lock glyph
  in the corner.
- **Track → main** (right rail, 320px): the current train's lanes as
  rows of `▶` chips that move right through the stages
  `merge → push → CI → CAS`. Below that, the last 5 trains are listed
  as finished rows (`✓ landed 41 · 0:38`, `✕→bisect`). At the bottom,
  `main` is drawn as a thick rule with the head SHA. When an intent
  lands, its dot animates off the treemap toward the track (if motion
  is allowed).
- **Scale switch**: at more than 200 dots in a cell, stop drawing dots
  and show `×143` plus a heat tint (opacity scales with log count).
  Above 2,000 dots total, draw them on one `<canvas>` overlay. Cells,
  labels and badges stay DOM.
- **View as table** (`t`): the same data as an accessible
  `<table>` (path, intents, owners, state, overlap with). It's always
  present in the DOM (`hidden` when the map is showing), so screen
  readers and agents get the full content.

**Counters strip** (also used on Inbox and Bench): six cells. Each has
an 11px uppercase label, a 32px number (56px in stage mode), a sparkline
or delta line, and a `data-metric` key. "Main red minutes" shows `0`
with a green `✓ always` line. It's the proof of invariant 2.

### 5.2 Inbox and Stories (`#/inbox`): "what does a human review"

**References:** the dense, grouped Linear issue list with its floating
bulk-action bar. The GitHub notifications two-line row (repo — title,
plus a reason label like "ci activity"). Supabase Security Advisor's
Errors/Warnings/Info tabs with counts and its "How are these
suggestions generated?" footer. (These stand in for Superhuman and
Graphite.)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ HUMAN TIME TODAY  NEEDS YOU   AUDIT SAMPLE   AUTO-LANDED   REVIEWER DISAGREES   POLICY         │
│   4m 30s          3           2 of 41 (5%)    39            6% (7d, n=212)       risk≤30 lands │
├──────────────┬───────────────────────────────────────────────┬───────────────────────────────┤
│ FILTERS      │ STORY g-12 "Add rate limiting to checkout" ▾   │ DETAIL  i-9a01                │
│ ! Needs you 3│ 12 intents · 10 landed · 1 sample · 1 needs you│ Gate /admin behind SSO        │
│   Plans    1 │───────────────────────────────────────────────│ ! awaiting plan · risk 58     │
│   Escal.   2 │ 58 ! i-9a01 Gate /admin behind SSO        C4  │ +40 protected src/auth/**     │
│ ◐ Sample   2 │    +40 protected src/auth/**  +8 size          │ +8  size 9 files              │
│ ✓ Auto    39 │    [Approve plan ⏎] [Edit] [Reject x]          │ +10 weak CI (no auth tests)   │
│              │ 44 ◐ i-31c2 Retry on 429 in client  sample C2  │───────────────────────────────│
│ GROUP BY     │    +15 LLM replay  +15 reviewer disagrees      │ PLAN (from session)           │
│ ● Story      │    ✓ CI r-881 @9f2c1e0 · 41 tests              │ 1. Add sso() middleware       │
│ ○ Risk       │    [Looks good a] [Send back x]                │ 2. Wire to /admin/*           │
│ ○ Agent      │ ── 10 auto-landed (risk ≤30) ── expand ▾ ──── │ FOOTPRINT  declared 9 files   │
│              │ STORY g-13 "Migrate logs to Pipelines" ▸ 6     │  src/auth/sso.ts  + 2 more    │
│              │                                                │ WHY THIS NEEDS YOU            │
│              │                                                │ "Protected path per policy."  │
│              │ ┌ 2 selected · [Approve all] [Send back] ✕ ┐   │ [Approve plan] [Open intent ↗]│
└──────────────┴───────────────────────────────────────────────┴───────────────────────────────┘
  footer: How is risk computed? → 6 deterministic terms, weights in .flare/policy.yml   [policy ↗]
```

**Behavior:**
- **Sorting**: Needs you (plans, then escalations) → Audit sample →
  Auto-landed. Within each group, sort by risk descending. Stories
  (goals) are the default grouping, and you can also group by risk or
  by agent.
- **Row anatomy** (44px): risk badge · state glyph · ID chip · title ·
  agent monogram, then a second line of term chips and an evidence
  row. The action buttons appear on focus or hover. They're always in
  the DOM, with `hidden` on the button labels only, so agents can find
  them.
- **Plan approval is one keystroke**: `⏎` or `a` approves the focused
  plan. It shows a 5s undo toast ("Plan approved · i-9a01 · Undo z")
  before calling `POST /v1/intents/i-9a01/approve`. The toast is
  `role="status"`.
- **Audit sample** rows are framed as a question: "Looks good?" (`a`) or
  "Send back" (`x`, which requires a one-line reason). The result feeds
  the **disagreement rate** metric.
- **Auto-landed** work collapses to a single line per story
  ("10 auto-landed (risk ≤30)"). Expanding it shows each one with the
  terms that fired. This is the Supabase advisor's explainability
  pattern: the system shows its homework.
- **Bulk**: `x`-select with the space bar, and a floating bar appears
  bottom-center (Linear's "6 selected · Actions").
- **Keys**: `j/k` move, `⏎` open or approve, `a` approve, `x` send
  back, `e` toggle evidence, `w` open the Why chain for the intent's
  first hunk, `s` select, `1/2/3` switch filters.
- **Zero state**: "Nothing needs you. 39 changes auto-landed today
  under policy `risk ≤ 30`. 2 are in the audit sample." This takes the
  Customer.io "All clear: nothing needs your attention" health pattern
  and turns it into the hero message.

### 5.3 Intent detail (`#/intents/i-7f3a`): goal → intent → evidence

**References:** the Linear issue detail with a properties rail. The
Browserbase agent run: a tick timeline across the top and a step log
with typed chips (Prompt/Reason/Tool) plus timestamps. The Vercel
deployment detail's meta grid (Created / Status / Duration /
Environment / Source sha).

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Intents › g-12 Add rate limiting to checkout › i-7f3a                       {} JSON  ⌘K      │
│ Add token-bucket limiter to /checkout                         ● working   risk 22   C4 a-04  │
│ draft ─ claimed ─ ●working ─ ready ─ in train ─ landed         lease 42s ◔   fork i-7f3a ⧉   │
├───────────────────────────────────────────────────────────────┬──────────────────────────────┤
│ GOAL      g-12 "Checkout gets hammered by bots; cap per IP."  │ PROPERTIES                   │
│ REASONING Token bucket in a DO keyed by IP; middleware so     │ State     working            │
│           routes stay untouched. Rejected: KV counter (eventual│ Agent     C4 (claude-code)   │
│           consistency lets bursts through).                   │ Created   14:02:11 PDT       │
│ ACCEPT    npm test -- ratelimit ; p95 < 5ms                   │ Session   flare/session ⧉    │
│───────────────────────────────────────────────────────────────│ Overlaps  i-31c2 ◐ (C2)      │
│ FOOTPRINT        declared (4)        actual (5, from 3 pushes) │ Train     —                  │
│  = src/middleware/ratelimit.ts       ✓                         │ Risk      22                 │
│  = src/routes/checkout.ts            ✓                         │  +8  size 5 files            │
│  = test/ratelimit.test.ts            ✓                         │  +15 drift 1 file            │
│  − wrangler.jsonc                    (not touched)             │ ──────────────────────────── │
│  + src/lib/ip.ts                     ◐ drift (undeclared)      │ [Mark ready]  [Fork session] │
│───────────────────────────────────────────────────────────────│ [Send note]   [Release]      │
│ EVIDENCE  ✓ CI r-903 @ a1b2c3d · 12 tests touched footprint · 31s · reviewer agrees          │
│───────────────────────────────────────────────────────────────────────────────────────────── │
│ SESSION   ▏▏ ▏  ▏▏▏   ▏ (tick strip, 0:00 → 6:41)                                             │
│  0:00 Plan    Read checkout.ts, middleware chain                                             │
│  0:41 Reason  Overlap with i-31c2 on middleware; will register after auth                    │
│  1:12 Tool    declare_intent → overlaps[1]                                                   │
│  3:30 Push    a1b2c3d  +84 −3  3 files                                                       │
│───────────────────────────────────────────────────────────────────────────────────────────── │
│ MAILBOX   “ Peer note · from i-31c2 (C2) · untrusted data                                     │
│           │ I'm wrapping fetch() in middleware.ts:40-60; please register after auth.  │      │
│           [Send note n]                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The **footprint diff** is the key visual. `=` means declared and
  touched, `−` means declared but untouched (muted), and `+` means
  undeclared drift (amber, and it adds a risk term). It answers
  "what if an agent lies about its footprint?" without narration.
- **Fork session** calls `fork_session` and shows the new fork remote
  plus the copy-paste command
  (`claude --mcp … "continue intent i-7f3a"`).

### 5.4 Train view (`#/trains/t-142`): integration, verified on the exact SHA

**References:** the Vercel deployments list (status dot plus duration,
branch, short SHA plus message, "Current"/"Rolled back" badges) for
the train history. The AirOps/Gumloop node canvases (vertical steps
with "Step N" tags and inline output) for the stage track. These
substitute for CircleCI workflows.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Trains › t-141                     ✕→✓ bisected · 40 intents · 3 lanes · 2m 14s   {} JSON    │
│ STAGES   merge ── push train/141 ── CI on exact SHA ── CAS main ── notes                     │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ LANE 1 (src/routes, src/lib)  ▢i-7f3a ▢i-55e0 ▢i-90aa … 14   ✓ merge  ✓ push  ✓ CI 0:31     │
│ LANE 2 (src/db)               ▢i-c310 ▢i-02bd … 12           ✓ merge  ✓ push  ✕ CI 0:29     │
│ LANE 3 (docs, test)           ▢ … 14                          ✓ merge  ✓ push  ✓ CI 0:22     │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ BISECT (lane 2, combined 7e91f00 red)                                                        │
│                 12 ✕ 7e91f00                                                                 │
│               ┌──────┴──────┐                                                                │
│           6 ✓ 3c0a…     6 ✕ 88d1…                                                            │
│                       ┌────┴────┐                                                            │
│                   3 ✓ …     3 ✕ …                                                            │
│                            ┌─┴─┐                                                             │
│                         1 ✓   1 ✕ i-c310 → culprit, back to ready, owner notified            │
│ RESULT  39 landed on main @ 9f2c1e0 (CI r-889 green on this exact SHA) · 1 requeued          │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ HISTORY  t-143 ▶ running 0:21 · t-142 ✓ 41 · 0:38 · t-141 ✕→✓ 39/40 · t-140 ✓ 50 · 0:41      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Lanes** are horizontal swimlanes. Each lane's label states its
  footprint, which explains why the lanes can run in parallel. Intent
  chips wrap; past 8 chips they collapse to `… 14`.
- **The exact SHA is always printed next to CI.** That's the
  differentiator, so render it in mono with a copy chip and link it to
  the CI run.
- The **bisect tree** is pure CSS/DOM: a nested `<ul>` with connector
  borders, no SVG needed. Nodes show their count, state glyph and SHA.
  The culprit leaf gets a red outline.
- A train detail is linkable mid-flight, and the stage chips update
  live.

### 5.5 Conflict view (`#/conflicts/c-9`): merging intents, not hunks

**References:** the Descript version history rail, with its "Conflicts
detected" plus "Fix" in a warning-tinted card. The Higgsfield/Recraft
side-by-side compare. The Mintlify expandable failure row (commit
details plus files changed plus Redeploy).

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Conflicts › c-9   ✕ open · src/middleware/index.ts:40-60 · train t-141     [Claim ⇧C] {} JSON │
├─────────────────────────────────────────────┬────────────────────────────────────────────────┤
│ A  i-7f3a  C4  "Add rate limit to checkout" │ B  i-31c2  C2  "Retry on 429 in client"        │
│ GOAL  g-12 cap bot traffic per IP           │ GOAL  g-13 resilient API client                │
│ WHY   limiter must run after auth           │ WHY   wrap fetch so retries see 429s           │
│ FOOTPRINT ◐ middleware/index.ts, …          │ FOOTPRINT ◐ middleware/index.ts, …             │
│ HUNK  +app.use(rateLimit())  @L44           │ HUNK  +app.use(retry429())  @L44               │
├─────────────────────────────────────────────┴────────────────────────────────────────────────┤
│ RESOLUTION: replay B on trunk @ 9f2c1e0 with A's why in context                              │
│ claimed by C7 ── ● replaying ── CI on exact SHA ── train t-144 ── landed                     │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ RACE (race_k = 3)           #1 C7            #2 C9            #3 workers-ai                  │
│                             ✓ CI 0:29        ✓ CI 0:31        ✕ CI (2 fail)                  │
│                             +6 −2            +11 −4           +9 −9                          │
│                             reviewer ✓       reviewer ◐       —                              │
│                             ★ winner (smallest green diff, reviewer agrees)                  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The two columns mirror each other row by row (goal / why /
  footprint / hunk), so the eye compares straight across. The shared
  path is highlighted with an amber hatch in both.
- The **replay stepper** reuses the lifecycle stepper. Each stage
  shows its timestamp when it's done.
- The race cards reuse the existing Races verdict data. The winner is
  marked with `★` plus the rule that picked it. That's text, not
  color.

### 5.6 Why panel (`#/repos/…?line=42&why=1`): line → chain

**References:** Microsoft Copilot's "See my thinking" right rail (a
vertical dotted chain with a bold verb per step). The GitHub PR file
view's line gutter.

The panel opens as a 420px right drawer over the repo file view.
Click a line number or press `w` on a focused line. `Esc` closes it.

```
┌ src/routes/checkout.ts ───────────────────────────┬ WHY  line 44 ─────────────────── ✕ ┐
│ 42  export async function checkout(c) {           │ ● LINE    app.use(rateLimit())     │
│ 43    const ip = clientIp(c)                      │ │                                  │
│ 44 ▸  app.use(rateLimit())        ← selected      │ ● COMMIT  a1b2c3d  C4  14:05       │
│ 45    …                                           │ │  Flare-Intent: i-7f3a ⧉          │
│                                                   │ ● INTENT  Add token-bucket limiter │
│                                                   │ │  ✓ landed in t-142 @ 9f2c1e0     │
│                                                   │ ● GOAL    g-12 cap bots per IP     │
│                                                   │ ● REASON  DO bucket keyed by IP;   │
│                                                   │ │  after auth (per note i-31c2)    │
│                                                   │ ● REJECTED KV counter: eventual    │
│                                                   │ │  consistency lets bursts through │
│                                                   │ ● EVIDENCE ✓ CI r-889 · 12 tests   │
│                                                   │ │  reviewer agrees · risk 22       │
│                                                   │ ● SESSION flare/session @ i-7f3a   │
│                                                   │   [Fork session]  [Copy chain]     │
│                                                   │   $ flare why src/routes/…:44  ⧉   │
└───────────────────────────────────────────────────┴────────────────────────────────────┘
```

- Each node is a `<li>` in an `<ol aria-label="Why chain">`, carrying
  `data-kind` and `data-id`.
- **Copy chain** copies the JSON. The CLI command line is always shown,
  so the shell, MCP and UI paths are visibly the same thing.
- Lines that came from a train show the train ID. Lines from before
  Forge show "No why note (pre-Forge commit)" plus the plain commit
  message. Missing data is stated, never hidden.

### 5.7 Goal composer (`c`, or ⌘K "New goal")

**References:** AirOps "Review your initial prompts" (an editable list
of rows with a topic dropdown, a delete button, and Continue). The
Higgsfield "Waiting for your approval" card (a numbered plan with
Approve and Stop). Microsoft Copilot "Edit research plan" with an
estimated time.

```
┌ New goal ────────────────────────────────────────────────────────────────────────── esc ┐
│ What should change?                                                                     │
│ ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Checkout gets hammered by bots. Cap requests per IP and make the client retry 429s. │ │
│ └─────────────────────────────────────────────────────────────────────────────────────┘ │
│ [Plan ⌘⏎]   planner: workers-ai · proposes intents, you edit                            │
│──────────────────────────────────────────────────────────────────────────────────────────│
│ PROPOSED INTENTS (5)                                         risk preview   needs        │
│ 1 [Add token-bucket limiter to /checkout ] [src/middleware/** ×][+]   22        —      🗑 │
│ 2 [Retry 429 in API client              ] [src/lib/client.ts ×][+]    18        —      🗑 │
│ 3 [Gate /admin behind SSO                ] [src/auth/** × ]  !         58   ! plan     🗑 │
│ 4 [Tests for limiter                     ] [test/** ×]                  6        —      🗑 │
│ 5 [Docs                                  ] [docs/** ×]                  4        —      🗑 │
│ ◐ 1 ↔ 2 overlap on src/middleware/index.ts (advisory: they'll be told at declare)        │
│ [+ Add intent]                                                                          │
│──────────────────────────────────────────────────────────────────────────────────────────│
│ 5 intents · 1 needs plan approval · est. 2 trains        [Cancel]  [Launch 5 intents ⏎] │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- The risk preview recomputes on each edit from the deterministic
  terms that are knowable before code exists (protected path, size).
- Footprint chips use path-glob autocomplete from the repo tree.
- An overlap between proposed intents is shown before launch. That's
  the declare-time story in miniature.

### 5.8 Scale and bench panel (`#/bench`)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Bench · run b-07 · 10,000 agents · measured 2026-10-12 @ 3c9e1a0   (projected rows in italics)│
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│              CHANGES/MIN   MEDIAN DECLARE→LAND   CONFLICTS (hit/avoided)   RED-MAIN MIN   HUMAN MIN   $ / 1K AGENTS │
│ Baseline PR+queue   3.1         3h 12m               1,840 / 0               47            1,210        —       │
│ Forge, trains only  88          9m 40s               1,790 / 0               0             1,210        $0.41   │
│ Forge, full         131 ▲42×    4m 05s               212 / 1,628             0             96 ▼92%      $0.44   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ [bar pairs per metric, baseline gray vs Forge white; same scale; labels on bars]             │
│ 100k declare bench: 100,000 intents · p50 overlap query 3.1 ms · p99 11 ms · 4 LeaseShards   │
│ Reproduce: npm run forge:bench -- --agents 10000 --mode all        ⧉                         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

(The numbers above are placeholders for layout only. The panel renders
whatever `GET /v1/forge/bench` returns, and its header always prints
the run ID, date and SHA. Rows with `projected: true` render in italics
with the word "projected".)

### 5.9 Agents (`#/agents`)

**References:** the Devin sessions sidebar ("PR is ready · 1" status
line plus an unread dot). The Customer.io MCP connection guide (tabs
for ChatGPT / Claude Desktop / Cursor with numbered steps). The
MagicPath "Connect Agent: Work with Codex, Claude Code, or Cursor"
card.

- A list: monogram · agent ID · client (claude-code/codex/cursor/sim)
  · current intent · last tool call and how long ago · lease ring
  (TTL remaining) · intents landed today.
- A pinned **Connect an agent** card at the top, with tabs (Claude Code
  · Cursor · Codex · curl) and the exact MCP config block (§8.4) plus
  a copy button. When there are no agents, this card is the whole page.
- Simulator agents are grouped and collapsed by default
  ("AgentPool · 9,994 simulated agents ▸"). That keeps real agents
  visible and the sim honest.

---

## 6. Command palette (⌘K) and keyboard

The existing palette (`#paletteOverlay`, the groups "Go to" and so on,
`↑↓ ⏎ esc`) is extended. **References:** Replit's palette (each
command has a one-line description and a shortcut on the right) and
Shopify's keyboard shortcuts sheet (`g`-sequence chords laid out in
columns, opened with `?`).

| Group | Command | Shortcut | MCP tool / REST |
|---|---|---|---|
| Go to | Live, Inbox, Intents, Trains, Conflicts, Agents, Bench | `g l/i/n/p/c/a/b` | n/a |
| Create | New goal… | `c` | `plan_goal` |
| Intent | Approve plan | `a` | `approve_plan` → `POST /v1/intents/:id/approve` |
| Intent | Send back with reason… | `x` | `send_back` |
| Intent | Mark ready | `m` on intent (`r` stays refresh) | `mark_ready` |
| Intent | Send note… | `n` | `send_note` |
| Intent | Fork session | `f` | `fork_session` |
| Conflict | Claim conflict | `⇧C` on conflict (`c` stays New goal) | `claim_conflict` |
| Why | Why is this line here? | `w` | `why` |
| Find | Jump to ID… (`i-`, `g-`, `t-`, `c-`, `a-`) | type the ID | `get_*` |
| View | Pause live / View as table / Stage mode | `p` / `t` / `⇧S` | n/a |
| Copy | Copy JSON URL / Copy MCP config | `⇧J` / n/a | n/a |

- Typing an ID prefix (`i-7f`) shows matching entities first.
- The palette footer shows the MCP tool name for the highlighted
  command (`→ mcp: approve_plan`). It's a small, constant reminder that
  agents can do everything humans can.
- `?` opens the shortcut sheet (a modal grid, Shopify style).
- **Fix the existing bug** (Plan §7 item 6): ⌘K → Merge queue opens an
  empty pane.

---

## 7. Empty, loading and error states

| Screen | Empty copy | Command block | Machine code |
|---|---|---|---|
| Live | "No agents are working on acme/shop." | `npx flare-actions@latest mcp-config --client claude-code` | `forge_no_active_intents` |
| Inbox | "Nothing needs you. N auto-landed under `risk ≤ 30`." | none (good news) | `inbox_clear` |
| Intents | "No goals yet. Write one and the planner proposes intents." | `[New goal c]` | `no_goals` |
| Trains | "No trains yet. The first ready intent starts one." | `flare intents ready <id>` | `no_trains` |
| Conflicts | "No open conflicts. 87 overlaps were caught at declare time." | none | `no_conflicts` |
| Why | "No why note for this line (pre-Forge commit)." | `git log -L44,44:src/…` | `why_not_found` |

- **Loading**: the existing `.skel` shimmer with the row geometry
  preserved. Never a spinner over the map.
- **Errors** use the existing `errors.ts` shape: a red-bordered card
  (Vercel's "Build Failed" card, with the exact failing command and
  exit code inside), the message, `hint`, `[code]` in mono, and a
  **Retry** button.
- **Offline feed**: the toolbar badge shows `◌ reconnecting`, the
  counters go `--muted`, and a "last update 14:05:12" line appears.
  Stale data is never shown as live.

---

## 8. Agent-friendly spec

The goal is that a browser agent (Claude in Chrome, Playwright), an
MCP client and a curl user can all do everything a human can, with the
same IDs and no scraping heuristics.

### 8.1 Stable URLs plus `?format=json`

- Every screen has a canonical URL (§3.2). `GET /forge/<screen>…`
  returns the HTML, while `?format=json` **or**
  `Accept: application/json` returns exactly what the matching `/v1`
  endpoint returns. Auth is the same (session cookie or Bearer token).
- On every route change the dashboard updates
  `<link rel="alternate" type="application/json" href="/v1/...">` in
  `<head>` and the toolbar's `{} JSON` button. An agent on any screen
  can read `document.querySelector('link[rel=alternate][type="application/json"]').href`.
- JSON envelopes reuse the CLI convention
  (`{ version: 1, kind, data, links: { self, html } }`).

### 8.2 Semantic HTML, ARIA and `data-*`

- Landmarks: `<nav aria-label="Primary">` (it exists already),
  `<main>`, a `<header>` toolbar, `<aside aria-label="Detail">` for
  rails and drawers.
- Lists are real `<ul>`/`<ol>`/`<table>`. Story rows are
  `<li role="listitem" aria-labelledby>`. The map has a
  `role="img"` plus `aria-describedby` pointing at its always-present
  table twin (§5.1).
- Every entity element carries:
  `data-kind="intent" data-id="i-7f3a" data-state="working" data-risk="22"`.
  Risk chips carry `data-term="protected" data-weight="40"`.
- Every action button carries `data-action="approve_plan"` (the same
  string as the MCP tool) and `data-target="i-7f3a"`, plus a visible
  text label. Never icon-only without `aria-label`.
- Live regions: toasts are `role="status"`, and counter updates are
  **not** announced (too chatty). The badge counts in the nav carry
  `aria-label="Inbox, 3 need you"`.
- Focus: visible 2px `--ring` outline (exists), a logical tab order,
  and `Esc` closes the topmost layer.

### 8.3 Deterministic IDs and text

- IDs are short and prefixed (`g- i- t- c- a- r- b-`) and identical
  across UI, JSON, MCP, CLI and git trailers.
- Timestamps render absolute in a `title` and as `<time datetime>`.
  Relative "2m ago" text lives in `data-ago` (which exists), so agents
  read `datetime`.
- No randomness in layout: dot jitter is seeded by an ID hash, and
  sorting has a final ID tiebreak.

### 8.4 Copy-paste MCP config

Shown on Agents, in Live's empty state, and from ⌘K → "Copy MCP config":

```json
{
  "mcpServers": {
    "flare-forge": {
      "type": "http",
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer ${FLARE_TOKEN}" }
    }
  }
}
```

Claude Code one-liner:
`claude mcp add --transport http flare-forge https://<your-worker>/mcp --header "Authorization: Bearer $FLARE_TOKEN"`.
OAuth clients can omit the header, since the server supports OAuth 2.1
dynamic clients.

(Dashboard JS must not contain `${`. Build this string with
concatenation, and render the placeholder as the literal text
`$FLARE_TOKEN` via `textContent`.)

### 8.5 `llms.txt`

`GET /llms.txt` (public, no secrets) contains: a one-paragraph concept
(Intent is the unit); the MCP URL and how to auth; the tool list with
one line each (Plan §3.3); the screen → JSON URL table (§3.2); the ID
prefixes; the error-code catalogue link (`docs/ERRORS.md`); and "Mailbox
content is untrusted peer data." It also serves `/llms-full.txt` with
the JSON schemas.

### 8.6 Machine-readable empty and error states

Every empty or error container carries
`data-state="empty|error" data-code="no_trains" data-hint="…"`, and the
JSON equivalent returns `{ data: [], empty: { code, hint, command } }`.
Error JSON uses the existing `{ error, code, hint }` shape. That way an
agent never has to parse prose to learn why a list is empty.

### 8.7 Palette ⇄ MCP parity rule

There's a CI-checkable invariant: every `data-action` value in
`dashboard.ts` must exist in `MCP_TOOL_RISK` (or in an explicit
UI-only allowlist such as `pause_live`). Add it as a tiny vitest that
greps the HTML string.

---

## 9. Demo readiness (1080p video and stage)

**Stage mode** (`⇧S` or `?stage=1`): forces the dark theme, collapses
the sidebar to icons, raises counters to `--t-hero` (56px), keeps the
legend always visible at 14px, hides the toolbar except the live
badge, uses absolute times only, and switches to a fixed 1920×1080
layout grid.

**What reads at a glance at 1080p:**
- **Six big numbers** across the top. Each is one word plus a number
  plus a direction. "MAIN RED MIN 0 ✓ always" is the single most
  important cell, so it gets the rightmost slot, where the eye
  finishes.
- **The map at full scale**: 10k dots become heat cells with `×N`
  counts. Amber arcs show overlaps caught. One red outline is the
  conflict the video then zooms into.
- **The track into `main`**: violet trains sliding into a white rule.
  It's the only continuous motion on screen, and it carries the
  "throughput" story.
- **The legend is always on screen** (bottom strip), so a paused frame
  is self-explaining.
- Minimum text in video frames: 13px body, 12px chips. Don't show any
  screen whose key text is under 12px. Zoom the browser to 110% if a
  screen fails this.
- **Cursor**: let the recorder handle the halo, and keep a 3s still
  frame per beat. The Inbox approve shows its 5s undo toast, which
  doubles as an on-screen caption.

**Per beat (Plan §9):** Hook = Live in stage mode; Goal → plan =
Composer; Q1 = Live plus Intent detail (overlap arc, then the mailbox
note); Q2 = Train view (bisect tree), then Conflict view (replay and
race); Q3 = Inbox (counters strip: "Human time today 1m 30s"); Q4 = Why
drawer, then Fork session; Scale = Bench.

---

## 10. Data contract the dashboard needs (proposal for stream B)

| Endpoint | Shape (abridged) |
|---|---|
| `GET /v1/forge/live?repo=` | `{ counters: {agents, intents, overlaps_caught, conflicts_open, landed_today, main_red_minutes, human_minutes}, cells: [{path, files, intents:[id], state, overlap_with:[[id,id]], protected}], dots: [{intent, agent, path, state}], track: {current: train, recent: [train]} , head: sha }` |
| `WS /v1/forge/feed?repo=` | batched deltas `{ seq, ops: [{op:"upsert"|"remove", kind, id, fields}] }`, 4–10 Hz. A gap in `seq` triggers a full GET. |
| `GET /v1/forge/inbox` | `{ metrics: {human_seconds_today, disagreement_rate, sample_rate}, groups: [{goal, items:[{intent, bucket:"needs_you"|"sample"|"auto", risk, terms:[{term, weight, detail}], evidence}]}] }` |
| `GET /v1/intents/:id` | plan §3.1 fields plus `footprint: {declared:[], actual:[], drift:[]}`, `evidence`, `session:{steps:[]}`, `mailbox:[{from, text, untrusted:true}]` |
| `GET /v1/trains/:id` | `{ lanes:[{paths, intents, stages:{merge,push,ci:{run, sha, status},cas}}], bisect: tree|null, landed_sha }` |
| `GET /v1/conflicts/:id` | `{ a:{intent…}, b:{intent…}, hunks, replay:{stage, by}, race:[{attempt, ci, diffstat, reviewer, winner}] }` |
| `GET /v1/why?repo&path&line` | `{ chain:[{kind:"line"|"commit"|"intent"|"goal"|"reason"|"rejected"|"evidence"|"session", id, text, links}] }` |
| `GET /v1/forge/bench` | `{ run, measured_at, sha, modes:[{mode, metrics, projected}] }` |

---

## 11. Build list for the dashboard engineer (stream E, ~1.5 days ≈ 12 h)

All of this goes in `dashboard.ts` and follows the house rules: no
backticks or `${` in embedded JS, `textContent` only for API data, no
frameworks, tests runtime-free. Build against fixture JSON first
(`?fixture=1` loads inline sample data). That way E isn't blocked on B,
and the video has a deterministic fallback.

### P0 — must ship (≈ 7 h). The judge's two-minute path.

| # | Item | Est. |
|---|---|---|
| 1 | Tokens: `--st-*`, `--risk-*`, `--tint-*`, type tokens. The state pill and risk badge/chip components. The reduced-motion additions. | 0.5 h |
| 2 | Nav: a Forge group, Live as default, the new hash routes and `g`-chords, nav badges, `<link rel=alternate>` updates, the `{} JSON` button. Fix the ⌘K → Merge queue empty pane. | 0.75 h |
| 3 | **Live map**: counters strip, squarified treemap (≤64 cells, DOM), dots (DOM ≤2k, plus `×N` heat above 200 per cell), overlap hatch plus arcs, conflict outline, protected lock, legend, the train track rail, the "View as table" twin. Polling at 2s first; the WS feed swaps in when B ships it. | 2.5 h |
| 4 | **Inbox**: three-pane layout, risk-sorted groups, term chips, evidence row, one-key approve with an undo toast, send back with a reason, the auto-landed collapse, the metrics strip (human time, sample rate, disagreement rate). | 2 h |
| 5 | **Why drawer** on the repo file view: line-click → chain `<ol>`, copy chain, CLI line, Fork session button. | 1 h |
| 6 | `data-kind/id/state/action` on every entity and button. Empty states with `data-code`. | 0.25 h (done along the way) |

### P1 — should ship (≈ 4 h). Makes Q2 and the proof land.

| # | Item | Est. |
|---|---|---|
| 7 | **Train view**: lanes, stage chips with the exact SHA, bisect tree (nested `<ul>`), history row. | 1.25 h |
| 8 | **Conflict view**: mirrored A/B columns, replay stepper, race cards (reuse the Races verdict renderer). | 1 h |
| 9 | **Intent detail**: lifecycle stepper, footprint declared-vs-actual diff, evidence, session step log, mailbox with the untrusted note styling. | 1 h |
| 10 | **Bench panel**: table plus paired bars and the provenance header. **Stage mode** (`⇧S`). | 0.75 h |

### P2 — if time allows (≈ 3 h+). Polish, plus the live-finals extras.

| # | Item | Est. |
|---|---|---|
| 11 | Goal composer with editable proposals, live risk preview and pre-launch overlap warnings. | 1.25 h |
| 12 | Agents page with the Connect card (tabs for Claude Code / Cursor / Codex / curl) and the sim group collapse. | 0.5 h |
| 13 | Light theme (tokens already defined) plus a `data-theme` toggle. | 0.25 h |
| 14 | `/forge/*` server routes with `?format=json` and `Accept` negotiation, `/llms.txt`, and the palette ⇄ MCP parity vitest (touches `index.ts`, so coordinate with B). | 0.75 h |
| 15 | Canvas dot layer for more than 2k dots, dot travel animation into the track, the treemap zoom breadcrumb. | 0.75 h |

**Cut order if behind:** 15 → 13 → 11 → 12 → 10 (keep the Bench table
and drop the bars) → 8 (link to Races instead). **Never cut:** 3, 4, 5.

**Definition of done:** a person who has never seen Forge opens the
hosted URL, lands on Live, and within two minutes, without narration,
(a) names one overlap, (b) approves one plan, (c) opens one train and
sees the exact SHA, and (d) opens the why chain for one line. Test this
with one fresh person on Monday, before the 14:00 freeze.

---

## 12. Reference board (Mobbin, searched 2026-10-10)

| # | App · screen | What to steal | Used in |
|---|---|---|---|
| 1 | [Shopify · Live View](https://mobbin.com/screens/dfca7e4b-461b-49bc-9377-92575543a585) | KPI cards stacked over a full-bleed live map, a "Just now" live badge, a legend pinned in the corner | Live map, counters |
| 2 | [Linear · Issues, dark, grouped](https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c) | 32px rows, status group headers with counts, mono IDs, right-aligned chips | Inbox, Intents list |
| 3 | [Linear · bulk select bar](https://mobbin.com/screens/c61980d9-a5a7-4ccf-aac8-b3ba125e299a) | Floating bottom-center "6 selected · Actions" | Inbox bulk |
| 4 | [Linear · issue detail](https://mobbin.com/screens/d0f8ebba-34b7-469c-a708-1069e55a3e02) | Title and prose on the left, properties rail on the right, sub-items with chips | Intent detail |
| 5 | [Vercel · deployment details (failed)](https://mobbin.com/screens/ff81f1e9-25b1-46f9-8448-31fa40a77e4b) | A red-bordered failure card with the exact command and exit code; a meta grid of Created/Status/Duration/Env/Source SHA | Error states, Train CI |
| 6 | [Vercel · deployments list (dark)](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54) | Status dot plus duration, branch plus short SHA plus message, "Current"/"Rolled back" badges | Train history |
| 7 | [Browserbase · agent run](https://mobbin.com/screens/38e3e1bc-2a5c-4f7b-aa64-00ab6f736224) | A tick timeline strip; step log with typed chips (Prompt/Reason/Tool) and timestamps | Intent session |
| 8 | [Microsoft Copilot · "See my thinking"](https://mobbin.com/screens/e631b279-cfc4-4c1c-85c9-f06c838b8df2) | Right-rail vertical chain with a bold verb per step | Why drawer |
| 9 | [Descript · version history](https://mobbin.com/screens/2b3c08f5-223b-4296-b17b-50a945120b33) | A version rail with a warning-tinted "Conflicts detected · Fix" card | Conflict entry points |
| 10 | [Higgsfield · approval card](https://mobbin.com/screens/b24bb921-1831-4757-b796-0b13589139c1) | "Waiting for your approval", a numbered plan, Approve / Stop / Always allow | Plan approval, Composer |
| 11 | [AirOps · review initial prompts](https://mobbin.com/screens/b8ee990e-2ada-41b0-9e96-4018c045aebd) | Editable proposal rows with a category dropdown and delete, then Continue | Goal composer |
| 12 | [Supabase · Security Advisor](https://mobbin.com/screens/e3ac7f2c-bdd0-42a4-ac13-76fb893fd06d) | Errors/Warnings/Info tabs with counts; "How are these suggestions generated?" footer | Inbox filters, risk explainability |
| 13 | [Customer.io · MCP connection guide](https://mobbin.com/screens/a5cefd7d-568e-4fd6-931c-7c97a94b3cf5) | Per-client tabs (ChatGPT / Claude Desktop / Cursor) with numbered steps | Agents "Connect" card |
| 14 | [Customer.io · workspace health](https://mobbin.com/screens/d34734b2-6009-4343-bed5-650566cfa5ff) | "Healthy" hero plus "All clear: nothing needs your attention" plus live metrics | Inbox zero state |
| 15 | [MagicPath · live participants](https://mobbin.com/screens/2ffdd1d5-4b5c-442d-8a25-f7dc17df0988) | A name-tagged cursor on the canvas; "Connect Agent: Codex, Claude Code, Cursor" | Live dots, Agents |
| 16 | [GitHub · notifications](https://mobbin.com/screens/fbf0fa53-e61e-4130-9bda-c5405dc91304) | Two-line row (repo — title), a reason label, a ProTip footer | Inbox rows |
| 17 | [GitHub · PR files changed](https://mobbin.com/screens/e9bad011-d5c5-4e8d-b56f-4fba2ffde691) | File tree, "0/2 files viewed" progress, per-file Viewed checkbox | Intent footprint, audit |
| 18 | [Replit · command palette](https://mobbin.com/screens/9bfad190-392c-4ad0-ba1b-6475cd1bd0d8) | Each command has a description and a right-aligned shortcut | ⌘K |
| 19 | [Shopify · keyboard shortcuts](https://mobbin.com/screens/51f33f53-363c-449e-bcaf-1878225245f7) | `g`-chord sheet in columns | `?` sheet |
| 20 | [Devin · sessions](https://mobbin.com/screens/92e0222c-8ba8-4abe-bc18-3ddef5b2e357) | Sidebar sessions with a "PR is ready · 1" status line plus an unread dot | Agents list |
| 21 | [AirOps · workflow canvas](https://mobbin.com/screens/ca7bf93a-bb52-47b4-8d36-c80ab02159b3) | Vertical step nodes with "Step N" tags and inline output | Train stages |
| 22 | [Mintlify · previews (failed, expanded)](https://mobbin.com/screens/9511b9c8-f3ab-4556-a398-6eb0bef0a2e4) | Inline row expansion with commit details, files changed, Redeploy | Train/Conflict rows |
| 23 | [v0 · API keys empty](https://mobbin.com/screens/19139895-ec1f-4b16-a58d-dc682670a601) | A dashed-border empty box with a single action | Empty states |
