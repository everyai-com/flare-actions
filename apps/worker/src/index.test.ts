import { describe, expect, it } from "vitest";
import { isHexSha, webhookSkipReason } from "./index";

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
