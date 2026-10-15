// `GET /runner.sh`: the one-line way to turn this computer into a Flare
// runner:
//
//   curl -fsSL <origin>/runner.sh | FLARE_PAIR_CODE=<PAIR-CODE> sh
//
// Checks prerequisites with plain-language errors, fetches the runner
// checkout at a PINNED ref (a release tag or a full commit SHA, never a
// moving branch), then pairs and starts polling. The single-use pairing
// code is the only secret and the script itself carries none. It travels
// in the environment, never in a process's argv: argv is world-readable
// (`ps`), the environment is owner-only. The legacy `| sh -s <CODE>
// [name]` form is still accepted (the code then sits in the shell's own
// argv while the script runs), but the pairing step always reads it
// from the environment. Re-running without a code just restarts an
// already paired runner. Kept as an array of plain strings: no template
// literal, so shell `$VAR` / `${...}` stay literal.
export const RUNNER_REPO_URL = "https://github.com/everyai-com/flare-actions";

// Fallback pin when the deployment configures none (FLARE_RUNNER_REF var
// or the fleet runner_version setting): main when one-line pairing
// shipped. Bump deliberately, like a dependency.
export const RUNNER_DEFAULT_REF = "5b1a81ae5c1ed471b703efa57c177a78c20cd316";

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
// A release tag (v1.2.3[-pre]) or a full 40-hex commit SHA. Both are
// shell-safe by construction.
const REF_RE = /^(v\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?|[0-9a-f]{40})$/;

export function isPinnedRunnerRef(ref: string): boolean {
  return REF_RE.test(ref);
}

// The ref /runner.sh pins: an explicit deployment ref, else the fleet's
// runner_version (semver -> its v-tag), else the built-in default.
export function resolveRunnerRef(configured: string | null | undefined, fleetVersion: string | null | undefined): string {
  const c = (configured ?? "").trim();
  if (c && isPinnedRunnerRef(c)) return c;
  const v = (fleetVersion ?? "").trim();
  if (v && isPinnedRunnerRef(`v${v}`)) return `v${v}`;
  return RUNNER_DEFAULT_REF;
}

// Pairing step, run in the pinned checkout's apps/runner: the runner's
// own pairRunner, with URL, code and name read from the environment.
// Contains no single quotes (it is single-quoted in the shell).
const PAIR_JS =
  'const { pairRunner } = await import("./src/pair.ts");' +
  " const e = process.env;" +
  " try {" +
  " const p = await pairRunner({ baseUrl: e.FLARE_ACTIONS_URL, code: e.FLARE_PAIR_CODE, ...(e.FLARE_PAIR_NAME ? { name: e.FLARE_PAIR_NAME } : {}), cwd: process.cwd() });" +
  ' console.log("Paired as " + p.name + ".");' +
  " } catch (err) {" +
  ' console.error("Pairing failed: " + (err instanceof Error ? err.message : String(err)));' +
  " process.exit(1);" +
  " }";

export function runnerScript(origin: string, ref: string = RUNNER_DEFAULT_REF): string | null {
  if (!ORIGIN_RE.test(origin)) return null;
  if (!isPinnedRunnerRef(ref)) return null;
  return [
    "#!/bin/sh",
    "# Flare Actions runner setup. Usage: curl -fsSL " + origin + "/runner.sh | FLARE_PAIR_CODE=<CODE> sh",
    "set -e",
    'URL="' + origin + '"',
    // Pinned runner ref; FLARE_RUNNER_REF overrides it on this machine.
    'REF="${FLARE_RUNNER_REF:-' + ref + '}"',
    'CODE="${FLARE_PAIR_CODE:-${1:-}}"',
    'NAME="${FLARE_PAIR_NAME:-${2:-}}"',
    'DIR="${FLARE_RUNNER_DIR:-$HOME/flare-runner}"',
    'say() { printf "\\n==> %s\\n" "$1"; }',
    'command -v git >/dev/null 2>&1 || { echo "Flare needs git. Install it from https://git-scm.com/downloads and run this again."; exit 1; }',
    'command -v node >/dev/null 2>&1 || { echo "Flare needs Node.js 22.6 or newer. Install it from https://nodejs.org and run this again."; exit 1; }',
    "node -e 'const [a,b]=process.versions.node.split(\".\").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' || { echo \"Flare needs Node.js 22.6 or newer (you have $(node --version)). Update it from https://nodejs.org and run this again.\"; exit 1; }",
    'case "$REF" in ""|*[!0-9A-Za-z.-]*) echo "FLARE_RUNNER_REF must be a release tag or a commit SHA."; exit 1;; esac',
    'if [ -d "$DIR/.git" ]; then',
    '  say "Updating the Flare runner in $DIR to $REF"',
    '  { git -C "$DIR" fetch --depth 1 --quiet origin "$REF" && git -C "$DIR" checkout --quiet --detach FETCH_HEAD; } || echo "(could not update; using the copy you have)"',
    "else",
    '  say "Downloading the Flare runner ($REF) to $DIR"',
    '  git init --quiet "$DIR"',
    '  git -C "$DIR" remote add origin ' + RUNNER_REPO_URL,
    '  git -C "$DIR" fetch --depth 1 --quiet origin "$REF"',
    '  git -C "$DIR" checkout --quiet --detach FETCH_HEAD',
    "fi",
    // A full-SHA pin is verified, not trusted: the checkout must be it.
    'case "$REF" in ' + "?".repeat(40) + ') [ "$(git -C "$DIR" rev-parse HEAD)" = "$REF" ] || { echo "The runner checkout is not $REF; refusing to run it."; exit 1; };; esac',
    'cd "$DIR"',
    'say "Installing (this takes a minute the first time)"',
    "npm ci --no-audit --no-fund --loglevel=error",
    'if [ -n "$CODE" ]; then',
    '  say "Connecting this computer to $URL"',
    "  (cd apps/runner && FLARE_ACTIONS_URL=\"$URL\" FLARE_PAIR_CODE=\"$CODE\" FLARE_PAIR_NAME=\"$NAME\" node --experimental-strip-types --no-warnings --input-type=module -e '" +
      PAIR_JS +
      "')",
    "fi",
    "unset CODE FLARE_PAIR_CODE",
    'say "Starting the runner. Keep this window open while your tests run (Ctrl+C stops it)."',
    'FLARE_ACTIONS_URL="$URL" exec npm run --silent runner',
    "",
  ].join("\n");
}
