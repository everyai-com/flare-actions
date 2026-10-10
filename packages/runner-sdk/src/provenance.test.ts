import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTrailers as workerAppendTrailers,
  formatTrailers as workerFormatTrailers,
  parseTrailers,
  TRAILER_KEYS as WORKER_TRAILER_KEYS,
} from "../../../apps/worker/src/intents-core.ts";
import { SESSION_STEP_KINDS as WORKER_KINDS, parseSessionLog } from "../../../apps/worker/src/session.ts";
import {
  appendSessionStep,
  appendTrailers,
  commitWithTrailers,
  formatTrailers,
  SESSION_STEP_KINDS,
  TRAILER_KEYS,
  trailersFromEnv,
  writeSessionPlan,
} from "./provenance.ts";

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() };

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: ["pipe", "pipe", "pipe"] });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-sdk-prov-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "agent@test"]);
  sh(dir, ["config", "user.name", "agent"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-qm", "init"]);
  return dir;
}

describe("trailer parity with the Worker", () => {
  it("formats exactly like intents-core and round-trips through parseTrailers", () => {
    expect(TRAILER_KEYS).toEqual(WORKER_TRAILER_KEYS);
    expect(SESSION_STEP_KINDS).toEqual(WORKER_KINDS);
    const t = { goal: "g1", intent: "i1", agent: "claude\nFlare-Intent: forged", session: "i-abc" };
    expect(formatTrailers(t)).toBe(workerFormatTrailers(t));
    expect(appendTrailers("feat: x\n\nbody", t)).toBe(workerAppendTrailers("feat: x\n\nbody", t));
    expect(parseTrailers(appendTrailers("feat: x", t))).toEqual({
      goal: "g1",
      intent: "i1",
      agent: "claude Flare-Intent: forged",
      session: "i-abc",
    });
  });

  it("reads FLARE_* env", () => {
    expect(trailersFromEnv({ FLARE_INTENT: "i", FLARE_AGENT: "a" })).toEqual({ intent: "i", agent: "a" });
  });
});

describe("commitWithTrailers", () => {
  it("commits with the trailer block; explicit values beat env", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "b\n");
    const prev = process.env.FLARE_INTENT;
    process.env.FLARE_INTENT = "from-env";
    try {
      const out = await commitWithTrailers({
        cwd: dir,
        message: "fix: a",
        all: true,
        trailers: { intent: "i-42", agent: "claude-1" },
      });
      expect(sh(dir, ["rev-parse", "HEAD"]).trim()).toBe(out.sha);
      expect(parseTrailers(sh(dir, ["log", "-1", "--format=%B"]))).toEqual({ intent: "i-42", agent: "claude-1" });
      // git itself sees them as trailers.
      expect(sh(dir, ["log", "-1", "--format=%(trailers:key=Flare-Intent,valueonly)"]).trim()).toBe("i-42");
    } finally {
      if (prev === undefined) delete process.env.FLARE_INTENT;
      else process.env.FLARE_INTENT = prev;
    }
  });
});

describe("session branch", () => {
  it("appends steps and writes the plan without touching HEAD, index or worktree", async () => {
    const dir = repo();
    writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");
    const head = sh(dir, ["rev-parse", "HEAD"]).trim();
    await writeSessionPlan({ cwd: dir, plan: "# Plan\n- add limiter" });
    await appendSessionStep({ cwd: dir, step: { kind: "prompt", text: "rate-limit login", ts: "2026-10-10T00:00:00.000Z" } });
    const second = await appendSessionStep({ cwd: dir, step: { kind: "decision", text: "token bucket" } });
    expect(sh(dir, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(sh(dir, ["status", "--porcelain"])).toBe("?? dirty.txt\n");
    expect(sh(dir, ["rev-parse", "flare/session"]).trim()).toBe(second.sha);
    expect(sh(dir, ["rev-list", "--count", "flare/session"]).trim()).toBe("3");
    expect(sh(dir, ["show", "flare/session:plan.md"])).toBe("# Plan\n- add limiter\n");
    const log = parseSessionLog(sh(dir, ["show", "flare/session:log.jsonl"]));
    expect(log.steps.map((s) => s.kind)).toEqual(["prompt", "decision"]);
    expect(log.steps[0]).toEqual({ ts: "2026-10-10T00:00:00.000Z", kind: "prompt", text: "rate-limit login" });
    expect(log.skipped).toBe(0);
  });

  it("rejects unknown kinds", async () => {
    const dir = repo();
    await expect(appendSessionStep({ cwd: dir, step: { kind: "bogus" as "note", text: "x" } })).rejects.toThrow(
      /unknown session step kind/,
    );
  });

  it("pushes to the remote and continues a session that exists only remotely", async () => {
    const root = mkdtempSync(join(tmpdir(), "flare-sdk-sess-"));
    const bare = join(root, "fork.git");
    sh(root, ["init", "-q", "--bare", "-b", "main", bare]);
    const a = repo();
    sh(a, ["remote", "add", "origin", bare]);
    sh(a, ["push", "-q", "origin", "main"]);
    const first = await appendSessionStep({ cwd: a, step: { kind: "note", text: "agent A" }, push: {} });
    expect(first.pushed).toBe(true);
    // Agent B clones (e.g. a forked session) and continues the log.
    const b = join(root, "b");
    sh(root, ["clone", "-q", bare, b]);
    sh(b, ["config", "user.email", "b@test"]);
    sh(b, ["config", "user.name", "b"]);
    await appendSessionStep({ cwd: b, step: { kind: "note", text: "agent B" }, push: { remote: "origin" } });
    const log = parseSessionLog(sh(root, ["--git-dir", bare, "show", "flare/session:log.jsonl"]));
    expect(log.steps.map((s) => s.text)).toEqual(["agent A", "agent B"]);
  });
});
