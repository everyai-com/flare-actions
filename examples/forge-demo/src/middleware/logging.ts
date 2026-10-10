// Structured access log: one JSON line per request.

import type { Next } from "../lib/http.ts";

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => console.log(line);

/** Swap the log sink (tests capture lines; production uses console). */
export function setLogSink(next: LogSink): void {
  sink = next;
}

export function formatLogLine(req: Request, res: Response): string {
  const url = new URL(req.url);
  return JSON.stringify({ level: "info", method: req.method, path: url.pathname, status: res.status });
}

export async function withLogging(req: Request, next: Next): Promise<Response> {
  const res = await next(req);
  sink(formatLogLine(req, res));
  return res;
}
