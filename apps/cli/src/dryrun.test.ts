import { describe, expect, it } from "vitest";
import type { DryRunPlan } from "flare-actions-runner-sdk";
import { formatPlan } from "./dryrun.ts";

function plan(over: Partial<DryRunPlan> = {}): DryRunPlan {
  return {
    repo: "o/r",
    sha: "abcdef1234567890",
    branch: "main",
    pipelineSource: "inline",
    jobs: [],
    queued: 0,
    blocked: 0,
    totalPriorMs: 0,
    budget: null,
    ...over,
  };
}

describe("formatPlan", () => {
  it("renders queued jobs with labels and priors", () => {
    const out = formatPlan(
      plan({
        jobs: [
          { name: "build", base: "build", needs: [], group: null, labels: ["linux"], status: "queued", blockedReason: null, wouldCancelInProgress: false, priorMs: 30000 },
        ],
        queued: 1,
        totalPriorMs: 30000,
      }),
    );
    expect(out).toContain("dry run: o/r@abcdef123456");
    expect(out).toContain("would queue 1, block 0");
    expect(out).toContain("[queued] build");
    expect(out).toContain("labels linux");
    expect(out).toContain("prior 30s");
  });

  it("explains blocked jobs with needs and groups", () => {
    const out = formatPlan(
      plan({
        jobs: [
          { name: "test", base: "test", needs: ["build"], group: null, labels: [], status: "blocked", blockedReason: "needs", wouldCancelInProgress: false, priorMs: 0 },
          { name: "deploy", base: "deploy", needs: [], group: "prod", labels: [], status: "blocked", blockedReason: "group", wouldCancelInProgress: false, priorMs: 0 },
        ],
        blocked: 2,
      }),
    );
    expect(out).toContain("[blocked:needs] test");
    expect(out).toContain("needs build");
    expect(out).toContain("[blocked:group] deploy");
    expect(out).toContain("group prod");
  });

  it("flags cancel-in-progress and blocking budgets", () => {
    const out = formatPlan(
      plan({
        jobs: [
          { name: "deploy", base: "deploy", needs: [], group: "prod", labels: [], status: "queued", blockedReason: null, wouldCancelInProgress: true, priorMs: 0 },
        ],
        queued: 1,
        budget: { mode: "block", usedMinutes: 61, cap: 60, wouldBlock: true },
      }),
    );
    expect(out).toContain("would cancel in-progress");
    expect(out).toContain("BUDGET WOULD BLOCK (61/60 compute-minutes)");
  });
});
