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

- `readonly` — `list_runs`, `get_run`, `get_run_digest`, `get_flaky`
- `runner` / admin — everything, including `run_and_wait`,
  `dispatch_run`, `rerun_job`, `generate_pipeline`

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

Responses are `tools/call` text payloads containing JSON. Unknown tools
and bad arguments return JSON-RPC errors (`-32602`); tool-level misses
(e.g. unknown run) return `{ error }` with `isError: true`.

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
