import { describe, expect, it } from "vitest";
import {
  assignAgents,
  basicHeader,
  buildBootstrapPlan,
  claudeArgs,
  dashboardUrls,
  DESIGNED_ORDER,
  gitAuthEnv,
  laneRefs,
  loadSeed,
  mcpConfig,
  normalizeGoalId,
  parseArgs,
  parseCliJson,
  parseDotenv,
  parseJsonc,
  pickIntents,
  pickRemote,
  pickRepoNames,
  pickToken,
  realAgentPrompt,
  redact,
  renderTable,
  replayPlanFor,
  resolveArtifactsTarget,
  seedIntents,
  stagePath,
  STAGE2_INTENTS,
  STAGE3_EXTRA,
  STAGES,
  trunkPaths,
  untilIndex,
  validateRepoName,
} from "./forge-demo-lib.mjs";

const seed = loadSeed();

describe("parseArgs", () => {
  it("splits values, bools and positionals; rejects unknown flags", () => {
    const f = parseArgs(["stage", "3", "--repo", "shelf", "--fresh", "--pace=10"], { values: ["repo", "pace"], bools: ["fresh"] });
    expect(f.pos).toEqual(["stage", "3"]);
    expect(f.values).toEqual({ repo: "shelf", pace: "10" });
    expect(f.bools.has("fresh")).toBe(true);
    expect(() => parseArgs(["--nope"], {})).toThrow(/unknown flag --nope/);
    expect(() => parseArgs(["--repo"], { values: ["repo"] })).toThrow(/needs a value/);
    expect(() => parseArgs(["--repo", "--fresh"], { values: ["repo"], bools: ["fresh"] })).toThrow(/needs a value/);
  });
  it("validates repo names like Artifacts does", () => {
    expect(validateRepoName("bookshelf")).toBe("bookshelf");
    expect(() => validateRepoName("../x")).toThrow();
    expect(() => validateRepoName("-x")).toThrow();
  });
});

describe("config", () => {
  it("parses dotenv and jsonc", () => {
    expect(parseDotenv("# c\nA=1\nB = \"two\"\nbad\n")).toEqual({ A: "1", B: "two" });
    expect(parseJsonc('{ // x\n "a": "http://y", /* z */ "b": [1,], }')).toEqual({ a: "http://y", b: [1] });
  });
  it("resolves namespace + account: flag > env > wrangler vars > binding > default", () => {
    const wranglerText = JSON.stringify({ vars: { ARTIFACTS_NAMESPACE: "from-vars", ARTIFACTS_ACCOUNT_ID: "a".repeat(32) }, artifacts: [{ namespace: "from-binding" }] });
    expect(resolveArtifactsTarget({ wranglerText })).toEqual({ namespace: "from-vars", accountId: "a".repeat(32) });
    expect(resolveArtifactsTarget({ env: { ARTIFACTS_NAMESPACE: "env" }, wranglerText }).namespace).toBe("env");
    expect(resolveArtifactsTarget({ flags: { namespace: "flag" }, env: { ARTIFACTS_NAMESPACE: "env" } }).namespace).toBe("flag");
    expect(resolveArtifactsTarget({}).namespace).toBe("flare-tournaments");
  });
  it("builds dashboard deep links per repo", () => {
    expect(dashboardUrls("https://w.dev/", "bookshelf").live).toBe("https://w.dev/#/live?repo=bookshelf");
    expect(dashboardUrls("https://w.dev", "b").inbox).toBe("https://w.dev/#/inbox?repo=b");
  });
});

describe("secrets stay out of argv and logs", () => {
  it("passes git auth through GIT_CONFIG env", () => {
    const env = gitAuthEnv("tok-123456789");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(basicHeader("tok-123456789"));
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.split(" ").pop(), "base64").toString()).toBe("x:tok-123456789");
  });
  it("redacts known secrets, auth headers and URL credentials", () => {
    const out = redact("push https://x:art_v2_secret@h/r.git Authorization: Bearer abc tok-123456789", ["tok-123456789"]);
    expect(out).not.toMatch(/art_v2_secret|abc|tok-123456789/);
  });
  it("keeps the runner token out of the MCP config file", () => {
    const cfg = mcpConfig("https://w.dev/", "claude-1");
    expect(cfg.mcpServers["flare-forge"]).toEqual({ type: "http", url: "https://w.dev/mcp", headers: { Authorization: "Bearer ${FLARE_TOKEN}", "X-Flare-Agent": "claude-1" } });
  });
});

describe("wrangler output shapes", () => {
  it("picks tokens, remotes and repo names from tolerant shapes", () => {
    expect(pickToken({ plaintext: "p" })).toBe("p");
    expect(pickToken({ result: { token: "t" } })).toBe("t");
    expect(pickToken({ token: { plaintext: "n" } })).toBe("n");
    expect(pickRemote({ result: { remote: "https://a/r.git" } })).toBe("https://a/r.git");
    expect(pickRemote({ url: "ftp://nope" })).toBe("");
    expect(pickRepoNames({ result: [{ name: "a" }, "b", { repo_name: "c" }] })).toEqual(["a", "b", "c"]);
    expect(parseCliJson('banner line\n{"a":1}')).toEqual({ a: 1 });
  });
});

