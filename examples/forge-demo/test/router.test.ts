import { test } from "node:test";
import assert from "node:assert/strict";
import { callJson } from "./helpers.ts";

test("unknown route is a 404 with an error body", async () => {
  const { status, body } = await callJson("GET", "/nope");
  assert.equal(status, 404);
  assert.equal(typeof body.error, "string");
});

test("known path with the wrong method is a 405", async () => {
  const { status } = await callJson("PUT", "/books");
  assert.equal(status, 405);
});
