import { describe, expect, it } from "vitest";
import {
  isBadgeHiddenRepo,
  parseAiGatewayId,
  parseBadgeHiddenRepos,
  parseAgentTag,
  parseBudgetMinutes,
  parseBudgetMode,
  parseBudgetKillMultiplier,
  parseFairSharePerAgent,
  parsePausedRepos,
  parseFairSharePerRepo,
  parseGithubRunnerLabels,
  parseGithubRunnerMode,
  parseMcpWriteConfirm,
  parseRunnerGroupCache,
  runnerGroupCacheGet,
  runnerGroupCacheSet,
  parseOpenRegistration,
  parseStoredBudgets,
  parseSupersedeBranchRuns,
  parseTriageWebSearch,
  validateBillingApiToken,
  validateCloudflareAccountId,
  validateGithubRunnerGroupName,
  validateNotifyFromEmail,
  validateNotifyMode,
  validateNotifyWebhookUrl,
  validateRunnerVersion,
  validateTriageModel,
  validateTurnstileSecretKey,
  validateTurnstileSiteKey,
  validateWebhookSecret,
} from "./settings";

describe("validateWebhookSecret", () => {
  it("accepts 16-512 char secrets", () => {
    expect(validateWebhookSecret("s".repeat(16))).toBeNull();
    expect(validateWebhookSecret("s".repeat(512))).toBeNull();
  });

  it("rejects short, long, and non-string input", () => {
    expect(validateWebhookSecret("too-short")).not.toBeNull();
    expect(validateWebhookSecret("s".repeat(513))).not.toBeNull();
    expect(validateWebhookSecret(null)).not.toBeNull();
  });
});

describe("validateNotifyFromEmail", () => {
  it("accepts well-formed sender addresses", () => {
    expect(validateNotifyFromEmail("ci@example.com")).toBeNull();
  });

  it("rejects malformed and non-string input", () => {
    expect(validateNotifyFromEmail("not-an-email")).not.toBeNull();
    expect(validateNotifyFromEmail("a@b")).not.toBeNull();
    expect(validateNotifyFromEmail("")).not.toBeNull();
    expect(validateNotifyFromEmail(null)).not.toBeNull();
  });
});

describe("validateNotifyMode", () => {
  it("accepts the three modes and rejects the rest", () => {
    expect(validateNotifyMode("all")).toBeNull();
    expect(validateNotifyMode("failures")).toBeNull();
    expect(validateNotifyMode("off")).toBeNull();
    expect(validateNotifyMode("sometimes")).not.toBeNull();
    expect(validateNotifyMode(null)).not.toBeNull();
  });
});

describe("validateNotifyWebhookUrl", () => {
  it("accepts https URLs and rejects the rest", () => {
    expect(validateNotifyWebhookUrl("https://hooks.slack.com/services/T/B/X")).toBeNull();
    expect(validateNotifyWebhookUrl("https://discord.com/api/webhooks/1/x")).toBeNull();
    expect(validateNotifyWebhookUrl("http://hooks.slack.com/services/x")).not.toBeNull();
    expect(validateNotifyWebhookUrl("not a url")).not.toBeNull();
    expect(validateNotifyWebhookUrl("https://x")).not.toBeNull();
    expect(validateNotifyWebhookUrl(42)).not.toBeNull();
  });
});

describe("badge visibility", () => {
  it("parses comma strings and arrays, deduping entries", () => {
    expect(parseBadgeHiddenRepos("o/a, o/b")).toEqual({ repos: ["o/a", "o/b"] });
    expect(parseBadgeHiddenRepos(["o/a", "o/a"])).toEqual({ repos: ["o/a"] });
    expect(parseBadgeHiddenRepos("")).toEqual({ repos: [] });
  });

  it("rejects malformed entries", () => {
    expect(parseBadgeHiddenRepos(42)).toHaveProperty("error");
    expect(parseBadgeHiddenRepos(["not a repo"])).toHaveProperty("error");
    expect(parseBadgeHiddenRepos([7])).toHaveProperty("error");
  });

  it("matches case-insensitively and never matches an empty list", () => {
    expect(isBadgeHiddenRepo("o/a,o/b", "O/A")).toBe(true);
    expect(isBadgeHiddenRepo("o/a", "o/b")).toBe(false);
    expect(isBadgeHiddenRepo("", "o/a")).toBe(false);
    expect(isBadgeHiddenRepo(null, "o/a")).toBe(false);
  });
});

