// Browser sessions (cookie `session=<id>`) and the combined authenticate().
// Protected path: changes here need plan approval (.flare/policy.yml).

import type { Env, Principal } from "../lib/http.ts";
import { verifyApiKey } from "./apiKey.ts";

const sessions = new Map<string, string>();

export function createSession(user: string): string {
  const id = crypto.randomUUID();
  sessions.set(id, user);
  return id;
}

export function endSession(id: string): void {
  sessions.delete(id);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function verifySession(req: Request): Principal | null {
  const id = readCookie(req, "session");
  if (id === null) return null;
  const user = sessions.get(id);
  return user === undefined ? null : { kind: "session", id: user };
}

/** Session first, then API key. Null = anonymous. */
export function authenticate(req: Request, env: Env): Principal | null {
  return verifySession(req) ?? verifyApiKey(req, env);
}
