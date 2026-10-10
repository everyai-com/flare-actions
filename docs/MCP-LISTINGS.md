# MCP registry listings packet

> Provenance: agent-drafted, revised 2026-10-10 for Flare Forge. Tool
> names and counts are read from `FORGE_TOOLS` and the CI tool list in
> `apps/worker/src/mcp.ts` (14 Forge + 15 CI = 29) at the commit that
> updated this file. **Prepared only: nothing has been submitted.**
> Submissions are manual, by the maintainer.

Everything a listing form asks for is below: copy, paste, submit, then
tick the roadmap box. Lead with Forge; the CI tools are the second
paragraph.

## The server (facts for every form)

- **Name:** Flare Forge (MCP server id `flare-actions`; client configs
  name the entry `flare-forge`)
- **Repo:** https://github.com/everyai-com/flare-actions
- **License:** MIT
- **Transport:** Streamable HTTP, `POST https://<your-worker>/mcp`
  (stateless JSON-RPC, no sessions; every deployment is a server)
- **Auth:** OAuth 2.1 discovery from the `401` challenge (paste just the
  URL into Claude, ChatGPT or Cursor), or `Authorization: Bearer` with a
  runner or readonly API token for headless clients.
- **One-command setup:** `npx flare-forge forge connect-agent --client claude|codex|cursor`
  prints the client config and the workflow prompt;
  `npx flare-forge forge init` writes AGENTS.md + `.mcp.json` for a repo.
- **Forge tools (14):** `plan_goal`, `whats_happening`,
  `declare_intent`, `claim_intent`, `heartbeat`, `report_push`,
  `mark_ready`, `send_note`, `read_inbox`, `claim_conflict`,
  `resolve_conflict`, `why`, `fork_session`, `forge_snapshot`
- **CI tools (15):** `run_and_wait` (dispatch + block + digest),
  `dispatch_run`, `rerun_job`, `get_run_digest`, `get_run`,
  `list_runs`, `get_flaky`, `generate_pipeline`, `list_artifacts`,
  `get_artifact`, `list_schedules`, `create_schedule`,
  `set_schedule_enabled`, `delete_schedule`, `tournament_why`
- **Safety rails (registries ask; say it):**
  - Agents never receive a trunk write token: `claim_intent` mints a
    1-hour token scoped to the agent's own fork; only CI-verified trains
    move `main`.
  - Peer notes are returned labelled as untrusted data, never as
    instructions.
  - Plan approval for protected paths is admin-only and not an MCP tool.
  - WriteGuard risk tiers per tool, an optional write-confirm gate,
    attributed audit rows for write-tier calls, token repo-scoping, and
    OAuth scopes (`flare:read` / `flare:run`; OAuth never carries admin).
- **Docs:** `docs/FORGE-AGENTS.md` (protocol), `docs/MCP.md` (CI tools),
  machine-readable [llms.txt](https://github.com/everyai-com/flare-actions/blob/main/llms.txt)

## One-line description (all directories)

> Flare Forge: many coding agents on one repo without stepping on each
> other. Declare intents before editing, see overlaps up front, work in
> your own fork, and land through CI-verified trains, with `why` for
> every line.

## Short description (directories with a paragraph field)

> Flare Forge is an MCP server for multi-agent software work on
> Cloudflare Workers and Artifacts. Agents declare what they are about
> to change (`declare_intent`) and get back every overlapping intent
> before writing code, claim a private fork with a fork-scoped token,
> push with plain git, and mark ready; trains land the work only after
> CI verifies the exact merged commit. Conflicts are replayed, review is
> routed by risk, and `why` answers who changed a line and for what
> goal. The same server exposes Flare Actions CI tools, including
> `run_and_wait`, which dispatches a run, waits, and returns a compact
> digest.

## Install snippet (all directories)

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

OAuth clients need only the URL. Claude Code one-liner:
`claude mcp add --transport http flare-forge https://<your-worker>/mcp --header "Authorization: Bearer $FLARE_TOKEN"`.

## Per-registry steps

### Official MCP registry (registry.modelcontextprotocol.io)

1. The server is self-hosted (one per deployment), so list it as a
   **remote** server template with a placeholder URL, or skip until a
   public hosted instance exists. Do not invent a shared URL.
2. If the registry needs an npm package for discovery, point at
   `flare-forge` (after `npm publish`); its `forge connect-agent` prints
   the per-deployment config.

### mcp.so

1. Open a PR against the registry repo adding `flare-forge` (name,
   one-line description, repo link, `streamable-http` transport,
   install snippet).
2. Confirm the listing shows the tool count (29) and the OAuth note;
   readers skim for auth difficulty first.

### Smithery

1. Smithery is stdio-first. Flare is a hosted Streamable HTTP server,
   so list it as a **remote / hosted** entry if that type exists. Do not
   wrap it in a fake stdio shim.
2. If there is no remote type yet, file a docs-only listing (repo, URL
   template, snippet) and note the gap.

## After submitting

- Check each listing renders (tools, auth, snippet) within a day.
  Registries sometimes mangle JSON snippets; fix them from the PR.
- Tick the roadmap box in docs/ROADMAP.md ("MCP registry listings").
- Mention the listing in the release notes for the next version.
