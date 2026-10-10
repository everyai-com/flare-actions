import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore } from "../src/lib/store.ts";
import { callJson } from "./helpers.ts";

beforeEach(() => {
  resetStore({
    authors: [{ id: "a1", name: "Frank Herbert" }],
    books: [
      { id: "b1", title: "Dune", authorId: "a1", year: 1965 },
      { id: "b2", title: "Dune Messiah", authorId: "a1", year: 1969 },
      { id: "b3", title: "The Dosadi Experiment", authorId: "a1", year: 1977 },
    ],
  });
});

test("GET /books lists books", async () => {
  const { status, body } = await callJson("GET", "/books");
  assert.equal(status, 200);
  assert.equal(body.items.length, 3);
  assert.equal(body.nextCursor, null);
});

test("GET /books?q= filters by title", async () => {
  const { body } = await callJson("GET", "/books?q=Dune");
  assert.deepEqual(body.items.map((b: { id: string }) => b.id), ["b1", "b2"]);
});

test("GET /books?limit=&cursor= pages", async () => {
  const first = await callJson("GET", "/books?limit=2");
  assert.equal(first.body.items.length, 2);
  assert.equal(first.body.nextCursor, "2");
  const second = await callJson("GET", "/books?limit=2&cursor=2");
  assert.deepEqual(second.body.items.map((b: { id: string }) => b.id), ["b3"]);
});

test("GET /books/:id returns a book or 404", async () => {
  assert.equal((await callJson("GET", "/books/b1")).body.title, "Dune");
  assert.equal((await callJson("GET", "/books/missing")).status, 404);
});

test("POST /books requires auth", async () => {
  const { status } = await callJson("POST", "/books", { body: { title: "X", authorId: "a1", year: 2000 } });
  assert.equal(status, 401);
});

test("POST /books validates and creates", async () => {
  const bad = await callJson("POST", "/books", { auth: true, body: { title: "", authorId: "a1", year: 2000 } });
  assert.equal(bad.status, 400);
  const unknown = await callJson("POST", "/books", { auth: true, body: { title: "X", authorId: "zz", year: 2000 } });
  assert.equal(unknown.status, 400);
  const ok = await callJson("POST", "/books", {
    auth: true,
    body: { title: "Children of Dune", authorId: "a1", year: 1976, isbn: "9780306406157" },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.title, "Children of Dune");
});

test("DELETE /books/:id removes a book", async () => {
  assert.equal((await callJson("DELETE", "/books/b1", { auth: true })).status, 204);
  assert.equal((await callJson("GET", "/books/b1")).status, 404);
});
