import { describe, expect, it } from "vitest";
import { matrixEnv, parseJobSpec } from "./spec";

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

  it("rejects bad steps and bad option shapes", () => {
    expect(parseJobSpec("")).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [] }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: 42 }] }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], container: 42 }))).toBeNull();
    expect(parseJobSpec(JSON.stringify({ steps: [{ run: "x" }], cache: { key: "k" } }))).toBeNull();
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
