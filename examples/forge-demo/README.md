# Bookshelf: the Flare Forge demo trunk

A small, zero-dependency Cloudflare Worker API that dozens of agents
change at the same time during the Forge demo. It is imported into
Cloudflare Artifacts as the trunk, so it is **self-contained**: it is not
part of the Flare Actions npm workspaces and needs no `npm install`.

```sh
cd examples/forge-demo
node --test                              # baseline suite, < 1 s (Node >= 22.18)
node scripts/verify-scenarios.mjs        # every designed interaction, ~30 s
node agents/apply.mjs g1-metrics .       # apply one intent's reference solution
```

## Why it looks like this

- **Zero install.** Node 22.18+ strips TypeScript types natively and ships
  `node:test`, so CI is `node --test` with no dependency step. The whole
  pipeline ([`flare.yml`](flare.yml)) runs in a few seconds, which keeps
  train CI on combined SHAs fast.
- **Clear seams.** One module per concern, so most intents land in
  parallel lanes:

  ```
  src/index.ts               route table (top) + middleware chain (bottom)
  src/routes/{books,authors,health}.ts
  src/middleware/{logging,cors}.ts
  src/auth/{session,apiKey}.ts        protected (plan approval)
  src/lib/{http,errors,pagination,store,validate}.ts
  migrations/                         protected (plan approval)
  test/*.test.ts                      one file per module or intent
  ```

- **Type-stripping safe.** Plain types only: no enums, parameter
  properties or namespaces; `import type` for types; relative imports
  carry `.ts`. `tsconfig.json` is for editors (`npx tsc -p .` with
  `@types/node` available); CI deliberately skips type checking.

## API

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | | `{ ok: true }` |
| `GET /books?q=&author=&limit=&cursor=` | | paged; default 20, max 50 |
| `GET /books/:id` | | |
| `POST /books` | yes | validated body |
| `DELETE /books/:id` | yes | |
| `GET /authors`, `GET /authors/:id` | | |
| `POST /authors` | yes | |

Auth is a `session=<id>` cookie or an `x-api-key` header matching
`API_KEY`. The store is in memory per isolate; `migrations/` holds the
target D1 schema.

## Forge files

| Path | Purpose |
|---|---|
| [`.flare/policy.yml`](.flare/policy.yml) | Protected paths, auto-land risk, audit sample, lanes, replay (plan §3.4) |
| [`flare.yml`](flare.yml) | CI: `node --test "test/**/*.test.ts"` (validated with Flare's pipeline parser) |
| [`GOALS.md`](GOALS.md) | The three demo goals and every designed interaction, explained |
| [`seed/goals.json`](seed/goals.json) | The same, machine-readable: goals, 13 intents (title, reasoning, footprint, accept), interactions, trains |
| [`agents/apply.mjs`](agents/apply.mjs) | Deterministic reference agent. `applyEdits()` is pure, so the simulator can apply solutions to an in-memory tree |
| [`agents/solutions/*.mjs`](agents/solutions) | One scripted solution per intent (data: `create` / exact-once `replace` edits), plus replay variants |
| [`scripts/verify-scenarios.mjs`](scripts/verify-scenarios.mjs) | Proves the design with plain git in a temp dir and prints a table; `--json`, `--keep` |

## What the verifier proves

1. Declared footprints equal the files each solution touches; footprint
   overlaps are exactly the two designed pairs; only
   `g3-api-key-rotation` hits a protected path.
2. Baseline is green, and each of the 13 intents is green alone.
3. `g1-metrics` + `g3-rate-limit` overlap on `src/index.ts` but merge
   cleanly in both orders, and are green together.
4. `g1-request-id` + `g3-log-latency` hit a real git conflict in
   `src/middleware/logging.ts` in both orders. The stale diff no longer
   applies, and the replay variant is green.
5. `g2-default-page-size` + `g3-max-page-size` have disjoint footprints and
   merge cleanly, but the combined suite fails 3 named tests.
6. The 11-intent green train is green; the 12-intent train with the
   semantic pair is red.

Set `FORGE_DEMO_TMP` to choose where the throwaway repo is created
(default: the OS temp dir).

## Importing as a trunk

Copy this directory as the root of a new repository. `agents/`, `seed/`
and `scripts/` are demo tooling. Leave them out of the trunk if agents
shouldn't see the reference solutions; nothing in `src/` or `test/`
depends on them.
