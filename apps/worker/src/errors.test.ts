import { describe, expect, it } from "vitest";
import { apiError, dispatchErrorCode, ERROR_CODES, ERROR_HINTS } from "./errors";

describe("apiError", () => {
  it("keeps the message first and attaches the catalog hint", () => {
    expect(apiError("budget_exceeded", "monthly budget exceeded for o/r (61/60 compute-minutes)")).toEqual({
      error: "monthly budget exceeded for o/r (61/60 compute-minutes)",
      code: "budget_exceeded",
      hint: ERROR_HINTS.budget_exceeded,
    });
  });

  it("lets routes override the hint with specifics", () => {
    expect(apiError("unauthorized", "unauthorized", "this endpoint needs the run scope")).toMatchObject({
      code: "unauthorized",
      hint: "this endpoint needs the run scope",
    });
  });

  it("covers every code with a non-empty next step", () => {
    expect(Object.keys(ERROR_HINTS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_HINTS[code].length).toBeGreaterThan(10);
    }
  });
});

describe("dispatchErrorCode", () => {
  it("maps load-phase failures to stable codes", () => {
    expect(dispatchErrorCode("pipeline parse failed")).toBe("invalid_pipeline");
    expect(dispatchErrorCode('could not resolve ref "main" — paste a full commit SHA')).toBe("unresolvable_ref");
    expect(dispatchErrorCode('unknown profile "smoke" (pipeline defines no profiles)')).toBe("unknown_profile");
    expect(dispatchErrorCode('profile "smoke" selected no jobs')).toBe("invalid_pipeline");
    expect(dispatchErrorCode('egress policy violation: job "bad" allows [evil.example] outside the o/r allowlist')).toBe(
      "egress_policy_violation",
    );
    expect(dispatchErrorCode("something else")).toBe("invalid_request");
  });
});
