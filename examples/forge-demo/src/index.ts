// Bookshelf API: a zero-dependency Cloudflare Worker.
//
// Layout: the route table (top) is assembled from per-module route lists;
// the middleware chain (bottom) wraps dispatch. Keep the two regions
// apart so route and middleware changes merge independently.

import { authenticate } from "./auth/session.ts";
import { withCors } from "./middleware/cors.ts";
import { withLogging } from "./middleware/logging.ts";
import { authorRoutes } from "./routes/authors.ts";
import { bookRoutes } from "./routes/books.ts";
import { healthRoutes } from "./routes/health.ts";
import { HttpError, toResponse } from "./lib/errors.ts";
import type { Env, Route } from "./lib/http.ts";

// --- route table -----------------------------------------------------------

export const routes: Route[] = [
  ...healthRoutes,
  ...bookRoutes,
  ...authorRoutes,
];

// --- dispatch --------------------------------------------------------------

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

async function dispatch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  let pathMatched = false;
  try {
    for (const route of routes) {
      const params = matchPath(route.path, url.pathname);
      if (params === null) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const principal = authenticate(req, env);
      if (route.auth === true && principal === null) throw new HttpError(401, "authentication required");
      return await route.handler({ req, url, env, params, principal });
    }
    throw pathMatched ? new HttpError(405, "method not allowed") : new HttpError(404, "route not found");
  } catch (err) {
    return toResponse(err);
  }
}

// --- middleware chain --------------------------------------------------------

export async function handle(req: Request, env: Env): Promise<Response> {
  return withLogging(req, (r) => withCors(r, env, (r2) => dispatch(r2, env)));
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
