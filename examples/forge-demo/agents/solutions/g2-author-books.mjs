// g2-author-books: GET /authors/:id/books. Disjoint lane (src/routes/authors.ts).
// Uses its own page default (10) on purpose: it must not depend on
// books.ts's DEFAULT_PAGE_SIZE, which another intent is changing.
export default {
  id: "g2-author-books",
  edits: [
    {
      op: "replace",
      path: "src/routes/authors.ts",
      find: `import { addAuthor, getAuthor, listAuthors } from "../lib/store.ts";
`,
      replace: `import { parseCursor, parseLimit } from "../lib/pagination.ts";
import { addAuthor, getAuthor, listAuthors, listBooks } from "../lib/store.ts";
`,
    },
    {
      op: "replace",
      path: "src/routes/authors.ts",
      find: `      if (author === undefined) throw notFound("author");
      return json(author);
    },
  },
`,
      replace: `      if (author === undefined) throw notFound("author");
      return json(author);
    },
  },
  {
    method: "GET",
    path: "/authors/:id/books",
    handler: ({ params, url }) => {
      if (getAuthor(params.id) === undefined) throw notFound("author");
      const limit = parseLimit(url.searchParams.get("limit"), AUTHOR_BOOKS_PAGE_SIZE);
      const offset = parseCursor(url.searchParams.get("cursor"));
      return json(listBooks({ authorId: params.id, offset, limit }));
    },
  },
`,
    },
    {
      op: "replace",
      path: "src/routes/authors.ts",
      find: `export const authorRoutes: Route[] = [
`,
      replace: `/** Page size for an author's bibliography. */
export const AUTHOR_BOOKS_PAGE_SIZE = 10;

export const authorRoutes: Route[] = [
`,
    },
    {
      op: "create",
      path: "test/author-books.test.ts",
      content: `import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore } from "../src/lib/store.ts";
import { callJson } from "./helpers.ts";

beforeEach(() => {
  resetStore({
    authors: [
      { id: "a1", name: "Ursula K. Le Guin" },
      { id: "a2", name: "Frank Herbert" },
    ],
    books: [
      { id: "b1", title: "A Wizard of Earthsea", authorId: "a1", year: 1968 },
      { id: "b2", title: "Dune", authorId: "a2", year: 1965 },
      { id: "b3", title: "The Lathe of Heaven", authorId: "a1", year: 1971 },
    ],
  });
});

test("GET /authors/:id/books lists only that author's books", async () => {
  const { status, body } = await callJson("GET", "/authors/a1/books");
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((b: { id: string }) => b.id), ["b1", "b3"]);
});

test("GET /authors/:id/books is a 404 for an unknown author", async () => {
  assert.equal((await callJson("GET", "/authors/zz/books")).status, 404);
});
`,
    },
  ],
};
