# flare-actions

The command-line client for [Flare Actions](https://github.com/everyai-com/flare-actions),
an open-source GitHub Actions alternative you host on your own Cloudflare
account. Run your CI locally with no account, convert GitHub Actions
workflows, and, once you have a deployment, dispatch runs, wait on them,
and read compact failure digests built for coding agents.

Requires Node.js 22 or newer.

## Run CI locally (no account)

```sh
npx flare-actions@latest local
```

Runs the pipeline in the current directory: `flare.yml` if present,
otherwise your `.github/workflows/*.yml`. Pass a job name to run just one
job, or `--parity` to see where local and cloud runs would differ.
Secrets come from `FLARE_SECRET_<NAME>` environment variables.

## Convert a GitHub Actions workflow

```sh
npx flare-actions@latest import .github/workflows/ci.yml
```

Prints the equivalent `flare.yml` plus any warnings for steps that need
attention.

## Connect a repository

```sh
npx flare-actions@latest connect
```

Detects your stack, scaffolds `flare.yml` if needed, prints (or with
`--wire` applies) the GitHub webhook wiring, and dispatches a first run
to verify. Server commands read `FLARE_ACTIONS_URL` and `RUNNER_TOKEN`
from the environment or a `.env` file; `npx flare-actions@latest login`
pairs a machine with a dashboard code.

## More

`npx flare-actions@latest --help` lists every command; `<command> --help`
shows one. Every command accepts `--json` for a versioned machine-readable
envelope. Installed globally, the binary is `flare`.

Source, docs, and the one-click Cloudflare deploy:
https://github.com/everyai-com/flare-actions
