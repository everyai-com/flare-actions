# Cognitive load budget

> Provenance: agent-drafted (2026-10-10). The rules below are
> enforced in part by `apps/worker/src/ux-budget.test.ts`; the rest are
> review rules.

Flare should be usable by a 10-year-old. Every screen in **Simple mode**
(the default for people) spends from a fixed budget. A screen that goes
over the budget must move things behind "Show more" or into **Pro mode**.

## The budget, per screen

| Item | Budget | Why |
|---|---|---|
| Jobs | **1**. The screen answers one question ("Is my code OK?") | One screen, one thing |
| Primary button | **≤ 1**, and it is the next move | No choosing between two big buttons |
| Other buttons/links | **≤ 3** visible before "Show more" | Choices cost attention |
| Numbers | **≤ 3** visible | Kids (and adults) read 3 numbers, not 6 |
| Headline | **≤ 6 words** | Readable at a glance |
| Any sentence | **≤ 15 words**, everyday words | No re-reading |
| Nav items | **≤ 5** in Simple mode | Fits in working memory |
| New words | **0** jargon without a plain label (table below) | Nothing to look up |
| State | Always shown as colour **and** icon **and** words | Works for colour-blind readers and skimmers |

## Plain words (Simple mode labels)

| Pro word | Simple word |
|---|---|
| Run / pipeline / job | Check |
| Runner / executor / seat | Computer |
| Intent | Plan |
| Footprint | Files it will touch |
| Overlap | Two agents on the same files |
| Conflict | Clash |
| Train | Landing |
| Trunk / main | The main version |
| Dispatch | Start |
| Repository | Project |
| Fixture / demo data | Pretend data |

Pro mode keeps the precise words. The `data-*` attributes and the API
keep the precise names, so agents never depend on display text.

## Game rules

Setup and daily use borrow from games because games teach without
manuals:

1. **One quest at a time.** Setup is a short quest line (levels 1-5).
   Only the current level is open; finished levels collapse to a star.
2. **Always a next move.** Every screen ends in exactly one obvious
   action: the primary button.
3. **Instant feedback.** Every click answers within 100 ms (a toast,
   a state change, or a spinner with words).
4. **Celebrate wins.** First green check, a new level, a green streak.
   Confetti respects `prefers-reduced-motion`.
5. **Streaks and badges, not scores.** "🔥 5 green in a row" and a few
   badges ("First green check", "Agent connected"). Never a leaderboard
   that shames.
6. **Safe to explore.** Pretend-data demo mode, undo where possible, no
   destructive action without a second click.

## Modes

- **Simple** (default): the budget applies. Five nav items: Home,
  Checks, Agents, Projects, Settings. Everything else is under "More".
- **Pro**: today's full dashboard, every screen and number. The switch
  lives in the side bar footer and is remembered per browser.
- Visitors on `?demo=1` get Simple mode plus the guided tour.
