# Runners: labels, BYO boxes, macOS, Windows

Runners are pull clients: they advertise labels, take the oldest queued
job they match, execute it, and report back. Any machine that can run
Node 22+ and `git` can be a runner — a laptop, a Mac Mini, a Windows box,
a cloud VM.

## Labels

Every runner reports `[os, arch, ...FLARE_LABELS]` — e.g.
`["macos", "arm64"]`, `["linux", "x64"]`, `["windows", "x64"]`.
A job's `runs-on` labels must *all* be present on the runner; jobs
without `runs-on` match every runner.

```bash
FLARE_LABELS=gpu,docker npm run runner   # picks up runs-on: [linux, gpu] etc.
```

## Minimal setup (any OS)

```bash
git clone https://github.com/everyai-com/flare-actions && cd flare-actions
npm install
export FLARE_ACTIONS_URL=https://<your-worker>.workers.dev
export RUNNER_TOKEN=<runner token from the dashboard Access tab>
export GITHUB_TOKEN=<optional, for private repos>
npm run runner
```

Keep it alive with a service manager — a bare terminal dies with your
session and queued jobs just sit there. Copy-paste examples:

```bash
# macOS (launchd): ~/Library/LaunchAgents/com.flare.runner.plist
# RunAtLoad + KeepAlive, FLARE_* vars in EnvironmentVariables, then:
launchctl load ~/Library/LaunchAgents/com.flare.runner.plist

# Linux (systemd user unit): ~/.config/systemd/user/flare-runner.service
# [Service] ExecStart=/usr/bin/npm run runner, WorkingDirectory=<repo>,
# Environment=FLARE_ACTIONS_URL=… RUNNER_TOKEN=…, Restart=always, then:
systemctl --user enable --now flare-runner

# Windows: Task Scheduler "at startup" trigger, or NSSM service wrapper.
# Anywhere else: tmux new -d -s flare 'npm run runner' survives SSH drops.
```

## macOS (Apple Silicon builds)

Cloudflare has no macOS compute, so Mac builds are BYO by design — a Mac
Mini or hosted Mac runner speaks the same label protocol:

```yaml
# flare.yml
jobs:
  ios:
    runs-on: macos
    steps:
      - run: xcodebuild -scheme App -destination 'platform=iOS Simulator' test
```

The runner needs Xcode command-line tools and `git`. Steps run under `sh`;
use `bash -lc '…'` inside `run:` if you need login-shell toolchains.

## Windows

Same protocol with `runs-on: windows`. Prerequisites: Node 22+, Git for
Windows (provides `sh` for step execution — ensure `sh.exe` is on PATH),
and `tar.exe` (ships with Windows 10+) for cache/artifacts. Prefer
`shell`-neutral commands or call `powershell -c '…'` explicitly.

## Docker execution

Jobs using `container:` or `services:` fail fast with a clear message on
runners without a docker daemon. Tag docker-capable runners
(`FLARE_LABELS=docker`) and select them with `runs-on: [linux, docker]`.

## Cache and artifacts

Cache blobs live in your deployment's R2 bucket (zero egress inside
Cloudflare). Runners `PUT`/`GET` tarballs keyed by the pipeline's static
`cache.key`; misses build clean, save failures warn — the cache never
fails a job. Artifacts upload per job and download from
`GET /v1/jobs/:jobId/artifacts/:name` or the run's artifact list.

## Security posture

Runners execute arbitrary repo code by design. Run untrusted repos on
disposable boxes or inside `container:` jobs, scope runner tokens per
machine (revoke in one click), and never reuse tokens across trust
boundaries.
