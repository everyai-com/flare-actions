import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlareForge, FORGE_AGENTS_MD_SNIPPET } from "flare-actions-runner-sdk";
import {
  FORGE_MARKER_END,
  FORGE_MARKER_START,
  forgeAgentsBlock,
  lineDiff,
  mergeMcpJson,
  planForgeInit,
  upsertBlock,
} from "./forge-init.ts";
import { FLARE_SKILLS, FORGE_SKILL_MD } from "./forge-skill.gen.ts";
import { runForge, type ForgeCliDeps } from "./forge.ts";

const URL_ = "https://flare.example.workers.dev";

function deps(files: Map<string, string>, opts: { json?: boolean; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: ForgeCliDeps = {
    json: opts.json ?? false,
    env: opts.env ?? { FLARE_ACTIONS_URL: URL_, RUNNER_TOKEN: "super-secret-runner-token" },
    forge: () => new FlareForge(URL_, "tok"),
    git: (args) =>
      args[0] === "rev-parse" ? { status: 0, stdout: "/home/me/bookshelf\n", stderr: "" } : { status: 1, stdout: "", stderr: "" },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readText: (p) => files.get(p) ?? null,
    writeText: (p, t) => files.set(p, t),
    writeFile: (p, t) => files.set(p, t),
    cwd: "/w",
  };
  return { d, out, err };
}

afterEach(() => vi.restoreAllMocks());

describe("forge init: AGENTS.md block", () => {
  it("creates, appends, and replaces in place (idempotent)", () => {
    const block = forgeAgentsBlock("bookshelf");
    expect(block.startsWith(FORGE_MARKER_START)).toBe(true);
    expect(block.endsWith(FORGE_MARKER_END)).toBe(true);
    expect(block).toContain(FORGE_AGENTS_MD_SNIPPET);
    expect(block).toContain("`bookshelf`");
    expect(block).toMatch(/Declare before you edit/);

    expect(upsertBlock(null, block)).toBe(`${block}\n`);
    const appended = upsertBlock("# Project\n\nRules.\n", block);
    expect(appended).toBe(`# Project\n\nRules.\n\n${block}\n`);
    expect(upsertBlock(appended, block)).toBe(appended);

    const replaced = upsertBlock(appended, forgeAgentsBlock("other"));
    expect(replaced.startsWith("# Project\n\nRules.\n")).toBe(true);
    expect(replaced).toContain("`other`");
    expect(replaced).not.toContain("`bookshelf`");
    expect(replaced.split(FORGE_MARKER_START).length).toBe(2);
  });

  it("refuses a dangling marker instead of guessing", () => {
    expect(() => upsertBlock(`x\n${FORGE_MARKER_START}\nno end`, "b")).toThrow(/dangling start/);
  });
});

describe("forge init: MCP config", () => {
  it("merges into an existing config, keeps other servers, never inlines a token", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: true });
    const plan = planForgeInit({ client: "claude", repo: "bookshelf", url: URL_, skill: false }, (p) => (p === ".mcp.json" ? existing : null));
    const mcp = plan.changes.find((c) => c.path === ".mcp.json");
    expect(mcp?.action).toBe("updated");
    const doc = JSON.parse(mcp?.after ?? "") as { extra: boolean; mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> };
    expect(doc.extra).toBe(true);
    expect(doc.mcpServers["other"]).toEqual({ command: "x" });
    expect(doc.mcpServers["flare-forge"].url).toBe(`${URL_}/mcp`);
    expect(doc.mcpServers["flare-forge"].headers?.["Authorization"]).toBe("Bearer ${FLARE_TOKEN}");
  });

  it("cursor uses its env syntax under .cursor/; codex is printed, not written", () => {
    const cursor = planForgeInit({ client: "cursor", repo: "r", url: URL_, skill: false }, () => null);
    const c = cursor.changes.find((x) => x.path === ".cursor/mcp.json");
    expect(c?.action).toBe("created");
    expect(c?.after).toContain("Bearer ${env:FLARE_TOKEN}");

    const codex = planForgeInit({ client: "codex", repo: "r", url: URL_, skill: false }, () => null);
    expect(codex.changes.map((x) => x.path)).toEqual(["AGENTS.md"]);
    expect(codex.manual.join("\n")).toContain('bearer_token_env_var = "FLARE_TOKEN"');
  });

  it("never overwrites an unparseable config", () => {
    expect(() => mergeMcpJson("{nope", ".mcp.json", {})).toThrow(/not valid JSON/);
    expect(() => mergeMcpJson("[]", ".mcp.json", {})).toThrow(/JSON object/);
    expect(() => mergeMcpJson('{"mcpServers": 3}', ".mcp.json", {})).toThrow(/mcpServers/);
  });

  it("warns when the deployment URL is unknown", () => {
    const plan = planForgeInit({ client: "claude", repo: "r", url: "https://<your-worker>.workers.dev", skill: false }, () => null);
    expect(plan.warnings.join("\n")).toMatch(/FLARE_ACTIONS_URL is not set/);
  });
});

describe("forge init: skill + diff", () => {
  it("embeds the repo skill verbatim (re-run apps/cli/scripts/gen-skill.mjs on drift)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const onDisk = readFileSync(join(here, "..", "..", "..", "skills", "flare-forge", "SKILL.md"), "utf8");
    expect(FORGE_SKILL_MD).toBe(onDisk);
    const plan = planForgeInit({ client: "claude", repo: "r", url: URL_, skill: true }, () => null);
    expect(plan.changes.map((c) => c.path)).toContain(".claude/skills/flare-forge/SKILL.md");
  });

  it("diffs line by line with context", () => {
    const diff = lineDiff("AGENTS.md", "a\nb\nc\n", "a\nB\nc\nd\n");
    expect(diff).toContain("--- a/AGENTS.md");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain("+d");
    expect(lineDiff("x", null, "new\n")).toContain("--- /dev/null");
  });
});

