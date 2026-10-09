# Tournament video script (Cloudflare git competition)

The entry is verified demo-ready: `npm run harness` went green
3-in-a-row on the `try-tournaments` preview on Oct 9 (race → verify
→ collision → verdict → promote → ledger, 13 checks each) running
current `main` incl. Waves 0–6. Two deploy blockers found and fixed
during the refresh (entry-module value export, schema index
ordering) — the preview self-healed on first request. Record
against the live preview:

- Board: https://try-tournaments-flare-actions.everyai-com.workers.dev/dashboard
  (Tournaments tab; admin token in `/tmp/tour-token.txt` if the session asks)
- Re-run the race live while recording (same command as CI):
  `HARNESS_URL="https://try-tournaments-flare-actions.everyai-com.workers.dev" HARNESS_ADMIN_TOKEN="$(cat /tmp/tour-token.txt)" npm run harness`

## Shots (~3 minutes)

1. **Hook (0:00–0:20)** — dashboard Tournaments tab, empty board.
   "Three agents, one task, one winner — verified by real CI, not vibes."
2. **Fork (0:20–0:50)** — run the harness; show three Artifacts forks
   appear on the board (alpha / beta / gamma).
3. **Verify (0:50–1:30)** — attempts tick to terminal: two green, one
   red. "Every attempt runs the actual pipeline on managed seats."
4. **Radar (1:30–2:00)** — collision radar lights up: all three touched
   `greeting.txt`. "The radar shows who stepped on whom."
5. **Verdict (2:00–2:30)** — AI verdict names alpha with rationale;
   winner fast-forwards onto main. Scroll the immutable ledger.
6. **Close (2:30–3:00)** — ledger close-up. "Every decision recorded.
   Flare Tournaments — agent races you can audit."

## Submit checklist (due Oct 14)

- [ ] Pre-flight: one more `npm run harness` green on the morning of
  recording (same env as above); seats warm (`KEEP=1` rehearsal).
- [ ] Record the shots above (~3 min) against the live preview board.
- [ ] Submit at the competition page: video + repo link
  (`https://github.com/everyai-com/flare-actions`) before Oct 14.
- [ ] Confirm the submission renders (video plays, link resolves).
- [ ] After the deadline: tear down the preview
  (`npx wrangler preview delete --name try-tournaments`).
  and `git branch -D try-tournaments` (the branch carries no unique commits).
