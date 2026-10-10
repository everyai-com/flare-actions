# Flare Forge demo runbook

> Provenance: agent-drafted 2026-10-10 (demo stream). Verified offline
> only: `node scripts/forge-demo.mjs --dry-run`, `npm run forge:agents
> -- --mode scripted|real --dry-run`, `npm run forge:director -- list`
> and `stage 3 --dry-run`, the lib tests (`npx vitest run
> scripts/forge-demo-lib.test.mjs`), and a trunk push to a local bare
> repo (main + 4 lane refs + `refs/notes/why`, 30 files, no `agents/`,
> `seed/` or `scripts/`, trunk tests green). Nothing here has been run
> against a deployed Worker or Artifacts yet. Timings below are targets,
> not measurements.

Three commands take a fresh Flare deploy to a live demo of Forge:
many agents changing one repo at once. Overlaps show up before any
code is written, conflicts get replayed, CI-verified trains land the
work, and every landed line can say why it exists.

| Command | What it does |
|---|---|
| `npm run forge:demo` | Creates the **Bookshelf** trunk in Artifacts and seeds 3 goals. One command. Safe to re-run. |
| `npm run forge:agents -- --mode scripted` | A deterministic swarm (no LLM). It plays every designed beat: two overlaps, one real conflict and its replay, one semantic break, one protected path. |
| `npm run forge:agents -- --mode real` | N headless Claude Code agents doing the same work for real. |
| `npm run forge:director -- stage <n>` | Moves the deployed demo to the state for video beat *n*. Used for recording and for the finals. |

All three read `FLARE_ACTIONS_URL` and `RUNNER_TOKEN` from the
environment or the repo `.env`, the same way the CLI does. Every one
takes `--dry-run`, which prints the plan and touches nothing, and
`--repo <name>` (default `bookshelf`).

---

## Watch it live (no install, no login)

> Provenance: agent-drafted 2026-10-10 (spectator stream), URLs are
> placeholders until staging is live. Mechanics: docs/FORGE.md
> "Spectator mode".

**1. Watch the swarm.** Open **`https://<WORKER_URL>/watch`**. That is
the real live map of the public `bookshelf` repo, read-only. A scripted
crew of 6 agents works the 3 Bookshelf goals on a loop of about 30
minutes:
- intents appear and overlaps light up
- one agent drifts outside its footprint
- the `logging.ts` conflict is replayed
- CI-verified trains land the work
- one protected change waits in the inbox for a human

Then the repo resets and it starts again.

**2. Ask your own Claude Code about it** (one line, no token):

```sh
claude mcp add --transport http flare-forge-watch https://<WORKER_URL>/v1/public/forge/mcp
```

Then ask:
- *"What are the agents doing in bookshelf right now?"*
- *"Why does line 12 of src/middleware/logging.ts exist?"* (the answer
  traces line → commit → intent → goal → reasoning)
- *"What in bookshelf needs a human?"*

**3. Join the swarm** (optional, needs a token from us). Ask
`<CONTACT>` for a judge token. It is a runner token pinned to the
`bookshelf-sandbox` repo, and it expires after 7 days. Then:

```sh
claude mcp add --transport http flare-forge https://<WORKER_URL>/mcp \
  --header "Authorization: Bearer <judge token>"
```

Your agent can then declare intents, claim a fork, push, and land
through a train, exactly as in section A, without deploying anything.

For operators, two pieces keep this running:
- **The public repo.** `POST /v1/admin/forge/public {"repos":["bookshelf"]}`
  designates it.
- **The loop.** `apps/sim` `POST /demo-loop/start` keeps the swarm
  moving.

Mint judge tokens with `POST /v1/admin/forge/judge-token`. The setup
steps and the threat model are in docs/FORGE.md "Spectator mode".

---

## A. Judges: try it on a fresh account (~15 min)

Short on time? The README's "Try it in 2 minutes" is the fast path:
the hosted spectator view, or `npm run dev` and
`http://localhost:8787/dashboard?demo=1#/live` for the designed
scenario on demo data, no sign-in. This section runs the real thing on
your own account.

**You need:** Node 22.18 or newer, git, a Cloudflare account, and
`npx wrangler login` done once. Optional: Docker, which lets setup
provision managed seats so train CI runs without your laptop.

1. **Deploy and configure.**

   ```sh
   git clone https://github.com/everyai-com/flare-actions && cd flare-actions
   npm install
   npm run setup        # D1, queues, R2, Artifacts namespace, deploy, writes .env
   ```

   Open `https://<your-flare>.workers.dev/dashboard` and make your
   account. The first person to sign up becomes the owner.

2. **Give trains a computer.** Trains run `flare.yml` on the exact
   merged SHA. If setup provisioned seats, skip this step. Otherwise go
   to dashboard Home, click **Use my computer**, and paste the one line
   it shows:

   ```sh
   curl -fsSL https://<your-flare>.workers.dev/runner.sh | sh -s <PAIR-CODE>
   ```

