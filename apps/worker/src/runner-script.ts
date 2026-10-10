// `GET /runner.sh`: the one-line way to turn this computer into a Flare
// runner (`curl -fsSL <origin>/runner.sh | sh -s <PAIR-CODE> [name]`). Checks
// prerequisites with plain-language errors, clones or updates the
// runner checkout, then pairs (the single-use code is the only secret,
// passed as an argument — the script itself carries none) and starts
// polling. Re-running without a code just restarts an already paired
// runner. Kept as an array of plain strings: no template literal, so
// shell `$VAR` / `${...}` stay literal.
export const RUNNER_REPO_URL = "https://github.com/everyai-com/flare-actions";

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

export function runnerScript(origin: string): string | null {
  if (!ORIGIN_RE.test(origin)) return null;
  return [
    "#!/bin/sh",
    "# Flare Actions runner setup. Usage: curl -fsSL " + origin + "/runner.sh | sh -s <CODE>",
    "set -e",
    'URL="' + origin + '"',
    'CODE="${1:-}"',
    'NAME="${2:-}"',
    'DIR="${FLARE_RUNNER_DIR:-$HOME/flare-runner}"',
    'say() { printf "\\n==> %s\\n" "$1"; }',
    'command -v git >/dev/null 2>&1 || { echo "Flare needs git. Install it from https://git-scm.com/downloads and run this again."; exit 1; }',
    'command -v node >/dev/null 2>&1 || { echo "Flare needs Node.js 22.6 or newer. Install it from https://nodejs.org and run this again."; exit 1; }',
    "node -e 'const [a,b]=process.versions.node.split(\".\").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' || { echo \"Flare needs Node.js 22.6 or newer (you have $(node --version)). Update it from https://nodejs.org and run this again.\"; exit 1; }",
    'if [ -d "$DIR/.git" ]; then',
    '  say "Updating the Flare runner in $DIR"',
    '  git -C "$DIR" pull --ff-only --quiet || echo "(could not update; using the copy you have)"',
    "else",
    '  say "Downloading the Flare runner to $DIR"',
    '  git clone --depth 1 --quiet ' + RUNNER_REPO_URL + ' "$DIR"',
    "fi",
    'cd "$DIR"',
    'say "Installing (this takes a minute the first time)"',
    "npm ci --no-audit --no-fund --loglevel=error",
    'if [ -n "$CODE" ]; then',
    '  say "Connecting this computer to $URL"',
    '  if [ -n "$NAME" ]; then FLARE_ACTIONS_URL="$URL" exec npm run --silent runner -- --pair "$CODE" --pair-name "$NAME"; fi',
    '  FLARE_ACTIONS_URL="$URL" exec npm run --silent runner -- --pair "$CODE"',
    "fi",
    'say "Starting the runner. Keep this window open while your tests run (Ctrl+C stops it)."',
    'FLARE_ACTIONS_URL="$URL" exec npm run --silent runner',
    "",
  ].join("\n");
}
