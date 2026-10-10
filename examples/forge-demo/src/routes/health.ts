// Liveness probe.

import { json, type Route } from "../lib/http.ts";

export const healthRoutes: Route[] = [
  {
    method: "GET",
    path: "/health",
    handler: () => json({ ok: true }),
  },
];
