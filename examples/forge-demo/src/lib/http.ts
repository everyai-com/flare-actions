// Shared request/route types. Plain types only: this repo runs under
// Node type stripping (no enums, no parameter properties, no namespaces).

export type Env = {
  /** Accepted API key(s) for writes (header `x-api-key`). */
  API_KEY?: string;
  /** Comma-separated CORS origin allowlist; unset = `*`. */
  CORS_ORIGINS?: string;
  /** Requests per minute per client; unset = default. */
  RATE_LIMIT?: string;
};

export type Principal = { kind: "apiKey" | "session"; id: string };

export type Ctx = {
  req: Request;
  url: URL;
  env: Env;
  params: Record<string, string>;
  principal: Principal | null;
};

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

export type Route = {
  method: string;
  /** Path pattern; `:name` segments become params. */
  path: string;
  /** Writes require an authenticated principal. */
  auth?: boolean;
  handler: Handler;
};

export type Next = (req: Request) => Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
