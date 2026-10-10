# Flare everywhere: every repo, every agent, every account

> Provenance: agent-drafted (2026-10-10). `forge init --global` was run on
> the maintainer's machine and checked by reading the written files;
> the GitHub App visibility claim is from `connect.ts` (`public: false`).

One Flare deployment can run CI and coordinate agents for many repos.
Setup happens at four levels. Do each one once.

| Level | What it gives you | Command |
|---|---|---|
| **Machine** (each laptop, server, or Claude login) | Every Claude Code / Codex session in every repo knows Flare | `npx flare-forge forge init --global` |
| **Repo** | CI runs on Flare; agents coordinate on it | `npx flare-forge connect` + `npx flare-forge forge init` |
| **GitHub account / org** | Flare receives that org's pushes and PRs | Install the GitHub App on it |
| **Cloudflare account** | A separate Flare (own bill, data, limits) | `npx wrangler login && npm run setup` |

## 1. Machine: make every agent know Flare

```bash
export FLARE_ACTIONS_URL=https://<your-flare>.workers.dev
npx flare-forge forge init --global --dry-run   # see the diff first
npx flare-forge forge init --global
```

This writes, idempotently and inside marker blocks (your own text is
never touched):

- `~/.claude/CLAUDE.md`: a "Flare" section that every Claude Code session
  reads in every repo. It covers when a repo is on Flare, the verify loop,
  the Forge loop, `doctor`, and what not to do.
- `~/.codex/AGENTS.md`: the same section for Codex.
- `~/.claude/skills/flare-{forge,verify,setup,migrate}/SKILL.md`: the four
  skills, available in every repo.

It then prints three steps you do by hand, because they live in each
tool's own store:

- **Claude Code MCP (all repos):**
  `claude mcp add --scope user --transport http flare-forge https://<your-flare>/mcp`.
  The first use opens a browser sign-in (OAuth), so no token is stored.
  Sign in with `/mcp` in any `claude` terminal.
- **Codex:** paste the printed `[mcp_servers.flare-forge]` block into
  `~/.codex/config.toml` and export `FLARE_TOKEN`.
- **Cursor:** Settings → Rules → User Rules gets the same block; Settings
  → MCP gets the same URL.

Re-run the command after upgrading the CLI to refresh the section and
skills. Check any machine with `npx flare-forge doctor`.

**Other Claude logins and claude.ai.** Claude Code reads `~/.claude` per
OS user, so every Claude account on the same OS user shares the setup.
For another OS user or machine, run the command there. In claude.ai
Projects, add this line to the project instructions:
"Flare is our CI; read https://<your-flare>/llms.txt before CI work."

## 2. Repo: put it on Flare

Run these from the repo root:

```bash
npx flare-forge connect --dry-run   # detects the stack, shows the plan
npx flare-forge connect             # wires and verifies a green run (exit 0)
npx flare-forge forge init          # AGENTS.md "Flare Forge" block + .mcp.json
```

- Repos without `flare.yml` run their `.github/workflows` unchanged.
  Keep GitHub Actions as a backstop until Flare has been green for a
  while; the `flare-migrate` skill covers retiring it.
- `forge init` writes only an env-var reference to the token, so
  `.mcp.json` is safe to commit. Commit it so teammates' agents get it
  too.
- Repos edited by several agents at once also want the Artifacts mirror,
  which is automatic after the first push. Agents then follow the Forge
  loop. This repo dogfoods it.

## 3. GitHub accounts and orgs

The GitHub App that dashboard **Connect GitHub** creates is **private**
(`public: false`): only the account that created it can install it.
For more accounts or orgs, pick one:

- **Same Flare, more orgs (recommended):** on GitHub, open the App's
  settings → Advanced → **Make public**. Then install it on each org from
  `https://github.com/apps/<app-slug>/installations/new` and choose the
  repos. Flare only acts on repos where it is installed.
- **Separate Flare per org:** use this when orgs must not share data or
  billing. Deploy another Flare (section 4) and Connect from that org's
  owner account.

Scope runner and agent tokens per org with the token repo allowlist:
in Settings → Tokens, set repos to `org/*`.

## 4. Cloudflare accounts

Each Cloudflare account runs its own Flare, with its own D1, queues,
R2, seats and bill:

```bash
npx wrangler logout && npx wrangler login   # pick the other account
npm run setup                               # idempotent, writes .env
```

Agents connect to one deployment at a time through `FLARE_ACTIONS_URL`.
If you use two, register both MCP servers under different names
(`flare-work`, `flare-personal`) with `claude mcp add --scope user ...`.
Keep the `flare-forge` name for the one `forge init --global` points at.

## 5. Teammates and their agents

- People: Settings → People → invite link (single use, 24 h). Or turn on
  open registration for read-only sign-up.
- Their machines: they run section 1 against your URL. Their agents sign
  in over OAuth, or get a runner token from a pairing code
  (`npx flare-forge login --code XXXX-XXXX`).
