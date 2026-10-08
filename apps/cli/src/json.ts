// `--json` on every CLI command: one JSON envelope on stdout, versioned
// so agents can pin a schema. Contract:
// - success: stdout is exactly one line, `{ version: 1, command, data }`.
// - failure: stdout stays empty; stderr keeps the human error and the
//   exit code is unchanged (0 ok, 1 run failed, 2 usage).
// - streaming verbs keep their bytes out of the envelope: `local`
//   runs quiet and reports its result object, `devbox exec` reports
//   captured stdio, `import` reports yaml + warnings, `mcp-config`
//   keeps its paste-ready document unwrapped, and `mcp-serve` (a stdio
//   server) ignores the flag entirely.

export const JSON_SCHEMA_VERSION = 1;

export interface JsonEnvelope {
  version: 1;
  command: string;
  data: unknown;
}

export function jsonEnvelope(command: string, data: unknown): JsonEnvelope {
  return { version: JSON_SCHEMA_VERSION, command, data };
}

export function printJson(command: string, data: unknown): void {
  console.log(JSON.stringify(jsonEnvelope(command, data)));
}

// Split argv at the first `--` so a `--json` inside passthrough args
// (e.g. `cli devbox exec box -- curl --json`) is never eaten: only the
// head is flag-bearing, the tail passes through verbatim.
export function splitPassthrough(args: string[]): { head: string[]; tail: string[] } {
  const at = args.indexOf("--");
  if (at === -1) return { head: [...args], tail: [] };
  return { head: args.slice(0, at), tail: args.slice(at) };
}

export function hasJsonFlag(headArgs: string[]): boolean {
  return headArgs.includes("--json");
}

export function stripJsonFlag(headArgs: string[]): string[] {
  return headArgs.filter((a) => a !== "--json");
}