describe("turnstile validators", () => {
  it("accepts well-formed keys", () => {
    expect(validateTurnstileSiteKey("0x4AAAAAAAsitekey")).toBeNull();
    expect(validateTurnstileSecretKey("0x4AAAAAAAsecretkeymaterial")).toBeNull();
  });

  it("rejects empty, short, long, and non-string keys", () => {
    expect(validateTurnstileSiteKey("")).not.toBeNull();
    expect(validateTurnstileSiteKey("   ")).not.toBeNull();
    expect(validateTurnstileSiteKey("x".repeat(129))).not.toBeNull();
    expect(validateTurnstileSiteKey(null)).not.toBeNull();
    expect(validateTurnstileSecretKey("short")).not.toBeNull();
    expect(validateTurnstileSecretKey("x".repeat(513))).not.toBeNull();
    expect(validateTurnstileSecretKey(42)).not.toBeNull();
  });
});

describe("parseFairSharePerRepo", () => {
  it("accepts the D1 string form and the admin API number form", () => {
    expect(parseFairSharePerRepo("3")).toEqual({ cap: 3 });
    expect(parseFairSharePerRepo(0)).toEqual({ cap: 0 });
    expect(parseFairSharePerRepo(100)).toEqual({ cap: 100 });
  });

  it("rejects missing, fractional, negative, and oversized values", () => {
    for (const bad of [null, undefined, "", "  ", "x", 1.5, -1, 101, "101", {}, []]) {
      expect("error" in parseFairSharePerRepo(bad)).toBe(true);
    }
  });
});

describe("parseAiGatewayId", () => {
  it("accepts URL slugs and rejects the rest", () => {
    expect(parseAiGatewayId("default")).toEqual({ id: "default" });
    expect(parseAiGatewayId("prod-gw_2")).toEqual({ id: "prod-gw_2" });
    for (const bad of [null, undefined, "", "  ", "Has Caps", "has space", "has/slash", "x".repeat(65), 42]) {
      expect("error" in parseAiGatewayId(bad)).toBe(true);
    }
  });
});

describe("parseMcpWriteConfirm", () => {
  it("accepts booleans and 1/0 spellings", () => {
    expect(parseMcpWriteConfirm(true)).toEqual({ on: true });
    expect(parseMcpWriteConfirm("1")).toEqual({ on: true });
    expect(parseMcpWriteConfirm(false)).toEqual({ on: false });
    expect(parseMcpWriteConfirm("0")).toEqual({ on: false });
    expect(parseMcpWriteConfirm(null)).toEqual({ on: false });
    expect(parseMcpWriteConfirm(undefined)).toEqual({ on: false });
    expect("error" in parseMcpWriteConfirm("sometimes")).toBe(true);
    expect("error" in parseMcpWriteConfirm(2)).toBe(true);
  });
});

describe("parseOpenRegistration", () => {
  it("accepts booleans and 1/0 spellings, defaults off", () => {
    expect(parseOpenRegistration(true)).toEqual({ on: true });
    expect(parseOpenRegistration("1")).toEqual({ on: true });
    expect(parseOpenRegistration(false)).toEqual({ on: false });
    expect(parseOpenRegistration("0")).toEqual({ on: false });
    expect(parseOpenRegistration(null)).toEqual({ on: false });
    expect(parseOpenRegistration(undefined)).toEqual({ on: false });
    expect("error" in parseOpenRegistration("sometimes")).toBe(true);
    expect("error" in parseOpenRegistration(2)).toBe(true);
  });
});

describe("parseTriageWebSearch", () => {
  it("accepts booleans and 1/0 spellings", () => {
    expect(parseTriageWebSearch(true)).toEqual({ on: true });
    expect(parseTriageWebSearch("1")).toEqual({ on: true });
    expect(parseTriageWebSearch(false)).toEqual({ on: false });
    expect(parseTriageWebSearch(null)).toEqual({ on: false });
    expect("error" in parseTriageWebSearch("sometimes")).toBe(true);
  });
});

