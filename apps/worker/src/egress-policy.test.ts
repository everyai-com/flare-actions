import { describe, expect, it } from "vitest";
import { applyRepoEgressPolicy, EgressPolicyViolationError } from "./egress-policy";
import type { PipelineJob } from "./pipeline";

const job = (over: Partial<PipelineJob> = {}): PipelineJob => ({ name: "a", steps: [{ run: "echo" }], ...over });
const POLICY = ["github.com", "registry.npmjs.org"];

describe("applyRepoEgressPolicy", () => {
  it("passes jobs through untouched without a repo policy", () => {
    const jobs = [job()];
    expect(applyRepoEgressPolicy(jobs, null)).toEqual({ jobs, violations: [] });
    expect(applyRepoEgressPolicy(jobs, [])).toEqual({ jobs, violations: [] });
  });

  it("gives undeclared jobs the full repo list (floor, not ceiling)", () => {
    const jobs = [job()];
    const { jobs: out, violations } = applyRepoEgressPolicy(jobs, POLICY);
    expect(violations).toEqual([]);
    expect(out[0].egress).toEqual({ allow: POLICY });
    // The input is not mutated, and the list is a copy.
    expect(jobs[0].egress).toBeUndefined();
    expect(out[0].egress?.allow).not.toBe(POLICY);
  });

  it("treats an empty declaration as undeclared", () => {
    const { jobs: out, violations } = applyRepoEgressPolicy([job({ egress: { allow: [] } })], POLICY);
    expect(violations).toEqual([]);
    expect(out[0].egress).toEqual({ allow: POLICY });
  });

  it("keeps job subsets as-is (jobs may narrow)", () => {
    const jobs = [job({ egress: { allow: ["github.com"] } })];
    const { jobs: out, violations } = applyRepoEgressPolicy(jobs, POLICY);
    expect(violations).toEqual([]);
    expect(out[0].egress).toEqual({ allow: ["github.com"] });
  });

  it("flags domains outside the repo list, per job", () => {
    const { violations } = applyRepoEgressPolicy(
      [
        job({ name: "ok", egress: { allow: ["github.com"] } }),
        job({ name: "bad", egress: { allow: ["github.com", "evil.example"] } }),
        job({ name: "worse", egress: { allow: ["oops.example", "evil.example"] } }),
      ],
      POLICY,
    );
    expect(violations).toEqual([
      { job: "bad", outside: ["evil.example"] },
      { job: "worse", outside: ["oops.example", "evil.example"] },
    ]);
  });

  it("flags fully disjoint declarations too", () => {
    const { violations } = applyRepoEgressPolicy([job({ egress: { allow: ["evil.example"] } })], POLICY);
    expect(violations).toEqual([{ job: "a", outside: ["evil.example"] }]);
  });
});

describe("EgressPolicyViolationError", () => {
  it("names the jobs, the offending domains, and the policy", () => {
    const err = new EgressPolicyViolationError("o/r", POLICY, [{ job: "bad", outside: ["evil.example"] }]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EgressPolicyViolationError");
    expect(err.repo).toBe("o/r");
    expect(err.jobs).toEqual(["bad"]);
    expect(err.message).toContain('job "bad" allows [evil.example]');
    expect(err.message).toContain("o/r allowlist ([github.com, registry.npmjs.org])");
  });
});
