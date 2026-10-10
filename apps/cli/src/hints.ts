// Small, pure CLI UX helpers: the FLARE_TOKEN alias, one shared
// "missing config" message, and "did you mean" suggestions for typos.
// Dependency-free so tests stay trivial.

export interface EnvLocation {
  // Absolute path of the .env that loadEnv() read, or null if none.
  path: string | null;
  // Directory the upward .env search started from.
  searchedFrom: string;
}

type Env = Record<string, string | undefined>;

function present(v: string | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

// README tells users to `export FLARE_TOKEN=...`; everything else reads
// RUNNER_TOKEN. Fill RUNNER_TOKEN from FLARE_TOKEN when it is unset or
// empty. Returns true when the alias was applied.
export function applyTokenAlias(env: Env): boolean {
  if (present(env["RUNNER_TOKEN"])) return false;
  if (!present(env["FLARE_TOKEN"])) return false;
  env["RUNNER_TOKEN"] = env["FLARE_TOKEN"];
  return true;
}

export function resolveToken(env: Env): string | undefined {
  if (present(env["RUNNER_TOKEN"])) return env["RUNNER_TOKEN"];
  if (present(env["FLARE_TOKEN"])) return env["FLARE_TOKEN"];
  return undefined;
}

// Names the missing variables; empty when both are set.
export function missingConfigVars(env: Env): string[] {
  const missing: string[] = [];
  if (!present(env["FLARE_ACTIONS_URL"])) missing.push("FLARE_ACTIONS_URL");
  if (!resolveToken(env)) missing.push("RUNNER_TOKEN (or FLARE_TOKEN)");
  return missing;
}

export function describeEnvLocation(loc: EnvLocation | undefined): string {
  if (!loc) return ".env: not checked";
  if (loc.path) return `.env: read ${loc.path}`;
  return `.env: none found in ${loc.searchedFrom} or its 5 parent directories`;
}

// One message for every command that needs a deployment + token.
// `cli` is how the user invoked the CLI (see cliInvocation).
export function missingConfigMessage(missing: string[], loc: EnvLocation | undefined, cli = "npm run cli --"): string {
  return [
    `Not set up yet: missing ${missing.join(" and ")}.`,
    `  ${describeEnvLocation(loc)}`,
    `  fix: \`${cli} login\` (pair with a code from dashboard Settings), or \`npm run setup\` for a new deployment,`,
    "       or export FLARE_ACTIONS_URL and RUNNER_TOKEN (FLARE_TOKEN also works).",
    nextLine(cli, "login", "then `doctor` to check"),
  ].join("\n");
}

// How the user ran the CLI, so every "next:" line is copy-pasteable:
// `npm run cli --` from a clone, `npx flare-forge` via npx, or the
// installed bin name (`flare`, `flare-forge`). Falls back to the
// in-repo form.
export function cliInvocation(argv: readonly string[], env: Env): string {
  if (env["npm_lifecycle_event"] === "cli") return "npm run cli --";
  if (env["npm_lifecycle_event"] === "start" && env["npm_package_name"] === "flare-forge") return "npm start --";
  const script = (argv[1] ?? "").split(/[\\/]/).pop() ?? "";
  const bin = script.replace(/\.m?js$/, "");
  if (env["npm_command"] === "exec") return "npx flare-forge";
  if (bin === "flare" || bin === "flare-forge") return bin;
  if (script === "cli.mjs") return "npx flare-forge";
  return "npm run cli --";
}

// The one "next move" line that ends every human-facing outcome.
// `command` is a CLI command (prefixed with the invocation); `why` is
// an optional short reason in plain words.
export function nextLine(cli: string, command: string, why?: string): string {
  return `next: ${cli} ${command}${why ? `   (${why})` : ""}`;
}

// A next move that is not a CLI command (open a page, edit a file).
export function nextText(text: string): string {
  return `next: ${text}`;
}

export interface DigestLike {
  runId: string;
  status: string;
  repo: string;
}

// After a run finishes (run, watch, logs): failed -> explain it, still
// going -> keep watching, green -> see recent checks.
export function nextAfterRun(cli: string, d: DigestLike): string {
  if (d.status === "success") return nextLine(cli, "runs", "all green; see recent checks");
  if (d.status === "queued" || d.status === "running" || d.status === "blocked") return nextLine(cli, `watch ${d.runId}`, "still running");
  return nextLine(cli, `explain ${d.runId}`, "what broke and how to fix it");
}

export interface ApiErrorLike {
  status: number;
  code: string | null;
}

// The next command after an error. API errors switch on the status:
// auth problems and outages go to `doctor` (it names the fix), unknown
// ids go back to the run list, budget/pause go to usage/paused.
export function nextAfterError(cli: string, err: ApiErrorLike | null): string {
  if (!err) return nextLine(cli, "doctor", "checks the URL, token and runners");
  if (err.status === 401 || err.status === 403) return nextLine(cli, "doctor", "checks your token and its scope");
  if (err.status === 404) return nextLine(cli, "runs", "find the right id");
  if (err.code === "repo_paused") return nextLine(cli, "paused", "see why the project is paused");
  if (err.status === 429) return nextLine(cli, "usage", "see what used the budget");
  if (err.status === 400 || err.status === 422) return nextLine(cli, "--help", "check the arguments");
  return nextLine(cli, "doctor", "checks the deployment");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Closest known command: edit distance <= 2, else a prefix match either
// way (`dep` -> `dispatch` no, `disp` -> `dispatch` yes). null if nothing
// is plausibly what the user meant.
export function suggestCommand(input: string, known: readonly string[]): string | null {
  const needle = input.toLowerCase();
  if (!needle) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const k of known) {
    const d = levenshtein(needle, k);
    // Ties go to the candidate closest in length (`rnus` -> `runs`).
    const closer = best !== null && Math.abs(k.length - needle.length) < Math.abs(best.length - needle.length);
    if (d < bestDist || (d === bestDist && closer)) {
      best = k;
      bestDist = d;
    }
  }
  if (best && bestDist <= 2 && bestDist < Math.max(needle.length, 2)) return best;
  if (needle.length >= 2) {
    const prefix = known.find((k) => k.startsWith(needle) || needle.startsWith(k));
    if (prefix) return prefix;
  }
  return null;
}
