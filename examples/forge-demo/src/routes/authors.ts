// /authors: list, get, create.

import { notFound } from "../lib/errors.ts";
import { json, readJson, type Route } from "../lib/http.ts";
import { addAuthor, getAuthor, listAuthors } from "../lib/store.ts";
import { validateAuthor } from "../lib/validate.ts";

export const authorRoutes: Route[] = [
  {
    method: "GET",
    path: "/authors",
    handler: () => json({ items: listAuthors() }),
  },
  {
    method: "GET",
    path: "/authors/:id",
    handler: ({ params }) => {
      const author = getAuthor(params.id);
      if (author === undefined) throw notFound("author");
      return json(author);
    },
  },
  {
    method: "POST",
    path: "/authors",
    auth: true,
    handler: async ({ req }) => json(addAuthor(validateAuthor(await readJson(req)).name), 201),
  },
];
