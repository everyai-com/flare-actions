import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStacks, formatStacks, generateStarter, isStackId, KNOWN_STACKS, primaryStack, type StackId } from "./detect";
import { parsePipeline } from "../../worker/src/pipeline.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-detect-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("detectStacks", () => {
  it("detects each stack from its manifests", () => {
    const cases: [StackId, string][] = [
      ["node", "package.json"],
      ["python", "pyproject.toml"],
      ["go", "go.mod"],
      ["rust", "Cargo.toml"],
      ["ruby", "Gemfile"],
      ["java", "pom.xml"],
      ["php", "composer.json"],
      ["dotnet", "app.csproj"],
      ["elixir", "mix.exs"],
    ];
    for (const [stack, manifest] of cases) {
      const dir = workspace({ [manifest]: stack === "node" ? "{}" : "x" });
      expect(detectStacks(dir)).toEqual([{ stack, evidence: [manifest] }]);
      expect(primaryStack(detectStacks(dir))?.stack).toBe(stack);
    }
  });

  it("reports every stack in a polyglot repo in priority order", () => {
    const dir = workspace({ "requirements.txt": "x", "package.json": "{}", "go.mod": "x" });
    expect(detectStacks(dir).map((s) => s.stack)).toEqual(["node", "python", "go"]);
    expect(primaryStack(detectStacks(dir))).toEqual({ stack: "node", evidence: ["package.json"] });
  });

  it("returns [] and a null primary when nothing matches", () => {
    const dir = workspace({ "README.md": "hi" });
    expect(detectStacks(dir)).toEqual([]);
    expect(primaryStack(detectStacks(dir))).toBeNull();
    expect(formatStacks([])).toBe("none detected");
  });

  it("collects lockfiles as node evidence", () => {
    const dir = workspace({ "package.json": "{}", "pnpm-lock.yaml": "x" });
    expect(detectStacks(dir)).toEqual([{ stack: "node", evidence: ["package.json", "pnpm-lock.yaml"] }]);
  });

  it("matches dotnet projects and solutions case-insensitively", () => {
    const dir = workspace({ "App.SLN": "x", "lib.fsproj": "x", "notes.txt": "x" });
    expect(detectStacks(dir)).toEqual([{ stack: "dotnet", evidence: ["App.SLN", "lib.fsproj"] }]);
  });

  it("validates stack ids", () => {
    for (const id of KNOWN_STACKS) expect(isStackId(id)).toBe(true);
    expect(isStackId("cobol")).toBe(false);
    expect(isStackId("")).toBe(false);
  });
});

describe("generateStarter", () => {
  it("every starter is a valid pipeline", () => {
    const dir = workspace({});
    for (const stack of KNOWN_STACKS) {
      const starter = generateStarter(dir, stack);
      expect(starter.stack).toBe(stack);
      const jobs = parsePipeline(starter.yaml);
      expect(jobs, `${stack} starter must parse`).not.toBeNull();
      expect(jobs?.length).toBe(1);
      expect(jobs?.[0]?.steps.length).toBeGreaterThan(0);
    }
  });

  it("matches the node package manager to the lockfile", () => {
    expect(generateStarter(workspace({ "package.json": "{}", "yarn.lock": "x" }), "node").yaml).toContain("yarn install --frozen-lockfile");
    expect(generateStarter(workspace({ "package.json": "{}", "pnpm-lock.yaml": "x" }), "node").yaml).toContain("pnpm install --frozen-lockfile");
    expect(generateStarter(workspace({ "package.json": "{}" }), "node").yaml).toContain("npm ci");
  });

  it("adds a build step when package.json has one, and tolerates invalid JSON", () => {
    const withBuild = generateStarter(workspace({ "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }) }), "node");
    expect(withBuild.yaml).toContain("npm run build");
    const invalid = generateStarter(workspace({ "package.json": "{nope" }), "node");
    expect(invalid.yaml).toContain("npm ci");
    expect(invalid.yaml).toContain("npm test");
  });

  it("picks python install/test commands from available manifests", () => {
    const req = generateStarter(workspace({ "requirements.txt": "pytest" }), "python").yaml;
    expect(req).toContain("pip install -r requirements.txt");
    expect(req).toContain("python -m pytest");
    const proj = generateStarter(workspace({ "pyproject.toml": "x" }), "python").yaml;
    expect(proj).toContain("pip install -e .");
  });

  it("runs rspec when spec/ exists, rake otherwise", () => {
    const specDir = workspace({ Gemfile: "x" });
    mkdirSync(join(specDir, "spec"));
    expect(generateStarter(specDir, "ruby").yaml).toContain("bundle exec rspec");
    expect(generateStarter(workspace({ Gemfile: "x" }), "ruby").yaml).toContain("bundle exec rake");
  });

  it("prefers maven, then the gradle wrapper", () => {
    expect(generateStarter(workspace({ "pom.xml": "x", "build.gradle": "x" }), "java").yaml).toContain("mvn -q test");
    expect(generateStarter(workspace({ "build.gradle": "x", gradlew: "x" }), "java").yaml).toContain("./gradlew test");
    expect(generateStarter(workspace({ "build.gradle": "x" }), "java").yaml).toContain("gradle test");
  });

  it("uses composer test when the script exists, phpunit otherwise", () => {
    const withScript = generateStarter(workspace({ "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }) }), "php").yaml;
    expect(withScript).toContain("composer test");
    const without = generateStarter(workspace({ "composer.json": "{}" }), "php").yaml;
    expect(without).toContain("vendor/bin/phpunit");
  });
});
