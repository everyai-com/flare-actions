# MCP server

Every Flare deployment is an MCP server at `POST /mcp` (Streamable HTTP,
stateless JSON-RPC — no sessions). Point any MCP-capable agent at it and
it can read runs, trigger runs, re-run jobs, check flakes, and generate
pipelines without touching the dashboard or CLI.

## Setup

**OAuth (recommended):** paste just the server URL into Claude, ChatGPT,
or Cursor:

```
https://<your-worker>/mcp
```

The client discovers OAuth from the `401` challenge, registers itself
(`POST /oauth/register`), and opens the dashboard login + consent page
(`GET /authorize`). No tokens to copy. Admins can grant `flare:read` +
`flare:run`; everyone else grants `flare:read` only (mirroring dashboard
privilege). Everyone manages their own connections in the dashboard
Apps tab (`GET`/`DELETE /v1/oauth/grants`, session-cookie authed —
revoking disconnects the app immediately); admins additionally see all
teammates' grants in the Access tab.

**API tokens:** for headless clients:

```bash
npm run cli -- mcp-config   # prints a paste-ready client config
```

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

`GET /mcp` (no auth) returns server metadata, the tool list, and the
OAuth endpoints for discovery.

## Auth

OAuth scopes (granted on the consent page):

- `flare:read` — `list_runs`, `get_run`, `get_run_digest`, `get_flaky`,
  `list_artifacts`, `get_artifact`
- `flare:run` — everything, including `run_and_wait`, `dispatch_run`,
  `rerun_job`, `generate_pipeline`
- `offline_access` — refresh tokens (granted to everyone)

Schedule tools (`list_schedules`, `create_schedule`,
`set_schedule_enabled`, `delete_schedule`) need an **admin API token**
(or a dashboard admin session) — OAuth grants never carry admin, even
for admin users.

Legacy API tokens keep working unchanged and map onto the same scopes:
`readonly` → `flare:read`, `runner`/admin → `flare:read` + `flare:run`
(repo allowlists still enforced). Same-origin browser requests may also
carry the dashboard session cookie instead of a Bearer [REDACTED] is how the
WebMCP pack and native page tools authenticate as the visitor.

## Tools

| Tool | Args | Does |
| ---- | ---- | ---- |
| `list_runs` | `limit?` (1–50) | Recent runs, newest first |
| `get_run` | `runId` | Run + jobs: status, step results, log tails, AI triage |
| `get_run_digest` | `runId` | **Compact result for agents**: failing step command/exit, bounded output tails, triage — no full logs |
| `dispatch_run` | `repo`, `sha`, `ref?`, `pipeline?`, `priority?` | Trigger a run; inline `pipeline` skips the `flare.yml` fetch; `priority` 0–10 jumps queued batch work |
| `run_and_wait` | `repo`, `sha`, `ref?`, `pipeline?`, `priority?`, `timeoutSeconds?` | **One-call verify loop**: dispatch and block until terminal, returning the digest |
| `rerun_job` | `runId`, `jobId` | Reset a finished job to queued |
| `get_flaky` | `repo`, `days?` | Per-job failure rates, worst first |
| `generate_pipeline` | `prompt` | Natural language → `flare.yml` |
| `list_artifacts` | `runId` | Run's artifacts: job, name, size (repo-scoped) |
| `get_artifact` | `jobId`, `name`, `maxBytes?` | Bounded text head of one artifact (repo-scoped; binaries stay on HTTP) |
| `list_schedules` | — | Cron schedules (admin token) |
| `create_schedule` | `repo`, `ref`, `cron`, `profile?` | New cron schedule, same rules as the REST route (admin token) |
| `set_schedule_enabled` | `scheduleId`, `enabled` | Pause/resume a schedule (admin token) |
| `delete_schedule` | `scheduleId` | Delete a schedule (admin token) |

Responses are `tools/call` text payloads containing JSON. Tool failures
(scope, validation, confirm gate, unknown run) return `{ error }` with
`isError: true`; malformed requests return JSON-RPC errors (`-32700`,
`-32600`, `-32601`, `-32602`).

Clients must send `Accept: application/json, text/event-stream` (both);
anything else is a `406`. Responses are SSE `data:` frames. Protocol:
modern `2026-07-28` plus the SDK's legacy era (`2025-11-25` …
`2024-11-05`), negotiated per request.

## WebMCP (browser agents)

Two layers, both authenticated as the visitor via the dashboard session
cookie on same-origin requests:

- **Native page tools** (works everywhere, no setup): the dashboard
  registers `flare_list_runs`, `flare_get_run_digest`, `flare_get_flaky`
  (everyone) plus `flare_dispatch_run`, `flare_rerun_job` (admins) on
  `document`/`navigator.modelContext` when the browser supports WebMCP
  (Chrome 146+, Cloudflare Browser Run). Feature-detected — other
  browsers are unaffected.
- **Site MCP Server pack** (custom domains behind the Cloudflare proxy):
  Agent Readiness → WebMCP → enable the Site MCP Server pack. The
  edge-injected bridge (`data-mcp-url="/mcp"`) discovers tools via
  `tools/list` and proxies `tools/call` with `credentials: same-origin`,
  which the session-cookie path on `POST /mcp` accepts. No origin
  changes needed.

## The agent fast loop

The intended shape of an agent's verify cycle is **two calls, zero sleeps**:

```
1. run_and_wait { repo, sha, pipeline?, priority: 9, timeoutSeconds: 45 }
   → { runId, status: "failure", failedJobs: 1, jobs: [
       { name: "test", status: "failure",
         failing: { command: "npm test", exitCode: 1, outputTail: "…expected 3, got 2…" },
         triage: "Cause: … Fix: …" } ], timedOut: false }
2. fix, export a new sha, repeat.
```

- `priority: 9` puts the job ahead of queued batch work (0 default, 10 max).
- `timedOut: true` means the run is still going: call `get_run_digest` again
  (or `run_and_wait` with a longer timeout) — never sleep-and-poll blind.
- The digest is deliberately small (a few KB): bounded output tails and
  capped triage, so it can be fed back into context repeatedly.

## Example session

```
> run_and_wait o/r main --priority 9
< run9 dispatched… failure  1/2 failed
< [FAIL] test: `npm test` exit 1 — "expected 3, got 2" · triage: …
> get_run_digest run9
< same compact payload (no re-dispatch)
> rerun_job run9 <jobId>
< { ok: true }
```

## Notes

- Dispatch resolves refs and private-repo pipelines with the GitHub App
  installation when the repo has one; public repos need nothing.
- AI tools (`generate_pipeline`, triage in `get_run`/`get_run_digest`)
  degrade gracefully when the deployment has no AI binding.
