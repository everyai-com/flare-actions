// g3-api-key-rotation: accept a comma-separated key list so keys rotate
// without downtime (new key first, old key until clients move).
// DESIGNED INTERACTION: touches protected src/auth/** -> the intent stops
// at awaiting_plan until a human approves the plan.
export default {
  id: "g3-api-key-rotation",
  edits: [
    {
      op: "replace",
      path: "src/auth/apiKey.ts",
      find: `export function verifyApiKey(req: Request, env: Env): Principal | null {
  const presented = req.headers.get("x-api-key");
  const expected = env.API_KEY;
  if (presented === null || expected === undefined || expected === "") return null;
  return safeEqual(presented, expected) ? { kind: "apiKey", id: "key" } : null;
}`,
      replace: `/** Configured keys: API_KEY is a comma-separated list during rotation. */
export function configuredKeys(env: Env): string[] {
  return (env.API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
}

export function verifyApiKey(req: Request, env: Env): Principal | null {
  const presented = req.headers.get("x-api-key");
  if (presented === null || presented === "") return null;
  // Compare against every key (no early exit) so timing doesn't reveal which slot matched.
  let slot = -1;
  configuredKeys(env).forEach((key, i) => {
    if (safeEqual(presented, key) && slot === -1) slot = i;
  });
  return slot === -1 ? null : { kind: "apiKey", id: "key" + slot };
}`,
    },
    {
      op: "create",
      path: "test/api-key-rotation.test.ts",
      content: `import { test } from "node:test";
import assert from "node:assert/strict";
import { callJson } from "./helpers.ts";

const env = { API_KEY: "new-key, old-key" };
const book = { title: "Rotation", authorId: "a_herbert", year: 2020 };

test("both the new and the old key authorize during rotation", async () => {
  for (const key of ["new-key", "old-key"]) {
    const { status } = await callJson("POST", "/books", { env, headers: { "x-api-key": key }, body: book });
    assert.equal(status, 201, key);
  }
});

test("keys outside the list are still rejected", async () => {
  const { status } = await callJson("POST", "/books", { env, headers: { "x-api-key": "stale-key" }, body: book });
  assert.equal(status, 401);
});
`,
    },
  ],
};