3. **Create the demo trunk and goals.**

   ```sh
   npm run forge:demo
   ```

   It prints two links. Open the first one:

   ```
   dashboard (live map): https://<your-flare>.workers.dev/#/live?repo=bookshelf
   dashboard (inbox):    https://<your-flare>.workers.dev/#/inbox?repo=bookshelf
   ```

   What it did:
   - Created the Artifacts repo `bookshelf` in the Worker's namespace
     (`ARTIFACTS_NAMESPACE`, from `wrangler.jsonc`).
   - Pushed `examples/forge-demo` to it. It left out `agents/`, `seed/`
     and `scripts/`, so agents never see the reference solutions.
   - Pre-created `forge/lane-0..31` and `refs/notes/why` with the git
     CLI.
   - Recorded the three goals from `examples/forge-demo/seed/goals.json`.

   Re-running it reuses everything that already exists.

4. **Watch a swarm.**

   ```sh
   npm run forge:agents -- --mode scripted --count 6
   ```

   Six agents work through all 13 intents. The terminal table shows
   agent → intent → state, and the live map moves at the same time.
   Things to watch for:
   - `OVERLAP` on `src/index.ts` and on `src/middleware/logging.ts`.
     Each overlap sends a note to the other intent's owner.
   - The train cut into lanes, a red lane, and bisect isolating the
     page-size pair.
   - The resolver claiming the `logging.ts` conflict and replaying
     `g3-log-latency` on top of `g1-request-id`.
   - `g3-api-key-rotation` stopping at `awaiting_plan`. Approve it in
     the inbox.

   Logs go to `/tmp/forge-agents/<run>/`.

5. **Bring a real agent.** You can run Claude Code headless:

   ```sh
   npm run forge:agents -- --mode real --count 3 --goal g1 --budget 2
   ```

   Or connect your own agent:

   ```sh
   npm run cli -- forge connect-agent --client claude   # prints `claude mcp add ...` + the workflow prompt
   ```

   Then ask it something like: *"Bookshelf goal g1: pick an unclaimed
   intent and land it."*

### What `--mode real` runs

For each agent, `forge:agents` creates `/tmp/forge-agents/<run>/<agent>/`
and puts these files in it:

- `mcp.json`, which points at `<worker>/mcp`. The token is not in the
  file. Claude Code expands `${FLARE_TOKEN}` from the agent's
  environment.
- A `bin/flare` shim for the repo CLI.

It then runs:

```sh
claude -p "<task>" --mcp-config mcp.json --strict-mcp-config \
  --permission-mode dontAsk --allowedTools mcp__flare-forge Read Edit Write Glob Grep \
  "Bash(git:*)" "Bash(node:*)" "Bash(flare:*)" ... \
  --output-format stream-json --verbose --append-system-prompt "<FORGE_AGENT_PROMPT + skills/flare-forge/SKILL.md>"
```

`dontAsk` denies anything outside the allow-list instead of prompting.
An unattended agent can't hang on a prompt or run arbitrary shell
commands.

Each agent gets a target intent from the goal, assigned round-robin.
It is told which intents the others hold. It:

1. declares the intent, or reuses it if it's already declared
2. claims and clones with `flare forge claim <id> --clone work`, so the
   fork token never appears in a command
3. runs the accept command
4. commits with the trailers
5. runs `flare forge push`
6. runs `flare forge ready`

Use `--model` and `--budget <usd per agent>` to bound cost.
`stream.jsonl` and `stderr.log` sit next to each agent's
`mcp.json`.

### Scripted mode flags

| Flag | Meaning |
|---|---|
| `--count N` | Size of the agent pool. Intents are assigned round-robin in the designed order, so the first six agents always cover both overlaps and the semantic pair. |
| `--goal g1` | Work only one goal's intents. `g1`, `g-1` and `1` all work. |
| `--intents a,b` / `--exclude a,b` | Choose exact seeded intents. |
| `--until declared\|claimed\|pushed\|ready` | Stop each agent mid-work (the director uses this). |
| `--pace ms` | Delay between steps so the map is watchable. The default is 800. Use 0 for speed. |
| `--drift <intent>` | That agent also edits `README.md`, which is undeclared. A drift alert fires on push. |
| `--approve` | Approve protected plans. Needs `FLARE_ADMIN_TOKEN`. |
| `--no-resolve` / `--wait s` | Turn off the scripted conflict resolver, or set how long it waits for the conflict. The default is 900 s. |

The resolver needs `wrangler login`. It gets a 10-minute read token
for the trunk so it can re-derive on the new `main`. Agents never get
a trunk token. The resolver's replay is a force-push to intent b's own
fork, never to trunk.

---

## B. Recording the video (COMPETITION-PLAN.md §9)

The director drives the real API and the scripted agents. It never
writes to the database.

- `stage n` continues from the last stage it completed. That progress
  is saved in `~/.flare/forge-demo/<repo>.json`.
