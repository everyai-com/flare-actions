// Bundles the CLI into one plain-Node ESM file (dist/flare.mjs) for npm.
// Why a bundle: Node refuses type stripping under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and the CLI imports
// worker/seats modules plus the unpublished runner SDK by relative path.
// Dev keeps running the .ts sources (`npm run cli`); this is publish-only.
// esbuild comes from the root install (wrangler/vite pin it), same as
// the root `eval:models` script.
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outfile = join(root, "dist", "flare.mjs");

const result = await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CJS deps (yaml) call require("process"/"buffer"); ESM has no
  // require, so give the bundle one.
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// flare-actions ${pkg.version} — bundled build; source: https://github.com/everyai-com/flare-actions/tree/main/apps/cli`,
      'import { createRequire as __flareCreateRequire } from "node:module";',
      "const require = __flareCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Workers-only modules must never reach the CLI; fail the build if any
  // import path drags one in rather than shipping a bundle that crashes.
  plugins: [
    {
      name: "no-workers-runtime",
      setup(b) {
        b.onResolve({ filter: /^cloudflare:/ }, (args) => ({
          errors: [{ text: `${args.path} imported from ${args.importer}: Workers-only module in the CLI bundle` }],
        }));
      },
    },
  ],
  // `flare --version`: baked in here; source runs (npm run cli) say "dev".
  define: { "process.env.FLARE_CLI_VERSION": JSON.stringify(pkg.version) },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

chmodSync(outfile, 0o755);
const bytes = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].bytes;
console.log(`built ${outfile} (${(bytes / 1024).toFixed(1)} KiB)`);
