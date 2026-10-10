import { describe, expect, it } from "vitest";
import { isHexSha, planFanOut, validateDispatch, validateMigrateInput, validateRegisterInput, validateScheduleInput, webhookSkipReason } from "./index";
import type { PipelineJob } from "./pipeline";

const SHA = "4203928f77b90dec92b4cd47b9e0795378752ef7";
const ZERO = "0000000000000000000000000000000000000000";

describe("webhookSkipReason", () => {
  it("allows normal pushes", () => {
    expect(webhookSkipReason("push", { after: SHA, ref: "refs/heads/main" })).toBeNull();
  });

  it("allows new-branch pushes", () => {
    expect(webhookSkipReason("push", { after: SHA, ref: "refs/heads/feat" })).toBeNull();
  });

  it("skips branch deletions", () => {
    expect(
      webhookSkipReason("push", { after: ZERO, ref: "refs/heads/old", deleted: true }),
    ).toBe("ref deleted");
  });

  it("skips zero SHAs even without the deleted flag", () => {
    expect(webhookSkipReason("push", { after: ZERO, ref: "refs/heads/old" })).toBe(
      "zero sha (deleted ref)",
    );
  });

  it("allows pull requests", () => {
    expect(
      webhookSkipReason("pull_request", { pull_request: { head: { sha: SHA, ref: "feat" } } }),
    ).toBeNull();
  });

  it("skips ping deliveries", () => {
    expect(webhookSkipReason("ping", { repository: { full_name: "o/r" } })).toBe(
      "unsupported event: ping",
    );
  });

  it("skips other non-CI events", () => {
    expect(webhookSkipReason("installation", {})).toBe("unsupported event: installation");
  });

  it("runs only opened/synchronize/reopened pull_request actions", () => {
    const pr = { pull_request: { head: { sha: SHA, ref: "feat" } } };
    for (const action of ["opened", "synchronize", "reopened"]) {
      expect(webhookSkipReason("pull_request", { ...pr, action })).toBeNull();
    }
    for (const action of ["closed", "labeled", "edited", "review_requested"]) {
      expect(webhookSkipReason("pull_request", { ...pr, action })).toBe(`pull_request action: ${action}`);
    }
    expect(webhookSkipReason("unknown", {})).toBe("unsupported event: unknown");
  });
});

describe("isHexSha", () => {
  it("distinguishes SHAs from branch names", () => {
    expect(isHexSha("4203928f77b90dec92b4cd47b9e0795378752ef7")).toBe(true);
    expect(isHexSha("abc1234")).toBe(true);
    expect(isHexSha("main")).toBe(false);
    expect(isHexSha("feature/foo")).toBe(false);
    expect(isHexSha("v1.2.3")).toBe(false);
  });
});

describe("validateDispatch", () => {
  it("accepts shas, slashed branches, tags, and optional pipeline", () => {
    expect(validateDispatch({ repo: "o/r", sha: "main" })).toEqual({
      repo: "o/r",
      sha: "main",
      ref: "",
      pipeline: undefined,
      priority: 0,
      agent: "",
    });
    expect(validateDispatch({ repo: "o/r", sha: "feature/x", ref: "feature/x" })).toEqual({
      repo: "o/r",
      sha: "feature/x",
      ref: "feature/x",
      pipeline: undefined,
      priority: 0,
      agent: "",
    });
    expect(validateDispatch({ repo: "o/r", sha: "v1.2.3", pipeline: "jobs: {}" })).toMatchObject({ pipeline: "jobs: {}" });
  });

  it("parses the agent identity tag", () => {
    expect(validateDispatch({ repo: "o/r", sha: "main", agent: "atlas-1" })).toMatchObject({ agent: "atlas-1" });
    expect(validateDispatch({ repo: "o/r", sha: "main" })).toMatchObject({ agent: "" });
    expect(validateDispatch({ repo: "o/r", sha: "main", agent: "has space" })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", agent: "x".repeat(65) })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", agent: 42 })).toHaveProperty("error");
  });

  it("parses the CI profile override", () => {
    expect(validateDispatch({ repo: "o/r", sha: "main", profile: "smoke" })).toMatchObject({ profile: "smoke" });
    expect(validateDispatch({ repo: "o/r", sha: "main" })).toMatchObject({ profile: undefined });
    expect(validateDispatch({ repo: "o/r", sha: "main", profile: "has space" })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", profile: "x".repeat(65) })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", profile: 42 })).toHaveProperty("error");
  });

  it("parses the agent priority lane", () => {
    expect(validateDispatch({ repo: "o/r", sha: "main", priority: 9 })).toMatchObject({ priority: 9 });
    expect(validateDispatch({ repo: "o/r", sha: "main", priority: 0 })).toMatchObject({ priority: 0 });
    expect(validateDispatch({ repo: "o/r", sha: "main", priority: 11 })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", priority: 1.5 })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", priority: "high" })).toHaveProperty("error");
  });

  it("validates source dispatches (working tree, no commit)", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(validateDispatch({ repo: "o/r", pipeline: "jobs: {}", source: id })).toEqual({
      repo: "o/r",
      sha: "",
      ref: "",
      pipeline: "jobs: {}",
      priority: 0,
      source: id,
      agent: "",
    });
    expect(validateDispatch({ repo: "o/r", pipeline: "jobs: {}", source: id, priority: 5, ref: "local" })).toMatchObject({
      priority: 5,
      ref: "local",
      source: id,
    });
    expect(validateDispatch({ repo: "o/r", source: "nope", pipeline: "jobs: {}" })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", source: id })).toHaveProperty("error"); // pipeline is the contract
    expect(validateDispatch({ repo: "o/r", source: id, pipeline: "   " })).toHaveProperty("error");
  });

  it("rejects malformed input with a message", () => {
    expect(validateDispatch({ repo: "nope", sha: "main" })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r" })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "../etc/passwd" })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "a".repeat(129) })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", pipeline: "   " })).toHaveProperty("error");
    expect(validateDispatch({ repo: "o/r", sha: "main", ref: 42 })).toHaveProperty("error");
  });
});

