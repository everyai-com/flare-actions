import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Tailscale-style pairing, runner half: exchange a one-time code for a
// runner token and persist it. One pasted command, zero config files:
//   FLARE_ACTIONS_URL=https://<worker> npm run runner -- --pair K7MD-Q2XA
// The token lands in ./.env (same merge semantics as setup: wanted keys
// replaced, unknown lines preserved, 0600), so the next start just polls.

export interface PairOptions {
  baseUrl: string;
  code: string;
  name?: string;
  cwd: string;
  fetchFn?: typeof fetch;
}

export async function exchangePairingCode(opts: PairOptions): Promise<{ token: string; name: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${opts.baseUrl.replace(/\/$/, "")}/v1/pair/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: opts.code.trim().toUpperCase(), ...(opts.name ? { name: opts.name } : {}) }),
  });
  if (!res.ok) {
    // Prefer the server's coded hint; fall back to local guidance
    // when the body is missing (old servers, proxies).
    const body = (await res.json().catch(() => ({}))) as { hint?: unknown };
    const hint = typeof body.hint === "string" && body.hint ? body.hint : null;
    if (res.status === 404) throw new Error(hint ?? "pairing code invalid or expired — mint a fresh one in dashboard Access → Pair a runner");
    if (res.status === 429) throw new Error(hint ?? "too many pairing attempts — try again later");
    throw new Error(hint ? `pairing exchange failed: HTTP ${res.status} — ${hint}` : `pairing exchange failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { token?: unknown; name?: unknown };
  if (typeof data.token !== "string" || !data.token) throw new Error("pairing exchange returned no token");
  return { token: data.token, name: typeof data.name === "string" ? data.name : "paired runner" };
}

// Merge wanted keys into an .env file, preserving unknown lines
// (mirrors scripts/setup.mjs step 10, minus the seats key).
export function mergeEnvFile(cwd: string, wanted: Record<string, string>): string {
  const path = join(cwd, ".env");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.split("=")[0].trim();
    if (key && key in wanted) {
      out.push(`${key}=${wanted[key]}`);
      seen.add(key);
    } else if (line.trim()) {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(wanted)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(path, `${out.join("\n")}\n`, { mode: 0o600 });
  return path;
}

export async function pairRunner(opts: PairOptions): Promise<{ token: string; name: string; envPath: string }> {
  const { token, name } = await exchangePairingCode(opts);
  const envPath = mergeEnvFile(opts.cwd, { FLARE_ACTIONS_URL: opts.baseUrl, RUNNER_TOKEN: token });
  return { token, name, envPath };
}
