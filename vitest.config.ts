import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Forge (stream A): index.ts re-exports DO/Workflow classes, so the
  // runtime module needs a stand-in for runtime-free tests that import it.
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./apps/worker/test/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    // examples/* are self-contained repos with their own runners (the
    // forge demo uses node:test, zero-install), not part of this suite.
    exclude: [...configDefaults.exclude, "examples/**", ".claude/**"],
    // Persist transformed modules between runs: agent loops re-run the
    // same suite all day and transform cost dominates warm re-runs
    // (~30% of tracked time on this repo per vitest's own scoring).
    fsModuleCache: true,
  },
});
