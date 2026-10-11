import { describe, expect, it } from "vitest";
import { expandMatrix, parseMatrixSpec, type MatrixSpec } from "./matrix.ts";

function spec(raw: unknown): MatrixSpec {
  const s = parseMatrixSpec(raw);
  if (typeof s === "string") throw new Error(s);
  return s;
}

describe("expandMatrix (GitHub include/exclude semantics)", () => {
  it("include with only new keys extends every original cell", () => {
    expect(expandMatrix(spec({ node: [18, 20], include: [{ experimental: true }] }))).toEqual([
      { node: "18", experimental: "true" },
      { node: "20", experimental: "true" },
    ]);
  });

  it("include extends matching cells and never overwrites original axis values", () => {
    const cells = expandMatrix(
      spec({ os: ["linux", "macos"], node: [18, 20], include: [{ node: 20, npm: 10 }, { os: "macos", node: 20, npm: 11 }] }),
    );
    expect(cells).toEqual([
      { os: "linux", node: "18" },
      { os: "linux", node: "20", npm: "10" },
      { os: "macos", node: "18" },
      // a later include may overwrite an added (non-axis) value
      { os: "macos", node: "20", npm: "11" },
    ]);
  });

  it("include that matches no cell becomes a new cell (and is not extended later)", () => {
    const cells = expandMatrix(
      spec({ os: ["linux"], node: [18, 20], include: [{ node: 22, experimental: true }, { node: 22, os: "linux", x: 1 }] }),
    );
    expect(cells).toEqual([
      { os: "linux", node: "18" },
      { os: "linux", node: "20" },
      { node: "22", experimental: "true" },
      { node: "22", os: "linux", x: "1" },
    ]);
  });

  it("follows GitHub's documented fruit/animal example", () => {
    const cells = expandMatrix(
      spec({
        fruit: ["apple", "pear"],
        animal: ["cat", "dog"],
        include: [
          { color: "green" },
          { color: "pink", animal: "cat" },
          { fruit: "apple", shape: "circle" },
          { fruit: "banana" },
          { fruit: "banana", animal: "cat" },
        ],
      }),
    );
    expect(cells).toEqual([
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ]);
  });

  it("exclude drops cells matching all of an entry's keys (partial match)", () => {
    expect(expandMatrix(spec({ os: ["linux", "macos"], node: [18, 20], exclude: [{ node: 18 }, { os: "macos", node: 20 }] }))).toEqual([
      { os: "linux", node: "20" },
    ]);
  });

  it("applies exclude before include", () => {
    const cells = expandMatrix(
      spec({ os: ["ubuntu-latest"], node: [18, 20], include: [{ node: 22, experimental: true }, { node: 18, old: true }], exclude: [{ node: 18 }] }),
    );
    expect(cells).toEqual([
      { os: "ubuntu-latest", node: "20" },
      { node: "22", experimental: "true" },
      // node=18 was excluded, so this include cannot extend it: new cell
      { node: "18", old: "true" },
    ]);
  });

  it("supports include-only matrices and dedupes identical new cells", () => {
    expect(expandMatrix(spec({ include: [{ target: "a" }, { target: "b" }, { target: "a" }] }))).toEqual([
      { target: "a" },
      { target: "b" },
    ]);
  });
});

describe("parseMatrixSpec bounds", () => {
  it("rejects malformed and unbounded shapes with a reason", () => {
    expect(parseMatrixSpec("${{ fromJSON(needs.a.outputs.m) }}")).toBe("matrix must be a map");
    expect(parseMatrixSpec({})).toMatch(/at least one axis/);
    expect(parseMatrixSpec({ node: [] })).toMatch(/axis `node`/);
    expect(parseMatrixSpec({ node: [{ v: 1 }] })).toMatch(/scalars/);
    expect(parseMatrixSpec({ node: [18], include: "x" })).toMatch(/include must be a list/);
    expect(parseMatrixSpec({ node: [18], include: [{ v: [1] }] })).toMatch(/scalar/);
    expect(parseMatrixSpec({ node: [18], exclude: [{ os: "x" }] })).toMatch(/not a matrix axis/);
    expect(parseMatrixSpec({ node: [18], exclude: [{ node: 18 }] })).toMatch(/zero combinations/);
    const sixteen = Array.from({ length: 16 }, (_, i) => i);
    // product checked before expansion: 16^8 never materializes
    const huge = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, sixteen]));
    expect(parseMatrixSpec(huge)).toMatch(/256/);
    expect(parseMatrixSpec({ a: sixteen, b: [1, 2, 3] })).toMatch(/past 32/);
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1]));
    expect(parseMatrixSpec({ a: [1], include: [nine] })).toMatch(/1-8 keys/);
  });
});
