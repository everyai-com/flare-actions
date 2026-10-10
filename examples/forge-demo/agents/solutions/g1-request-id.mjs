// g1-request-id: stamp every request with an id, echo it, and log it.
// DESIGNED INTERACTION: same lines of src/middleware/logging.ts as
// g3-log-latency -> real textual merge conflict.
export default {
  id: "g1-request-id",
  edits: [
    {
      op: "replace",
      path: "src/middleware/logging.ts",
      find: `export function formatLogLine(req: Request, res: Response): string {
  const url = new URL(req.url);
  return JSON.stringify({ level: "info", method: req.method, path: url.pathname, status: res.status });
}

export async function withLogging(req: Request, next: Next): Promise<Response> {
  const res = await next(req);
  sink(formatLogLine(req, res));
  return res;
}`,
      replace: `export function formatLogLine(req: Request, res: Response, requestId: string): string {
  const url = new URL(req.url);
  return JSON.stringify({ level: "info", method: req.method, path: url.pathname, status: res.status, requestId });
}

/** Reuse the caller's id (or Cloudflare's cf-ray) so traces join across hops. */
export function requestIdFor(req: Request): string {
  return req.headers.get("x-request-id") ?? req.headers.get("cf-ray") ?? crypto.randomUUID();
}

export async function withLogging(req: Request, next: Next): Promise<Response> {
  const requestId = requestIdFor(req);
  const inner = await next(req);
  const res = new Response(inner.body, inner);
  res.headers.set("x-request-id", requestId);
  sink(formatLogLine(req, res, requestId));
  return res;
}`,
    },
    {
      op: "create",
      path: "test/request-id.test.ts",
      content: `import { test } from "node:test";
import assert from "node:assert/strict";
import { call, logLines } from "./helpers.ts";

test("responses carry an x-request-id", async () => {
  const res = await call("GET", "/health");
  assert.match(res.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
});

test("an incoming x-request-id is echoed and logged", async () => {
  const res = await call("GET", "/health", { headers: { "x-request-id": "trace-abc" } });
  assert.equal(res.headers.get("x-request-id"), "trace-abc");
  const line = JSON.parse(logLines[logLines.length - 1]);
  assert.equal(line.requestId, "trace-abc");
});
`,
    },
  ],
};
