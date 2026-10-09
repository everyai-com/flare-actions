// Focused tests for the outputs module: file parsing bounds,
// static ref resolution, and log rendering.
import { describe, expect, it } from "vitest";
import {
  formatOutputsLine,
  isValidOutputName,
  parseOutputRef,
  parseStepOutputs,
  resolveJobOutputs,
} from "./outputs";

describe("parseStepOutputs", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    const parsed = parseStepOutputs("# comment\n\nurl=https://x.example/a\nempty=\n");
    expect(parsed.outputs).toEqual({ url: "https://x.example/a", empty: "" });
    expect(parsed.truncated).toEqual([]);
    expect(parsed.ignored).toBe(0);
  });

  it("splits on the first equals and strips carriage returns", () => {
    const parsed = parseStepOutputs("conn=a=b=c\r\n");
    expect(parsed.outputs).toEqual({ conn: "a=b=c" });
  });

  it("ignores garbage, bad names, duplicates, and overflow", () => {
    const lines = ["no-equals", "9bad=x", "has space=x", "dup=1", "dup=2"];
    for (let i = 0; i < 20; i++) lines.push(`k${i}=v`);
    const parsed = parseStepOutputs(lines.join("\n"));
    expect(parsed.outputs.dup).toBe("1");
    expect(Object.keys(parsed.outputs)).toHaveLength(16);
    // 3 garbage/bad + 1 dup + 5 overflow (dup + k0..k14 fill 16).
    expect(parsed.ignored).toBe(3 + 1 + 5);
  });

  it("truncates overlong values and names them", () => {
    const parsed = parseStepOutputs(`big=${"x".repeat(2000)}\nok=short`);
    expect(parsed.outputs.big?.length).toBe(1024);
    expect(parsed.outputs.ok).toBe("short");
    expect(parsed.truncated).toEqual(["big"]);
    expect(parsed.ignored).toBe(0);
  });
});

describe("parseOutputRef", () => {
  it("accepts stepid.key and rejects the rest", () => {
    expect(parseOutputRef("deploy.url")).toEqual({ stepId: "deploy", key: "url" });
    expect(parseOutputRef("no-dot")).toBe(null);
    expect(parseOutputRef(".key")).toBe(null);
    expect(parseOutputRef("a.b.c")).toBe(null);
    expect(parseOutputRef("9bad.key")).toBe(null);
    expect(parseOutputRef("id.")).toBe(null);
  });
});

describe("resolveJobOutputs", () => {
  it("resolves refs and lists missing names", () => {
    const resolved = resolveJobOutputs(
      { url: "deploy.url", sha: "build.sha", gone: "nope.x" },
      { deploy: { url: "https://x" }, build: {} },
    );
    expect(resolved.outputs).toEqual({ url: "https://x" });
    expect(resolved.missing).toEqual(["sha", "gone"]);
  });
});

describe("output names", () => {
  it("shares one alphabet for ids, keys, and mapping names", () => {
    expect(isValidOutputName("deploy_url-1")).toBe(true);
    expect(isValidOutputName("9bad")).toBe(false);
    expect(isValidOutputName("has space")).toBe(false);
    expect(isValidOutputName("a".repeat(65))).toBe(false);
    expect(formatOutputsLine({ url: "https://x", big: "y".repeat(200) })).toBe(`url=https://x big=${"y".repeat(120)}…`);
  });
});
