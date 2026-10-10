# MCP registry listings packet

Manual submissions for the Flare MCP server (roadmap: mcp.so,
Smithery). Everything a listing form asks for is below — copy,
paste, submit; then tick the roadmap box.

## The server (facts for every form)

- **Name:** flare-actions
- **Repo:** https://github.com/everyai-com/flare-actions
- **Transport:** Streamable HTTP — `POST https://<your-worker>/mcp`
  (stateless JSON-RPC, no sessions; every deployment is a server)
- **Auth:** OAuth 2.1 discovery from the `401` challenge (paste just
  the URL into Claude/ChatGPT/Cursor), or `Authorization: Bearer`
  with a runner/readonly API token for headless clients
  (`cli mcp-config` prints the paste-ready config)
- **Tools (29):** `run_and_wait` (dispatch + block + digest — the
  agent loop in one call), `dispatch_run`, `rerun_job`,
  `get_run_digest`, `get_run`, `list_runs`, `get_flaky`,
  `generate_pipeline`, `list_artifacts`, `get_artifact`,
  `list_schedules`, `create_schedule`, `set_schedule_enabled`,
  `delete_schedule`, `tournament_why` — plus 14 Forge tools
  (`plan_goal`, `declare_intent`, `whats_happening`, `claim_intent`,
  `heartbeat`, `report_push`, `mark_ready`, `send_note`, `read_inbox`,
  `claim_conflict`, `resolve_conflict`, `why`, `fork_session`,
  `forge_snapshot`; see docs/FORGE-AGENTS.md)
- **Safety rails (say it — registries ask):** WriteGuard risk tiers
  per tool, optional write-confirm gate, attributed audit rows for
  write-tier calls, token repo-scoping, OAuth scopes
  (`flare:read` / `flare:run`, admins only get run)
- **Docs:** docs/MCP.md in the repo; machine-readable
  [llms.txt](https://github.com/everyai-com/flare-actions/blob/main/llms.txt)

## One-line description (all directories)

> MCP server for Flare Actions: dispatch CI runs, block until green,
> and read token-efficient digests — the agent verify loop in one
> `run_and_wait` call.

## Install snippet (all directories)

```json
{
  "mcpServers": {
    "flare-actions": {
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

OAuth clients need only the URL (no token to copy).

## Per-registry steps

### mcp.so

1. Open a PR against the registry repo adding `flare-actions`
   (name, description above, repo link, `streamable-http` transport,
   install snippet).
2. Confirm the listing renders the tool count (29) and the OAuth
   note — mcp.so readers skim for auth difficulty first.

### Smithery

1. Smithery's registry is stdio-first (it spawns local servers);
   Flare is a hosted Streamable-HTTP server, so list it as a
   **remote / hosted** entry if that type exists — do not wrap it
   in a fake stdio shim.
2. If Smithery has no remote-server type yet, file the listing as
   docs-only (repo + URL + snippet) and note the gap in the
   submission; revisit when remote listings open.

## After submitting

- Check the listing renders (tools, auth, snippet) within a day;
  registries sometimes mangle JSON snippets — fix from the PR.
- Tick the roadmap box in docs/ROADMAP.md ("MCP registry listings").
- Announce in the release notes for the version that follows.
