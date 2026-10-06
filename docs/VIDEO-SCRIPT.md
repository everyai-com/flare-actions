# Tournament video shot script (5–10 min)

Record against a staging preview with the dashboard open side-by-side
with a terminal. One harness run is the whole demo (~3–4 min wall).
Rehearse once with `KEEP=1` to pre-warm seats, then record fresh.

## Act 1 — the race (0:00–1:00, no architecture yet)

1. Terminal: `npm run harness` (env already exported). Say: one task,
   three agents, isolated forks.
2. Dashboard Tournaments tab: board appears, three claims land. Point:
   every claim is a real fork (`t-<id>-alpha/beta/gamma`).
3. Terminal: `pushed alpha … beta … gamma …` — concurrent pushes.

The tournament idea must land before minute one ends.

## Act 2 — review at scale (1:00–4:00)

4. Ticks: `d=3` — three verification runs dispatched, all `verifying`.
   Say: every attempt runs real CI, not vibes.
5. `[terminal] alpha run success / gamma run failure / beta run success`
   — the red one is the point: verification caught it.
6. Collisions: `alpha x beta: greeting.txt`. Say: file-level overlap
   radar, honest scope, no semantic oversell.
7. Verdict row: `Winner: alpha.` + two-sentence Why. Say: ranking is
   deterministic (status, failing tests); AI writes the justification.
8. `promoted main -> <sha>` + `source main == alpha head`. Say: the
   winner actually landed on the branch, from the Worker.
9. MCP once: `tournament_why` in the client — winner + rationale +
   collisions, no log spelunking.
10. Scroll the ledger top to bottom: opened → claimed → pushed →
    terminal → collision → verdict → resolved → promoted.

## Act 3 — how it works (4:00–6:00, hard stop ≤10:00)

11. One breath: push events → queue → container seats → verdict;
    seats scale to zero, queue fans out. No unproven numbers.
12. Where to run it: repo link, `docs/TOURNAMENTS.md`, MIT.

## Submission checklist

- [ ] Video 5–10 min, race → review → decision arc on screen
- [ ] Multi-agent concurrency undeniable in Act 1
- [ ] Radar + verdict + promote all visible (Act 2)
- [ ] MIT source link in description
- [ ] Run/try instructions (`docs/TOURNAMENTS.md`) verified cold
- [ ] Nothing claimed that isn't shown
- [ ] Submit at cloudflare.com/git-competition (Day-8 morning)
