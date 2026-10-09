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

  it("keeps step ids and job outputs, rejecting malformed shapes", () => {
    const good = {
      steps: [{ run: "x", id: "build" }],
      outputs: { image: "build.tag" },
    };
    const spec = parseJobSpec(JSON.stringify(good));
    expect(spec?.steps).toEqual([{ run: "x", id: "build" }]);
    expect(spec?.outputs).toEqual({ image: "build.tag" });
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", id: "9bad" }] }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x", id: "a" }, { run: "y", id: "a" }] }))).toBeNull();
    const withSteps = { steps: [{ run: "x", id: "build" }] };
    expect(parseJobSpec(JSON.stringify({ ...withSteps, outputs: {} }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ ...withSteps, outputs: { bad: "no-dot" } }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ ...withSteps, outputs: { "9bad": "build.tag" } }))).toBeNull();
    const many: Record<string, string> = {};
    for (let i = 0; i < 17; i++) many[`o${i}`] = "build.tag";
    expect(parseJobSpec(JSON.stringify({ ...withSteps, outputs: many }))).toBeNull();
  });

  it("keeps cache restoreKeys and rejects malformed shapes", () => {
    const good = { steps: [{ run: "x" }], cache: { key: "k", paths: ["y"], restoreKeys: ["node-", "npm-"] } };
    expect(parseJobSpec(JSON.stringify(good))?.cache).toEqual({ key: "k", paths: ["y"], restoreKeys: ["node-", "npm-"] });
    const bad = { steps: [{ run: "x" }], cache: { key: "k", paths: ["y"] } };
    expect(parseJobSpec(JSON.stringify({ ...bad, cache: { ...bad.cache, restoreKeys: [] } }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ ...bad, cache: { ...bad.cache, restoreKeys: ["../x"] } }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ ...bad, cache: { ...bad.cache, restoreKeys: "node-" } }))).toBeNull();
    const many = Array.from({ length: 11 }, (_, i) => `p${i}-`);
    expect(parseJobSpec(JSON.stringify({ ...bad, cache: { ...bad.cache, restoreKeys: many } }))).toBeNull();
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

  it("keeps check actions and preview-URL templates, rejects malformed shapes", () => {
    const good = [
      {
        name: "login",
        url: "https://app-git-{branch}.example.com/login",
        expectText: "Welcome",
        actions: [
          { kind: "type", selector: "#user", text: "demo" },
          { kind: "click", selector: "#submit" },
          { kind: "wait", selector: "#dashboard" },
          { kind: "wait-text", text: "Welcome" },
        ],
      },
    ];
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], browserChecks: good }))?.browserChecks).toEqual(good);
    const bad = (checks: unknown) => parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], browserChecks: checks }));
    const check = (over: Record<string, unknown>) =>
      bad([{ name: "x", url: "https://example.com/", expectTitle: "t", ...over }]);
    expect(check({ actions: [] })).toBeNull();
    expect(check({ actions: [{ kind: "hover", selector: "#x" }] })).toBeNull();
    expect(check({ actions: [{ kind: "type", selector: "#x" }] })).toBeNull();
    expect(check({ actions: [{ kind: "click", selector: "#x", text: "stray" }] })).toBeNull();
    expect(check({ actions: [{ kind: "wait-text", text: "t", selector: "#x" }] })).toBeNull();
    expect(check({ actions: [{ kind: "click", selector: "" }] })).toBeNull();
    expect(check({ actions: [{ kind: "wait-text", text: "" }] })).toBeNull();
    expect(check({ actions: Array.from({ length: 11 }, () => ({ kind: "click", selector: "#x" })) })).toBeNull();
    expect(bad([{ name: "x", url: "https://{repo}.example.com/", expectTitle: "t" }])).toBeNull();
    expect(bad([{ name: "x", url: "https://example.com/{branch", expectTitle: "t" }])).toBeNull();
  });

  it("keeps CI profile tags and rejects malformed shapes", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], tags: ["fast", "smoke"] }))?.tags).toEqual(["fast", "smoke"]);
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }] }))?.tags).toBeUndefined();
    const bad = (tags: unknown) => parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], tags }));
    expect(bad([])).toBeNull();
    expect(bad("fast")).toBeNull();
    expect(bad(["ok", 42])).toBeNull();
    expect(bad([""])).toBeNull();
    expect(bad(Array.from({ length: 9 }, (_, i) => `t${i}`))).toBeNull();
  });

  it("keeps egress allowlists and rejects malformed shapes", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], egress: { allow: ["Example.COM"] } }))?.egress).toEqual({
      allow: ["example.com"],
    });
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }] }))?.egress).toBeUndefined();
    const bad = (egress: unknown) => parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], egress }));
    expect(bad({ allow: [] })).toBeNull();
    expect(bad({ allow: "example.com" })).toBeNull();
    expect(bad({ allow: ["https://example.com/"] })).toBeNull();
    expect(bad({ allow: ["a.com", "a.com"] })).toBeNull();
    expect(bad("nope")).toBeNull();
  });

  it("keeps test-selection configs and rejects malformed shapes", () => {
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], testSelection: true }))?.testSelection).toEqual({});
    expect(
      parseJobSpec(
        JSON.stringify({ steps: [{ run: "x" }], testSelection: { tests: ["t/**"], fullOnBranches: ["main"], historyDays: 3 } }),
      )?.testSelection,
    ).toEqual({ tests: ["t/**"], fullOnBranches: ["main"], historyDays: 3 });
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }] }))?.testSelection).toBeUndefined();
    const bad = (testSelection: unknown) => parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], testSelection }));
    expect(bad({ tests: [] })).toBeNull();
    expect(bad({ historyDays: 31 })).toBeNull();
    expect(bad("yes")).toBeNull();
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