describe("validateScheduleInput", () => {
  it("accepts a well-formed schedule and trims the cron", () => {
    expect(validateScheduleInput({ repo: "o/r", ref: "main", cron: "0 3 * * *" })).toEqual({
      repo: "o/r",
      ref: "main",
      cron: "0 3 * * *",
    });
    expect(validateScheduleInput({ repo: "o/r", ref: "release/v1", cron: "  */15 * * * * " })).toEqual({
      repo: "o/r",
      ref: "release/v1",
      cron: "*/15 * * * *",
    });
  });

  it("rejects bad repos, refs, and crons", () => {
    expect(validateScheduleInput({ repo: "nope", ref: "main", cron: "0 3 * * *" })).toHaveProperty("error");
    expect(validateScheduleInput({ repo: "o/r", ref: "", cron: "0 3 * * *" })).toHaveProperty("error");
    expect(validateScheduleInput({ repo: "o/r", ref: "../x", cron: "0 3 * * *" })).toHaveProperty("error");
    expect(validateScheduleInput({ repo: "o/r", ref: "main", cron: "0 3 * *" })).toHaveProperty("error");
    expect(validateScheduleInput({ repo: "o/r", ref: "main", cron: 42 })).toHaveProperty("error");
  });

  it("accepts an optional pinned CI profile", () => {
    expect(validateScheduleInput({ repo: "o/r", ref: "main", cron: "0 3 * * *", profile: "full" })).toEqual({
      repo: "o/r",
      ref: "main",
      cron: "0 3 * * *",
      profile: "full",
    });
    expect(validateScheduleInput({ repo: "o/r", ref: "main", cron: "0 3 * * *", profile: "has space" })).toHaveProperty("error");
    expect(validateScheduleInput({ repo: "o/r", ref: "main", cron: "0 3 * * *", profile: 42 })).toHaveProperty("error");
  });
});

describe("validateRegisterInput", () => {
  it("routes invite tokens in invite mode, open or closed", () => {
    expect(validateRegisterInput({ token: "tok", password: "long-enough" }, false)).toEqual({
      mode: "invite",
      token: "tok",
      password: "long-enough",
    });
    expect(validateRegisterInput({ token: "tok", password: "long-enough" }, true)).toEqual({
      mode: "invite",
      token: "tok",
      password: "long-enough",
    });
  });

  it("routes bare emails in open mode only, normalized", () => {
    expect(validateRegisterInput({ email: "  New@Example.com ", password: "long-enough" }, true)).toEqual({
      mode: "open",
      email: "new@example.com",
      password: "long-enough",
    });
    expect(validateRegisterInput({ email: "new@example.com", password: "long-enough" }, false)).toEqual({
      error: "invite required",
    });
  });

  it("prefers the token when both are present", () => {
    expect(validateRegisterInput({ token: "tok", email: "new@example.com", password: "long-enough" }, true)).toEqual({
      mode: "invite",
      token: "tok",
      password: "long-enough",
    });
  });

  it("rejects weak passwords and bad emails", () => {
    expect(validateRegisterInput({ token: "tok", password: "short" }, true)).toHaveProperty("error");
    expect(validateRegisterInput({ email: "not-an-email", password: "long-enough" }, true)).toHaveProperty("error");
    expect(validateRegisterInput({ password: "long-enough" }, true)).toHaveProperty("error");
  });
});

