#!/usr/bin/env node
// Bundles the CLI into one self-contained ESM file (dist/cli.mjs) for
// npm. In the repo the CLI runs from source under Node type stripping;
// installed from npm it cannot, because it imports the runner SDK (a
// workspace package that is not published) and a few worker/seats
// modules by relative path. esbuild resolves all of that at build time,
// so the published package has zero runtime dependencies.
//
// Usage: node apps/cli/scripts/build.mjs [--outfile path]
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const i = args.indexOf("--outfile");
const outfile = i !== -1 && args[i + 1] ? args[i + 1] : join(root, "dist", "cli.mjs");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  legalComments: "none",
  // Bundled CommonJS deps (yaml) call require() for node builtins; ESM
  // output has no require, so provide one.
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// ${pkg.name}@${pkg.version} — bundled from github.com/everyai-com/flare-actions (MIT). Do not edit.`,
      "import { createRequire as __flareCreateRequire } from 'node:module';",
      "const require = __flareCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
