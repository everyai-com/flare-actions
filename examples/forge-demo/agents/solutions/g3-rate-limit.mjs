// g3-rate-limit: fixed-window per-client rate limit (429 past the limit).
// DESIGNED INTERACTION: overlaps g1-metrics on src/index.ts, but edits the
// import block below the logging import and the middleware chain, not
// the route table -> declare-time overlap warning, clean merge, green together.
export default {
  id: "g3-rate-limit",
  edits: [
    {
      op: "create",
      path: "src/middleware/rateLimit.ts",
      content: `// Fixed-window rate limit per client IP (cf-connecting-ip). Isolate-scoped
// counters: good enough to shed abuse at the edge; a Durable Object would
// make it global.

import { HttpError, toResponse } from "../lib/errors.ts";
import type { Env, Next } from "../lib/http.ts";

export const DEFAULT_RATE_LIMIT = 600;
const WINDOW_MS = 60_000;

let windows = new Map<string, { start: number; count: number }>();

export function resetRateLimits(): void {
  windows = new Map();
}

export function rateLimitFor(env: Env): number {
  const n = Number(env.RATE_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RATE_LIMIT;
}

export async function withRateLimit(req: Request, env: Env, next: Next, now = Date.now()): Promise<Response> {
  const client = req.headers.get("cf-connecting-ip") ?? "anonymous";
  const w = windows.get(client);
  if (w === undefined || now - w.start >= WINDOW_MS) {
    windows.set(client, { start: now, count: 1 });
  } else {
    w.count += 1;
    if (w.count > rateLimitFor(env)) {
      const res = toResponse(new HttpError(429, "rate limit exceeded"));
      res.headers.set("retry-after", String(Math.ceil((w.start + WINDOW_MS - now) / 1000)));
      return res;
    }
  }
  return next(req);
}
`,
    },
    {
      op: "replace",
      path: "src/index.ts",
      find: `import { withLogging } from "./middleware/logging.ts";
`,
      replace: `import { withLogging } from "./middleware/logging.ts";
import { withRateLimit } from "./middleware/rateLimit.ts";
`,
    },
    {
      op: "replace",
      path: "src/index.ts",
      find: `  return withLogging(req, (r) => withCors(r, env, (r2) => dispatch(r2, env)));`,
      replace: `  return withLogging(req, (r) => withCors(r, env, (r2) => withRateLimit(r2, env, (r3) => dispatch(r3, env))));`,
    },
    {
      op: "create",
      path: "test/rate-limit.test.ts",
      content: `import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetRateLimits } from "../src/middleware/rateLimit.ts";
import { call } from "./helpers.ts";

const env = { RATE_LIMIT: "2" };

beforeEach(() => resetRateLimits());

test("the request past the limit gets a 429 with retry-after", async () => {
  const headers = { "cf-connecting-ip": "203.0.113.7" };
  assert.equal((await call("GET", "/health", { env, headers })).status, 200);
  assert.equal((await call("GET", "/health", { env, headers })).status, 200);
  const limited = await call("GET", "/health", { env, headers });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(limited.headers.get("access-control-allow-origin"), "*");
});

test("clients are limited independently", async () => {
  for (let i = 0; i < 3; i++) await call("GET", "/health", { env, headers: { "cf-connecting-ip": "203.0.113.8" } });
  const other = await call("GET", "/health", { env, headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(other.status, 200);
});
`,
    },
  ],
};