describe("cli forge init", () => {
  it("writes AGENTS.md + .mcp.json, is idempotent, and never prints or writes the token", async () => {
    const files = new Map<string, string>([["/w/AGENTS.md", "# Repo rules\n"]]);
    const first = deps(files);
    expect(await runForge(["init"], first.d)).toBe(0);
    expect(files.get("/w/AGENTS.md")).toContain("# Repo rules");
    expect(files.get("/w/AGENTS.md")).toContain("Forge repo: `bookshelf`");
    expect(files.get("/w/.mcp.json")).toContain(`${URL_}/mcp`);
    for (const v of files.values()) expect(v).not.toContain("super-secret-runner-token");
    expect(first.out.join("\n")).not.toContain("super-secret-runner-token");
    expect(first.out.join("\n")).toContain("+<!-- flare-forge:start -->");

    const snapshot = new Map(files);
    const second = deps(files);
    expect(await runForge(["init"], second.d)).toBe(0);
    expect(files).toEqual(snapshot);
    expect(second.out.filter((l) => l.includes("unchanged")).length).toBe(2);
  });

  it("--dry-run shows the diff and writes nothing", async () => {
    const files = new Map<string, string>();
    const h = deps(files);
    expect(await runForge(["init", "--dry-run", "--skill", "--repo", "demo"], h.d)).toBe(0);
    expect(files.size).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("AGENTS.md: would be created");
    expect(text).toContain(".claude/skills/flare-forge/SKILL.md: would be created");
    expect(text).toContain("dry run: nothing was written");
  });

  it("--json reports files and manual steps", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = deps(new Map(), { json: true });
    expect(await runForge(["init", "--client", "codex"], h.d)).toBe(0);
    expect(h.out).toEqual([]);
    const env = JSON.parse(String(log.mock.calls[0][0])) as { command: string; data: { files: Array<{ path: string; action: string }>; manual: string[] } };
    expect(env.command).toBe("forge init");
    expect(env.data.files).toEqual([{ path: "AGENTS.md", action: "created", why: expect.any(String) as string }]);
    expect(env.data.manual.join("\n")).toContain("~/.codex/config.toml");
  });

  it("rejects bad input and broken configs", async () => {
    expect(await runForge(["init", "--client", "vim"], deps(new Map()).d)).toBe(2);
    expect(await runForge(["init", "--repo", "a/b"], deps(new Map()).d)).toBe(2);
    expect(await runForge(["init", "--url", "javascript:x"], deps(new Map()).d)).toBe(2);
    const files = new Map([["/w/.mcp.json", "{broken"]]);
    const h = deps(files);
    expect(await runForge(["init"], h.d)).toBe(1);
    expect(h.err.join("\n")).toMatch(/not valid JSON/);
    expect(files.get("/w/.mcp.json")).toBe("{broken");
    expect(files.has("/w/AGENTS.md")).toBe(false);
  });
});

describe("forge init --global", () => {
  it("embeds every repo skill verbatim (re-run apps/cli/scripts/gen-skill.mjs on drift)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const [name, text] of Object.entries(FLARE_SKILLS)) {
      expect(text, name).toBe(readFileSync(join(here, "..", "..", "..", "skills", name, "SKILL.md"), "utf8"));
    }
    expect(Object.keys(FLARE_SKILLS).sort()).toEqual(["flare-forge", "flare-migrate", "flare-setup", "flare-verify"]);
  });

  it("writes user-level files under HOME, keeps existing content, and is idempotent", async () => {
    const files = new Map<string, string>([["/home/me/.claude/CLAUDE.md", "# Mine\n\nKeep this.\n"]]);
    const { d, out } = deps(files, { env: { FLARE_ACTIONS_URL: URL_, HOME: "/home/me" } });
    expect(await runForge(["init", "--global"], d)).toBe(0);
    const claude = files.get("/home/me/.claude/CLAUDE.md") ?? "";
    expect(claude.startsWith("# Mine\n\nKeep this.\n")).toBe(true);
    expect(claude).toContain("<!-- flare-global:start -->");
    expect(claude).toContain(URL_);
    expect(files.get("/home/me/.codex/AGENTS.md")).toContain("run_and_wait");
    for (const n of ["flare-forge", "flare-verify", "flare-setup", "flare-migrate"]) {
      expect(files.get(`/home/me/.claude/skills/${n}/SKILL.md`)).toBe(FLARE_SKILLS[n]);
    }
    expect(out.join("\n")).toContain(`claude mcp add --scope user --transport http flare-forge ${URL_}/mcp`);
    // nothing written inside the working directory
    expect([...files.keys()].some((k) => k.startsWith("/w/"))).toBe(false);
    const snapshot = new Map(files);
    expect(await runForge(["init", "--global"], d)).toBe(0);
    expect(files).toEqual(snapshot);
  });

  it("--dry-run writes nothing", async () => {
    const files = new Map<string, string>();
    const { d } = deps(files, { env: { HOME: "/home/me" } });
    expect(await runForge(["init", "--global", "--dry-run"], d)).toBe(0);
    expect(files.size).toBe(0);
  });
});
