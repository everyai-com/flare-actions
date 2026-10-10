#!/usr/bin/env node
// Launcher for both bins (`flare-forge` and `flare`).
//
// Installed from npm: runs the bundled dist/cli.mjs (built by
// `npm run build:cli`; self-contained, zero runtime dependencies).
// In the repo (no dist/, which is gitignored): runs src/index.ts under
// Node type stripping, the same no-build policy as the runner SDK.
// Node 23.6+ strips types by default; the flag keeps 22.x working too.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = join(root, "dist", "cli.mjs");

if (existsSync(bundled)) {
  await import(pathToFileURL(bundled).href);
} else {
  const entry = join(root, "src", "index.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
