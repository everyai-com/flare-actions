# Agent Autopilot: zero-setup agents on Flare

> Provenance: agent-drafted 2026-10-10. The gap analysis comes from reading
> `apps/worker/src/{mcp,intents}.ts`, `docs/FORGE-AGENTS.md`,
> `docs/ROADMAP.md` and `skills/` on branch `feat/forge-intents`. It is a
> plan, not a record: nothing below is shipped unless it is marked so.

## Goal

An agent from any account or tool (Claude Code, Codex, Cursor) opens a repo
and, with nobody wiring anything:

1. finds out that the repo uses Flare,
2. gets its own scoped identity,
3. learns with one call what is happening: CI health, flaky tests, other
   agents' work, and the budget,
4. coordinates with the other agents,
5. pushes, and Flare runs CI, then hands back a digest, which the agent
   loops on until green,
6. cannot say "done" while its branch is red.

**Success metric:** a fresh agent with no prompt beyond "fix issue #N" goes
from clone to a green, merge-queued PR. It never reads raw logs, never
collides with another agent, and needs no human help.

## What already exists

| Need | Shipped |
|---|---|
| Coordination | Forge: `plan_goal`, `whats_happening`, `declare_intent`/`claim_intent`, heartbeat leases, notes/inbox, conflicts, `why`, merge trains |
| CI for agents | `run_and_wait`, `get_run_digest`, `/wait`, dry-run, `--source` runs, triage, self-heal, quarantine |
| Access | MCP with OAuth 2.1 plus tokens, `X-Flare-Agent` tag, per-agent fair-share caps, budgets, kill switch |
| Onboarding | `cli init` (AGENTS.md snippet), `cli connect`, `forge connect-agent` (prints configs), skills `flare-setup` / `flare-forge` / `flare-verify` |

## Gaps

1. **Two brains.** Forge (`whats_happening`) and CI (runs, digests,
   flaky) are separate surfaces. `intents.ts` never looks at runs, so an
   agent needs about 4 calls and has to know which ones to make.
2. **Onboarding prints and does not commit.** `connect-agent` prints the
   config for a human to paste. A new agent opening the repo sees nothing.
3. **Identity is a free-text header.** Anyone can claim any `X-Flare-Agent`
   name, and nothing ties a push to an intent or a session.
4. **CI is not tied to intents.** A push fires a run, but the run does not
   know its intent, and the intent does not show its CI state.
5. **No enforcement.** Following the workflow is optional. An agent can stop
   with a red branch or skip `declare_intent`.
6. **No push channel.** `/v1/forge/feed` returns 501, so agents can only
   poll.

## The plan: 5 phases

Each phase ships on its own and is useful alone. They are ordered by
leverage.

### Phase 1: One brain (`flare_context`). The highest leverage.

One read that answers "what is going on here, and what should I do?"

- **MCP tool `flare_context {repo, branch?, paths?}`**, plus
  `GET /v1/context` and `cli context`. It returns, all bounded:
  - `ci`: latest run on `branch` and on the default branch, with status and
    a digest of any failure (reuses `digest.ts`). Includes whether `main` is
    red right now, with the failing check named, so the agent does not chase
    breakage it did not cause.
  - `flaky`: quarantined tests plus candidates touching `paths`
    (`listQuarantinedFailingTests`, `suggestQuarantine`).
  - `agents`: active intents with agent, title, footprint, lease age and
    CI state, ordered by overlap with `paths` (reuses the
    `whats_happening` core).
  - `pipeline`: job names, p50 duration, and queue wait
    (`summarizeBottlenecks`).
  - `limits`: budget used against the cap, the caller's fair-share slots,
    and whether the repo is paused.
  - `you`: the resolved identity, scopes, the caller's open intents, and
    unread inbox count.
  - `nextSteps`: the same contract as Forge.
- **Hard budget:** 8 KB of JSON at most. Each section is truncated with a
  `more:` pointer to the detailed tool.
- **Files:** a new pure module `apps/worker/src/context.ts` (composes the
  existing queries), a route in `index.ts`, a tool in `mcp.ts` (read tier),
  the CLI, OpenAPI, and `docs/MCP.md`.
- **Done when:** a test fixture repo with a red `main`, one quarantined
  test and two overlapping intents gets the right `nextSteps` in one call
  of 8 KB or less.

### Phase 2: CI ⇄ intent linkage

Make every run belong to the work that caused it.

- Schema: `runs.intent_id` (nullable, indexed), filled in this order:
  1. a `Flare-Intent:` git trailer on the head commit (Forge already
     writes trailers),
  2. a branch match to a claimed intent's fork (`i-<12>`),
  3. the `intent` field on dispatch.
- On terminal rollup, store a `ci_state` on the intent
  (`green|red|running|none` plus the latest run id), and post an
  inbox note to the intent's owner with the digest when it goes red. This
  reuses the notify plumbing and is never blocking.
- `report_push` becomes optional: the webhook infers it from the trailer.
  One less verb for the agent to remember.
