// g1-health-version: /health reports build version and uptime. Disjoint lane.
export default {
  id: "g1-health-version",
  edits: [
    {
      op: "replace",
      path: "src/routes/health.ts",
      find: `import { json, type Route } from "../lib/http.ts";

export const healthRoutes: Route[] = [
  {
    method: "GET",
    path: "/health",
    handler: () => json({ ok: true }),
  },
];`,
      replace: `import { json, type Route } from "../lib/http.ts";

/** Bumped by the release script; surfaced so deploys are verifiable. */
export const VERSION = "1.4.0";

const startedAt = Date.now();

export const healthRoutes: Route[] = [
  {
    method: "GET",
    path: "/health",
    handler: () => json({ ok: true, version: VERSION, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }),
  },
];`,
    },
    {
      op: "create",
      path: "test/health-version.test.ts",
      content: `import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/routes/health.ts";
import { callJson } from "./helpers.ts";

test("GET /health reports version and uptime", async () => {
  const { body } = await callJson("GET", "/health");
  assert.equal(body.ok, true);
  assert.equal(body.version, VERSION);
  assert.match(body.version, /^\\d+\\.\\d+\\.\\d+$/);
  assert.ok(Number.isInteger(body.uptimeSeconds) && body.uptimeSeconds >= 0);
});
`,
    },
  ],
};