describe("billing settings", () => {
  it("validates the token length", () => {
    expect(validateBillingApiToken("x".repeat(40))).toBeNull();
    expect(validateBillingApiToken("short")).not.toBeNull();
    expect(validateBillingApiToken(42)).not.toBeNull();
  });
  it("validates the 32-hex account id", () => {
    expect(validateCloudflareAccountId("a54b12fe3ef06df16ff0041d79c18fc0")).toBeNull();
    expect(validateCloudflareAccountId("A54B12FE3EF06DF16FF0041D79C18FC0")).toBeNull();
    expect(validateCloudflareAccountId("not-hex")).not.toBeNull();
    expect(validateCloudflareAccountId("a54b12fe")).not.toBeNull();
  });
  it("validates triage model ids", () => {
    expect(validateTriageModel("@cf/deepseek-ai/deepseek-v4-flash-0731")).toBeNull();
    expect(validateTriageModel("llama")).not.toBeNull();
    expect(validateTriageModel("")).not.toBeNull();
  });
  it("validates fleet runner versions", () => {
    expect(validateRunnerVersion("0.2.0")).toBeNull();
    expect(validateRunnerVersion("1.0.0-rc.1")).toBeNull();
    expect(validateRunnerVersion("v1")).not.toBeNull();
    expect(validateRunnerVersion("1.2")).not.toBeNull();
    expect(validateRunnerVersion("")).not.toBeNull();
  });
});

describe("budget guardrail settings", () => {
  it("parses owner/name=minutes pairs and clears on empty", () => {
    expect(parseBudgetMinutes("")).toEqual({ budgets: {} });
    expect(parseBudgetMinutes("o/r=1200, org/other=600")).toEqual({ budgets: { "o/r": 1200, "org/other": 600 } });
    expect("error" in parseBudgetMinutes("o/r")).toBe(true);
    expect("error" in parseBudgetMinutes("not-a-repo=10")).toBe(true);
    expect("error" in parseBudgetMinutes("o/r=0")).toBe(true);
    expect("error" in parseBudgetMinutes("o/r=abc")).toBe(true);
  });

  it("reads stored JSON tolerantly and validates the mode", () => {
    expect(parseStoredBudgets('{"o/r":120,"x/y":-1}')).toEqual({ "o/r": 120 });
    expect(parseStoredBudgets("junk")).toEqual({});
    expect(parseStoredBudgets(null)).toEqual({});
    expect(parseBudgetMode("")).toEqual({ mode: "warn" });
    expect(parseBudgetMode("block")).toEqual({ mode: "block" });
    expect("error" in parseBudgetMode("nope")).toBe(true);
  });

  it("parses the auto-supersede toggle", () => {
    expect(parseSupersedeBranchRuns("push")).toEqual({ mode: "push" });
    expect(parseSupersedeBranchRuns(null)).toEqual({ mode: "off" });
    expect("error" in parseSupersedeBranchRuns("always")).toBe(true);
  });

  it("parses the kill multiplier, off by default", () => {
    expect(parseBudgetKillMultiplier(null)).toEqual({ multiplier: 0 });
    expect(parseBudgetKillMultiplier("")).toEqual({ multiplier: 0 });
    expect(parseBudgetKillMultiplier("off")).toEqual({ multiplier: 0 });
    expect(parseBudgetKillMultiplier(2)).toEqual({ multiplier: 2 });
    expect(parseBudgetKillMultiplier("3")).toEqual({ multiplier: 3 });
    expect("error" in parseBudgetKillMultiplier("0.5")).toBe(true);
    expect("error" in parseBudgetKillMultiplier("101")).toBe(true);
    expect("error" in parseBudgetKillMultiplier("nope")).toBe(true);
  });

  it("reads paused repos tolerantly and fails open", () => {
    expect(parsePausedRepos(null)).toEqual({});
    expect(parsePausedRepos("junk")).toEqual({});
    expect(parsePausedRepos('{"o/r":"2026-10-08T00:00:00.000Z","bad":1}')).toEqual({ "o/r": "2026-10-08T00:00:00.000Z" });
  });

  it("parses the per-agent fair-share cap", () => {
    expect(parseFairSharePerAgent(0)).toEqual({ cap: 0 });
    expect(parseFairSharePerAgent(3)).toEqual({ cap: 3 });
    expect(parseFairSharePerAgent("2")).toEqual({ cap: 2 });
    expect("error" in parseFairSharePerAgent(null)).toBe(true);
    expect("error" in parseFairSharePerAgent("")).toBe(true);
    expect("error" in parseFairSharePerAgent(-1)).toBe(true);
    expect("error" in parseFairSharePerAgent(101)).toBe(true);
    expect("error" in parseFairSharePerAgent("nope")).toBe(true);
  });

  it("parses agent identity tags", () => {
    expect(parseAgentTag("atlas-1")).toEqual({ agent: "atlas-1" });
    expect(parseAgentTag("a.b_c-d")).toEqual({ agent: "a.b_c-d" });
    expect("error" in parseAgentTag("")).toBe(true);
    expect("error" in parseAgentTag("has space")).toBe(true);
    expect("error" in parseAgentTag("x".repeat(65))).toBe(true);
    expect("error" in parseAgentTag(null)).toBe(true);
  });
});

