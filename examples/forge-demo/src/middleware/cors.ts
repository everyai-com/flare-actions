// CORS: answer preflights and stamp allow-origin on every response.

import type { Env, Next } from "../lib/http.ts";

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS = "content-type, x-api-key, authorization";

function allowOrigin(_req: Request, _env: Env): string | null {
  return "*";
}

function withHeaders(res: Response, origin: string | null): Response {
  const out = new Response(res.body, res);
  if (origin !== null) out.headers.set("access-control-allow-origin", origin);
  return out;
}

export async function withCors(req: Request, env: Env, next: Next): Promise<Response> {
  const origin = allowOrigin(req, env);
  if (req.method === "OPTIONS") {
    const res = new Response(null, {
      status: 204,
      headers: { "access-control-allow-methods": ALLOW_METHODS, "access-control-allow-headers": ALLOW_HEADERS },
    });
    return withHeaders(res, origin);
  }
  return withHeaders(await next(req), origin);
}
