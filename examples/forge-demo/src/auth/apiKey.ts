// API-key auth for automation clients (header `x-api-key`).
// Protected path: changes here need plan approval (.flare/policy.yml).

import type { Env, Principal } from "../lib/http.ts";

/** Constant-time string compare (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyApiKey(req: Request, env: Env): Principal | null {
  const presented = req.headers.get("x-api-key");
  const expected = env.API_KEY;
  if (presented === null || expected === undefined || expected === "") return null;
  return safeEqual(presented, expected) ? { kind: "apiKey", id: "key" } : null;
}
