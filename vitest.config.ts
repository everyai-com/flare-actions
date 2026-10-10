import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Forge (stream A): index.ts re-exports DO/Workflow classes, so the
  // runtime module needs a stand-in for runtime-free tests that import it.
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./apps/worker/test/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    // Persist transformed modules between runs: agent loops re-run the
    // same suite all day and transform cost dominates warm re-runs
    // (~30% of tracked time on this repo per vitest's own scoring).
    fsModuleCache: true,
  },
});
