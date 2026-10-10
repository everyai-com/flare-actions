// g2-default-page-size: raise /books default page size 20 -> 30.
// DESIGNED INTERACTION (semantic conflict): footprint is disjoint from
// g3-max-page-size (src/lib/pagination.ts), git merges cleanly, each is
// green alone, but together DEFAULT 30 > MAX 25 and train CI goes red:
//   test/pagination.test.ts  "contract: the default page size is servable"
//   test/pagination.test.ts  "GET /books without ?limit= returns exactly DEFAULT_PAGE_SIZE items"
//   test/default-page-size.test.ts  (this intent's own accept check)
export default {
  id: "g2-default-page-size",
  edits: [
    {
      op: "replace",
      path: "src/routes/books.ts",
      find: `export const DEFAULT_PAGE_SIZE = 20;`,
      replace: `export const DEFAULT_PAGE_SIZE = 30;`,
    },
    {
      op: "create",
      path: "test/default-page-size.test.ts",
      content: `import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore, type Book } from "../src/lib/store.ts";
import { callJson } from "./helpers.ts";

beforeEach(() => {
  const books: Book[] = [];
  for (let i = 0; i < 100; i++) books.push({ id: "b" + i, title: "Book " + i, authorId: "a1", year: 2000 });
  resetStore({ authors: [{ id: "a1", name: "Anon" }], books });
});

test("GET /books returns 30 books per page by default", async () => {
  const { body } = await callJson("GET", "/books");
  assert.equal(body.items.length, 30);
  assert.equal(body.nextCursor, "30");
});
`,
    },
  ],
};
