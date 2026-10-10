import { describe, expect, it } from "vitest";
import {
  aiText,
  buildPlannerMessages,
  extractJson,
  groundedEntry,
  plannerRequest,
  PLANNER_MODELS,
  readTrunkTree,
  runPlanner,
  validatePlan,
  type PlannerArtifacts,
} from "./forge-planner";
import { DEFAULT_POLICY } from "./intents-core";
import type { AiBinding } from "./triage";

const TREE = { paths: ["README.md", "src/api/a.ts", "src/api/b.ts", "src/auth/keys.ts", "test/a.test.ts"], truncated: false };

function fakeAi(replies: Record<string, unknown | Error>, calls: Array<{ model: string; input: unknown }> = []): AiBinding {
  return {
    async run(model: string, input: unknown) {
      calls.push({ model, input });
      const r = replies[model];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const chat = (content: string) => ({ choices: [{ message: { content }, finish_reason: "stop" }] });

describe("forge planner: parsing + validation", () => {
  it("reads text from every Workers AI output shape", () => {
    expect(aiText({ response: "x" })).toBe("x");
    expect(aiText(chat("y"))).toBe("y");
    expect(aiText({ output: [{ content: [{ type: "reasoning_text", text: "think" }, { type: "output_text", text: "z" }] }] })).toBe("z");
    expect(aiText({ choices: [{ message: { content: null, reasoning_content: "..." } }] })).toBeNull();
  });

  it("extracts the plan from prose, fences, objects and bare arrays", () => {
    expect(extractJson('{"intents":[]}')).toEqual({ intents: [] });
    expect(extractJson('Here:\n```json\n{"intents":[1]}\n```')).toEqual({ intents: [1] });
    expect(extractJson('Sure. [{"title":"a"},{"title":"b"}] done')).toEqual([{ title: "a" }, { title: "b" }]);
    expect(extractJson("no json")).toBeNull();
  });

  it("grounds footprints in the trunk tree (existing paths, new files in existing dirs)", () => {
    const idx = { files: new Set(TREE.paths), dirs: new Set(["src", "src/api", "src/auth", "test"]), tops: new Set(["README.md", "src", "test"]) };
    expect(groundedEntry("src/api/a.ts", idx, false)).toBe(true);
    expect(groundedEntry("src/api/new.ts", idx, false)).toBe(true);
    expect(groundedEntry("src/api/**", idx, false)).toBe(true);
    expect(groundedEntry("CHANGELOG.md", idx, false)).toBe(true);
    expect(groundedEntry("lib/made-up/x.ts", idx, false)).toBe(false);
    expect(groundedEntry("nowhere/**", idx, false)).toBe(false);
  });

  it("drops invalid proposals and entries, remaps after edges onto survivors", () => {
    const raw = {
      intents: [
        { title: "x", footprint: ["src/api/a.ts"], reasoning: "", accept: "" }, // title too short
        { title: "Split API handler", footprint: ["src/api/a.ts", "made/up.ts"], reasoning: "r", accept: "npm test", after: [] },
        { title: "Docs", footprint: ["README.md"], reasoning: "r", accept: "grep", after: [1, 0, 5, 2] },
        { title: "Nothing grounded", footprint: ["ghost/**"], reasoning: "r", accept: "x" },
      ],
    };
    const { intents, dropped } = validatePlan(raw, TREE);
    expect(dropped).toBe(2);
    expect(intents.map((i) => i.title)).toEqual(["Split API handler", "Docs"]);
    expect(intents[0].footprint).toEqual(["src/api/a.ts"]);
    expect(intents[1].after).toEqual([0]);
  });

  it("prompts for disjoint footprints, explicit after edges, and no generic advice", () => {
    const [sys, user] = buildPlannerMessages({ goal: "Speed up the API", tree: TREE, policy: { ...DEFAULT_POLICY, protected: ["src/auth/**"] } });
    expect(sys.content).toMatch(/DISJOINT/);
    expect(sys.content).toMatch(/after/);
    expect(sys.content).toMatch(/No generic advice/);
    expect(user.content).toContain("src/auth/**");
    expect(user.content).toContain("src/api/b.ts");
  });

  it("turns GLM thinking off and keeps gpt-oss reasoning low", () => {
    expect(plannerRequest("@cf/zai-org/glm-5.3", [])).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(plannerRequest("@cf/openai/gpt-oss-120b", [])).toMatchObject({ reasoning_effort: "low" });
  });
});

describe("forge planner: inference with a fake AI", () => {
  const good = JSON.stringify({ intents: [{ title: "Cache API reads", footprint: ["src/api/**"], reasoning: "slow", accept: "npm test -- api", after: [] }] });

  it("uses the primary model when it answers", async () => {
    const calls: Array<{ model: string; input: unknown }> = [];
    const out = await runPlanner(fakeAi({ [PLANNER_MODELS[0]]: chat(good) }, calls), { goal: "g", tree: TREE, policy: DEFAULT_POLICY });
    expect(out?.model).toBe(PLANNER_MODELS[0]);
    expect(out?.intents[0].footprint).toEqual(["src/api/**"]);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the second model on an error or empty (reasoning-only) output", async () => {
    const empty = { choices: [{ message: { content: null, reasoning_content: "thinking..." }, finish_reason: "length" }] };
    for (const first of [new Error("busy"), empty, chat("not json")]) {
      const out = await runPlanner(fakeAi({ [PLANNER_MODELS[0]]: first, [PLANNER_MODELS[1]]: { response: good } }), { goal: "g", tree: TREE, policy: DEFAULT_POLICY });
      expect(out?.model).toBe(PLANNER_MODELS[1]);
    }
  });

  it("returns null (heuristic) when no model yields a valid plan or there is no binding", async () => {
    expect(await runPlanner(null, { goal: "g", tree: TREE, policy: DEFAULT_POLICY })).toBeNull();
    const bad = chat(JSON.stringify({ intents: [{ title: "Made up", footprint: ["ghost/x.ts/y/**"], reasoning: "", accept: "" }] }));
    expect(await runPlanner(fakeAi({ [PLANNER_MODELS[0]]: bad, [PLANNER_MODELS[1]]: new Error("down") }), { goal: "g", tree: TREE, policy: DEFAULT_POLICY })).toBeNull();
  });
});

describe("forge planner: trunk tree", () => {
  it("walks the tree breadth-first within the path cap", async () => {
    const trees: Record<string, Array<{ name: string; mode: string; hash: string }>> = {
      root: [
        { name: "README.md", mode: "100644", hash: "f1" },
        { name: "src", mode: "40000", hash: "t-src" },
      ],
      "t-src": [
        { name: "a.ts", mode: "100644", hash: "f2" },
        { name: "b.ts", mode: "100644", hash: "f3" },
      ],
    };
    const artifacts: PlannerArtifacts = {
      async get() {
        return {
          log: async () => [{ hash: "c1" }],
          readCommit: async () => ({ treeHash: "root" }),
          readTree: async (h: string) => trees[h] ?? null,
        };
      },
    };
    expect(await readTrunkTree(artifacts, "demo")).toEqual({ paths: ["README.md", "src/a.ts", "src/b.ts"], truncated: false });
    expect((await readTrunkTree(artifacts, "demo", 2)).truncated).toBe(true);
  });
});
