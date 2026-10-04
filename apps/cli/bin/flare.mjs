#!/usr/bin/env node
// Launcher: Node 22.6+ runs TypeScript via type stripping, which is how
// this package ships (same policy as the runner SDK — no build step, no
// generated artifacts to drift). Node 23.6+ strips types by default; the
// flag keeps 22.x working too.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
