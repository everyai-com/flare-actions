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
