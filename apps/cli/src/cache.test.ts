import { describe, expect, it } from "vitest";
import { formatCacheStats, parseCacheStats } from "./cache.ts";

const STATS = {
  days: 7,
  hits: 10,
  misses: 2,
  hitRate: 10 / 12,
  scopes: [{ scope: "node", hits: 9, misses: 1, hitRate: 0.9 }],
};

describe("parseCacheStats", () => {
  it("accepts the server payload", () => {
    expect(parseCacheStats(STATS)).toEqual(STATS);
  });

  it("rejects malformed payloads", () => {
    expect(parseCacheStats(null)).toBeNull();
    expect(parseCacheStats({})).toBeNull();
    expect(parseCacheStats({ ...STATS, scopes: [{ scope: "node" }] })).toBeNull();
    expect(parseCacheStats({ ...STATS, hitRate: "high" })).toBeNull();
  });
});

describe("formatCacheStats", () => {
  it("renders the verdict plus per-scope rows", () => {
    const text = formatCacheStats(STATS);
    expect(text).toContain("cache hit rate (7d): 83.3% (10 hits, 2 misses)");
    expect(text).toContain("node: 90.0% (9 hits, 1 misses)");
  });

  it("names the empty window", () => {
    const text = formatCacheStats({ days: 7, hits: 0, misses: 0, hitRate: 0, scopes: [] });
    expect(text).toContain("0.0%");
    expect(text).toContain("no cache reads in the window");
  });
});
