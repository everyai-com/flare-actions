# MCP server

Every Flare deployment is an MCP server at `POST /mcp` (Streamable HTTP,
stateless JSON-RPC — no sessions). Point any MCP-capable agent at it and
it can read runs, trigger runs, re-run jobs, check flakes, and generate
pipelines without touching the dashboard or CLI.

## Setup

```bash
npm run cli -- mcp-config   # prints a paste-ready client config
```

It prints:

```json
{
  "mcpServers": {
    "flare-actions": {
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer <runner-or-readonly-token>" }
    }
  }
}
```

Paste into Claude Code / Cursor / any MCP client, replacing the token
with one issued in the dashboard Access tab. `GET /mcp` (no auth) returns
server metadata and the tool list for discovery.

## Auth

The Bearer token maps onto existing scopes:

- `readonly` — `list_runs`, `get_run`, `get_flaky`
- `runner` / admin — everything, including `dispatch_run`, `rerun_job`,
  `generate_pipeline`

## Tools

| Tool | Args | Does |
| ---- | ---- | ---- |
| `list_runs` | `limit?` (1–50) | Recent runs, newest first |
| `get_run` | `runId` | Run + jobs: status, step results, log tails, AI triage |
| `dispatch_run` | `repo`, `sha`, `ref?`, `pipeline?` | Trigger a run; inline `pipeline` skips the `flare.yml` fetch |
| `rerun_job` | `runId`, `jobId` | Reset a finished job to queued |
| `get_flaky` | `repo`, `days?` | Per-job failure rates, worst first |
| `generate_pipeline` | `prompt` | Natural language → `flare.yml` |

Responses are `tools/call` text payloads containing JSON. Unknown tools
and bad arguments return JSON-RPC errors (`-32602`); tool-level misses
(e.g. unknown run) return `{ error }` with `isError: true`.

## Example session

```
> list recent runs
< 3 runs, newest 9f2c… status failure
> get_run 9f2c…
< job "test (node=20)" failed step 2 `npm test`; triage: …
> rerun_job 9f2c… <jobId>
< { ok: true }
```

## Notes

- `dispatch_run` on private repos needs an inline `pipeline` (manual
  dispatch can't mint installation tokens); webhooks cover private repos.
- AI tools (`generate_pipeline`, triage in `get_run`) degrade gracefully
  when the deployment has no AI binding.
