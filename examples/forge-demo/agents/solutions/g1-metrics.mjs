// g1-metrics: Prometheus-style catalog gauges at GET /metrics.
// DESIGNED INTERACTION: overlaps g3-rate-limit on src/index.ts, but in a
// different region (route table vs middleware chain) -> declare-time
// overlap warning, clean git merge, green together.
export default {
  id: "g1-metrics",
  edits: [
    {
      op: "create",
      path: "src/routes/metrics.ts",
      content: `// Prometheus text exposition of catalog gauges.

import type { Route } from "../lib/http.ts";
import { countAuthors, countBooks } from "../lib/store.ts";

export function renderMetrics(): string {
  return [
    "# TYPE bookshelf_books_total gauge",
    "bookshelf_books_total " + countBooks(),
    "# TYPE bookshelf_authors_total gauge",
    "bookshelf_authors_total " + countAuthors(),
    "",
  ].join("\\n");
}

export const metricsRoutes: Route[] = [
  {
    method: "GET",
    path: "/metrics",
    handler: () => new Response(renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } }),
  },
];
`,
    },
    {
      op: "replace",
      path: "src/index.ts",
      find: `import { healthRoutes } from "./routes/health.ts";
`,
      replace: `import { healthRoutes } from "./routes/health.ts";
import { metricsRoutes } from "./routes/metrics.ts";
`,
    },
    {
      op: "replace",
      path: "src/index.ts",
      find: `  ...healthRoutes,
`,
      replace: `  ...healthRoutes,
  ...metricsRoutes,
`,
    },
    {
      op: "create",
      path: "test/metrics.test.ts",
      content: `import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore } from "../src/lib/store.ts";
import { call } from "./helpers.ts";

beforeEach(() => {
  resetStore({
    authors: [{ id: "a1", name: "Octavia E. Butler" }],
    books: [
      { id: "b1", title: "Kindred", authorId: "a1", year: 1979 },
      { id: "b2", title: "Parable of the Sower", authorId: "a1", year: 1993 },
    ],
  });
});

test("GET /metrics exposes catalog gauges as text", async () => {
  const res = await call("GET", "/metrics");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\\/plain/);
  const text = await res.text();
  assert.match(text, /^bookshelf_books_total 2$/m);
  assert.match(text, /^bookshelf_authors_total 1$/m);
});
`,
    },
  ],
};
