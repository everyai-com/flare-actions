import { describe, expect, it } from "vitest";
import { LANE_REF_POOL, laneRefPool, missingLaneRefspecs } from "./artifacts-mirror.mjs";
import { MAX_LANE_REFS, laneRefPool as workerPool } from "../apps/worker/src/train-core.ts";

describe("lane-ref pool bootstrap", () => {
  it("matches the Worker's fixed pool exactly", () => {
    expect(LANE_REF_POOL).toBe(MAX_LANE_REFS);
    expect(laneRefPool()).toEqual(workerPool());
  });

  it("creates only the missing refs, at the given sha", () => {
    const have = ["refs/heads/forge/lane-0", "refs/heads/forge/lane-31", "refs/heads/main"];
    const specs = missingLaneRefspecs(have, "abc");
    expect(specs.length).toBe(30);
    expect(specs[0]).toBe("abc:refs/heads/forge/lane-1");
    expect(specs).not.toContain("abc:refs/heads/forge/lane-0");
    expect(missingLaneRefspecs(laneRefPool(), "abc")).toEqual([]);
  });
});
