import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// `cli login`: guided pairing for humans and agents. Takes a one-time
// pairing code (dashboard Settings → Pair a runner), exchanges it for a
// runner token, and merges FLARE_ACTIONS_URL + RUNNER_TOKEN into .env
// (0600, unknown lines preserved) so every other command just works.

export interface LoginOptions {
  baseUrl?: string;
  code?: string;
  cwd: string;
  fetchFn?: typeof fetch;
  prompt?: (question: string) => Promise<string>;
}

export interface LoginResult {
  token: string;
  name: string;
  envPath: string;
  baseUrl: string;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("a worker URL is required");
  if (!/^https?:\/\//.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function mergeLoginEnv(cwd: string, baseUrl: string, token: string): string {
  const path = join(cwd, ".env");
  const wanted: Record<string, string> = { FLARE_ACTIONS_URL: baseUrl, RUNNER_TOKEN: token };
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

function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runLogin(opts: LoginOptions): Promise<LoginResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const prompt = opts.prompt ?? defaultPrompt;
  let baseUrl = (opts.baseUrl ?? process.env["FLARE_ACTIONS_URL"] ?? "").trim();
  if (!baseUrl) baseUrl = await prompt("Worker URL (https://<worker>.workers.dev): ");
  const normalized = normalizeBaseUrl(baseUrl);
  let code = (opts.code ?? "").trim();
  if (!code) code = await prompt("Pairing code (dashboard Settings → Pair a runner): ");
  code = normalizeCode(code);
  if (!code) throw new Error("a pairing code is required");
  const res = await fetchFn(`${normalized}/v1/pair/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { hint?: unknown; error?: unknown };
    const hint = typeof data.hint === "string" ? data.hint : null;
    if (res.status === 404) throw new Error(hint ?? "pairing code invalid or expired — mint a fresh one in dashboard Settings → Pair a runner");
    if (res.status === 429) throw new Error(hint ?? "too many pairing attempts — try again later");
    throw new Error(hint ? `login failed: HTTP ${res.status} — ${hint}` : `login failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { token?: unknown; name?: unknown };
  if (typeof data.token !== "string" || !data.token) throw new Error("login returned no token");
  const envPath = mergeLoginEnv(opts.cwd, normalized, data.token);
  return { token: data.token, name: typeof data.name === "string" ? data.name : "paired runner", envPath, baseUrl: normalized };
}
