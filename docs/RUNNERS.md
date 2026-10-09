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

## Resource self-report + size labels

While a job runs, the runner samples its process subtree once a second
(one `ps` invocation; Linux/macOS, failing open where `ps` is
missing) and reports peak RSS + peak CPU% in the result JSON
(`peakRssBytes`, `peakCpuPercent`) plus a `[resources]` log line.
Seats report the same `peakRssBytes` via cgroupfs. Container-step work
runs inside Docker, so host-side peaks cover non-container steps, tar
cache ops, and service shims — the work footprint, not the runner
baseline.

Peaks feed right-sizing hints: the run digest carries `sizeHint`, the
dashboard run page graphs peak RSS per job with bars, and `cli
explain` names the heaviest job. Classes:

| peak RSS | label | meaning |
| -------- | ----- | ------- |
| <512 MB | `size-s` | fits small runners |
| <2 GB | `size-m` | fits standard runners |
| <8 GB | `size-l` | needs 8gb+ runners |
| ≥8 GB | `size-xl` | needs 16gb+ runners |

To segment a fleet, tag heavy jobs (`runs-on: [linux, size-l]`) and
advertise the label on big boxes (`FLARE_LABELS=size-l`) — small jobs
keep draining on small runners instead of queueing behind memory
hogs.

## Pairing (zero-config machines)

Dashboard Access → **Pair a runner** mints a short single-use code and
shows one command. Paste it on the fresh box — no `.env` editing, no
token copying:

```bash
FLARE_ACTIONS_URL=https://<your-worker>.workers.dev npm run runner -- --pair K7MD-Q2XA --pair-name ci-metal-01
```

The runner exchanges the code for a runner-scoped API token (shown
once, like dashboard tokens), writes `.env` next to itself (0600,
merging with existing keys), and starts polling. Codes expire after
10 minutes, work exactly once, and the exchange throttles per IP like
logins. Re-pairing needs the old `RUNNER_TOKEN` unset first (refusing
to silently re-key a live machine). Revoke a paired machine like any
token: Access tab → Revoke.

## Minimal setup (any OS)

```bash
git clone https://github.com/everyai-com/flare-actions && cd flare-actions
npm install
export FLARE_ACTIONS_URL=https://<your-worker>.workers.dev
export RUNNER_TOKEN=<runner token from the dashboard Access tab>
export GITHUB_TOKEN=<optional, for private repos>
npm run runner
```

Prefer not to touch tokens at all? Use pairing (above) instead of the
`RUNNER_TOKEN` export.

Keep it alive with a service manager — a bare terminal dies with your
session and queued jobs just sit there. Copy-paste units:

### Linux (systemd user unit)

```ini
# ~/.config/systemd/user/flare-runner.service
[Unit]
Description=Flare Actions runner
After=network-online.target

[Service]
WorkingDirectory=%h/flare-actions
Environment=FLARE_ACTIONS_URL=https://<your-worker>.workers.dev
Environment=RUNNER_TOKEN=<runner token from the dashboard>
Environment=FLARE_LABELS=docker
ExecStart=/usr/bin/env npm run runner
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now flare-runner
loginctl enable-linger "$USER"   # keep running without an open session
```

### macOS (launchd)

```xml
<!-- ~/Library/LaunchAgents/com.flare.runner.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.flare.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>npm</string><string>run</string><string>runner</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/flare-actions</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FLARE_ACTIONS_URL</key><string>https://&lt;your-worker&gt;.workers.dev</string>
    <key>RUNNER_TOKEN</key><string>&lt;runner token&gt;</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.flare.runner.plist
```

### Windows and anywhere else

Task Scheduler with an "at startup" trigger, or NSSM to wrap
`npm run runner` as a service. No service manager? `tmux new -d -s flare
'npm run runner'` survives SSH drops.

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

## Auto-update

Set a fleet version in the dashboard Settings tab ("fleet runner
version", blank = off). Runners compare it with their own package
version while idle (every 10 minutes, never mid-job) and log an hourly
warning when behind. With `--auto-update` (`npm run runner --
--auto-update`, or add it to your service unit's `ExecStart`), a behind
runner instead pulls (`git pull --ff-only`, refused on dirty trees or
divergence), reinstalls (`npm install`), and exits 42 for the service
manager to restart on the new tree. Non-git installs skip with a log
line. Both lanes (Flare jobs and `--github`) share the same check.

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
