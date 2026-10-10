// Request body validators. Return a typed value or throw a 400.

import { badRequest } from "./errors.ts";

export type NewBook = { title: string; authorId: string; year: number; isbn?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateBook(body: unknown): NewBook {
  if (!isRecord(body)) throw badRequest("body must be a JSON object");
  const { title, authorId, year, isbn } = body;
  if (typeof title !== "string" || title.trim() === "" || title.length > 200) {
    throw badRequest("title must be 1-200 characters");
  }
  if (typeof authorId !== "string" || authorId === "") {
    throw badRequest("authorId is required");
  }
  if (typeof year !== "number" || !Number.isInteger(year) || year < 0 || year > 3000) {
    throw badRequest("year must be an integer");
  }
  if (isbn !== undefined && typeof isbn !== "string") {
    throw badRequest("isbn must be a string");
  }
  return isbn === undefined ? { title: title.trim(), authorId, year } : { title: title.trim(), authorId, year, isbn };
}

export function validateAuthor(body: unknown): { name: string } {
  if (!isRecord(body)) throw badRequest("body must be a JSON object");
  const { name } = body;
  if (typeof name !== "string" || name.trim() === "" || name.length > 120) {
    throw badRequest("name must be 1-120 characters");
  }
  return { name: name.trim() };
}
