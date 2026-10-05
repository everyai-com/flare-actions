import { describe, expect, it } from "vitest";
import { labelsMatch, simulateDrain, splitLabels, type SimJob } from "./fairness";

const job = (over: Partial<SimJob> & { id: string }): SimJob => ({
  repo: "o/a",
  priority: 0,
  createdAt: "2026-10-02T10:00:00.000Z",
  labels: "",
  ...over,
});

describe("labelsMatch", () => {
  it("matches the claim-path predicate", () => {
    expect(splitLabels("linux, gpu")).toEqual(["linux", "gpu"]);
    expect(splitLabels("")).toEqual([]);
    expect(labelsMatch("", [])).toBe(true);
    expect(labelsMatch("", ["linux"])).toBe(true);
    expect(labelsMatch("linux", [])).toBe(false);
    expect(labelsMatch("linux,gpu", ["linux", "gpu"])).toBe(true);
    expect(labelsMatch("linux,gpu", ["linux"])).toBe(false);
  });
});

describe("simulateDrain", () => {
  it("claims priority-first, oldest-first, id-tiebroken", () => {
    const jobs = [
      job({ id: "c", priority: 0, createdAt: "2026-10-02T10:00:03.000Z" }),
      job({ id: "a", priority: 5, createdAt: "2026-10-02T10:00:02.000Z" }),
      job({ id: "b", priority: 5, createdAt: "2026-10-02T10:00:01.000Z" }),
      job({ id: "d", priority: 0, createdAt: "2026-10-02T10:00:01.000Z" }),
    ];
    const claims = simulateDrain(jobs, [{ id: "r1", labels: [] }]);
    expect(claims.map((c) => c.jobId)).toEqual(["b", "a", "d", "c"]);
    expect(claims[0]).toMatchObject({ runnerId: "r1", round: 1, repo: "o/a" });
  });

  it("skips jobs the runner's labels cannot take", () => {
    const jobs = [job({ id: "gpu-job", labels: "gpu" }), job({ id: "plain" })];
    expect(simulateDrain(jobs, [{ id: "r1", labels: [] }]).map((c) => c.jobId)).toEqual(["plain"]);
    expect(simulateDrain(jobs, [{ id: "r1", labels: ["gpu"] }]).map((c) => c.jobId)).toEqual(["gpu-job", "plain"]);
  });

  it("honors repo allowlists and fair-share caps", () => {
    const jobs = [
      job({ id: "a1", repo: "o/a", createdAt: "2026-10-02T10:00:01.000Z" }),
      job({ id: "b1", repo: "o/b", createdAt: "2026-10-02T10:00:02.000Z" }),
      job({ id: "a2", repo: "o/a", createdAt: "2026-10-02T10:00:03.000Z" }),
    ];
    // Repo-scoped runner skips other repos.
    expect(simulateDrain(jobs, [{ id: "r1", labels: [], repos: ["o/b"] }]).map((c) => c.jobId)).toEqual(["b1"]);
    // Cap 1 with o/a already running: o/a queued jobs wait, o/b flows.
    const capped = simulateDrain(jobs, [{ id: "r1", labels: [] }], 1, { "o/a": 1 });
    expect(capped.map((c) => c.jobId)).toEqual(["b1"]);
    // Cap 1 from idle: the first o/a job flows, then o/b jumps the
    // second o/a job (nothing finishes mid-simulation, so a2 waits).
    const capped1 = simulateDrain(jobs, [{ id: "r1", labels: [] }], 1);
    expect(capped1.map((c) => c.jobId)).toEqual(["a1", "b1"]);
  });

  it("is deterministic regardless of input order", () => {
    const jobs = [
      job({ id: "a", priority: 3 }),
      job({ id: "b", priority: 3, labels: "gpu" }),
      job({ id: "c", priority: 1 }),
    ];
    const runners = [
      { id: "r1", labels: [] },
      { id: "r2", labels: ["gpu"] },
    ];
    const fwd = simulateDrain(jobs, runners, 1);
    const rev = simulateDrain([...jobs].reverse(), runners, 1);
    expect(rev).toEqual(fwd);
    expect(simulateDrain(jobs, runners, 1)).toEqual(fwd);
  });
});
