import { describe, expect, it } from "vitest";
import { NEXT_MOVE_JS, type NextMove, type NextMoveState } from "./next-move";
import { DASHBOARD_HTML } from "./dashboard";

// Runtime-free: compiles the exact string the dashboard ships.
const nextMove = new Function(NEXT_MOVE_JS + "\nreturn nextMove;")() as (s: NextMoveState) => NextMove;

// A fully set-up expert; each test knocks out one fact.
const done: NextMoveState = {
  signedIn: true,
  admin: true,
  githubConnected: true,
  projectPicked: true,
  waitingForComputer: false,
  checks: 12,
  passed: 9,
  latestStatus: "success",
  inboxCount: 0,
  agentSeen: true,
  teammateSeen: true,
};
const key = (patch: NextMoveState) => nextMove({ ...done, ...patch }).key;

describe("next-move engine (docs/OCTALYSIS.md)", () => {
  it("ships inside the dashboard script, ES5-safe", () => {
    expect(DASHBOARD_HTML).toContain(NEXT_MOVE_JS);
    expect(NEXT_MOVE_JS).not.toContain("`");
    expect(NEXT_MOVE_JS).not.toContain("${");
    expect(NEXT_MOVE_JS).not.toMatch(/\b(let|const)\b|=>/);
  });

  it("follows the table's rule order: the first match wins", () => {
    expect(nextMove({})).toMatchObject({ key: "account", phase: "discovery" });
    expect(key({ githubConnected: false, projectPicked: false, checks: 0 })).toBe("github");
    expect(key({ projectPicked: false, checks: 0, waitingForComputer: true })).toBe("project");
    expect(key({ waitingForComputer: true, latestStatus: "failure", inboxCount: 3 })).toBe("computer");
    expect(key({ checks: 0, passed: 0, latestStatus: "", agentSeen: false })).toBe("first_check");
    expect(key({ latestStatus: "failure", inboxCount: 2 })).toBe("see_broke");
    expect(key({ latestStatus: "error" })).toBe("see_broke");
    expect(key({ inboxCount: 2, latestStatus: "running" })).toBe("inbox");
    expect(key({ latestStatus: "running", agentSeen: false })).toBe("watch");
    expect(key({ latestStatus: "queued" })).toBe("watch");
    expect(key({ agentSeen: false, teammateSeen: false })).toBe("agent");
    expect(key({ teammateSeen: false })).toBe("invite");
    expect(key({})).toBe("run");
  });

  it("labels the move in plain words", () => {
    expect(nextMove({ ...done, inboxCount: 3 }).label).toBe("Review 3 waiting");
    expect(nextMove({ ...done, latestStatus: "running" }).label).toBe("Watch it run");
    expect(nextMove({ ...done, checks: 0, passed: 0 }).label).toBe("Run your first check");
  });

  it("reports the phase: onboarding until the first green, then scaffolding, then endgame", () => {
    expect(nextMove({ ...done, githubConnected: false }).phase).toBe("onboarding");
    expect(nextMove({ ...done, passed: 0, latestStatus: "failure" }).phase).toBe("onboarding");
    expect(nextMove({ ...done, latestStatus: "failure" }).phase).toBe("scaffolding");
    expect(nextMove({ ...done, agentSeen: false }).phase).toBe("scaffolding");
    expect(nextMove({ ...done, teammateSeen: false }).phase).toBe("endgame");
    expect(nextMove(done).phase).toBe("endgame");
  });

  it("keeps every label within the Simple budget", () => {
    const states: NextMoveState[] = [
      {},
      { ...done, githubConnected: false },
      { ...done, projectPicked: false },
      { ...done, waitingForComputer: true },
      { ...done, checks: 0 },
      { ...done, latestStatus: "failure" },
      { ...done, inboxCount: 12 },
      { ...done, latestStatus: "running" },
      { ...done, agentSeen: false },
      { ...done, teammateSeen: false },
      done,
    ];
    const keys = new Set<string>();
    for (const st of states) {
      const m = nextMove(st);
      keys.add(m.key);
      expect(m.label.split(/\s+/).length, m.label).toBeLessThanOrEqual(6);
      expect(m.label).not.toMatch(/\b(intent|footprint|train|trunk|fixture|executor|runner|dispatch|sha|pipeline)s?\b/i);
    }
    expect(keys.size).toBe(11);
  });

  it("marks owner-only moves", () => {
    expect(nextMove({ ...done, githubConnected: false }).owner).toBe(true);
    expect(nextMove({ ...done, latestStatus: "failure" }).owner).toBe(false);
  });
});
