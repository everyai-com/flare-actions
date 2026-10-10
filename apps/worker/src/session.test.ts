/// <reference types="node" />
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSessionStep, writeSessionPlan } from "../../../packages/runner-sdk/src/provenance.ts";
import { declareIntent, isForgeError, listForgeLedger } from "./intents";
import { gitCli } from "./provenance-harness.test-util";
import {
  formatSessionStep,
  forkSession,
  parseSessionLog,
  readSession,
  sessionForkName,
  type ForkSessionArtifacts,
  type SessionArtifacts,
  type SessionForkHandle,
  type SessionTokenHandle,
} from "./session";
import { sqliteDb } from "./why-fakes.test-util";

// These suites spawn real git processes (or run the full simulator), which
// can exceed vitest's 5 s default on a loaded machine.
const SLOW_TEST_MS = 60_000;

// SessionArtifacts over a bare repo through the git CLI (stands in for
// the binding: first-parent log + readFile by ref/path).
function cliArtifacts(bare: string): SessionArtifacts {
  return {
    async get() {
      return {
        async log({ ref } = {}) {
          try {
            const out = gitCli(bare, ["log", "-1", "--format=%H %ct", ref ?? "HEAD"]).trim().split(" ");
            return [{ hash: out[0], committedAt: Number(out[1]) }];
          } catch {
            return [];
          }
        },
        async readFile({ ref, path }) {
          try {
            const text = gitCli(bare, ["show", `${ref}:${path}`]);
            return { size: text.length, text: async () => text };
          } catch {
            return null;
          }
        },
      };
    },
  };
}

describe("session log format", () => {
  it("formats bounded JSONL and parses leniently (bad lines counted, tail kept)", () => {
    const line = formatSessionStep({ ts: "2026-10-10T00:00:00.000Z", kind: "tool", text: "x".repeat(5000) });
    expect(JSON.parse(line).text).toHaveLength(4000);
    expect(JSON.parse(formatSessionStep({ ts: "garbage", kind: "note", text: "n" })).ts).toMatch(/^\d{4}-/);
    const text = [
      formatSessionStep({ ts: "2026-10-10T00:00:01.000Z", kind: "prompt", text: "p" }),
      "{oops",
      JSON.stringify({ ts: "t", kind: "shell", text: "bad kind" }),
      formatSessionStep({ ts: "2026-10-10T00:00:02.000Z", kind: "reason", text: "r" }),
      formatSessionStep({ ts: "2026-10-10T00:00:03.000Z", kind: "decision", text: "d" }),
      "",
    ].join("\n");
    const all = parseSessionLog(text);
    expect(all).toMatchObject({ total: 5, skipped: 2 });
    expect(all.steps.map((s) => s.kind)).toEqual(["prompt", "reason", "decision"]);
    expect(parseSessionLog(text, 2).steps.map((s) => s.text)).toEqual(["r", "d"]);
  });
});

describe("readSession (SDK writer -> real git remote -> Worker reader)", { timeout: SLOW_TEST_MS }, () => {
  it("reads plan + steps an agent pushed with the SDK helper", async () => {
    const root = mkdtempSync(join(tmpdir(), "flare-session-"));
    const bare = join(root, "i-abc.git");
    gitCli(root, ["init", "-q", "--bare", "-b", "main", bare]);
    const work = join(root, "work");
    gitCli(root, ["init", "-q", "-b", "main", work]);
    gitCli(work, ["config", "user.email", "agent@test"]);
    gitCli(work, ["config", "user.name", "agent"]);
    writeFileSync(join(work, "a.txt"), "a\n");
    gitCli(work, ["add", "."]);
    gitCli(work, ["commit", "-qm", "init"]);
    gitCli(work, ["remote", "add", "origin", bare]);
    gitCli(work, ["push", "-q", "origin", "main"]);

    const artifacts = cliArtifacts(bare);
    expect(await readSession({ artifacts }, "i-abc")).toBeNull();

    await writeSessionPlan({ cwd: work, plan: "# Plan\n1. limiter\n", push: {} });
    await appendSessionStep({ cwd: work, step: { kind: "prompt", text: "rate-limit /login" }, push: {} });
    await appendSessionStep({ cwd: work, step: { kind: "decision", text: "token bucket per IP" }, push: {} });

    const view = await readSession({ artifacts }, "i-abc");
    expect(view).not.toBeNull();
    expect(view?.branch).toBe("flare/session");
    expect(view?.plan).toBe("# Plan\n1. limiter\n");
    expect(view?.steps.map((s) => `${s.kind}:${s.text}`)).toEqual(["prompt:rate-limit /login", "decision:token bucket per IP"]);
    expect(view?.head?.sha).toBe(gitCli(bare, ["rev-parse", "flare/session"]).trim());
    expect(view?.logTruncated).toBe(false);
  });

  it("returns null when the repo is missing", async () => {
    const artifacts: SessionArtifacts = {
      get: async () => {
        throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      },
    };
    expect(await readSession({ artifacts }, "nope")).toBeNull();
  });
});

