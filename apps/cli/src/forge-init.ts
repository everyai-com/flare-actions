// `cli forge init`: make the current repo Forge-ready for agents in one
// command. It writes (idempotently, showing a diff, `--dry-run` writes
// nothing):
//
// - AGENTS.md: a marker-delimited "Flare Forge" block (declare before you
//   edit, the loop, etiquette). Replaced in place on re-run; the rest of
//   the file is never touched. Codex, Cursor and Claude Code all read it.
// - the MCP server entry for the chosen client, merged into the client's
//   project config (`.mcp.json` for Claude Code, `.cursor/mcp.json` for
//   Cursor). The token is always an env-var reference, never a value, so
//   the file is safe to commit. Codex keeps MCP servers in
//   `~/.codex/config.toml`, outside the repo: we print that snippet and
//   leave the user's home directory alone.
// - optionally (`--skill`) `.claude/skills/flare-forge/SKILL.md`.
//
// Pure planning (`planForgeInit`) is separate from IO so tests can drive
// every branch without a filesystem.
import { forgeConnectAgent, FORGE_AGENTS_MD_SNIPPET, type ForgeAgentClient } from "flare-actions-runner-sdk";
import { FORGE_SKILL_MD } from "./forge-skill.gen.ts";

export const FORGE_MARKER_START = "<!-- flare-forge:start -->";
export const FORGE_MARKER_END = "<!-- flare-forge:end -->";
export const FORGE_MCP_SERVER = "flare-forge";
export const PLACEHOLDER_URL = "https://<your-worker>.workers.dev";

export interface ForgeInitOptions {
  client: ForgeAgentClient;
  /** Forge repo name in the Artifacts namespace (e.g. "bookshelf"). */
  repo: string;
  /** Deployment URL (FLARE_ACTIONS_URL); placeholder when unknown. */
  url: string;
  skill: boolean;
}

export interface FileChange {
  path: string;
  /** null = the file does not exist yet. */
  before: string | null;
  after: string;
  /** created | updated | unchanged */
  action: "created" | "updated" | "unchanged";
  why: string;
}

export interface ForgeInitPlan {
  changes: FileChange[];
  /** Things the user must do by hand (never automated: secrets, home dir). */
  manual: string[];
  warnings: string[];
}

export class ForgeInitError extends Error {}

/** The AGENTS.md block: the shared SDK snippet plus repo + etiquette. */
export function forgeAgentsBlock(repo: string): string {
  return [
    FORGE_MARKER_START,
    FORGE_AGENTS_MD_SNIPPET,
    "",
    `Forge repo: \`${repo}\`. Declare before you edit, even for a one-line fix: the declare call is`,
    "how the other agents (and you) learn about overlaps before any code is written.",
    "",
    "Etiquette:",
    "- Re-check `whats_happening` before large edits and before touching a file you did not declare.",
    "- `send_note` the owners before changing a shared contract (API shape, schema, exported type, config key).",
    "- Keep your lease alive with `heartbeat`; ask for `refreshToken: true` when the 1 h fork token nears expiry.",
    "- Before editing code you did not write, ask `why {repo, path, line}`.",
    "",
    "Setup: `export FLARE_TOKEN=<runner token>` (never commit it). Re-run `npx flare-forge forge init` to refresh this block.",
    FORGE_MARKER_END,
  ].join("\n");
}

/** Insert or replace the marker block; everything outside it is preserved. */
export function upsertBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === "") return `${block}\n`;
  const start = existing.indexOf(FORGE_MARKER_START);
  const end = existing.indexOf(FORGE_MARKER_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + FORGE_MARKER_END.length);
  }
  if (start !== -1 || end !== -1) {
    throw new ForgeInitError(`AGENTS.md has a dangling ${start !== -1 ? "start" : "end"} marker; fix it by hand, then re-run`);
  }
  return `${existing.replace(/\n*$/, "\n")}\n${block}\n`;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The server entry for a project-scoped MCP config file. */
export function mcpServerEntry(client: "claude" | "cursor", url: string): JsonObject {
  const out = forgeConnectAgent({ url, client });
  const parsed: unknown = JSON.parse(out.config);
  if (!isObject(parsed) || !isObject(parsed["mcpServers"]) || !isObject(parsed["mcpServers"][FORGE_MCP_SERVER])) {
    throw new ForgeInitError("internal: unexpected MCP config shape");
  }
  return parsed["mcpServers"][FORGE_MCP_SERVER];
}

/**
 * Merge our server into an existing MCP JSON config. Other servers and
 * top-level keys survive untouched; an unparseable file is an error,
 * never overwritten.
 */
