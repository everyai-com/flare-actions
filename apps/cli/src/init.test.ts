import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS_MARKER_END, AGENTS_MARKER_START, runInit } from "./init";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-init-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("runInit", () => {
  it("converts the first convertible workflow and writes the AGENTS snippet", () => {
    const dir = workspace({
      ".github/workflows/ci.yml":
        "on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n",
    });
    const result = runInit({ cwd: dir });
    expect(result.pipelineSource).toBe("converted");
    expect(result.convertedFrom).toBe("ci.yml");
    const pipeline = readFileSync(join(dir, "flare.yml"), "utf8");
    expect(pipeline).toContain("npm test");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain(AGENTS_MARKER_START);
    expect(agents).toContain(AGENTS_MARKER_END);
    expect(agents).toContain("npm run check");
  });

  it("falls back to a stack-matched starter without workflows", () => {
    const dir = workspace({ "go.mod": "module example.com/x\n" });
    const result = runInit({ cwd: dir });
    expect(result.pipelineSource).toBe("starter");
    expect(result.starterStack).toBe("go");
    expect(result.stacks).toEqual([{ stack: "go", evidence: ["go.mod"] }]);
    const pipeline = readFileSync(join(dir, "flare.yml"), "utf8");
    expect(pipeline).toContain("go test ./...");
  });

  it("falls back to the generic placeholder with no manifests", () => {
    const dir = workspace({});
    const result = runInit({ cwd: dir });
    expect(result.pipelineSource).toBe("starter");
    expect(result.starterStack).toBe("generic");
    expect(result.stacks).toEqual([]);
    expect(readFileSync(join(dir, "flare.yml"), "utf8")).toContain("TODO");
  });

  it("--stack forces that starter even when workflows exist", () => {
    const dir = workspace({
      "package.json": "{}",
      ".github/workflows/ci.yml":
        "on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
    });
    const result = runInit({ cwd: dir, stack: "rust" });
    expect(result.pipelineSource).toBe("starter");
    expect(result.starterStack).toBe("rust");
    expect(result.stacks).toEqual([{ stack: "node", evidence: ["package.json"] }]);
    expect(readFileSync(join(dir, "flare.yml"), "utf8")).toContain("cargo test");
  });

  it("rejects an unknown --stack without writing anything", () => {
    const dir = workspace({ "package.json": "{}" });
    const result = runInit({ cwd: dir, stack: "cobol" });
    expect(result.error).toContain("unknown stack");
    expect(existsSync(join(dir, "flare.yml"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("keeps exactly one managed AGENTS block across re-runs", () => {
    const dir = workspace({ "AGENTS.md": "# Repo\n\nExisting conventions.\n" });
    runInit({ cwd: dir });
    runInit({ cwd: dir, force: true });
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents.split(AGENTS_MARKER_START).length - 1).toBe(1);
    expect(agents.split(AGENTS_MARKER_END).length - 1).toBe(1);
    expect(agents).toContain("Existing conventions.");
  });

  it("refuses to overwrite flare.yml without --force", () => {
    const dir = workspace({ "flare.yml": "jobs:\n  a:\n    steps:\n      - run: echo\n" });
    const result = runInit({ cwd: dir });
    expect(result.error).toContain("--force");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("--template writes that gallery template verbatim", () => {
    const dir = workspace({
      "package.json": "{}",
      ".github/workflows/ci.yml":
        "on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
    });
    const result = runInit({ cwd: dir, template: "go" });
    expect(result.pipelineSource).toBe("template");
    expect(result.templateId).toBe("go");
    expect(readFileSync(join(dir, "flare.yml"), "utf8")).toContain("go test ./...");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("rejects an unknown --template without writing anything", () => {
    const dir = workspace({ "package.json": "{}" });
    const result = runInit({ cwd: dir, template: "cobol" });
    expect(result.error).toContain("unknown template");
    expect(existsSync(join(dir, "flare.yml"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });
});
