// Error type + the single place errors turn into HTTP responses.

import { json } from "./http.ts";

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found`);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function toResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message }, err.status);
  }
  return json({ error: "internal error" }, 500);
}
