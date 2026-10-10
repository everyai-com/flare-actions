// /books: list (paged, filterable), get, create, delete.

import { badRequest, notFound } from "../lib/errors.ts";
import { json, readJson, type Route } from "../lib/http.ts";
import { parseCursor, parseLimit } from "../lib/pagination.ts";
import { addBook, deleteBook, getAuthor, getBook, listBooks } from "../lib/store.ts";
import { validateBook } from "../lib/validate.ts";

/** Page size when the client sends no `?limit=`. Must be <= MAX_PAGE_SIZE. */
export const DEFAULT_PAGE_SIZE = 20;

export const bookRoutes: Route[] = [
  {
    method: "GET",
    path: "/books",
    handler: ({ url }) => {
      const q = url.searchParams.get("q") ?? undefined;
      const authorId = url.searchParams.get("author") ?? undefined;
      const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_PAGE_SIZE);
      const offset = parseCursor(url.searchParams.get("cursor"));
      return json(listBooks({ q, authorId, offset, limit }));
    },
  },
  {
    method: "GET",
    path: "/books/:id",
    handler: ({ params }) => {
      const book = getBook(params.id);
      if (book === undefined) throw notFound("book");
      return json(book);
    },
  },
  {
    method: "POST",
    path: "/books",
    auth: true,
    handler: async ({ req }) => {
      const input = validateBook(await readJson(req));
      if (getAuthor(input.authorId) === undefined) throw badRequest("unknown authorId");
      return json(addBook(input), 201);
    },
  },
  {
    method: "DELETE",
    path: "/books/:id",
    auth: true,
    handler: ({ params }) => {
      if (!deleteBook(params.id)) throw notFound("book");
      return new Response(null, { status: 204 });
    },
  },
];
