import { describe, expect, it } from "vitest";
import {
  buildImporters,
  canParsePath,
  extractTypeScriptImports,
  failureTouchesFile,
  groupGrepLines,
  isTestFile,
  matchGlob,
  resolveImport,
  selectTests,
} from "./testselect.ts";

// Fixture graph (repo-relative posix paths):
//
//   src/app.ts -> src/util.ts, src/store.ts
//   src/store.ts -> src/util.ts
//   tests/app.test.ts -> src/app.ts
//   tests/store.test.ts -> src/store.ts
//   tests/lonely.test.ts -> (nothing)
//   src/util.ts (leaf)
const FIXTURE_FILES = [
  "src/app.ts",
  "src/util.ts",
  "src/store.ts",
  "tests/app.test.ts",
  "tests/store.test.ts",
  "tests/lonely.test.ts",
  "README.md",
];

const FIXTURE_CONTENTS = new Map<string, string>([
  ["src/app.ts", 'import { add } from "./util";\nimport { Store } from "./store";\n'],
  ["src/util.ts", "export const add = (a: number, b: number): number => a + b;\n"],
  ["src/store.ts", 'import { add } from "./util";\nexport class Store {}\n'],
  ["tests/app.test.ts", 'import { app } from "../src/app";\n'],
  ["tests/store.test.ts", 'const { Store } = require("../src/store");\n'],
  ["tests/lonely.test.ts", "// no imports\n"],
]);

describe("matchGlob", () => {
  it("matches exact and wildcard segments", () => {
    expect(matchGlob("tests/app.test.ts", "tests/app.test.ts")).toBe(true);
    expect(matchGlob("tests/*.test.ts", "tests/app.test.ts")).toBe(true);
    expect(matchGlob("tests/*.test.ts", "tests/nested/app.test.ts")).toBe(false);
    expect(matchGlob("**/*.test.ts", "tests/nested/app.test.ts")).toBe(true);
    expect(matchGlob("tests/**/*", "tests/a.ts")).toBe(true);
    expect(matchGlob("tests/**/*", "tests/a/b.ts")).toBe(true);
    expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false);
  });

  it("rejects empty or absurd inputs", () => {
    expect(matchGlob("", "a.ts")).toBe(false);
    expect(matchGlob("**", "")).toBe(false);
  });
});

describe("isTestFile", () => {
  it("recognizes conventional test paths", () => {
    expect(isTestFile("tests/app.test.ts")).toBe(true);
    expect(isTestFile("src/app.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/app.ts")).toBe(true);
    expect(isTestFile("test/helpers/a.ts")).toBe(true);
    expect(isTestFile("src/app.ts")).toBe(false);
  });

  it("honors custom patterns", () => {
    expect(isTestFile("qa/e2e.py", ["qa/**"])).toBe(true);
    expect(isTestFile("tests/app.test.ts", ["qa/**"])).toBe(false);
  });
});

describe("extractTypeScriptImports", () => {
  it("extracts static, type, side-effect, require, and dynamic imports", () => {
    const src = [
      'import { a } from "./a";',
      "import type { B } from '../b';",
      'import "./side-effect";',
      'export { c } from "./c";',
      'export * from "./d";',
      'const e = require("./e");',
      'const f = await import("./f");',
      'import pkg from "some-package";',
    ].join("\n");
    expect(extractTypeScriptImports(src).sort()).toEqual(
      ["./a", "../b", "./c", "./d", "./e", "./f", "./side-effect", "some-package"].sort(),
    );
  });

  it("ignores commented-out imports", () => {
    const src = ['// import { a } from "./a";', "/* import { b } from './b'; */", 'import { c } from "./c";'].join("\n");
    expect(extractTypeScriptImports(src)).toEqual(["./c"]);
  });
});

describe("resolveImport", () => {
  const files = new Set(["src/app.ts", "src/util.ts", "src/nested/index.ts", "src/data.json"]);
  const exists = (p: string): boolean => files.has(p);

  it("resolves extensionless and index imports", () => {
    expect(resolveImport("src/app.ts", "./util", exists)).toBe("src/util.ts");
    expect(resolveImport("src/app.ts", "./nested", exists)).toBe("src/nested/index.ts");
    expect(resolveImport("src/nested/index.ts", "../util.ts", exists)).toBe("src/util.ts");
  });

  it("rejects bare and missing imports", () => {
    expect(resolveImport("src/app.ts", "some-package", exists)).toBeNull();
    expect(resolveImport("src/app.ts", "./missing", exists)).toBeNull();
    expect(resolveImport("src/app.ts", "../../escape", exists)).toBeNull();
  });
});

