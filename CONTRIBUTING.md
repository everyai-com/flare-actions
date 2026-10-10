# Contributing

Thanks for helping make Flare Actions better. This is a small, opinionated
codebase — these notes keep reviews fast.

## Setup

```bash
npm install
npm run dev      # local Worker (wrangler dev, simulated D1 + queues)
# or the full path:
npm run setup    # provision D1 + queues + R2, migrate, deploy, write .env
```

`npm run setup -- --dry-run` previews everything without touching your account.

### Fast inner loop

While iterating, run `npm run check` instead of the full commands: it lints
only changed files (oxlint), type-checks with the fast native compiler when
available, and runs only the tests affected by your change. It serializes
across worktrees (`FLARE_CHECK_SLOTS`, default 3) so parallel sessions don't
thrash a laptop. See [docs/DEV-SPEED.md](docs/DEV-SPEED.md) for measurements
and rationale.

## Before you open a PR

Run the same gates CI runs:

```bash
npm run typecheck
npm run lint
npm test
npm run types
npm run deploy:dry
```

If you touched `apps/seats`, also generate the seats config and dry-run it:

```bash
node -e "const fs=require('fs');fs.writeFileSync('apps/seats/wrangler.jsonc',fs.readFileSync('apps/seats/wrangler.jsonc.example','utf8').replace('__ACCOUNT_ID__','0123456789abcdef0123456789abcdef'))"
npx wrangler deploy --dry-run --config apps/seats/wrangler.jsonc
```

- Add colocated `*.test.ts` coverage for behavior changes; keep Worker unit
  tests runtime-free (no real D1, no network).
- Don't commit `.env`, `.dev.vars`, `worker-configuration.d.ts`, or
  `apps/seats/wrangler.jsonc` — all gitignored on purpose.
- CI's preview deploy is optional (needs repo secrets) and skips cleanly
  without them.

## Conventions

[`AGENTS.md`](AGENTS.md) is the source of truth for architecture and
conventions — read it before touching the Worker. The short version:

- Strict TypeScript, no `any`, no floating promises, structured JSON logs,
  explicit try/catch.
- Timing-safe comparisons for anything secret-shaped; never `===` on secrets.
- The dashboard is one inline HTML string with `textContent`-only data
  rendering.
- Keep PRs focused. For larger features or design changes, open an issue
  first so we can agree on the shape before code exists.

## Commits and PRs

- Imperative, scoped summary lines (see `git log` for tone).
- One logical change per PR; describe what you verified and how.

## Security

Please don't report vulnerabilities in public issues — see
[`SECURITY.md`](SECURITY.md).

## Publishing to npm

The CLI publishes as **`flare-forge`** (bins `flare-forge` and `flare`).
In the repo it runs from TypeScript source under Node type stripping; for
npm, `npm run build:cli` bundles it with esbuild into one self-contained
`apps/cli/dist/cli.mjs` (the runner SDK and the worker/seats modules it
imports are inlined, so the package has zero runtime dependencies).
`prepublishOnly` rebuilds and smoke-runs the bundle.

```bash
npm run pack:cli                          # build + flare-forge-X.Y.Z.tgz; inspect the file list
npm install -g ./flare-forge-*.tgz && flare-forge forge help   # optional local smoke
npm login
npm publish --workspace apps/cli          # publishes flare-forge
```

Bump `version` in `apps/cli/package.json` and tag the release (`vX.Y.Z`).
After publishing, `npx flare-forge forge connect-agent --client claude`
and `npx flare-forge connect` work without cloning. The runner SDK
(`flare-actions-runner-sdk`) still ships as TypeScript sources and is
published separately only if you want it as a library; the CLI no longer
needs it at runtime.

## License

By contributing you agree your work is licensed under the repo's
[MIT license](LICENSE).
