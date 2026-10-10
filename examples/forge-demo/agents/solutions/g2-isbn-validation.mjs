// g2-isbn-validation: reject ISBN-13s with a bad checksum. Disjoint lane
// (src/lib/validate.ts).
export default {
  id: "g2-isbn-validation",
  edits: [
    {
      op: "replace",
      path: "src/lib/validate.ts",
      find: `  if (isbn !== undefined && typeof isbn !== "string") {
    throw badRequest("isbn must be a string");
  }`,
      replace: `  if (isbn !== undefined && (typeof isbn !== "string" || !isValidIsbn13(isbn))) {
    throw badRequest("isbn must be a valid ISBN-13");
  }`,
    },
    {
      op: "replace",
      path: "src/lib/validate.ts",
      find: `export function validateBook(body: unknown): NewBook {`,
      replace: `/** ISBN-13 checksum (hyphens and spaces ignored). */
export function isValidIsbn13(raw: string): boolean {
  const digits = raw.replace(/[-\\s]/g, "");
  if (!/^\\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

export function validateBook(body: unknown): NewBook {`,
    },
    {
      op: "create",
      path: "test/isbn-validation.test.ts",
      content: `import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidIsbn13 } from "../src/lib/validate.ts";
import { callJson } from "./helpers.ts";

test("isValidIsbn13 checks the checksum", () => {
  assert.equal(isValidIsbn13("9780306406157"), true);
  assert.equal(isValidIsbn13("978-0-306-40615-7"), true);
  assert.equal(isValidIsbn13("9780306406158"), false);
  assert.equal(isValidIsbn13("12345"), false);
});

test("POST /books rejects a bad ISBN with a 400", async () => {
  const { status } = await callJson("POST", "/books", {
    auth: true,
    body: { title: "Bad ISBN", authorId: "a_herbert", year: 1999, isbn: "9780306406158" },
  });
  assert.equal(status, 400);
});
`,
    },
  ],
};