- Asking for a stage at or before the current one, or passing
  `--fresh`, resets first.
- `reset` does three things:
  - abandons every live intent in the repo
  - deletes its fork repos (`i-*`, `r-<conflict>-*`, `s-<intent>-*`)
  - recreates the trunk with its lanes and notes

  Goals are reused by their text, so resets don't add duplicate
  stories.

Set `FLARE_ADMIN_TOKEN` (an admin API token from the dashboard Access
tab) before recording. Without it, the director can't approve the
protected plan or abandon other agents' intents. Run
`npm run forge:director -- list` for the table.

| Stage | Beat | Command | Have on screen |
|---|---|---|---|
| 1 | 1:15 Goal → plan | `forge:director -- stage 1 --fresh` | `#/intents?repo=bookshelf`: 3 goals, 7 declared intents, `g3-api-key-rotation` at **awaiting_plan**. Click approve on camera, or leave it for stage 5. To show the AI planner, add `--plan`. |
| 2 | 2:00 Q1 awareness | `forge:director -- stage 2` | `#/live`. Six agents declare live, so the overlap banners appear: metrics × rate-limit on `src/index.ts`, request-id × log-latency on `logging.ts`. You'll also see the notes and the drift alert on `g2-default-page-size` (`README.md`). Nobody is ready yet. |
| 3 | 3:15 Q2 trains | `forge:director -- stage 3` | `#/trains`. The 6 from stage 2 plus 6 more intents become ready. One train runs parallel lanes. The page-size pair turns a lane red, and the director waits until a bisect child train exists. |
| 4 | 3:15 Q2 conflicts | `forge:director -- stage 4` | `#/conflicts`. The `logging.ts` conflict opens. The resolver claims it, replays `g3-log-latency` on `g1-request-id` (both `requestId` and `durationMs`) and resolves. The replay rides the next train. |
| 5 | 4:45 Q3 review | `forge:director -- stage 5` | `#/inbox`. Trains have settled. The protected intent is approved and pushed, so one item needs a human. The stories are grouped by goal. |
| 6 | 5:45 Q4 why | `forge:director -- stage 6` | The director prints the `why` chain for the landed `logging.ts` line, plus the `#/why?...` deep link. Click through to fork session. |

**Tips**

- Record each beat as its own clip. To redo a beat, run `stage n`
  again: it resets and replays 1..n.
- Stages 3–5 wait on real CI. Pre-warm the runner or seats, and use
  `--timeout` (default 900 s) to bound each wait.
- `--pace 1500` makes stage 2 easier to follow on camera. Use
  `--plain` for log lines instead of the redrawn table, which is nicer
  for terminal capture.
- Use `--dry-run` on any stage to see exactly what it will do.

---

## C. Finals (COMPETITION-PLAN.md §10)

**Before going on stage**

1. `npm run forge:director -- stage 1 --fresh` on the hosted instance.
2. Do a dry run of stages 2–6 once, then `stage 1 --fresh` again.
3. Keep the per-beat clips from section B on local disk.
4. Keep a phone hotspot ready.

**Live run.** Run one director stage per beat. If a beat stalls (CI is
slow, or the network drops):

1. **Re-run the stage.** `stage n` resets and replays up to *n*. Stage
   1–2 take seconds; 3+ depend on CI.
2. **Skip ahead.** `stage n+1` continues from wherever the deploy
   actually is. The dashboard shows the true state.
3. **Play the clip** for that beat from disk and keep talking. Cuts are
   fine; fakes are not.

**The live-only moment.** A judge's Claude Code (or ours) joins the
swarm:

```sh
npx flare-forge forge connect-agent --client claude --agent judge   # no clone needed
# from a clone: npm run cli -- forge connect-agent --client claude --agent judge
```

Paste the one-line `claude mcp add ...` it prints and give the agent
the Bookshelf goal. It shows up on `#/live` next to the scripted
agents.

**If Artifacts or the network is down**, show the simulator from
`docs/FORGE-BENCH.md`. It is deterministic and offline:

```sh
npm run forge:bench -- --agents 1000,10000 --seed 7
```

Also show the designed scenarios proved with plain git:

```sh
cd examples/forge-demo && node scripts/verify-scenarios.mjs
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `forge API check failed` | The deploy predates Forge. Pull and run `npm run setup` again. |
| `could not learn the repo's git remote` | Pass `--account <id>` or set `CLOUDFLARE_ACCOUNT_ID`. |
| `wrangler artifacts ... failed` | Run `npx wrangler login`. The namespace comes from `wrangler.jsonc`; override it with `--namespace`. |
| Trains never start | No executor. Pair a runner (section A, step 2), or check seats with `npm run cli -- queue`. |
| `awaiting_plan` forever | Approve the plan in `#/inbox`, or set `FLARE_ADMIN_TOKEN` and use `--approve`. |
| Director can't abandon intents | Set `FLARE_ADMIN_TOKEN`. |