describe("planFanOut", () => {
  const job = (over: Partial<PipelineJob> & { name: string }): PipelineJob => ({ steps: [], ...over });

  it("queues independent jobs and parks jobs with needs", () => {
    const planned = planFanOut(
      [job({ name: "build" }), job({ name: "test", needs: ["build"] })],
      () => false,
    );
    expect(planned[0]).toMatchObject({ status: "queued", blockedReason: null });
    expect(planned[1]).toMatchObject({ status: "blocked", blockedReason: "needs", needs: ["build"] });
  });

  it("parks same-group jobs only while the group is active", () => {
    const jobs = [job({ name: "deploy", group: "prod" })];
    expect(planFanOut(jobs, () => true)[0]).toMatchObject({ status: "blocked", blockedReason: "group" });
    expect(planFanOut(jobs, () => false)[0]).toMatchObject({ status: "queued", blockedReason: null });
  });

  it("lets cancel-in-progress skip the group block and flags the supersede", () => {
    const planned = planFanOut([job({ name: "deploy", group: "prod", cancelInProgress: true })], () => true);
    expect(planned[0]).toMatchObject({ status: "queued", wouldCancelInProgress: true });
  });

  it("skips roots whose if is already false and defers needs jobs to promote", () => {
    const planned = planFanOut(
      [job({ name: "notify", if: "failure()" }), job({ name: "cleanup", needs: ["test"], if: "failure()" })],
      () => false,
    );
    expect(planned[0]).toMatchObject({ status: "skipped", blockedReason: "if" });
    expect(planned[1]).toMatchObject({ status: "blocked", blockedReason: "needs" });
  });

  it("reports observe-only with no repo policy", () => {
    const planned = planFanOut([job({ name: "build" })], () => false);
    expect(planned[0]).toMatchObject({ egressAllow: null, policyViolation: null });
  });

  it("shows the effective allowlist after the repo floor policy", () => {
    const planned = planFanOut(
      [job({ name: "build" }), job({ name: "test", egress: { allow: ["github.com"] } })],
      () => false,
      ["github.com", "registry.npmjs.org"],
    );
    expect(planned[0]).toMatchObject({ egressAllow: ["github.com", "registry.npmjs.org"], policyViolation: null });
    expect(planned[1]).toMatchObject({ egressAllow: ["github.com"], policyViolation: null });
  });

  it("flags jobs outside the repo list without rejecting the plan", () => {
    const planned = planFanOut([job({ name: "bad", egress: { allow: ["evil.example"] } })], () => false, ["github.com"]);
    expect(planned[0]).toMatchObject({
      status: "queued",
      egressAllow: ["evil.example"],
      policyViolation: "allows [evil.example] outside the repo allowlist",
    });
  });
});

describe("validateMigrateInput", () => {
  it("accepts a workflow with a default filename", () => {
    expect(validateMigrateInput({ workflow: "on: [push]\njobs:\n  a:\n    steps:\n      - run: echo\n" })).toEqual({
      workflow: "on: [push]\njobs:\n  a:\n    steps:\n      - run: echo\n",
      filename: "workflow.yml",
    });
  });

  it("keeps an explicit filename", () => {
    expect(validateMigrateInput({ workflow: "jobs:\n  a:\n    steps:\n      - run: echo\n", filename: "ci.yml" })).toEqual({
      workflow: "jobs:\n  a:\n    steps:\n      - run: echo\n",
      filename: "ci.yml",
    });
  });

  it("rejects empty, oversized, and misnamed inputs", () => {
    expect(validateMigrateInput({})).toHaveProperty("error");
    expect(validateMigrateInput({ workflow: "   " })).toHaveProperty("error");
    expect(validateMigrateInput({ workflow: "x".repeat(65537) })).toHaveProperty("error");
    expect(validateMigrateInput({ workflow: "jobs: {}", filename: "x".repeat(129) })).toHaveProperty("error");
  });
});