describe("bootstrap plan", () => {
  it("excludes reference solutions and tooling from the trunk", () => {
    const files = trunkPaths(["src/index.ts", "agents/apply.mjs", "agents/solutions/g1-metrics.mjs", "seed/goals.json", "scripts/verify-scenarios.mjs", "test/a.test.ts", ".flare/policy.yml", "flare.yml", "GOALS.md", "node_modules/x/y.js"]);
    expect(files).toEqual([".flare/policy.yml", "flare.yml", "src/index.ts", "test/a.test.ts"]);
  });
  it("pre-creates 32 lane refs by default", () => {
    const refs = laneRefs();
    expect(refs).toHaveLength(32);
    expect(refs[0]).toBe("refs/heads/forge/lane-0");
    expect(refs[31]).toBe("refs/heads/forge/lane-31");
  });
  it("orders steps and toggles seeding/declaring", () => {
    const ids = (o) => buildBootstrapPlan({ url: "u", repo: "r", namespace: "n", files: [], ...o }).map((s) => s.id);
    expect(ids({})).toEqual(["check", "repo", "token", "tree", "push-main", "lanes", "notes", "goals", "print"]);
    expect(ids({ declare: true })).toContain("declare");
    expect(ids({ seed: false })).not.toContain("goals");
  });
});

describe("seed and scripted picks", () => {
  it("covers all 13 seeded intents in the designed order", () => {
    expect(new Set(DESIGNED_ORDER)).toEqual(new Set(seedIntents(seed).map((i) => i.id)));
  });
  it("normalizes goal ids", () => {
    expect(normalizeGoalId(seed, "g-1")).toBe("g1");
    expect(normalizeGoalId(seed, "2")).toBe("g2");
    expect(normalizeGoalId(seed, "g3-rate-limit")).toBe("g3");
    expect(normalizeGoalId(seed, undefined)).toBeNull();
    expect(() => normalizeGoalId(seed, "g9")).toThrow(/unknown goal/);
  });
  it("puts both overlaps and the semantic pair in front of the first six agents", () => {
    const crew = assignAgents(pickIntents(seed), 6);
    const first = crew.map((c) => c.intents[0].id);
    expect(first).toEqual(STAGE2_INTENTS);
    for (const x of seed.interactions.filter((i) => i.kind !== "plan_approval")) for (const id of x.intents) expect(first).toContain(id);
  });
  it("filters by goal, only and exclude", () => {
    expect(pickIntents(seed, { goal: "g1" }).map((i) => i.id)).toEqual(["g1-metrics", "g1-request-id", "g1-health-version", "g1-error-codes"]);
    expect(pickIntents(seed, { only: ["g2-fuzzy-search"] }).map((i) => i.id)).toEqual(["g2-fuzzy-search"]);
    expect(pickIntents(seed, { exclude: ["g3-log-latency"] })).toHaveLength(12);
    expect(() => pickIntents(seed, { only: ["nope"] })).toThrow(/unknown intent/);
    expect(assignAgents(pickIntents(seed, { limit: 2 }), 6)).toHaveLength(2);
  });
  it("stage 3 extras are the green rest (no protected intent, no stage-2 overlap)", () => {
    expect(STAGE3_EXTRA.filter((id) => STAGE2_INTENTS.includes(id))).toEqual([]);
    expect(STAGE3_EXTRA).not.toContain("g3-api-key-rotation");
    expect(STAGE2_INTENTS.length + STAGE3_EXTRA.length + 1).toBe(13);
  });
  it("knows the designed replay", () => {
    expect(replayPlanFor(seed, "g3-log-latency", "g1-request-id")).toEqual({ intent: "g3-log-latency", on: "g1-request-id" });
    expect(replayPlanFor(seed, "g3-log-latency", "g2-fuzzy-search")).toBeNull();
    expect(replayPlanFor(seed, "g1-metrics")).toBeNull();
  });
  it("validates --until", () => {
    expect(untilIndex("pushed")).toBe(2);
    expect(() => untilIndex("landed")).toThrow();
  });
});

describe("real agents", () => {
  it("runs Claude Code headless with a bounded allow-list, never bypassing permissions", () => {
    const args = claudeArgs({ prompt: "P", mcpConfigPath: "/x/mcp.json", systemPrompt: "S", maxBudgetUsd: 2 });
    expect(args.slice(0, 2)).toEqual(["-p", "P"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("mcp__flare-forge");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
  });
  it("prompts with the target intent and the CLI claim --clone path", () => {
    const t = seedIntents(seed)[0];
    const p = realAgentPrompt({ repo: "bookshelf", agent: "claude-1", goal: "G", goalId: "g-1", target: t, others: ["other"], cliHint: "flare" });
    expect(p).toContain(t.title);
    expect(p).toContain("flare forge claim <intentId> --clone work");
    expect(p).toContain('"other"');
    expect(p).not.toMatch(/\n\n\n/);
  });
});

describe("director stages", () => {
  it("defines six beats in order", () => {
    expect(STAGES.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("advances forward and resets when going back or fresh", () => {
    expect(stagePath(0, 3)).toEqual({ reset: true, run: [1, 2, 3] });
    expect(stagePath(2, 4)).toEqual({ reset: false, run: [3, 4] });
    expect(stagePath(4, 2)).toEqual({ reset: true, run: [1, 2] });
    expect(stagePath(3, 3)).toEqual({ reset: true, run: [1, 2, 3] });
    expect(stagePath(-1, 1)).toEqual({ reset: true, run: [1] });
    expect(() => stagePath(0, 7)).toThrow();
  });
  it("renders aligned tables", () => {
    const t = renderTable([{ a: "x", b: "long value" }], [{ key: "a", label: "A" }, { key: "b", label: "B" }]);
    expect(t.split("\n")).toEqual(["A  B", "-  ----------", "x  long value"]);
  });
});
