import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // examples/* are self-contained repos with their own runners (the
    // forge demo uses node:test, zero-install), not part of this suite.
    exclude: [...configDefaults.exclude, "examples/**"],
    // Persist transformed modules between runs: agent loops re-run the
    // same suite all day and transform cost dominates warm re-runs
    // (~30% of tracked time on this repo per vitest's own scoring).
    fsModuleCache: true,
  },
});
