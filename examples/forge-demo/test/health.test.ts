import { test } from "node:test";
import assert from "node:assert/strict";
import { callJson } from "./helpers.ts";

test("GET /health reports ok", async () => {
  const { status, body } = await callJson("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});
