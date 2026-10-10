// Test helpers (not a test file). Drives the Worker's fetch() directly:
// Node 24 ships Request/Response, so no runtime or bundler is needed.

import worker from "../src/index.ts";
import type { Env } from "../src/lib/http.ts";
import { setLogSink } from "../src/middleware/logging.ts";

export const API_KEY = "test-key-123";
export const ENV: Env = { API_KEY };

/** Captured access-log lines (the sink is swapped so tests stay quiet). */
export const logLines: string[] = [];
setLogSink((line) => {
  logLines.push(line);
});

export type CallOptions = { env?: Env; body?: unknown; headers?: Record<string, string>; auth?: boolean };

export async function call(method: string, path: string, opts: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth === true) headers["x-api-key"] = API_KEY;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const req = new Request(`https://bookshelf.test${path}`, { method, headers, body });
  return worker.fetch(req, opts.env ?? ENV);
}

// Test bodies are ad hoc JSON; `any` keeps assertions terse.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callJson(method: string, path: string, opts: CallOptions = {}): Promise<{ status: number; body: any }> {
  const res = await call(method, path, opts);
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}