export function mergeMcpJson(existing: string | null, path: string, entry: JsonObject): string {
  let doc: JsonObject = {};
  if (existing !== null && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new ForgeInitError(`${path} is not valid JSON; fix it by hand (nothing was written)`);
    }
    if (!isObject(parsed)) throw new ForgeInitError(`${path} must be a JSON object; fix it by hand (nothing was written)`);
    doc = parsed;
  }
  const servers = isObject(doc["mcpServers"]) ? doc["mcpServers"] : {};
  if (doc["mcpServers"] !== undefined && !isObject(doc["mcpServers"])) {
    throw new ForgeInitError(`${path}: "mcpServers" must be an object; fix it by hand (nothing was written)`);
  }
  const next = { ...doc, mcpServers: { ...servers, [FORGE_MCP_SERVER]: entry } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

function change(path: string, before: string | null, after: string, why: string): FileChange {
  const action = before === null ? "created" : before === after ? "unchanged" : "updated";
  return { path, before, after, action, why };
}

/** Plan every file change; `read` returns null for a missing file. */
export function planForgeInit(opts: ForgeInitOptions, read: (path: string) => string | null): ForgeInitPlan {
  const changes: FileChange[] = [];
  const manual: string[] = ["export FLARE_TOKEN=<runner token>  # RUNNER_TOKEN in .env, or mint one in the dashboard Access tab; never commit it"];
  const warnings: string[] = [];
  if (opts.url === PLACEHOLDER_URL) {
    warnings.push(`FLARE_ACTIONS_URL is not set: the MCP url is a placeholder (${PLACEHOLDER_URL}/mcp). Re-run with --url or after \`cli login\`.`);
  }

  const agentsBefore = read("AGENTS.md");
  changes.push(change("AGENTS.md", agentsBefore, upsertBlock(agentsBefore, forgeAgentsBlock(opts.repo)), "Flare Forge block: declare before you edit, the loop, etiquette"));

  if (opts.client === "claude" || opts.client === "cursor") {
    const path = opts.client === "claude" ? ".mcp.json" : ".cursor/mcp.json";
    const before = read(path);
    const after = mergeMcpJson(before, path, mcpServerEntry(opts.client, opts.url));
    changes.push(change(path, before, after, `MCP server "${FORGE_MCP_SERVER}" (token via env var reference, safe to commit)`));
  } else {
    const codex = forgeConnectAgent({ url: opts.url, client: "codex" });
    manual.push(`add to ${codex.configPath} (outside this repo, so not written):\n${codex.config}`);
  }

  if (opts.skill) {
    const path = ".claude/skills/flare-forge/SKILL.md";
    changes.push(change(path, read(path), FORGE_SKILL_MD, "flare-forge skill for Claude Code"));
  }
  return { changes, manual, warnings };
}

/**
 * Minimal unified-style line diff (LCS) for small config files. Files
 * above the cap fall back to a one-line summary instead of a slow diff.
 */
export function lineDiff(path: string, before: string | null, after: string, maxLines = 2000): string {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const header = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  if (a.length > maxLines || b.length > maxLines) {
    return [...header, `@@ ${a.length} -> ${b.length} lines (too large to diff inline) @@`].join("\n");
  }
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Array<{ k: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ k: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ k: "-", line: a[i++] });
    } else {
      ops.push({ k: "+", line: b[j++] });
    }
  }
  while (i < n) ops.push({ k: "-", line: a[i++] });
  while (j < m) ops.push({ k: "+", line: b[j++] });
  // Keep 2 lines of context around each change; elide the rest.
  const keep = Array.from({ length: ops.length }, () => false);
  ops.forEach((op, idx) => {
    if (op.k === " ") return;
    for (let x = Math.max(0, idx - 2); x <= Math.min(ops.length - 1, idx + 2); x++) keep[x] = true;
  });
  const body: string[] = [];
  let skipped = false;
  ops.forEach((op, idx) => {
    if (keep[idx]) {
      body.push(`${op.k}${op.line}`);
      skipped = false;
    } else if (!skipped) {
      body.push("@@ ... @@");
      skipped = true;
    }
  });
  const cap = 80;
  const shown = body.length > cap ? [...body.slice(0, cap), `@@ ... ${body.length - cap} more line(s) @@`] : body;
  return [...header, ...shown].join("\n");
}

export interface ForgeInitIo {
  write: (path: string, text: string) => void;
  out: (line: string) => void;
}

export interface ForgeInitReport {
  dryRun: boolean;
  client: ForgeAgentClient;
  repo: string;
  url: string;
  files: Array<{ path: string; action: FileChange["action"]; why: string }>;
  manual: string[];
  warnings: string[];
}

/** Apply (or, with dryRun, only show) a plan. Returns the report. */
export function applyForgeInit(plan: ForgeInitPlan, opts: ForgeInitOptions & { dryRun: boolean; quiet: boolean }, io: ForgeInitIo): ForgeInitReport {
  for (const c of plan.changes) {
    if (c.action !== "unchanged" && !opts.dryRun) io.write(c.path, c.after);
    if (opts.quiet) continue;
    const verb = c.action === "unchanged" ? "unchanged" : opts.dryRun ? `would be ${c.action}` : c.action;
    io.out(`${c.path}: ${verb} — ${c.why}`);
    if (c.action !== "unchanged") io.out(lineDiff(c.path, c.before, c.after));
  }
  if (!opts.quiet) {
    for (const w of plan.warnings) io.out(`warning: ${w}`);
    io.out("by hand:");
    for (const m of plan.manual) io.out(`  ${m.replace(/\n/g, "\n    ")}`);
    if (opts.dryRun) io.out("dry run: nothing was written");
  }
  return {
    dryRun: opts.dryRun,
    client: opts.client,
    repo: opts.repo,
    url: opts.url,
    files: plan.changes.map((c) => ({ path: c.path, action: c.action, why: c.why })),
    manual: plan.manual,
    warnings: plan.warnings,
  };
}
