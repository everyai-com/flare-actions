// g3-max-page-size: cap list pages at 25 to bound payload size and D1 reads.
// DESIGNED INTERACTION (semantic conflict): with g2-default-page-size the
// default (30) exceeds this cap (25). Disjoint files, clean merge, green
// alone, red together. See g2-default-page-size.mjs for the failing tests.
export default {
  id: "g3-max-page-size",
  edits: [
    {
      op: "replace",
      path: "src/lib/pagination.ts",
      find: `export const MAX_PAGE_SIZE = 50;`,
      replace: `export const MAX_PAGE_SIZE = 25;`,
    },
    {
      op: "create",
      path: "test/max-page-size.test.ts",
      content: `import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { parseLimit } from "../src/lib/pagination.ts";
import { resetStore, type Book } from "../src/lib/store.ts";
import { callJson } from "./helpers.ts";

beforeEach(() => {
  const books: Book[] = [];
  for (let i = 0; i < 100; i++) books.push({ id: "b" + i, title: "Book " + i, authorId: "a1", year: 2000 });
  resetStore({ authors: [{ id: "a1", name: "Anon" }], books });
});

test("no page is larger than 25", async () => {
  assert.equal(parseLimit("26", 10), 25);
  const { body } = await callJson("GET", "/books?limit=1000");
  assert.equal(body.items.length, 25);
});
`,
    },
  ],
};
