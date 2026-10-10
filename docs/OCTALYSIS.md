# Octalysis design for Flare

> Provenance: agent-drafted (2026-10-10) from Yu-kai Chou's published
> Octalysis material (yukaichou.com, *Actionable Gamification*); sources
> at the end. Companion to [UX-BUDGET.md](UX-BUDGET.md), which caps how
> much any screen may ask of a person. This file decides *why* someone
> moves forward and *where* they go next.

## The framework in one minute

Octalysis says people act because of eight **core drives (CD)**:

| # | Core drive | Side | Hat |
|---|---|---|---|
| CD1 | Epic Meaning & Calling | — | White |
| CD2 | Development & Accomplishment | Left (extrinsic) | White |
| CD3 | Empowerment of Creativity & Feedback | Right (intrinsic) | White |
| CD4 | Ownership & Possession | Left | — |
| CD5 | Social Influence & Relatedness | Right | — |
| CD6 | Scarcity & Impatience | Left | Black |
| CD7 | Unpredictability & Curiosity | Right | Black |
| CD8 | Loss & Avoidance | — | Black |

- **White hat** (CD1-3) makes people feel powerful and in control.
  **Black hat** (CD6-8) creates urgency, and burns people out if
  overused.
- **Left brain** (CD2, 4, 6) is extrinsic: people want the reward.
  **Right brain** (CD3, 5, 7) is intrinsic: the activity is its own
  reward. Rewards alone backfire: when they stop, motivation drops
  below where it started (the overjustification effect).
- Motivation changes across **four experience phases**: Discovery
  (hear about it → sign up), Onboarding (learn the rules → first win),
  Scaffolding (daily use, habits, mastery), Endgame (has done
  everything; why stay?).

## Flare's rules

1. **White hat first.** Every screen leads with CD1-3. Black hat drives
   only reflect *real* stakes: a broken main branch, a check waiting for
   a computer. No fake countdowns, no fake scarcity, no guilt copy.
2. **Intrinsic over extrinsic.** Stars and streaks mark real progress
   (a green check is the reward). They never replace it.
3. **One next move, always.** A single "next move" engine (below) picks
   the one action shown as the primary button, on Home and in the side
   bar.
4. **Phases, not pages.** Each phase has its own goal and its own
   drives. The UI knows which phase a person is in and shows only that
   phase's job.

## Phase by phase (people)

### 1. Discovery: a stranger hears about Flare
Goal: "I get it, and I want it." Ends at sign-up.

| Drive | What Flare does |
|---|---|
| CD1 Meaning | One line: "Your AI agents work together without breaking each other's code." |
| CD7 Curiosity | The live demo with a moving board and the 4-step tour. No sign-in. |
| CD5 Social | "Open source" and the GitHub link; "built for Claude Code, Codex, Cursor". |
| CD3 Feedback | Demo clicks respond instantly with pretend data. |

Where they land: the README → the **live demo** (`?demo=1&tour=1`) →
"Get Flare on GitHub" / "Make your account".

### 2. Onboarding: learn the rules, win once
Goal: first green check. Ends when they can continue on their own.

| Drive | What Flare does |
|---|---|
| CD2 Accomplishment | Quest line, Level 1-5 with stars: account → GitHub → project → first check → green. Only the current level is open. |
| CD3 Feedback | Every step answers instantly; the check shows live while running. |
| CD4 Ownership | "Your Flare", "your project": their repo name everywhere once picked. |
| CD8 Loss (real only) | "Your checks need a computer" when jobs are queued with no runner, with the one-command fix. |
| CD1 Meaning | Level 5 completion: confetti + "Flare now checks every change you push." |

Where they go: Home always shows the current level's one button. They
never need the menu during onboarding.

### 3. Scaffolding: daily use
Goal: "Is my code OK? Are my agents OK?" in one glance, then back to work.

| Drive | What Flare does |
|---|---|
| CD2 Accomplishment | Green streak ("🔥 7 green in a row"); badges for real milestones. |
| CD3 Feedback | Health screen: ✅ / ❌ / ⏳ with the one fix; "What broke" first on a failed check. |
| CD5 Social | Agents board: who is working on what; "Two agents want the same file — caught early". Invite a teammate. |
| CD7 Curiosity | Live board animates when plans land or clashes are caught; agent races. |
| CD8 Loss (real only) | "Main is broken" and "streak ends if this stays red" only when true. |
| CD6 Impatience (real only) | "Waiting for a computer · 2 checks queued" with time waited. |