describe("buildImporters", () => {
  it("reverses the fixture graph", () => {
    const importers = buildImporters(FIXTURE_FILES, FIXTURE_CONTENTS);
    expect([...(importers.get("src/util.ts") ?? [])].sort()).toEqual(["src/app.ts", "src/store.ts"]);
    expect([...(importers.get("src/store.ts") ?? [])].sort()).toEqual(["src/app.ts", "tests/store.test.ts"]);
    expect([...(importers.get("src/app.ts") ?? [])]).toEqual(["tests/app.test.ts"]);
    expect(importers.get("tests/lonely.test.ts")).toBeUndefined();
  });
});

describe("failureTouchesFile", () => {
  it("matches suite/classname paths and basenames", () => {
    expect(failureTouchesFile({ suite: "tests/app.test.ts", name: "renders", classname: "" }, "tests/app.test.ts")).toBe(
      true,
    );
    expect(failureTouchesFile({ suite: "", name: "x", classname: "src/store.test.ts" }, "tests/store.test.ts")).toBe(
      true,
    );
    expect(failureTouchesFile({ suite: "unrelated", name: "x", classname: "" }, "tests/app.test.ts")).toBe(false);
  });
});

describe("groupGrepLines", () => {
  it("regroups file:line output per file", () => {
    const grouped = groupGrepLines('./src/a.ts:import { x } from "./b";\n./tests/a.test.ts:import { a } from "../src/a";\n');
    expect([...grouped.keys()].sort()).toEqual(["src/a.ts", "tests/a.test.ts"]);
    expect(grouped.get("src/a.ts")).toContain("./b");
  });
});

describe("canParsePath", () => {
  it("covers TS/JS and nothing else", () => {
    expect(canParsePath("src/a.ts")).toBe(true);
    expect(canParsePath("src/a.mjs")).toBe(true);
    expect(canParsePath("src/a.py")).toBe(false);
    expect(canParsePath("README.md")).toBe(false);
  });
});

describe("selectTests", () => {
  it("selects the transitive importers of a changed leaf", () => {
    const result = selectTests({ allFiles: FIXTURE_FILES, contents: FIXTURE_CONTENTS, changed: ["src/util.ts"], failures: [] });
    expect(result.mode).toBe("select");
    expect(result.selected).toEqual(["tests/app.test.ts", "tests/store.test.ts"]);
    expect(result.skipped).toEqual([{ file: "tests/lonely.test.ts", reason: "unaffected by this diff" }]);
    expect(result.totalTests).toBe(3);
  });

  it("selects a changed test directly", () => {
    const result = selectTests({ allFiles: FIXTURE_FILES, contents: FIXTURE_CONTENTS, changed: ["tests/lonely.test.ts"], failures: [] });
    expect(result.selected).toEqual(["tests/lonely.test.ts"]);
  });

  it("boosts recently failed tests even when unaffected", () => {
    const result = selectTests({
      allFiles: FIXTURE_FILES,
      contents: FIXTURE_CONTENTS,
      changed: ["src/store.ts"],
      failures: [{ suite: "tests/lonely.test.ts", name: "flakes", classname: "" }],
    });
    expect(result.selected).toContain("tests/lonely.test.ts");
    expect(result.selected).toContain("tests/store.test.ts");
  });

  it("falls back to full on unmapped changes", () => {
    const docs = selectTests({ allFiles: FIXTURE_FILES, contents: FIXTURE_CONTENTS, changed: ["README.md"], failures: [] });
    expect(docs.mode).toBe("full");
    expect(docs.reason).toContain("README.md");
    const deleted = selectTests({ allFiles: FIXTURE_FILES, contents: FIXTURE_CONTENTS, changed: ["src/gone.ts"], failures: [] });
    expect(deleted.mode).toBe("full");
  });

  it("falls back to full when nothing is affected", () => {
    const result = selectTests({
      allFiles: [...FIXTURE_FILES, "src/island.ts"],
      contents: new Map([...FIXTURE_CONTENTS, ["src/island.ts", "export const x = 1;\n"]]),
      changed: ["src/island.ts"],
      failures: [],
    });
    expect(result.mode).toBe("full");
    expect(result.reason).toContain("no affected tests");
  });

  it("falls back to full when no tests exist", () => {
    const result = selectTests({ allFiles: ["src/a.ts"], contents: new Map(), changed: ["src/a.ts"], failures: [] });
    expect(result.mode).toBe("full");
  });

  it("ignores deleted test files", () => {
    const result = selectTests({
      allFiles: FIXTURE_FILES,
      contents: FIXTURE_CONTENTS,
      changed: ["tests/deleted.test.ts", "src/store.ts"],
      failures: [],
    });
    expect(result.mode).toBe("select");
    expect(result.selected).toContain("tests/store.test.ts");
  });
});
