import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore } from "../src/lib/store.ts";
import { callJson } from "./helpers.ts";

beforeEach(() => {
  resetStore({ authors: [{ id: "a1", name: "Ursula K. Le Guin" }], books: [] });
});

test("GET /authors lists authors", async () => {
  const { status, body } = await callJson("GET", "/authors");
  assert.equal(status, 200);
  assert.equal(body.items.length, 1);
});

test("GET /authors/:id returns an author or 404", async () => {
  assert.equal((await callJson("GET", "/authors/a1")).body.name, "Ursula K. Le Guin");
  assert.equal((await callJson("GET", "/authors/zz")).status, 404);
});

test("POST /authors validates and creates (auth required)", async () => {
  assert.equal((await callJson("POST", "/authors", { body: { name: "N. K. Jemisin" } })).status, 401);
  assert.equal((await callJson("POST", "/authors", { auth: true, body: { name: "" } })).status, 400);
  const ok = await callJson("POST", "/authors", { auth: true, body: { name: "N. K. Jemisin" } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, "N. K. Jemisin");
});