Where they go: Home (health) → the failing check → "What broke" → fix
→ green. Agents board for multi-agent repos. Inbox only when something
needs them (badge count).

### 4. Endgame: the expert
Goal: they've done it all; Flare stays worth it and they bring others.

| Drive | What Flare does |
|---|---|
| CD1 Meaning | "Flare everywhere": every repo and agent on their machines (`forge init --global`). |
| CD4 Ownership | Pro mode, budgets, schedules, their own runners, many projects. |
| CD5 Social | Invite teammates; share the demo link; badges for helping (first invite). |
| CD3 Creativity | Agent races, custom checks, flare.yml profiles. |

Where they go: Settings → "Flare everywhere"; Pro mode toggle; More menu.

## The next-move engine

One function decides the single primary action. The first rule that
matches wins:

| # | Condition | Next move (button) | Phase |
|---|---|---|---|
| 1 | Not signed in | "Make your account" (demo link secondary) | Discovery |
| 2 | GitHub not connected | "Connect GitHub" | Onboarding |
| 3 | No project picked | "Pick a project" | Onboarding |
| 4 | Checks queued, no computer | "Use my computer" | Onboarding / Scaffolding |
| 5 | No check yet | "Run your first check" | Onboarding |
| 6 | Newest check broke | "See what broke" | Scaffolding |
| 7 | Inbox has items | "Review N waiting" | Scaffolding |
| 8 | Check running | "Watch it run" | Scaffolding |
| 9 | All green, no agent ever connected | "Connect an AI agent" | Scaffolding → Endgame |
| 10 | All green, no teammate | "Invite a teammate" | Endgame |
| 11 | Otherwise | "Run a check" | Scaffolding |

The engine shows the same answer on Home (big) and as a "Next:" chip in
the side bar, so people can go anywhere and still find the way back.

## Agents are players too

Agents have the same four phases. Their "UI" is text, so the drives
appear as clear win-states and next steps rather than visuals:

| Phase | Agent surface | Drives |
|---|---|---|
| Discovery | `/llms.txt`, global CLAUDE.md block, skills | CD1: what Flare is for; CD3: one copy-paste prompt |
| Onboarding | `doctor`, MCP `instructions`, `forge init` | CD2: ✓/✗ checklist with the fix; CD3: instant results |
| Scaffolding | `run_and_wait` → digest, Forge loop | CD3: digest says exactly what broke; CD5: `whats_happening`, peer notes; CD8: overlaps flagged before editing |
| Endgame | `nextSteps` on every result, `why` | CD2: every result names the next tool; CD1: `why` ties each line to a goal |

Rule: every agent-facing response ends in a next step (`nextSteps`, a
`hint`, or a `fix:` line), the agent version of "one next move".

## Guardrails

- Never use CD6-8 to keep someone in the product. Use them only to
  surface a real problem with its fix.
- Respect `prefers-reduced-motion`; celebrations are optional to see and
  never block.
- No leaderboards between people. Streaks and badges are personal.
- Pro mode is a choice, not a reward. Nothing useful is locked behind
  "levels".

## Sources

- [Octalysis: Yu-kai Chou's gamification framework](https://foundersnetwork.com/octalysis-startup-gamification-framework/)
- [The ultimate guide to gamification](https://yukaichou.com/the-ultimate-guide-to-gamification-past-present-and-future/)
- [Gamification design: 4 phases of a player's journey](https://www.yukaichou.com/gamification-examples/experience-phases-game/)
- [Discovery phase](https://yukaichou.com/gamification-study/gamification-discovery-phase/)
- [Creating intrinsic motivation with Octalysis](https://yukaichou.com/gamification-study/create-intrinsic-motivation-octalysis-gamification/)
- [Actionable Gamification, ch. 3](https://leanpub.com/read/actionable-gamification-beyond-points-badges-leaderboards/leanpub-auto-chapter-3-the-octalysis-framework)
