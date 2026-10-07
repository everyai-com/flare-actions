import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Persist transformed modules between runs: agent loops re-run the
    // same suite all day and transform cost dominates warm re-runs
    // (~30% of tracked time on this repo per vitest's own scoring).
    fsModuleCache: true,
  },
});
