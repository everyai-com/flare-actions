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
export function missingConfigMessage(missing: string[], loc: EnvLocation | undefined): string {
  return [
    `Not configured: missing ${missing.join(" and ")}.`,
    `  ${describeEnvLocation(loc)}`,
    "  fix: `npm run cli -- login` (pair with a code from dashboard Settings) or `npm run setup` (new deployment),",
    "       or export FLARE_ACTIONS_URL and RUNNER_TOKEN (FLARE_TOKEN also works).",
    "  then: `npm run cli -- doctor` to verify.",
  ].join("\n");
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
