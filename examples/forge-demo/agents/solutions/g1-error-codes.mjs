// g1-error-codes: every error body carries a stable machine-readable code.
// Disjoint lane (src/lib/errors.ts). Additive: `error` keeps its message.
export default {
  id: "g1-error-codes",
  edits: [
    {
      op: "replace",
      path: "src/lib/errors.ts",
      find: `export function toResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message }, err.status);
  }
  return json({ error: "internal error" }, 500);
}`,
      replace: `const CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  429: "rate_limited",
};

/** Stable code for clients to branch on; messages may change, codes don't. */
export function errorCode(status: number): string {
  return CODES[status] ?? (status >= 500 ? "internal" : "error");
}

export function toResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, code: errorCode(err.status) }, err.status);
  }
  return json({ error: "internal error", code: "internal" }, 500);
}`,
    },
    {
      op: "create",
      path: "test/error-codes.test.ts",
      content: `import { test } from "node:test";
import assert from "node:assert/strict";
import { callJson } from "./helpers.ts";

test("error bodies carry stable codes next to the message", async () => {
  const cases: Array<[string, string, number, string]> = [
    ["GET", "/nope", 404, "not_found"],
    ["PUT", "/books", 405, "method_not_allowed"],
    ["POST", "/books", 401, "unauthorized"],
  ];
  for (const [method, path, status, code] of cases) {
    const res = await callJson(method, path);
    assert.equal(res.status, status, method + " " + path);
    assert.equal(res.body.code, code);
    assert.equal(typeof res.body.error, "string");
  }
  const bad = await callJson("POST", "/books", { auth: true, body: { title: "" } });
  assert.equal(bad.body.code, "bad_request");
});
`,
    },
  ],
};