describe("github runner mode settings", () => {
  it("parses the mode toggle, defaulting off", () => {
    expect(parseGithubRunnerMode("on")).toEqual({ mode: "on" });
    expect(parseGithubRunnerMode("off")).toEqual({ mode: "off" });
    expect(parseGithubRunnerMode(null)).toEqual({ mode: "off" });
    expect(parseGithubRunnerMode("")).toEqual({ mode: "off" });
    expect(parseGithubRunnerMode("1")).toEqual({ mode: "on" });
    expect("error" in parseGithubRunnerMode("sometimes")).toBe(true);
  });

  it("parses the managed label list, defaulting to flare", () => {
    expect(parseGithubRunnerLabels(null)).toEqual({ labels: ["flare"] });
    expect(parseGithubRunnerLabels("")).toEqual({ labels: ["flare"] });
    expect(parseGithubRunnerLabels("Flare, gpu")).toEqual({ labels: ["flare", "gpu"] });
    expect(parseGithubRunnerLabels("flare,flare")).toEqual({ labels: ["flare"] });
    expect(parseGithubRunnerLabels(["a", "b"])).toEqual({ labels: ["a", "b"] });
    expect("error" in parseGithubRunnerLabels("a,b,c,d,e,f")).toBe(true);
    expect("error" in parseGithubRunnerLabels("has space")).toBe(true);
    expect("error" in parseGithubRunnerLabels(42)).toBe(true);
  });

  it("validates org group names", () => {
    expect(validateGithubRunnerGroupName("GPU Fleet")).toBeNull();
    expect(validateGithubRunnerGroupName("")).not.toBeNull();
    expect(validateGithubRunnerGroupName("x".repeat(101))).not.toBeNull();
    expect(validateGithubRunnerGroupName("has\nnewline")).not.toBeNull();
    expect(validateGithubRunnerGroupName("del\x7fchar")).not.toBeNull();
    expect(validateGithubRunnerGroupName("  ")).not.toBeNull();
    expect(validateGithubRunnerGroupName("Équipe GPU")).toBeNull();
  });

  it("caches group ids with TTL, tolerance, and bounds", () => {
    expect(parseRunnerGroupCache(null)).toEqual({});
    expect(parseRunnerGroupCache("garbage{")).toEqual({});
    const t0 = 1_700_000_000_000;
    let cache = runnerGroupCacheSet({}, "Acme", "GPU Fleet", 7, t0);
    expect(runnerGroupCacheGet(cache, "acme", "GPU Fleet", t0 + 1000)).toBe(7);
    expect(runnerGroupCacheGet(cache, "acme", "GPU Fleet", t0 + 3700000)).toBeNull();
    expect(runnerGroupCacheGet(cache, "other", "GPU Fleet", t0 + 1000)).toBeNull();
    for (let i = 0; i < 60; i++) cache = runnerGroupCacheSet(cache, `org${i}`, "g", i, t0 + i);
    expect(Object.keys(cache)).toHaveLength(50);
    expect(cache).not.toHaveProperty("org0\0g");
  });
});
