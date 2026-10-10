import { test } from "node:test";
import assert from "node:assert/strict";
import { call } from "./helpers.ts";

test("responses allow any origin by default", async () => {
  const res = await call("GET", "/health", { headers: { origin: "https://example.com" } });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("preflight answers 204 with allowed methods", async () => {
  const res = await call("OPTIONS", "/books", { headers: { origin: "https://example.com" } });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
});