describe("forkSession", () => {
  function fakeForkArtifacts(opts: { forkThrows?: boolean; tokenThrows?: boolean } = {}) {
    const forks: Array<{ from: string; name: string; defaultBranchOnly?: boolean }> = [];
    const tokens: Array<{ repo: string; scope: string; ttl: number }> = [];
    const revoked: string[] = [];
    const artifacts: ForkSessionArtifacts = {
      async get(repo: string): Promise<SessionForkHandle & SessionTokenHandle> {
        return {
          async fork(name, o) {
            if (opts.forkThrows) throw new Error("FORK_IN_PROGRESS");
            forks.push({ from: repo, name, defaultBranchOnly: o?.defaultBranchOnly });
            return { name, remote: `https://acct.artifacts.cloudflare.net/git/ns/${name}.git`, token: "art_v2_creation" };
          },
          async createToken(scope, ttl) {
            if (opts.tokenThrows) throw new Error("boom");
            tokens.push({ repo, scope, ttl });
            return { plaintext: `art_v2_${repo}`, expiresAt: "2026-10-10T01:00:00.000Z" };
          },
          async revokeToken(t) {
            revoked.push(t);
            return true;
          },
        };
      },
    };
    return { artifacts, forks, tokens, revoked };
  }

  async function seeded(forkRepo: string | null) {
    const { db, raw } = sqliteDb();
    const d = await declareIntent(db, { repo: "demo", title: "Rate-limit login", footprint: ["src/login.ts"] });
    if (isForgeError(d)) throw new Error(d.message);
    if (forkRepo) raw.prepare("UPDATE intents SET fork_repo = ?, state = 'landed' WHERE id = ?").run(forkRepo, d.intent.id);
    return { db, intent: d.intent };
  }

  it("forks the intent fork (all branches), mints a 1h write token, revokes the creation token, records the ledger", async () => {
    const { db, intent } = await seeded("i-abc");
    const f = fakeForkArtifacts();
    const out = await forkSession({ db, artifacts: f.artifacts, random: () => "beef01" }, { intentId: intent.id, agent: "Claude.7" });
    expect(isForgeError(out)).toBe(false);
    if (isForgeError(out)) return;
    expect(out.forkRepo).toBe(sessionForkName(intent.id, "Claude.7", "beef01"));
    expect(out.forkRepo).toMatch(/^s-[a-z0-9]+-claude-7-beef01$/);
    expect(out).toMatchObject({ sourceRepo: "i-abc", branch: "flare/session", token: `art_v2_${out.forkRepo}`, tokenExpiresAt: "2026-10-10T01:00:00.000Z" });
    expect(f.forks).toEqual([{ from: "i-abc", name: out.forkRepo, defaultBranchOnly: false }]);
    expect(f.tokens).toEqual([{ repo: out.forkRepo, scope: "write", ttl: 3600 }]);
    expect(f.revoked).toEqual(["art_v2_creation"]);
    const ledger = await listForgeLedger(db, "intent", intent.id);
    expect(ledger.find((r) => r.kind === "session.forked")).toMatchObject({ actor: "Claude.7", body: `Claude.7 forked i-abc -> ${out.forkRepo}` });
  });

  it("fails cleanly: unknown intent, unclaimed intent, bad agent, fork and token failures", async () => {
    const { db, intent } = await seeded("i-abc");
    const { db: db2, intent: unclaimed } = await seeded(null);
    const ok = fakeForkArtifacts();
    const code = async (p: Promise<unknown>) => {
      const v = await p;
      return isForgeError(v) ? v.error : "ok";
    };
    expect(await code(forkSession({ db, artifacts: ok.artifacts }, { intentId: "nope", agent: "a" }))).toBe("not-found");
    expect(await code(forkSession({ db: db2, artifacts: ok.artifacts }, { intentId: unclaimed.id, agent: "a" }))).toBe("no-session");
    expect(await code(forkSession({ db, artifacts: ok.artifacts }, { intentId: intent.id, agent: "" }))).toBe("invalid-agent");
    expect(await code(forkSession({ db, artifacts: fakeForkArtifacts({ forkThrows: true }).artifacts }, { intentId: intent.id, agent: "a" }))).toBe("fork-failed");
    expect(await code(forkSession({ db, artifacts: fakeForkArtifacts({ tokenThrows: true }).artifacts }, { intentId: intent.id, agent: "a" }))).toBe("token-failed");
    expect((await listForgeLedger(db, "intent", intent.id)).some((r) => r.kind === "session.forked")).toBe(false);
  });
});
