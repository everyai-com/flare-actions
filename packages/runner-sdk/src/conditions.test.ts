// Focused tests for the bounded `if:` engine: grammar coverage,
// budgets, fail-closed eval, and GitHub-compatible missing semantics.
import { describe, expect, it } from "vitest";
import { evaluateCondition, initialJobStatus, jobConditionSatisfied, normalizeCondition, parseCondition } from "./conditions";

const CLEAN = { anyFailed: false, jobFailed: false };
const FAILED = { anyFailed: true, jobFailed: true };
const CTX = {
  needs: { build: { result: "success", outputs: { tag: "v1", empty: "" } }, lint: { result: "failure", outputs: {} } },
  steps: { prep: { sha: "abc" } },
};
const EMPTY = { needs: {}, steps: {} };

describe("parseCondition", () => {
  it("accepts the legacy status functions and negations", () => {
    for (const c of ["always()", "success()", "failure()", "cancelled()", "!failure()", "Failure()", "  always()  "]) {
      expect(parseCondition(c)).not.toBe(null);
    }
  });

  it("accepts comparisons over needs and steps", () => {
    expect(parseCondition("needs.build.result == 'success'")).not.toBe(null);
    expect(parseCondition("needs.build.outputs.tag != 'v0'")).not.toBe(null);
    expect(parseCondition("steps.prep.outputs.sha == 'abc'")).not.toBe(null);
    expect(parseCondition("needs.my.job.result == 'success'")).not.toBe(null);
    expect(parseCondition("needs.build.outputs.tag == 'it''s'")).not.toBe(null);
  });

  it("accepts boolean combinations and parens", () => {
    expect(parseCondition("failure() && needs.build.result == 'success'")).not.toBe(null);
    expect(parseCondition("a == 'x' || b == 'y'")).toBe(null); // bare words are not operands
    expect(parseCondition("!(failure() || cancelled())")).not.toBe(null);
    expect(parseCondition("(needs.a.result == 'x' || needs.a.result == 'y') && success()")).not.toBe(null);
  });

  it("rejects expression soup and enforces budgets", () => {
    for (const c of [
      "",
      "   ",
      "github.event == 'push'",
      "needs.build.result = 'success'",
      "needs.build.result == success",
      "needs.build.result == 'unterminated",
      "needs..result == 'x'",
      "needs.build.outputs.9bad == 'x'",
      "success() &&",
      "|| failure()",
      "(failure()",
      "failure())",
      "success() failure()",
      "needs.build.result === 'success'",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(parseCondition(c)).toBe(null);
    }
    expect(parseCondition(`needs.a.result == '${"x".repeat(300)}'`)).toBe(null); // literal cap
    expect(parseCondition("success() && ".repeat(60) + "success()")).toBe(null); // length cap
    expect(parseCondition("(((((((((((success())))))))))))")).toBe(null); // depth cap
  });

  it("rejects steps refs when allowSteps is false", () => {
    expect(parseCondition("steps.prep.outputs.sha == 'abc'", { allowSteps: false })).toBe(null);
    expect(parseCondition("needs.build.result == 'success'", { allowSteps: false })).not.toBe(null);
    expect(normalizeCondition("Failure()", { allowSteps: false })).toBe("Failure()");
  });

  it("normalizeCondition keeps the trimmed original (literals keep case)", () => {
    expect(normalizeCondition("  needs.Build.result == 'Prod'  ")).toBe("needs.Build.result == 'Prod'");
    expect(normalizeCondition("nope(")).toBe(null);
    expect(normalizeCondition("Needs.build.result == 'x'")).toBe(null);
  });
});

describe("evaluateCondition", () => {
  it("keeps legacy fn semantics", () => {
    expect(evaluateCondition("always()", FAILED, EMPTY)).toBe(true);
    expect(evaluateCondition("success()", CLEAN, EMPTY)).toBe(true);
    expect(evaluateCondition("success()", FAILED, EMPTY)).toBe(false);
    expect(evaluateCondition("failure()", FAILED, EMPTY)).toBe(true);
    expect(evaluateCondition("failure()", CLEAN, EMPTY)).toBe(false);
    expect(evaluateCondition("cancelled()", FAILED, EMPTY)).toBe(false);
    expect(evaluateCondition("!failure()", CLEAN, EMPTY)).toBe(true);
  });

  it("compares needs results and outputs", () => {
    expect(evaluateCondition("needs.build.result == 'success'", CLEAN, CTX)).toBe(true);
    expect(evaluateCondition("needs.build.result != 'success'", CLEAN, CTX)).toBe(false);
    expect(evaluateCondition("needs.build.outputs.tag == 'v1'", CLEAN, CTX)).toBe(true);
    expect(evaluateCondition("needs.lint.result == 'success'", CLEAN, CTX)).toBe(false);
    expect(evaluateCondition("steps.prep.outputs.sha == 'abc'", CLEAN, CTX)).toBe(true);
    expect(evaluateCondition("failure() && needs.build.result == 'success'", FAILED, CTX)).toBe(true);
    expect(evaluateCondition("failure() && needs.build.result == 'success'", CLEAN, CTX)).toBe(false);
    expect(evaluateCondition("needs.nope.result == 'x' || success()", CLEAN, CTX)).toBe(true);
  });

  it("treats missing refs as empty strings (GitHub parity)", () => {
    expect(evaluateCondition("needs.missing.result == ''", CLEAN, CTX)).toBe(true);
    expect(evaluateCondition("needs.build.outputs.missing == ''", CLEAN, CTX)).toBe(true);
    expect(evaluateCondition("needs.build.outputs.missing != 'x'", CLEAN, CTX)).toBe(true);
    expect(evaluateCondition("needs.build.outputs.missing == 'x'", CLEAN, CTX)).toBe(false);
    expect(evaluateCondition("steps.later.outputs.x == ''", CLEAN, CTX)).toBe(true);
  });

  it("fails closed on unparseable input", () => {
    expect(evaluateCondition("github.event == 'push'", CLEAN, CTX)).toBe(false);
    expect(evaluateCondition("", CLEAN, CTX)).toBe(false);
  });

  it("honors && over || without parens", () => {
    const ctx = { needs: { a: { result: "x", outputs: {} } }, steps: {} };
    // a=='y' || (a=='x' && failure()) → false when clean.
    expect(evaluateCondition("needs.a.result == 'y' || needs.a.result == 'x' && failure()", CLEAN, ctx)).toBe(false);
    expect(evaluateCondition("needs.a.result == 'y' || needs.a.result == 'x' && failure()", FAILED, ctx)).toBe(true);
  });

  it("keeps cancelled() false at step level unless the engine reports it", () => {
    expect(evaluateCondition("cancelled()", CLEAN, EMPTY)).toBe(false);
    expect(evaluateCondition("cancelled()", FAILED, EMPTY)).toBe(false);
    expect(evaluateCondition("cancelled()", { anyFailed: false, jobFailed: false, anyCancelled: true }, EMPTY)).toBe(true);
  });
});

describe("jobConditionSatisfied", () => {
  const skipped = { build: { result: "skipped", outputs: {} } };
  const cancelled = { build: { result: "cancelled", outputs: {} } };
  const failed = { build: { result: "failure", outputs: {} } };
  const green = { build: { result: "success", outputs: {} } };

  it("cascade-skips default dependents of skipped needs without tripping failure()", () => {
    expect(jobConditionSatisfied(undefined, true, skipped)).toBe(false);
    expect(jobConditionSatisfied("success()", true, skipped)).toBe(false);
    expect(jobConditionSatisfied("failure()", true, skipped)).toBe(false);
    expect(jobConditionSatisfied("always()", true, skipped)).toBe(true);
    expect(jobConditionSatisfied("cancelled()", true, skipped)).toBe(false);
  });

  it("routes cancelled needs to cancelled(), not failure()", () => {
    expect(jobConditionSatisfied(undefined, true, cancelled)).toBe(false);
    expect(jobConditionSatisfied("failure()", true, cancelled)).toBe(false);
    expect(jobConditionSatisfied("cancelled()", true, cancelled)).toBe(true);
    expect(jobConditionSatisfied("always()", true, cancelled)).toBe(true);
  });

  it("keeps failure() true on real failures and success() true on green", () => {
    expect(jobConditionSatisfied("failure()", false, failed)).toBe(true);
    expect(jobConditionSatisfied(undefined, false, failed)).toBe(false);
    expect(jobConditionSatisfied(undefined, false, green)).toBe(true);
    expect(jobConditionSatisfied("failure()", false, green)).toBe(false);
  });

  it("falls back to the coarse flag when there are no needs to read", () => {
    expect(jobConditionSatisfied(undefined, false, {})).toBe(true);
    expect(jobConditionSatisfied("failure()", false, {})).toBe(false);
    expect(jobConditionSatisfied("failure()", true)).toBe(true);
    expect(jobConditionSatisfied("cancelled()", true)).toBe(false);
  });

  it("fails closed on unparseable conditions", () => {
    expect(jobConditionSatisfied("github.event == 'push'", false, green)).toBe(false);
  });
});

describe("initialJobStatus", () => {
  it("parks needs and group jobs, queues plain roots", () => {
    expect(initialJobStatus({ needs: ["build"] }, false)).toEqual({ status: "blocked", blockedReason: "needs" });
    expect(initialJobStatus({}, true)).toEqual({ status: "blocked", blockedReason: "group" });
    expect(initialJobStatus({}, false)).toEqual({ status: "queued", blockedReason: null });
    expect(initialJobStatus({ if: "always()" }, false)).toEqual({ status: "queued", blockedReason: null });
  });

  it("skips roots whose if is already false instead of queueing", () => {
    expect(initialJobStatus({ if: "failure()" }, false)).toEqual({ status: "skipped", blockedReason: "if" });
    expect(initialJobStatus({ if: "garbage((", }, false)).toEqual({ status: "skipped", blockedReason: "if" });
  });

  it("defers needs jobs to promote even when their if reads false early", () => {
    // needs.test.result is unknown at fan-out; promote evaluates later.
    expect(initialJobStatus({ needs: ["test"], if: "failure()" }, false)).toEqual({
      status: "blocked",
      blockedReason: "needs",
    });
  });
});
