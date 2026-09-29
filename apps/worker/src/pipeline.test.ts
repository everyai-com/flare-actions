import { describe, expect, it } from "vitest";
import { defaultPipeline, MAX_DEFINITION_BYTES, parsePipeline } from "./pipeline";

describe("parsePipeline", () => {
  it("parses jobs with steps", () => {
    const jobs = parsePipeline("jobs:\n  test:\n    steps:\n      - run: node --version\n      - run: npm test\n  lint:\n    steps:\n      - run: npm run lint\n");
    expect(jobs).toEqual([
      { name: "test", steps: [{ run: "node --version" }, { run: "npm test" }] },
      { name: "lint", steps: [{ run: "npm run lint" }] },
    ]);
  });

  it("trims commands", () => {
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: '  echo hi  '\n")).toEqual([
      { name: "a", steps: [{ run: "echo hi" }] },
    ]);
  });

  it("rejects invalid documents", () => {
    expect(parsePipeline("")).toBeNull();
    expect(parsePipeline("just a string")).toBeNull();
    expect(parsePipeline("jobs: []")).toBeNull();
    expect(parsePipeline("jobs: {}")).toBeNull();
    expect(parsePipeline("jobs:\n  a: 42\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps: []\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: ''\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: 42\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - shell: bash\n")).toBeNull();
    expect(parsePipeline("{{{not yaml")).toBeNull();
  });

  it("enforces caps", () => {
    const manyJobs = "jobs:\n" + Array.from({ length: 33 }, (_, i) => `  j${i}:\n    steps:\n      - run: echo\n`).join("");
    expect(parsePipeline(manyJobs)).toBeNull();
    const manySteps = "jobs:\n  a:\n    steps:\n" + "      - run: echo\n".repeat(101);
    expect(parsePipeline(manySteps)).toBeNull();
    expect(parsePipeline("x".repeat(MAX_DEFINITION_BYTES + 1))).toBeNull();
  });
});

describe("defaultPipeline", () => {
  it("returns one echo job", () => {
    expect(defaultPipeline()).toEqual([{ name: "main", steps: [{ run: "echo hello from flare-actions" }] }]);
  });
});
