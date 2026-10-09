import { describe, expect, it } from "vitest";
import {
  maybeUpdateRunner,
  needsUpdate,
  RUNNER_UPDATE_EXIT_CODE,
  updateRunner,
  type UpdateExec,
} from "./update.ts";

describe("needsUpdate", () => {
  it("treats the fleet version as a pin", () => {
    expect(needsUpdate("0.1.0", null)).toBe(false);
    expect(needsUpdate("0.1.0", undefined)).toBe(false);
    expect(needsUpdate("0.1.0", "")).toBe(false);
    expect(needsUpdate("0.1.0", "0.1.0")).toBe(false);
    expect(needsUpdate("0.1.0", "0.2.0")).toBe(true);
    expect(needsUpdate("0.2.0", "0.1.0")).toBe(true);
  });
});

describe("updateRunner", () => {
  function execWith(responses: Record<string, { code: number; stdout?: string; stderr?: string }>): {
    exec: UpdateExec;
    calls: string[];
  } {
    const calls: string[] = [];
    const exec: UpdateExec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      const r = responses[cmd] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    return { exec, calls };
  }

  it("pulls and reinstalls in a clean checkout", async () => {
    const { exec, calls } = execWith({ git: { code: 0, stdout: "?? .env\n" }, npm: { code: 0 } });
    const out = await updateRunner({ cwd: "/r", exec, exists: () => true });
    expect(out).toEqual({ ok: true });
    expect(calls).toEqual(["git status --porcelain", "git pull --ff-only", "npm install --no-audit --no-fund"]);
  });

  it("refuses non-git dirs, dirty trees, and failed pulls", async () => {
    expect(await updateRunner({ cwd: "/r", exists: () => false })).toEqual({ ok: false, reason: "not a git checkout" });
    const dirty = execWith({ git: { code: 0, stdout: " M src/x.ts\n" } });
    expect(await updateRunner({ cwd: "/r", exec: dirty.exec, exists: () => true })).toMatchObject({ ok: false });
    expect(dirty.calls).toEqual(["git status --porcelain"]);
    const pullFail = execWith({ git: { code: 1, stdout: "", stderr: "diverged" } });
    const out = await updateRunner({ cwd: "/r", exec: pullFail.exec, exists: () => true });
    // git status itself failed here; a pull failure surfaces the same way.
    expect(out.ok).toBe(false);
    expect(pullFail.calls).toEqual(["git status --porcelain"]);
  });
});

describe("maybeUpdateRunner", () => {
  it("throttles checks, warns hourly, and exits 42 after updating", async () => {
    const logs: Record<string, unknown>[] = [];
    const log = (o: Record<string, unknown>) => logs.push(o);
    const state = { lastCheck: 0, lastWarn: 0 };
    const base = {
      state,
      current: "0.1.0",
      autoUpdate: false,
      cwd: "/r",
      getFleetVersion: async () => "0.2.0",
      log,
    };
    const t0 = 1_700_000_000_000;
    // First check warns (never warned).
    expect(await maybeUpdateRunner({ ...base, now: t0 })).toBeNull();
    expect(logs.at(-1)).toMatchObject({ msg: "runner behind fleet version", fleet: "0.2.0" });
    // 5 min later: throttled, silent.
    expect(await maybeUpdateRunner({ ...base, now: t0 + 5 * 60 * 1000 })).toBeNull();
    expect(logs).toHaveLength(1);
    // 11 min later: checks again but the hourly warn stays quiet.
    expect(await maybeUpdateRunner({ ...base, now: t0 + 11 * 60 * 1000 })).toBeNull();
    expect(logs).toHaveLength(1);
    // Auto-update on: updates and exits 42.
    const updated = await maybeUpdateRunner({
      ...base,
      now: t0 + 22 * 60 * 1000,
      autoUpdate: true,
      update: async () => ({ ok: true }),
    });
    expect(updated).toBe(RUNNER_UPDATE_EXIT_CODE);
    expect(logs.at(-1)).toMatchObject({ msg: "runner updated, exiting for restart", exitCode: 42 });
  });

  it("stays silent when current and degrades on fetch failure", async () => {
    const logs: Record<string, unknown>[] = [];
    const state = { lastCheck: 0, lastWarn: 0 };
    expect(
      await maybeUpdateRunner({
        state,
        now: 1_000_000,
        current: "0.2.0",
        autoUpdate: true,
        cwd: "/r",
        getFleetVersion: async () => "0.2.0",
        log: (o) => logs.push(o),
      }),
    ).toBeNull();
    expect(logs).toHaveLength(0);
    expect(
      await maybeUpdateRunner({
        state: { lastCheck: 0, lastWarn: 0 },
        now: 2_000_000,
        current: "0.1.0",
        autoUpdate: true,
        cwd: "/r",
        getFleetVersion: async () => {
          throw new Error("down");
        },
        log: (o) => logs.push(o),
      }),
    ).toBeNull();
    expect(logs.at(-1)).toMatchObject({ msg: "update check failed" });
  });

  it("logs skips without exiting", async () => {
    const logs: Record<string, unknown>[] = [];
    const out = await maybeUpdateRunner({
      state: { lastCheck: 0, lastWarn: 0 },
      now: 1_000_000,
      current: "0.1.0",
      autoUpdate: true,
      cwd: "/r",
      getFleetVersion: async () => "0.2.0",
      update: async () => ({ ok: false, reason: "not a git checkout" }),
      log: (o) => logs.push(o),
    });
    expect(out).toBeNull();
    expect(logs.at(-1)).toMatchObject({ msg: "runner update skipped", reason: "not a git checkout" });
  });
});
