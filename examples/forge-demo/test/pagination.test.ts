// The page-size contract. Two constants in two files must agree:
// DEFAULT_PAGE_SIZE (src/routes/books.ts) <= MAX_PAGE_SIZE (src/lib/pagination.ts).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAGE_SIZE } from "../src/routes/books.ts";
import { MAX_PAGE_SIZE, parseLimit } from "../src/lib/pagination.ts";
import { resetStore, type Book } from "../src/lib/store.ts";
import { callJson } from "./helpers.ts";

beforeEach(() => {
  const books: Book[] = [];
  for (let i = 0; i < 120; i++) books.push({ id: `b${i}`, title: `Book ${i}`, authorId: "a1", year: 2000 });
  resetStore({ authors: [{ id: "a1", name: "Anon" }], books });
});

test("contract: the default page size is servable", () => {
  assert.ok(DEFAULT_PAGE_SIZE <= MAX_PAGE_SIZE, `DEFAULT_PAGE_SIZE ${DEFAULT_PAGE_SIZE} > MAX_PAGE_SIZE ${MAX_PAGE_SIZE}`);
});

test("parseLimit clamps to [1, MAX_PAGE_SIZE]", () => {
  assert.equal(parseLimit("0", 10), 1);
  assert.equal(parseLimit("1000", 10), MAX_PAGE_SIZE);
  assert.equal(parseLimit(null, 10), 10);
  assert.equal(parseLimit("abc", 10), 10);
});

test("GET /books without ?limit= returns exactly DEFAULT_PAGE_SIZE items", async () => {
  const { body } = await callJson("GET", "/books");
  assert.equal(body.items.length, DEFAULT_PAGE_SIZE);
});

test("GET /books?limit=1000 is clamped to MAX_PAGE_SIZE", async () => {
  const { body } = await callJson("GET", "/books?limit=1000");
  assert.equal(body.items.length, MAX_PAGE_SIZE);
});
