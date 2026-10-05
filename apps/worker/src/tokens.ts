import { findLiveToken, type Db } from "./db";
import { bytesEqual } from "./github";

export const TOKEN_SCOPES = ["runner", "readonly", "admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newTokenValue(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parseScopes(raw: string): TokenScope[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s));
}

export function scopesAllow(scopes: TokenScope[], need: "run" | "read" | "admin"): boolean {
  if (scopes.includes("admin")) return true;
  if (scopes.includes("runner")) return need === "run" || need === "read";
  return need === "read" && scopes.includes("readonly");
}

export function normalizeScopes(input: unknown): TokenScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: TokenScope[] = [];
  for (const s of input) {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (!(TOKEN_SCOPES as readonly string[]).includes(t)) return null;
    if (!out.includes(t as TokenScope)) out.push(t as TokenScope);
  }
  return out.length > 0 ? out : null;
}

// Per-token repo scoping: an empty list means "all repos" (backwards
// compatible with existing tokens); otherwise the token only sees the
// listed owner/name entries.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function normalizeRepos(input: unknown): string[] | null {
  if (input === undefined || input === null || input === "") return [];
  const list = typeof input === "string" ? input.split(",") : input;
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return null;
    const repo = item.trim();
    if (!repo) continue;
    if (!REPO_RE.test(repo)) return null;
    if (!out.includes(repo)) out.push(repo);
  }
  if (out.length > 50) return null;
  return out;
}

export function parseRepos(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => REPO_RE.test(r));
}

export type AuthScope = "admin" | "runner" | "readonly";

export interface ApiTokenIdentity {
  scope: AuthScope;
  actor: string;
  repos: string[];
}

export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return bytesEqual(new Uint8Array(da), new Uint8Array(db));
}

// Bearer validation shared by the HTTP API (authIdentity) and the MCP
// OAuth validator (dual-auth fallback): env secrets first, then D1
// tokens. `repos` is the token's repo allowlist ([] = all repos).
export async function authIdentityFromToken(
  token: string,
  secrets: { db: Db; adminToken?: string; runnerToken?: string },
): Promise<ApiTokenIdentity | null> {
  if (secrets.adminToken && (await timingSafeEqualStr(token, secrets.adminToken))) {
    return { scope: "admin", actor: "break-glass", repos: [] };
  }
  if (secrets.runnerToken && (await timingSafeEqualStr(token, secrets.runnerToken))) {
    return { scope: "runner", actor: "env:runner", repos: [] };
  }
  const row = await findLiveToken(secrets.db, await hashToken(token));
  if (!row) return null;
  const scopes = parseScopes(row.scopes);
  const repos = parseRepos(row.repos ?? "");
  if (scopesAllow(scopes, "admin")) return { scope: "admin", actor: `token:${row.id}`, repos };
  if (scopesAllow(scopes, "run")) return { scope: "runner", actor: `token:${row.id}`, repos };
  if (scopesAllow(scopes, "read")) return { scope: "readonly", actor: `token:${row.id}`, repos };
  return null;
}
