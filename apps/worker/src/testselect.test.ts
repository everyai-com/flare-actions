import { describe, expect, it } from "vitest";
import {
  decideSelectionMode,
  parseSelectionReport,
  parseTestSelectionConfig,
  readTestSelectionConfig,
} from "./testselect";

describe("parseTestSelectionConfig", () => {
  it("accepts true and full objects", () => {
    expect(parseTestSelectionConfig(true)).toEqual({});
    expect(
      parseTestSelectionConfig({
        tests: ["tests/**/*.test.ts"],
        "full-on-profiles": ["full", "nightly"],
        "full-on-branches": ["main"],
        "history-days": 14,
      }),
    ).toEqual({
      tests: ["tests/**/*.test.ts"],
      fullOnProfiles: ["full", "nightly"],
      fullOnBranches: ["main"],
      historyDays: 14,
    });
  });

  it("rejects malformed values", () => {
    expect(parseTestSelectionConfig(false)).toBeNull();
    expect(parseTestSelectionConfig("yes")).toBeNull();
    expect(parseTestSelectionConfig({ tests: [] })).toBeNull();
    expect(parseTestSelectionConfig({ tests: ["ok", 42] })).toBeNull();
    expect(parseTestSelectionConfig({ "history-days": 0 })).toBeNull();
    expect(parseTestSelectionConfig({ "history-days": 31 })).toBeNull();
    expect(parseTestSelectionConfig({ "full-on-profiles": "full" })).toBeNull();
  });
});

describe("readTestSelectionConfig", () => {
  it("reads stored camelCase definitions", () => {
    expect(readTestSelectionConfig(JSON.stringify({ steps: [], testSelection: { fullOnBranches: ["main"] } }))).toEqual({
      fullOnBranches: ["main"],
    });
    expect(readTestSelectionConfig(JSON.stringify({ steps: [], testSelection: true }))).toEqual({});
  });

  it("reads absent or malformed as null", () => {
    expect(readTestSelectionConfig(JSON.stringify({ steps: [] }))).toBeNull();
    expect(readTestSelectionConfig(JSON.stringify({ steps: [], testSelection: { historyDays: 99 } }))).toBeNull();
    expect(readTestSelectionConfig("not json")).toBeNull();
  });
});

describe("decideSelectionMode", () => {
  const config = {};
  const base = { event: "pull_request", branch: "feat", profile: null, changedFiles: ["src/a.ts"] };

  it("is off without config", () => {
    expect(decideSelectionMode(null, base).mode).toBe("off");
  });

  it("selects on narrow runs with a known diff", () => {
    expect(decideSelectionMode(config, base)).toEqual({ mode: "select", reason: "diff mapped to affected tests" });
  });

  it("runs everything on schedules", () => {
    expect(decideSelectionMode(config, { ...base, event: "schedule" }).mode).toBe("full");
  });

  it("runs everything on full-suite profiles", () => {
    expect(decideSelectionMode(config, { ...base, profile: "full" }).mode).toBe("full");
    expect(decideSelectionMode(config, { ...base, profile: "smoke" }).mode).toBe("select");
    expect(decideSelectionMode({ fullOnProfiles: ["landing"] }, { ...base, profile: "landing" }).mode).toBe("full");
  });

  it("runs everything on merge-candidate branches", () => {
    expect(decideSelectionMode({ fullOnBranches: ["main"] }, { ...base, branch: "main" }).mode).toBe("full");
    expect(decideSelectionMode({ fullOnBranches: ["main"] }, base).mode).toBe("select");
  });

  it("runs everything when the diff is unknown", () => {
    expect(decideSelectionMode(config, { ...base, changedFiles: [] }).mode).toBe("full");
  });
});

describe("parseSelectionReport", () => {
  it("accepts bounded reports", () => {
    expect(
      parseSelectionReport({
        mode: "select",
        reason: "2/10 tests affected",
        selected: ["tests/a.test.ts"],
        skipped: [{ file: "tests/b.test.ts", reason: "unaffected by this diff" }],
      }),
    ).toEqual({
      mode: "select",
      reason: "2/10 tests affected",
      selected: ["tests/a.test.ts"],
      skipped: [{ file: "tests/b.test.ts", reason: "unaffected by this diff" }],
    });
  });

  it("drops invalid shapes", () => {
    expect(parseSelectionReport(undefined)).toBeNull();
    expect(parseSelectionReport({ mode: "sometimes", reason: "x" })).toBeNull();
    expect(parseSelectionReport({ mode: "full" })).toBeNull();
    expect(parseSelectionReport({ mode: "full", reason: "x", selected: ["ok", 1] })).toBeNull();
    expect(
      parseSelectionReport({ mode: "full", reason: "x", skipped: [{ file: "a", reason: 1 }] }),
    ).toBeNull();
  });
});
