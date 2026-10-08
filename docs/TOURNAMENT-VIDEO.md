# Tournament video script (Cloudflare git competition)

The entry is verified demo-ready: `npm run harness` went green on the
`try-tournaments` preview on Oct 8 (race → verify → collision → verdict
→ promote → ledger, 12 checks). Record against the live preview:

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

## After recording

- Submit the video + repo link at the competition page before Oct 14.
- Tear down the preview: `npx wrangler preview delete --name try-tournaments`
  and `git branch -D try-tournaments` (the branch carries no unique commits).
