import { describe, expect, it } from "vitest";
import { hasJsonFlag, jsonEnvelope, splitPassthrough, stripJsonFlag, JSON_SCHEMA_VERSION } from "./json";

describe("json envelope", () => {
  it("versions every payload", () => {
    expect(JSON_SCHEMA_VERSION).toBe(1);
    expect(jsonEnvelope("runs", { runs: [] })).toEqual({ version: 1, command: "runs", data: { runs: [] } });
  });
});

describe("json flag parsing", () => {
  it("detects and strips the flag", () => {
    expect(hasJsonFlag(["o/r", "--json"])).toBe(true);
    expect(hasJsonFlag(["o/r"])).toBe(false);
    expect(stripJsonFlag(["--json", "o/r", "--json"])).toEqual(["o/r"]);
  });

  it("never eats a --json past the passthrough separator", () => {
    expect(splitPassthrough(["exec", "box", "--", "curl", "--json"])).toEqual({
      head: ["exec", "box"],
      tail: ["--", "curl", "--json"],
    });
    expect(splitPassthrough(["o/r", "--json"])).toEqual({ head: ["o/r", "--json"], tail: [] });
    const { head } = splitPassthrough(["exec", "box", "--", "curl", "--json"]);
    expect(hasJsonFlag(head)).toBe(false);
  });
});
