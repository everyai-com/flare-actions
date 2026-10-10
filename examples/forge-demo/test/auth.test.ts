import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/auth/session.ts";
import { callJson } from "./helpers.ts";

const book = { title: "Auth Test", authorId: "a_herbert", year: 2001 };

test("a wrong API key is rejected", async () => {
  const { status } = await callJson("POST", "/books", { headers: { "x-api-key": "nope" }, body: book });
  assert.equal(status, 401);
});

test("no API key configured means API-key auth is off", async () => {
  const { status } = await callJson("POST", "/books", { env: {}, headers: { "x-api-key": "" }, body: book });
  assert.equal(status, 401);
});

test("a valid session cookie authorizes writes", async () => {
  const id = createSession("alice");
  const { status } = await callJson("POST", "/books", { headers: { cookie: `session=${id}` }, body: book });
  assert.equal(status, 201);
});
