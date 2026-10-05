import { describe, expect, it } from "vitest";
import { buildErrorQuery, formatSearchContext, webSearch } from "./websearch";

const input = (output: string) => ({
  repo: "o/r",
  sha: "abc",
  jobName: "test",
  steps: [
    { command: "npm ci", exitCode: 0, output: "ok" },
    { command: "npm test", exitCode: 1, output },
  ],
  logTail: "",
});

describe("buildErrorQuery", () => {
  it("picks the last error-looking line of the first failing step", () => {
    expect(buildErrorQuery(input("starting\nError: Cannot find module 'express'\nmore noise"))).toBe(
      "Error: Cannot find module 'express'",
    );
    expect(buildErrorQuery(input("FAIL src/a.test.ts: expected true to be false\nsummary"))).toBe(
      "FAIL src/a.test.ts: expected true to be false",
    );
  });

  it("falls back to the last line and to null", () => {
    expect(buildErrorQuery(input("just some output"))).toBe("just some output");
    expect(
      buildErrorQuery({ repo: "o/r", sha: "a", jobName: "t", steps: [{ command: "x", exitCode: 0, output: "ok" }], logTail: "" }),
    ).toBeNull();
    expect(buildErrorQuery(input("   \n  "))).toBeNull();
  });
});

describe("webSearch", () => {
  const items = {
    items: [
      { url: "https://a.example/x", title: "Fix X", description: "do the thing" },
      { url: "https://b.example/y", title: "Y docs" },
      { url: "https://c.example/z", title: "Z", description: "zee" },
      { url: "https://d.example/w", title: "W", description: "extra beyond the cap" },
    ],
  };

  it("returns capped, truncated items through the gateway", async () => {
    const seen: unknown[] = [];
    const ai = {
      websearch: async (req: unknown) => {
        seen.push(req);
        return new Response(JSON.stringify(items), { status: 200 });
      },
    };
    const out = await webSearch(ai, "prod", "Error: boom");
    expect(seen).toEqual([{ gatewayId: "prod", query: "Error: boom", limit: 5 }]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ url: "https://a.example/x", title: "Fix X", description: "do the thing" });
    expect(formatSearchContext(out)).toContain("1. Fix X — do the thing (https://a.example/x)");
  });

  it("degrades to [] on anything unexpected", async () => {
    const ok = (body: unknown, status = 200) => ({
      websearch: async () => new Response(JSON.stringify(body), { status }),
    });
    expect(await webSearch(undefined, "g", "q")).toEqual([]);
    expect(await webSearch({} as never, "g", "q")).toEqual([]);
    expect(await webSearch(ok(items), undefined, "q")).toEqual([]);
    expect(await webSearch(ok(items), "g", "  ")).toEqual([]);
    expect(await webSearch(ok(items, 500), "g", "q")).toEqual([]);
    expect(await webSearch(ok({ nope: 1 }), "g", "q")).toEqual([]);
    expect(await webSearch(ok({ items: [{ url: 42 }] }), "g", "q")).toEqual([]);
    expect(
      await webSearch(
        {
          websearch: async () => {
            throw new Error("down");
          },
        },
        "g",
        "q",
      ),
    ).toEqual([]);
  });
});
