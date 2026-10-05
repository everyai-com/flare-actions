import { describe, expect, it } from "vitest";
import { matrixEnv, parseJobSpec, stepRuns } from "./spec";

describe("parseJobSpec", () => {
  it("parses a full spec", () => {
    const spec = parseJobSpec(
      JSON.stringify({
        steps: [{ run: "echo" }],
        base: "test",
        matrix: { node: "20" },
        env: { TAG: "v1" },
        container: "node:20",
        services: { db: { image: "postgres:16", ports: ["5432:5432"] } },
        cache: { key: "k", paths: ["node_modules"] },
        artifacts: { name: "dist", paths: ["dist"] },
        timeoutMinutes: 10,
      }),
    );
    expect(spec?.container).toBe("node:20");
    expect(spec?.services?.db.image).toBe("postgres:16");
    expect(spec?.cache).toEqual({ key: "k", paths: ["node_modules"] });
    expect(spec?.timeoutMinutes).toBe(10);
  });

  it("parses legacy step-only definitions", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "echo" }] }))?.steps).toEqual([{ run: "echo" }]);
  });

  it("keeps continue-on-error flags and rejects malformed ones", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", continueOnError: true }] }))?.steps).toEqual([
      { run: "x", continueOnError: true },
    ]);
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", continueOnError: 1 }] }))).toBeNull();
  });

  it("keeps supported step conditions and rejects expression soup", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", if: "always()" }] }))?.steps).toEqual([
      { run: "x", if: "always()" },
    ]);
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", if: "!cancelled()" }] }))?.steps).toEqual([
      { run: "x", if: "!cancelled()" },
    ]);
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", if: "github.event_name == 'push'" }] }))).toBeNull();
  });

  it("keeps step timeouts/shell and rejects malformed ones", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", timeoutMinutes: 5, shell: "bash" }] }))?.steps).toEqual([
      { run: "x", timeoutMinutes: 5, shell: "bash" },
    ]);
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", timeoutMinutes: 0 }] }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", shell: "sh -c evil" }] }))).toBeNull();
  });

  it("rejects bad steps and bad option shapes", () => {
    expect(parseJobSpec("")).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [] }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: 42 }] }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], container: 42 }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], cache: { key: "k" } }))).toBeNull();
  });

  it("keeps test-reports paths and rejects malformed shapes", () => {
    expect(
      parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], testReports: { paths: ["junit.xml", "reports"] } }))?.testReports,
    ).toEqual({ paths: ["junit.xml", "reports"] });
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], testReports: { paths: [] } }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], testReports: [] }))).toBeNull();
  });

  it("keeps retain-on-failure and rejects non-boolean shapes", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], retainOnFailure: true }))?.retainOnFailure).toBe(true);
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], retainOnFailure: false }))?.retainOnFailure).toBeUndefined();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }]}))?.retainOnFailure).toBeUndefined();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], retainOnFailure: "yes" }))).toBeNull();
  });

  it("keeps browser-checks and rejects malformed shapes", () => {
    const good = [{ name: "home", url: "https://example.com/", expectTitle: "Example", screenshot: false }];
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], browserChecks: good }))?.browserChecks).toEqual(good);
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }] }))?.browserChecks).toBeUndefined();
    const bad = (checks: unknown) => parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], browserChecks: checks }));
    expect(bad([])).toBeNull();
    expect(bad([{ name: "home", url: "http://example.com/", expectTitle: "x" }])).toBeNull();
    expect(bad([{ name: "home", url: "https://example.com/" }])).toBeNull();
    expect(bad([{ name: "dup", url: "https://example.com/", expectTitle: "x" }, { name: "dup", url: "https://example.com/", expectTitle: "x" }])).toBeNull();
    expect(
      bad(Array.from({ length: 11 }, (_, i) => ({ name: `c${i}`, url: "https://example.com/", expectTitle: "x" }))),
    ).toBeNull();
  });
});

describe("stepRuns", () => {
  it("evaluates the bounded subset with negations", () => {
    const clean = { anyFailed: false, jobFailed: false };
    const failed = { anyFailed: true, jobFailed: true };
    const coeOnly = { anyFailed: true, jobFailed: false };
    expect(stepRuns(undefined, clean)).toBe(true);
    expect(stepRuns(undefined, failed)).toBe(false);
    expect(stepRuns("always()", failed)).toBe(true);
    expect(stepRuns("success()", coeOnly)).toBe(true);
    expect(stepRuns("failure()", failed)).toBe(true);
    expect(stepRuns("failure()", clean)).toBe(false);
    expect(stepRuns("failure()", coeOnly)).toBe(true);
    expect(stepRuns("cancelled()", failed)).toBe(false);
    expect(stepRuns("!cancelled()", failed)).toBe(true);
    expect(stepRuns("!always()", clean)).toBe(false);
    expect(stepRuns("!failure()", clean)).toBe(true);
  });
});

describe("matrixEnv", () => {
  it("uppercases keys with a FLARE prefix", () => {
    expect(matrixEnv({ node: "20", "os-name": "linux" })).toEqual({
      FLARE_MATRIX_NODE: "20",
      FLARE_MATRIX_OS_NAME: "linux",
    });
    expect(matrixEnv(undefined)).toEqual({});
  });
});
