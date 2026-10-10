// g3-cors-allowlist: when CORS_ORIGINS is set, only listed origins are
// echoed (with Vary: Origin); unset keeps `*`. Disjoint lane
// (src/middleware/cors.ts).
export default {
  id: "g3-cors-allowlist",
  edits: [
    {
      op: "replace",
      path: "src/middleware/cors.ts",
      find: `function allowOrigin(_req: Request, _env: Env): string | null {
  return "*";
}

function withHeaders(res: Response, origin: string | null): Response {
  const out = new Response(res.body, res);
  if (origin !== null) out.headers.set("access-control-allow-origin", origin);
  return out;
}`,
      replace: `function allowlist(env: Env): string[] {
  return (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
}

function allowOrigin(req: Request, env: Env): string | null {
  const list = allowlist(env);
  if (list.length === 0) return "*";
  const origin = req.headers.get("origin");
  return origin !== null && list.includes(origin) ? origin : null;
}

function withHeaders(res: Response, origin: string | null): Response {
  const out = new Response(res.body, res);
  if (origin !== null) out.headers.set("access-control-allow-origin", origin);
  if (origin !== "*") out.headers.append("vary", "Origin");
  return out;
}`,
    },
    {
      op: "create",
      path: "test/cors-allowlist.test.ts",
      content: `import { test } from "node:test";
import assert from "node:assert/strict";
import { call } from "./helpers.ts";

const env = { CORS_ORIGINS: "https://app.example, https://admin.example" };

test("a listed origin is echoed back with Vary: Origin", async () => {
  const res = await call("GET", "/health", { env, headers: { origin: "https://app.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example");
  assert.match(res.headers.get("vary") ?? "", /Origin/);
});

test("an unlisted origin gets no allow-origin header", async () => {
  const res = await call("GET", "/health", { env, headers: { origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
`,
    },
  ],
};
