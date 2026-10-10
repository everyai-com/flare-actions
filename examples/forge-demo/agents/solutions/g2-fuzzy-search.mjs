// g2-fuzzy-search: ?q= matches case-insensitive substrings, not prefixes.
// Disjoint lane (src/lib/store.ts).
export default {
  id: "g2-fuzzy-search",
  edits: [
    {
      op: "replace",
      path: "src/lib/store.ts",
      find: `function matchesQuery(book: Book, q: string): boolean {
  return book.title.startsWith(q);
}`,
      replace: `function matchesQuery(book: Book, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return needle === "" || book.title.toLowerCase().includes(needle);
}`,
    },
    {
      op: "create",
      path: "test/fuzzy-search.test.ts",
      content: `import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore } from "../src/lib/store.ts";
import { callJson } from "./helpers.ts";

beforeEach(() => {
  resetStore({
    authors: [{ id: "a1", name: "Frank Herbert" }],
    books: [
      { id: "b1", title: "Dune", authorId: "a1", year: 1965 },
      { id: "b2", title: "Children of Dune", authorId: "a1", year: 1976 },
      { id: "b3", title: "The Dosadi Experiment", authorId: "a1", year: 1977 },
    ],
  });
});

test("?q= is case-insensitive and matches anywhere in the title", async () => {
  const { body } = await callJson("GET", "/books?q=dune");
  assert.deepEqual(body.items.map((b: { id: string }) => b.id), ["b1", "b2"]);
});
`,
    },
  ],
};
