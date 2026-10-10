import { describe, expect, it } from "vitest";
import { auditRoll, buildSnapshot, cellOf, heldFootprint, overlapsFor, similarFor, titleSimilarity } from "./forge-ports";
import { extractPaths, nextStepsFor } from "./forge-service";
import { DEFAULT_POLICY, type Intent } from "./intents-core";

function intent(id: string, paths: string[], over: Partial<Intent> = {}): Intent {
  return {
    id,
    goalId: null,
    repo: "demo",
    agent: `agent-${id}`,
    title: `Change ${id}`,
    reasoning: "",
    accept: "",
    footprint: { paths },
    actualFootprint: null,
    forkRepo: null,
    state: "working",
    risk: 0,
    riskTerms: [],
    baseSha: "",
    headSha: "",
    trainId: null,
    landedSha: null,
    planApprovedBy: null,
    leaseExpiresAt: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    ...over,
  };
}

describe("forge ports: pure helpers", () => {
  it("cells are directory prefixes of at most two segments", () => {
    expect(cellOf("src/api/x.ts")).toBe("src/api");
    expect(cellOf("src/**")).toBe("src");
    expect(cellOf("README.md")).toBe("/");
    expect(cellOf("**/*.ts")).toBe("/");
  });

  it("held footprint unions declared and pushed files", () => {
    const i = intent("a", ["src/**"], { actualFootprint: { paths: ["docs/x.md"] } });
    expect(heldFootprint(i).paths).toEqual(["docs/x.md", "src/**"]);
  });

  it("finds overlaps and similar titles deterministically", () => {
    const me = intent("a", ["src/api/x.ts"], { title: "Add api cache" });
    const others = [intent("b", ["src/**"], { title: "Add api cache layer" }), intent("c", ["docs/**"], { title: "Unrelated" })];
    expect(overlapsFor(me, others).map((o) => o.intentId)).toEqual(["b"]);
    expect(similarFor(me, others).map((s) => s.intentId)).toEqual(["b"]);
    expect(titleSimilarity("", "x")).toBe(0);
  });

  it("builds the Live map with overlap cells, protected flags and the train track", () => {
    const snap = buildSnapshot({
      repo: "demo",
      intents: [intent("a", ["src/api/x.ts"]), intent("b", ["src/api/**"]), intent("c", ["src/auth/y.ts"], { state: "awaiting_plan", agent: "" })],
      policy: { ...DEFAULT_POLICY, protected: ["src/auth/**"] },
      trains: [],
      head: "h",
      conflictsOpen: 1,
      landedToday: 2,
      overlapsCaught: 3,
      source: "d1",
      now: "2026-10-10T00:00:00.000Z",
    });
    expect(snap.counters).toEqual({ agents: 2, intents: 3, overlaps_caught: 3, conflicts_open: 1, landed_today: 2, main_red_minutes: 0, human_minutes: 0 });
    const api = snap.cells.find((c) => c.path === "src/api");
    expect(api).toMatchObject({ state: "overlap", overlap_with: [["a", "b"]], protected: false });
    expect(snap.cells.find((c) => c.path === "src/auth")).toMatchObject({ state: "awaiting_plan", protected: true });
    expect(snap.dots.map((d) => d.intent)).toEqual(["a", "b", "c"]);
    expect(snap.track).toEqual({ current: null, recent: [] });
  });

  it("caps the map at 64 cells with an other/ rollup", () => {
    const many = Array.from({ length: 80 }, (_, i) => intent(`i${i}`, [`d${i}/f.ts`]));
    const snap = buildSnapshot({ repo: "r", intents: many, policy: DEFAULT_POLICY, trains: [], head: "", conflictsOpen: 0, landedToday: 0, overlapsCaught: 0, source: "d1" });
    expect(snap.cells).toHaveLength(64);
    expect(snap.cells[63].path).toBe("other/");
    expect(snap.cells[63].intents).toHaveLength(17);
  });

  it("audit rolls are stable uniform draws", () => {
    expect(auditRoll("x")).toBe(auditRoll("x"));
    expect(auditRoll("x")).toBeGreaterThanOrEqual(0);
    expect(auditRoll("x")).toBeLessThan(1);
  });

  it("extracts path-like tokens from goal text", () => {
    expect(extractPaths("Fix `src/auth/login.ts` and README.md, plus src/api/**.")).toEqual(["README.md", "src/api/**", "src/auth/login.ts"]);
    expect(extractPaths("make it faster")).toEqual([]);
  });

  it("names the next tool for every live state", () => {
    expect(nextStepsFor(intent("a", ["x"], { state: "draft" }))[0].tool).toBe("claim_intent");
    expect(nextStepsFor(intent("a", ["x"], { state: "working" }), "agent-a").map((s) => s.tool)).toEqual(["heartbeat", "report_push", "mark_ready"]);
    expect(nextStepsFor(intent("a", ["x"], { state: "working" }), "other")[0].tool).toBe("send_note");
    expect(nextStepsFor(intent("a", ["x"], { state: "expired" })).map((s) => s.tool)).toEqual(["claim_intent", "fork_session"]);
  });
});
