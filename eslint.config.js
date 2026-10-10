import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/worker-configuration.d.ts",
      "**/wrangler.jsonc",
      ".wrangler/**",
      "coverage/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "apps/cli/bin/*.mjs", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    // Self-contained example repos: run under Node (tests, tooling) and
    // Workers; both expose these globals.
    files: ["examples/**/*.{ts,mjs}"],
    languageOptions: { globals: globals.node },
  },
);
