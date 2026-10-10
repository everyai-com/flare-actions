import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Main-module exports extend `cloudflare:workers` classes (the train
    // Workflow); vitest has no Workers runtime, so a stub stands in.
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./apps/worker/src/testing/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    // Persist transformed modules between runs: agent loops re-run the
    // same suite all day and transform cost dominates warm re-runs
    // (~30% of tracked time on this repo per vitest's own scoring).
    fsModuleCache: true,
  },
});
