// Shared secrets helpers for runners, seats, and tests. Pure string ops
// only — no Node or Workers APIs — so both runtimes import this file.
// Secrets interpolate executor-side (never worker-side) so plaintext
// values never land in jobs.definition or any API response.

export const SECRETS_PATTERN = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Replace ${{ secrets.NAME }} with the value, or "" when unset (GitHub
// parity: missing secrets evaluate empty, they never leak the placeholder).
export function interpolateSecrets(text: string, secrets: Record<string, string>): string {
  return text.replace(SECRETS_PATTERN, (_match, name: string) => secrets[name] ?? "");
}

// Redact every secret value from logs and result JSON. Longest values
// first so overlapping values mask fully; empty values never match.
export function maskSecrets(text: string, secrets: Record<string, string>): string {
  const values = Object.values(secrets).filter((v) => v.length > 0);
  values.sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) {
    out = out.split(value).join("***");
  }
  return out;
}

// True when a step still references secrets after interpolation (no
// values were available at all — surfaces a warning, not a leak).
export function hasSecretPlaceholders(text: string): boolean {
  SECRETS_PATTERN.lastIndex = 0;
  return SECRETS_PATTERN.test(text);
}
