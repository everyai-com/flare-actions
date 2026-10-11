import { afterEach, describe, expect, it, vi } from "vitest";
import { FlareForge } from "flare-actions-runner-sdk";
import { parseFlags, runForge, withForgeAuth, type ForgeCliDeps, type GitResult } from "./forge.ts";

interface Harness {
  deps: ForgeCliDeps;
  out: string[];
  err: string[];
  gitCalls: Array<{ args: string[]; env?: Record<string, string> }>;
  files: Map<string, string>;
  fetches: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }>;
}

function harness(opts: { json?: boolean; git?: (args: string[]) => GitResult; reply?: (url: string, method: string) => unknown } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const gitCalls: Harness["gitCalls"] = [];
  const files = new Map<string, string>();
  const fetches: Harness["fetches"] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    fetches.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    const data = opts.reply?.(url, method) ?? {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const deps: ForgeCliDeps = {
    json: opts.json ?? false,
    env: { FLARE_ACTIONS_URL: "https://ci.example.com" },
    forge: () => new FlareForge("https://ci.example.com", "tok", { agent: "alpha" }),
    git: (args, o = {}) => {
      gitCalls.push({ args, env: o.env });
      return opts.git ? opts.git(args) : { status: 0, stdout: "", stderr: "" };
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readText: (p) => files.get(p) ?? null,
    writeText: (p, t) => files.set(p, t),
    writeFile: (p, t) => files.set(p, t),
    cwd: "/work",
  };
  return { deps, out, err, gitCalls, files, fetches };
}

afterEach(() => vi.unstubAllGlobals());

const SHA = "c".repeat(40);
const INTENT = { id: "i1", repo: "demo", state: "working", risk: 12, title: "t" };

describe("cli forge", () => {
  it("parses repeatable, comma-split and optional-value flags", () => {
    const f = parseFlags(["demo", "Add", "x", "--path", "a,b", "--path", "c", "--reason", "why", "--clone"], {
      values: ["reason"],
      multi: ["path"],
      optionalValue: ["clone"],
    });
    expect(f.pos).toEqual(["demo", "Add", "x"]);
    expect(f.multi.path).toEqual(["a", "b", "c"]);
    expect(f.values.reason).toBe("why");
    expect(f.bools.has("clone")).toBe(true);
    expect(() => parseFlags(["--nope"], {})).toThrow(/unknown flag/);
  });

  it("stores fork auth without stacking stale headers", () => {
    const first = withForgeAuth("[core]\n\tbare = false\n", "t1", { intent: "i1", repo: "demo" });
    expect(first).toContain("[flare]\n\tintent = i1");
    const second = withForgeAuth(first, "t2");
    expect(second.match(/extraHeader/g)).toHaveLength(1);
    expect(second).toContain(Buffer.from("x:t2").toString("base64"));
    expect(second).toContain("intent = i1");
  });

  it("help exits 0, no verb exits 2, unknown verbs are usage errors", async () => {
    expect(await runForge(["--help"], harness().deps)).toBe(0);
    expect(await runForge([], harness().deps)).toBe(2);
    const h = harness();
    expect(await runForge(["bogus"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Unknown forge verb: bogus/);
    expect(h.err[h.err.length - 1]).toBe("next: cli forge --help");
  });

  it("declare sends the footprint and prints overlaps + next steps", async () => {
    const h = harness({
      reply: () => ({
        intent: { ...INTENT, state: "draft" },
        protectedHits: [],
        overlaps: [{ intentId: "i0", title: "Other", agent: "beta", state: "working", reasoning: "", paths: [["src/a.ts", "src/**"]] }],
        similar: [],
        inbox: [],
        nextSteps: [{ tool: "send_note", args: { toIntent: "i0" }, why: "overlap" }],
      }),
    });
    expect(await runForge(["declare", "demo", "Add", "cache", "--path", "src/a.ts", "--accept", "npm test"], h.deps)).toBe(0);
    expect(h.fetches[0]).toMatchObject({ method: "POST", body: { repo: "demo", title: "Add cache", footprint: ["src/a.ts"], accept: "npm test" } });
    expect(h.fetches[0].headers["X-Flare-Agent"]).toBe("alpha");
    expect(h.out.join("\n")).toMatch(/OVERLAP i0 "Other"/);
    expect(h.out.join("\n")).toMatch(/next: cli forge note i0 "<text>"/);
  });

  it("push runs plain git push, reads HEAD, then reports the sha", async () => {
    const h = harness({
      json: true,
      git: (args) => {
        if (args[0] === "config") return { status: 0, stdout: "i1\n", stderr: "" };
        if (args[0] === "rev-parse") return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "To fork\n   main -> main" };
      },
      reply: () => ({ intent: INTENT, sha: SHA, actualFootprint: { files: ["src/a.ts"], truncated: false, source: "verified" }, drift: [], risk: { score: 12, terms: [] }, overlaps: [], inbox: [], nextSteps: [] }),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runForge(["push"], h.deps)).toBe(0);
    expect(h.gitCalls.map((c) => c.args[0])).toEqual(["config", "push", "rev-parse"]);
    expect(h.gitCalls[1].args).toEqual(["push", "origin", "HEAD:main"]);
    expect(h.fetches[0]).toMatchObject({ url: "https://ci.example.com/v1/forge/intents/i1/push", body: { sha: SHA } });
    const printed = JSON.parse(String(log.mock.calls[0][0])) as { version: number; command: string };
    expect(printed).toMatchObject({ version: 1, command: "forge push" });
    expect(h.err[0]).toMatch(/To fork/);
    log.mockRestore();
  });

  it("push fails loudly when git push fails, without reporting", async () => {
    const h = harness({ git: (args) => (args[0] === "push" ? { status: 1, stdout: "", stderr: "denied" } : { status: 0, stdout: "", stderr: "" }) });
    await expect(runForge(["push", "i1"], h.deps)).rejects.toThrow(/git push failed/);
    expect(h.fetches).toHaveLength(0);
  });

  it("claim --clone keeps the token out of argv and records flare.intent", async () => {
    const h = harness({
      reply: () => ({
        intent: { ...INTENT, state: "claimed" },
        forkRepo: "i-abc",
        forkRemote: "https://acct.example/git/ns/i-abc.git",
        token: "secret-fork-token",
        tokenScope: "write:i-abc",
        tokenExpiresAt: "2026-10-10T01:00:00.000Z",
        tokenEnv: "FLARE_FORK_TOKEN",
        cloneCommand: "git clone ...",
        pushCommand: "git push origin HEAD:main",
        trailers: "Flare-Intent: i1",
        commitTemplate: "",
        leaseExpiresAt: null,
        heartbeatEverySeconds: 150,
        inbox: [],
        nextSteps: [],
      }),
    });
    h.files.set("i-abc/.git/config", "[core]\n");
    expect(await runForge(["claim", "i1", "--clone"], h.deps)).toBe(0);
    const clone = h.gitCalls[0];
    expect(clone.args).toEqual(["clone", "https://acct.example/git/ns/i-abc.git", "i-abc"]);
    expect(clone.args.join(" ")).not.toContain("secret-fork-token");
    expect(clone.env?.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(h.files.get("i-abc/.git/config")).toContain("intent = i1");
    expect(h.out.join("\n")).not.toContain("secret-fork-token");
  });

  it("connect-agent prints a paste-ready config per client", async () => {
    for (const client of ["claude", "codex", "cursor"]) {
      const h = harness({ json: true });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runForge(["connect-agent", "--client", client, "--agent", "alpha"], h.deps)).toBe(0);
      const env = JSON.parse(String(log.mock.calls[0][0])) as { data: { config: string; mcpUrl: string; prompt: string; agentsMd: string } };
      expect(env.data.mcpUrl).toBe("https://ci.example.com/mcp");
      expect(env.data.config).toContain("FLARE_TOKEN");
      expect(env.data.config).toContain("alpha");
      expect(env.data.prompt).toMatch(/declare_intent/);
      expect(env.data.agentsMd).toMatch(/Flare Forge/);
      log.mockRestore();
    }
    expect(await runForge(["connect-agent", "--client", "vim"], harness().deps)).toBe(2);
  });
});