- `mark_ready` refuses with `ci_not_green` (a new error code with a hint)
  unless the latest run on the intent's head sha is green. This is the
  server-side gate.
- **Files:** a migration plus `schema.ts` (both, per conventions),
  `intents-core.ts`, the webhook path in `index.ts`, the
  `finish`/rollup hook, and `errors.ts` plus `docs/ERRORS.md`.

### Phase 3: Committed onboarding (`flare adopt`)

The repo itself carries Flare, so every agent that opens it is wired.

- **`cli adopt`** (an extension of `connect`/`init`, idempotent, and it
  opens a PR rather than pushing to `main`). It writes:
  - `.mcp.json`: the Flare MCP URL, **OAuth only, never a token**. Claude
    Code and Cursor load it automatically. It also writes the matching
    entries for `.codex/config.toml` and `.cursor/mcp.json`.
  - A **managed block** in `AGENTS.md` and `CLAUDE.md`
    (`<!-- flare:begin -->…<!-- flare:end -->`, rewritten in place). It is
    5 to 8 lines: "Call `flare_context` first. Declare intent before
    editing. Push, then `wait`. Don't stop red."
  - `.claude/skills/flare/SKILL.md`: one merged skill (setup, forge and
    verify become one loop) with a version stamp.
  - `.claude/settings.json` hooks (Phase 5), opt-in with a flag.
- **`/.well-known/flare.json`** on the worker (the MCP URL, OAuth
  metadata, version), so `adopt` and other tools can discover it from
  just a worker URL.
- **Drift check:** `flare_context` reports `adoption: stale` when the
  committed block or skill version is behind the worker, and suggests
  `cli adopt`.
- **Done when:** a fresh clone opened in Claude Code with an empty prompt
  lists the Flare tools, and the first tool call the agent makes is
  `flare_context`.

### Phase 4: Real agent identity

Turn "agent" from a label into a principal.

- **OAuth dynamic client means an agent.** At consent, the human names it
  (or it is derived from the client name plus the account) and limits its
  repos. Store it in `agents (id, slug, owner_user, client_id, repos,
  created_at, last_seen)`.
- The `X-Flare-Agent` header becomes a *display* hint only for legacy
  tokens. OAuth principals always get their bound slug, so one agent
  cannot impersonate another.
- Per-agent views: the dashboard **Agents tab** (active intents, runs,
  minutes, red/green ratio, last seen), and per-agent budgets that reuse
  the budget machinery keyed by agent.
- Revoke an agent means revoke its client, which aborts its claimed
  intents (lease release) with notes to its peers.
- This closes the roadmap gaps "identity is the missing half" (fair-share)
  and anomaly attribution.

### Phase 5: Enforcement and push

Make the right behavior the default, not a suggestion.

- **Claude Code hooks shipped by `adopt`** (each one a short call to
  `cli`):
  - `SessionStart`: injects a compact `flare_context` summary into
    context, so the agent knows the state before its first thought.
  - `PreToolUse` on Edit/Write: warns (it does not block) when the file is
    in another agent's active footprint and the caller has no intent
    covering it.
  - `PostToolUse` on `git push`: runs `cli wait --branch` in the
    background and surfaces the digest.
  - `Stop`: blocks finishing while the caller's branch run is red or
    running. Escape hatch: `FLARE_ALLOW_RED=1` or a quarantine
    justification.
  - Codex and Cursor get the AGENTS.md rules plus the server gate
    (`mark_ready`), because they have no hooks.
- **Live feed:** implement `/v1/forge/feed` (the 501 today) on a per-repo
  Durable Object. It carries CI terminal events, intent changes, notes and
  conflicts. MCP clients that support notifications get pushes, and the
  rest keep `wait`.
- **Autopilot for unattended agents:** a `skills/flare` "loop" mode,
  context → intent → edit → push → wait → digest → fix, with a hard
  attempt cap (3), a budget check per loop, and escalation by note or PR
  comment when stuck. Self-heal (`heal.ts`) already does this
  server-side; this is the client-side twin.

## Order and sizing

| # | Phase | Size | Depends on |
|---|---|---|---|
| 1 | `flare_context` | M (≈2 days) | — |
| 2 | CI ⇄ intent linkage + `ci_not_green` gate | M | 1 (for display) |
| 3 | `cli adopt` + `.well-known` | M | 1 |
| 4 | Agent identity | L | 3 (OAuth path) |
| 5 | Hooks, live feed, loop mode | L | 1–3 |

Phases 1, 2 and 3 are the minimum product: any agent is wired, aware, and
gated. Phases 4 and 5 make it trustworthy at fleet scale.

## Dogfooding gate

Before each phase is called done, run this repo's own agents (three
accounts, three repos) through it, and record the results here with
command and date:

- tool calls from clone to first correct action (target ≤ 2),
- context tokens spent on CI state (target < 2k),
- collisions and red merges (target 0).

## Non-goals

- No expression engine and no general workflow DSL for agents.
- No tokens committed to repos, ever. Committed config is OAuth-only.
- Never block on Flare availability. Hooks fail open with a warning when
  the worker is unreachable.
