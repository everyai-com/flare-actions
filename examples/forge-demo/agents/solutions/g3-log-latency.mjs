// g3-log-latency: log how long each request took.
// DESIGNED INTERACTION: same lines of src/middleware/logging.ts as
// g1-request-id -> real textual merge conflict. `replayOn["g1-request-id"]`
// is the re-derived change on a trunk that already carries request ids
// (what a replaying agent produces with both intents' reasoning in context).

const test = {
  op: "create",
  path: "test/log-latency.test.ts",
  content: `import { test } from "node:test";
import assert from "node:assert/strict";
import { callJson, logLines } from "./helpers.ts";

test("access-log lines carry a non-negative integer durationMs", async () => {
  await callJson("GET", "/health");
  const line = JSON.parse(logLines[logLines.length - 1]);
  assert.equal(typeof line.durationMs, "number");
  assert.ok(Number.isInteger(line.durationMs) && line.durationMs >= 0);
});
`,
};

export default {
  id: "g3-log-latency",
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
      replace: `export function formatLogLine(req: Request, res: Response, durationMs: number): string {
  const url = new URL(req.url);
  return JSON.stringify({ level: "info", method: req.method, path: url.pathname, status: res.status, durationMs });
}

export async function withLogging(req: Request, next: Next): Promise<Response> {
  const started = performance.now();
  const res = await next(req);
  sink(formatLogLine(req, res, Math.round(performance.now() - started)));
  return res;
}`,
    },
    test,
  ],
  replayOn: {
    "g1-request-id": [
      {
        op: "replace",
        path: "src/middleware/logging.ts",
        find: `export function formatLogLine(req: Request, res: Response, requestId: string): string {
  const url = new URL(req.url);
  return JSON.stringify({ level: "info", method: req.method, path: url.pathname, status: res.status, requestId });
}`,
        replace: `export function formatLogLine(req: Request, res: Response, requestId: string, durationMs: number): string {
  const url = new URL(req.url);
  return JSON.stringify({ level: "info", method: req.method, path: url.pathname, status: res.status, requestId, durationMs });
}`,
      },
      {
        op: "replace",
        path: "src/middleware/logging.ts",
        find: `  const requestId = requestIdFor(req);
  const inner = await next(req);`,
        replace: `  const requestId = requestIdFor(req);
  const started = performance.now();
  const inner = await next(req);`,
      },
      {
        op: "replace",
        path: "src/middleware/logging.ts",
        find: `  sink(formatLogLine(req, res, requestId));`,
        replace: `  sink(formatLogLine(req, res, requestId, Math.round(performance.now() - started)));`,
      },
      test,
    ],
  },
};
