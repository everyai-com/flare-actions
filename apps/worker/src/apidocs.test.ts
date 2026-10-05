import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiDocsPage } from "./apidocs";
import { OPENAPI_YAML } from "./openapi-spec";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("api docs", () => {
  it("serves the committed spec byte-for-byte", () => {
    expect(OPENAPI_YAML).toBe(readFileSync(join(root, "openapi.yaml"), "utf8"));
  });

  it("renders Redoc over the same-origin spec", () => {
    const page = apiDocsPage();
    expect(page).toContain('<redoc spec-url="openapi.yaml">');
    expect(page).toContain("redoc.standalone.js");
    expect(page).not.toContain("${");
  });
});
