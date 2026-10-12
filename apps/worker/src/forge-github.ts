// Forge <-> GitHub bridge: bring an existing GitHub repo into Flare Forge
// and keep both sides in step, so a team can adopt intent-native
// collaboration without leaving GitHub (docs/FORGE-GITHUB.md).
//
//   import   GitHub repo -> Artifacts trunk (server-side `import`, any
//            size; private repos through the GitHub App installation).
//            Trunk work happens on `main`: a GitHub default branch with
//            another name gets a `main` alias on first sync.
//   pull     GitHub default branch -> trunk main, fast-forward only.
//            Human commits and merged sync PRs flow in; trains see main
//            move and rebuild (their CAS already handles that). Never a
//            force push: a diverged history is reported, not rewritten.
//   push     trunk main -> GitHub, per link `sync_mode`:
//              branch  force-update `sync_branch` (ours alone)
//              pr      branch + one rolling PR into the default branch
//                      (humans merge on GitHub; the merge flows back in)
//              direct  fast-forward the default branch (never force)
//              off     nothing leaves Forge
//
// The trunk stays agent-read-only (§3.2 invariant 1): only trains and
// this bridge ever write trunk main, both fast-forward only, both with
// write tokens minted per push and never returned. Runtime-free: git,
// HTTP, Artifacts and GitHub REST are injected so tests run real git
// over an in-process http-backend.
import type { FsClient, HttpClient } from "isomorphic-git";
import type git from "isomorphic-git";
import { audit, nowIso, type Db } from "./db";
import { REPOS_NAME_RE } from "./repos";
import { nextFetchDepth } from "./train-core";

export const SYNC_MODES = ["off", "branch", "pr", "direct"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];
export const DEFAULT_SYNC_MODE: SyncMode = "pr";
export const DEFAULT_SYNC_BRANCH = "flare/trunk";
export const TRUNK_BRANCH = "main";
const GITDIR = "/repo.git";
const TOKEN_TTL_S = 600;
const MAX_LINKS = 200;
const PR_INTENTS = 20;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const GH_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;

// owner/name from `owner/name`, `github.com/owner/name`, an https or
// ssh clone URL (with or without `.git`), or a browser URL with extra
// path segments (`/tree/main`). null for anything else.
export function parseGithubRepo(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s || s.length > 300) return null;
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  s = s.replace(/[?#].*$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");
  if (!GH_NAME.test(owner) || !GH_REPO.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

// Trunk name for an imported repo: `gh-owner-name`, lowercase, within
// the Artifacts name rules. Prefixed so it never collides with the CI
// mirror of the same repo (`owner-name`, artifacts-mirrors.ts).
export function defaultTrunkName(githubRepo: string): string {
  const slug = `gh-${githubRepo.replace("/", "-")}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
  return slug.slice(0, 100);
}

export function isSyncMode(v: unknown): v is SyncMode {
  return typeof v === "string" && (SYNC_MODES as readonly string[]).includes(v);
}

// A branch we own on GitHub: plain ref-name characters, no `..`, no
// leading `-`/`/`, no trailing `/` or `.lock`, never the trunk alias.
export function validSyncBranch(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 1 || v.length > 100) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) return false;
  if (v.includes("..") || v.includes("//") || /^[-/.]/.test(v) || /[/.]$/.test(v) || v.endsWith(".lock")) return false;
  return true;
}

export function prTitle(trunk: string): string {
  return `Flare Forge: landed work from ${trunk}`;
}

export interface LandedIntentLine {
  id: string;
  title: string;
  agent: string;
  landedSha: string | null;
}

// The rolling PR's body: what landed (newest first, bounded) and how it
// was verified. Intent titles are agent-written: rendered as inline
// code-free text with newlines and markdown link syntax flattened.
export function prBody(input: { trunk: string; trunkSha: string; intents: LandedIntentLine[]; dashboardUrl?: string }): string {
  const clean = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/[[\]<>]/g, "").slice(0, 160);
  const lines = [
    `Every commit on this branch landed on the Flare Forge trunk \`${input.trunk}\` through a train that CI verified as the exact combined SHA.`,
    "",
    `Trunk head: \`${input.trunkSha.slice(0, 12)}\``,
    "",
  ];
  if (input.intents.length) {
    lines.push("### Landed intents", "");
    for (const i of input.intents) {
      const sha = i.landedSha ? ` (\`${i.landedSha.slice(0, 7)}\`)` : "";
      lines.push(`- ${clean(i.title)} — ${clean(i.agent || "agent")}${sha} · \`${i.id.slice(0, 12)}\``);
    }
    lines.push("");
  }
  lines.push(
    "Merge this PR to bring the work into the default branch; the merge flows back into the trunk on the next sync.",
    "Ask why any line exists with `cli forge why <repo> <path>:<line>`.",
  );
  if (input.dashboardUrl) lines.push("", `Dashboard: ${input.dashboardUrl}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

export interface GithubLink {
  repo: string;
  githubRepo: string;
  defaultBranch: string;
  syncMode: SyncMode;
  syncBranch: string;
  pullUpstream: boolean;
  status: "importing" | "ready" | "failed";
  detail: string;
  installationId: number | null;
  isPrivate: boolean;
  lastPushedSha: string;
  lastPulledSha: string;
  prNumber: number | null;
  lastSyncAt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface LinkRow {
  repo: string;
  github_repo: string;
  default_branch: string;
  sync_mode: string;
  sync_branch: string;
  pull_upstream: number;
  status: string;
  detail: string;
  installation_id: number | null;
  is_private: number;
  last_pushed_sha: string;
  last_pulled_sha: string;
  pr_number: number | null;
  last_sync_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toLink(r: LinkRow): GithubLink {
  return {
    repo: r.repo,
    githubRepo: r.github_repo,
    defaultBranch: r.default_branch,
    syncMode: isSyncMode(r.sync_mode) ? r.sync_mode : "off",
    syncBranch: r.sync_branch,
    pullUpstream: r.pull_upstream === 1,
    status: r.status === "ready" || r.status === "failed" ? r.status : "importing",
    detail: r.detail,
    installationId: r.installation_id ?? null,
    isPrivate: r.is_private === 1,
    lastPushedSha: r.last_pushed_sha,
    lastPulledSha: r.last_pulled_sha,
    prNumber: r.pr_number ?? null,
    lastSyncAt: r.last_sync_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getGithubLink(db: Db, repo: string): Promise<GithubLink | null> {
  const row = await db.prepare("SELECT * FROM forge_github_links WHERE repo = ?").bind(repo).first<LinkRow>();
  return row ? toLink(row) : null;
}

export async function listGithubLinks(db: Db, limit = MAX_LINKS): Promise<GithubLink[]> {
  const res = await db
    .prepare("SELECT * FROM forge_github_links ORDER BY created_at DESC LIMIT ?")
    .bind(Math.max(1, Math.min(MAX_LINKS, limit)))
    .all<LinkRow>();
  return res.results.map(toLink);
}

export async function linksForGithubRepo(db: Db, githubRepo: string): Promise<GithubLink[]> {
  const res = await db
    .prepare("SELECT * FROM forge_github_links WHERE github_repo = ? COLLATE NOCASE LIMIT 10")
    .bind(githubRepo)
    .all<LinkRow>();
  return res.results.map(toLink);
}

async function insertLink(db: Db, l: Omit<GithubLink, "createdAt" | "updatedAt" | "lastPushedSha" | "lastPulledSha" | "prNumber" | "lastSyncAt">): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO forge_github_links (repo, github_repo, default_branch, sync_mode, sync_branch, pull_upstream, status, detail, installation_id, is_private, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET default_branch = excluded.default_branch, sync_mode = excluded.sync_mode,
         sync_branch = excluded.sync_branch, pull_upstream = excluded.pull_upstream, status = excluded.status,
         detail = excluded.detail, installation_id = excluded.installation_id, is_private = excluded.is_private,
         updated_at = excluded.updated_at`,
    )
    .bind(
      l.repo,
      l.githubRepo,
      l.defaultBranch,
      l.syncMode,
      l.syncBranch,
      l.pullUpstream ? 1 : 0,
      l.status,
      l.detail.slice(0, 500),
      l.installationId,
      l.isPrivate ? 1 : 0,
      l.createdBy.slice(0, 100),
      now,
      now,
    )
    .run();
}

type LinkPatch = Partial<{
  status: GithubLink["status"];
  detail: string;
  syncMode: SyncMode;
  syncBranch: string;
  pullUpstream: boolean;
  installationId: number | null;
  lastPushedSha: string;
  lastPulledSha: string;
  prNumber: number | null;
  lastSyncAt: string;
}>;

const PATCH_COLUMNS: Record<keyof LinkPatch, string> = {
  status: "status",
  detail: "detail",
  syncMode: "sync_mode",
  syncBranch: "sync_branch",
  pullUpstream: "pull_upstream",
  installationId: "installation_id",
  lastPushedSha: "last_pushed_sha",
  lastPulledSha: "last_pulled_sha",
  prNumber: "pr_number",
  lastSyncAt: "last_sync_at",
};

export async function patchGithubLink(db: Db, repo: string, patch: LinkPatch): Promise<void> {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof LinkPatch, LinkPatch[keyof LinkPatch]]>) {
    if (value === undefined) continue;
    sets.push(`${PATCH_COLUMNS[key]} = ?`);
    if (typeof value === "boolean") values.push(value ? 1 : 0);
    else if (key === "detail" && typeof value === "string") values.push(value.slice(0, 500));
    else values.push(value);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  values.push(nowIso(), repo);
  await db.prepare(`UPDATE forge_github_links SET ${sets.join(", ")} WHERE repo = ?`).bind(...values).run();
}

// Unlink only: the trunk and the GitHub repo both stay exactly as they are.
export async function deleteGithubLink(db: Db, repo: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM forge_github_links WHERE repo = ?").bind(repo).run();
  return Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

async function landedIntents(db: Db, repo: string): Promise<LandedIntentLine[]> {
  const res = await db
    .prepare("SELECT id, title, agent, landed_sha FROM intents WHERE repo = ? AND state = 'landed' ORDER BY updated_at DESC LIMIT ?")
    .bind(repo, PR_INTENTS)
    .all<{ id: string; title: string; agent: string; landed_sha: string | null }>();
  return res.results.map((r) => ({ id: r.id, title: r.title, agent: r.agent, landedSha: r.landed_sha }));
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type BridgeGit = Pick<typeof git, "init" | "addRemote" | "fetch" | "push" | "writeRef" | "listServerRefs" | "readCommit" | "isDescendent" | "findMergeBase">;

export interface BridgeRepoHandle {
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<{ plaintext: string } | string>;
  readonly [Symbol.dispose]?: () => void;
}

export interface BridgeArtifacts {
  import(params: {
    source: { url: string; branch?: string };
    target: { name: string; opts?: { description?: string } };
  }): Promise<{ remote: string }>;
  get(name: string): Promise<BridgeRepoHandle>;
}

export interface GithubRepoInfo {
  defaultBranch: string;
  isPrivate: boolean;
}

// GitHub REST, as the bridge needs it. The real implementation
// (`githubRestPort`) mints App installation tokens; tests inject fakes.
export interface GithubPort {
  installationFor(githubRepo: string): Promise<number | null>;
  installationToken(installationId: number): Promise<string | null>;
  repoInfo(githubRepo: string, token: string | null): Promise<GithubRepoInfo | null>;
  findOpenPr(githubRepo: string, token: string, head: string, base: string): Promise<number | null>;
  openPr(githubRepo: string, token: string, pr: { head: string; base: string; title: string; body: string }): Promise<number | null>;
  updatePr(githubRepo: string, token: string, prNumber: number, body: string): Promise<boolean>;
}

export interface BridgeDeps {
  db: Db;
  artifacts: BridgeArtifacts | null;
  github: GithubPort;
  git: BridgeGit;
  http: HttpClient;
  fs: () => FsClient;
  // HTTPS remote of a trunk (Artifacts); null = unconfigured.
  remoteFor: (repo: string) => string | null;
  // Git remote of a GitHub repo (tests point it at a local fixture).
  githubRemote?: (githubRepo: string) => string;
  dashboardUrl?: string;
}

function githubUrl(deps: BridgeDeps, githubRepo: string): string {
  return deps.githubRemote ? deps.githubRemote(githubRepo) : `https://github.com/${githubRepo}.git`;
}

function codeOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  return String((err as { code?: unknown }).code ?? "");
}

// Error text for logs/rows: never a URL (private imports and pushes
// carry tokens in credentials), bounded.
function redact(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/https?:\/\/[^\s]+/g, "<url>").replace(/(?:ghs|ghp|gho|art)_[A-Za-z0-9_]+/g, "<token>").slice(0, 200);
}

function dispose(h: { [Symbol.dispose]?: () => void } | null): void {
  try {
    h?.[Symbol.dispose]?.();
  } catch {
    // Disposal never fails a sync.
  }
}

async function mintTrunkToken(deps: BridgeDeps, repo: string, scope: "read" | "write"): Promise<string> {
  if (!deps.artifacts) throw new Error("artifacts unconfigured");
  let handle: BridgeRepoHandle | null = null;
  try {
    handle = await deps.artifacts.get(repo);
    const t = await handle.createToken(scope, TOKEN_TTL_S);
    return typeof t === "string" ? t : t.plaintext;
  } finally {
    dispose(handle);
  }
}

// Installation token for a link: stored id first, then a fresh lookup
// (the App may have been installed after the import). null = public,
// read-only access.
async function githubToken(deps: BridgeDeps, link: Pick<GithubLink, "repo" | "githubRepo" | "installationId">): Promise<string | null> {
  let id = link.installationId;
  if (!id) {
    id = await deps.github.installationFor(link.githubRepo).catch(() => null);
    if (id) await patchGithubLink(deps.db, link.repo, { installationId: id });
  }
  if (!id) return null;
  return deps.github.installationToken(id).catch(() => null);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportInput {
  github: unknown;
  name?: unknown;
  syncMode?: unknown;
  syncBranch?: unknown;
  pullUpstream?: unknown;
  actor: string;
}

export type BridgeError = {
  error: "invalid_request" | "github_repo_unavailable" | "github_link_exists" | "artifacts_unconfigured" | "forge_not_found";
  message: string;
};

export interface ImportResult {
  status: "ready" | "importing" | "failed" | "exists";
  link: GithubLink;
  trunk: string;
  remote: string | null;
  // What happened to the `main` alias / first pull, when it ran.
  sync?: PullResult;
  warnings: string[];
}

export async function importGithubRepo(deps: BridgeDeps, input: ImportInput): Promise<ImportResult | BridgeError> {
  const githubRepo = parseGithubRepo(input.github);
  if (!githubRepo) return { error: "invalid_request", message: "github must be owner/name or a github.com URL" };
  const trunk = input.name === undefined || input.name === "" ? defaultTrunkName(githubRepo) : input.name;
  if (typeof trunk !== "string" || !REPOS_NAME_RE.test(trunk)) {
    return { error: "invalid_request", message: "name must be 1-100 letters, digits, dots, dashes or underscores" };
  }
  const syncMode = input.syncMode === undefined ? DEFAULT_SYNC_MODE : input.syncMode;
  if (!isSyncMode(syncMode)) return { error: "invalid_request", message: `syncMode must be one of ${SYNC_MODES.join(", ")}` };
  const syncBranch = input.syncBranch === undefined ? DEFAULT_SYNC_BRANCH : input.syncBranch;
  if (!validSyncBranch(syncBranch)) return { error: "invalid_request", message: "syncBranch must be a plain branch name" };
  const pullUpstream = input.pullUpstream === undefined ? true : input.pullUpstream === true || input.pullUpstream === "true";
  if (!deps.artifacts) return { error: "artifacts_unconfigured", message: "no ARTIFACTS binding on this deployment" };

  const existing = await getGithubLink(deps.db, trunk);
  if (existing && existing.githubRepo.toLowerCase() !== githubRepo.toLowerCase()) {
    return { error: "github_link_exists", message: `trunk ${trunk} is already linked to ${existing.githubRepo}` };
  }
  if (existing && existing.status === "ready") {
    return { status: "exists", link: existing, trunk, remote: deps.remoteFor(trunk), warnings: [] };
  }

  const warnings: string[] = [];
  const installationId = await deps.github.installationFor(githubRepo).catch(() => null);
  const token = installationId ? await deps.github.installationToken(installationId).catch(() => null) : null;
  const info = await deps.github.repoInfo(githubRepo, token).catch(() => null);
  if (!info) {
    return {
      error: "github_repo_unavailable",
      message: token
        ? `github.com/${githubRepo} could not be read with the App installation`
        : `github.com/${githubRepo} is not public, or does not exist (private repos need the Flare GitHub App installed on them)`,
    };
  }
  if (info.isPrivate && !token) {
    return { error: "github_repo_unavailable", message: `github.com/${githubRepo} is private: install the Flare GitHub App on it, then retry` };
  }
  if (!token && syncMode !== "off") {
    warnings.push(`no GitHub App installation on ${githubRepo}: landed work cannot be pushed back until the App is installed (contents:write, pull_requests:write)`);
  }

  await insertLink(deps.db, {
    repo: trunk,
    githubRepo,
    defaultBranch: info.defaultBranch,
    syncMode,
    syncBranch,
    pullUpstream,
    status: "importing",
    detail: "",
    installationId,
    isPrivate: info.isPrivate,
    createdBy: input.actor,
  });
  await audit(deps.db, input.actor, "forge.github.import", `${githubRepo} -> ${trunk}`).catch(() => undefined);

  // Server-side import: no history ever passes through the Worker.
  const sourceUrl = token ? `https://x-access-token:${token}@github.com/${githubRepo}.git` : `https://github.com/${githubRepo}.git`;
  let status: ImportResult["status"] = "ready";
  try {
    await deps.artifacts.import({
      source: { url: deps.githubRemote ? githubUrl(deps, githubRepo) : sourceUrl, branch: info.defaultBranch },
      target: { name: trunk, opts: { description: `Imported from github.com/${githubRepo} by Flare Forge` } },
    });
  } catch (err) {
    const code = codeOf(err);
    if (code === "ALREADY_EXISTS") {
      warnings.push(`trunk ${trunk} already existed: adopted it as the link target`);
    } else if (code === "IMPORT_IN_PROGRESS") {
      status = "importing";
    } else {
      const detail = `import ${code || "error"}: ${redact(err)}`;
      await patchGithubLink(deps.db, trunk, { status: "failed", detail });
      const link = await getGithubLink(deps.db, trunk);
      return link ? { status: "failed", link, trunk, remote: null, warnings } : { error: "forge_not_found", message: "link vanished" };
    }
  }

  let sync: PullResult | undefined;
  if (status === "ready") {
    // First pull: creates the `main` alias when GitHub's default branch
    // has another name, and records the imported head.
    sync = await syncFromGithub(deps, trunk, { force: true });
    if (sync.status === "failed") {
      // The import may still be settling; reconcileGithubLinks retries.
      status = "importing";
      await patchGithubLink(deps.db, trunk, { status: "importing", detail: sync.detail });
    } else {
      await patchGithubLink(deps.db, trunk, { status: "ready", detail: "" });
    }
  }
  const link = await getGithubLink(deps.db, trunk);
  if (!link) return { error: "forge_not_found", message: "link vanished" };
  return { status, link, trunk, remote: deps.remoteFor(trunk), ...(sync ? { sync } : {}), warnings };
}

// Cron: finish imports that were still settling (bounded per tick).
export async function reconcileGithubLinks(deps: BridgeDeps, limit = 3): Promise<number> {
  const res = await deps.db
    .prepare("SELECT * FROM forge_github_links WHERE status = 'importing' ORDER BY updated_at ASC LIMIT ?")
    .bind(limit)
    .all<LinkRow>();
  let done = 0;
  for (const row of res.results) {
    const out = await syncFromGithub(deps, row.repo, { force: true });
    if (out.status === "failed") {
      await patchGithubLink(deps.db, row.repo, { detail: out.detail });
      continue;
    }
    await patchGithubLink(deps.db, row.repo, { status: "ready", detail: "" });
    done += 1;
  }
  return done;
}

// ---------------------------------------------------------------------------
// Git plumbing (one MemoryFS repo per sync)
// ---------------------------------------------------------------------------

interface SyncCtx {
  deps: BridgeDeps;
  fs: FsClient;
  remotes: Map<string, string>;
}

async function openCtx(deps: BridgeDeps): Promise<SyncCtx> {
  const fs = deps.fs();
  await deps.git.init({ fs, gitdir: GITDIR, bare: true, defaultBranch: TRUNK_BRANCH });
  return { deps, fs, remotes: new Map() };
}

async function remoteName(ctx: SyncCtx, url: string): Promise<string> {
  const known = ctx.remotes.get(url);
  if (known) return known;
  const name = `r${ctx.remotes.size}`;
  await ctx.deps.git.addRemote({ fs: ctx.fs, gitdir: GITDIR, remote: name, url, force: true });
  ctx.remotes.set(url, name);
  return name;
}

function auth(username: string, token: string | null): { onAuth?: () => { username: string; password: string } } {
  return token ? { onAuth: () => ({ username, password: token }) } : {};
}

async function hasCommit(ctx: SyncCtx, oid: string): Promise<boolean> {
  try {
    await ctx.deps.git.readCommit({ fs: ctx.fs, gitdir: GITDIR, oid });
    return true;
  } catch {
    return false;
  }
}

async function serverRef(ctx: SyncCtx, url: string, ref: string, user: string, token: string | null): Promise<string | null> {
  const refs = await ctx.deps.git.listServerRefs({ http: ctx.deps.http, url, prefix: ref, ...auth(user, token) });
  return refs.find((r) => r.ref === ref)?.oid ?? null;
}

async function fetchDepth(ctx: SyncCtx, url: string, ref: string, depth: number, user: string, token: string | null): Promise<string | null> {
  const out = await ctx.deps.git.fetch({
    fs: ctx.fs,
    http: ctx.deps.http,
    gitdir: GITDIR,
    remote: await remoteName(ctx, url),
    ref,
    singleBranch: true,
    depth,
    tags: false,
    ...auth(user, token),
  });
  return out.fetchHead ?? null;
}

// Fetch `ref`, deepening (50/200/1000) until `need` is local.
async function fetchCovering(ctx: SyncCtx, url: string, ref: string, need: string | null, user: string, token: string | null): Promise<string | null> {
  let depth = nextFetchDepth(null);
  let head: string | null = null;
  while (depth !== null) {
    head = await fetchDepth(ctx, url, ref, depth, user, token);
    if (!need || (await hasCommit(ctx, need))) return head;
    depth = nextFetchDepth(depth);
  }
  return head;
}

async function descends(ctx: SyncCtx, oid: string, ancestor: string): Promise<boolean> {
  if (oid === ancestor) return true;
  try {
    return await ctx.deps.git.isDescendent({ fs: ctx.fs, gitdir: GITDIR, oid, ancestor, depth: -1 });
  } catch {
    return false;
  }
}

const SCRATCH_REF = "refs/heads/flare-bridge-sync";

async function pushTo(ctx: SyncCtx, url: string, oid: string, remoteRef: string, force: boolean, user: string, token: string): Promise<void> {
  // push takes a local ref, not an oid: park the commit under a scratch name.
  await ctx.deps.git.writeRef({ fs: ctx.fs, gitdir: GITDIR, ref: SCRATCH_REF, value: oid, force: true });
  const res = await ctx.deps.git.push({
    fs: ctx.fs,
    http: ctx.deps.http,
    gitdir: GITDIR,
    url,
    ref: SCRATCH_REF,
    remoteRef,
    force,
    onAuth: () => ({ username: user, password: token }),
  });
  const r = res.refs?.[remoteRef];
  if (!res.ok || (r && !r.ok)) throw new Error(`push ${remoteRef} rejected: ${r?.error ?? res.error ?? "unknown"}`);
}

// ---------------------------------------------------------------------------
// Pull: GitHub default branch -> trunk main (fast-forward only)
// ---------------------------------------------------------------------------

export interface PullResult {
  status: "noop" | "seeded" | "fast-forwarded" | "ahead" | "diverged" | "skipped" | "failed";
  detail: string;
  githubSha?: string;
  trunkSha?: string;
}

export async function syncFromGithub(deps: BridgeDeps, repo: string, opts: { force?: boolean } = {}): Promise<PullResult> {
  const link = await getGithubLink(deps.db, repo);
  if (!link) return { status: "failed", detail: "no GitHub link for this trunk" };
  if (!link.pullUpstream && !opts.force) return { status: "skipped", detail: "pull_upstream is off" };
  const trunkUrl = deps.remoteFor(repo);
  if (!trunkUrl || !deps.artifacts) return { status: "failed", detail: "artifacts unconfigured" };
  const out = await pullOnce(deps, link, trunkUrl).catch((err: unknown): PullResult => ({ status: "failed", detail: redact(err) }));
  await patchGithubLink(deps.db, repo, {
    lastSyncAt: nowIso(),
    ...(out.githubSha && (out.status === "noop" || out.status === "seeded" || out.status === "fast-forwarded") ? { lastPulledSha: out.githubSha } : {}),
    ...(out.status === "diverged" || out.status === "failed" ? { detail: `pull: ${out.detail}` } : {}),
  });
  if (out.status === "seeded" || out.status === "fast-forwarded" || out.status === "diverged") {
    await audit(deps.db, "forge-github", `forge.github.pull.${out.status}`, `${link.githubRepo} -> ${repo} ${out.githubSha?.slice(0, 12) ?? ""}`).catch(() => undefined);
  }
  return out;
}

async function pullOnce(deps: BridgeDeps, link: GithubLink, trunkUrl: string): Promise<PullResult> {
  const ghToken = await githubToken(deps, link);
  const readToken = await mintTrunkToken(deps, link.repo, "read");
  const ctx = await openCtx(deps);
  const ghUrl = githubUrl(deps, link.githubRepo);
  const branchRef = `refs/heads/${link.defaultBranch}`;
  const githubSha = await serverRef(ctx, ghUrl, branchRef, "x-access-token", ghToken);
  if (!githubSha) return { status: "failed", detail: `GitHub branch ${link.defaultBranch} not found` };
  const trunkSha = await serverRef(ctx, trunkUrl, `refs/heads/${TRUNK_BRANCH}`, "x", readToken);
  if (trunkSha === githubSha) return { status: "noop", detail: "trunk matches GitHub", githubSha, trunkSha };

  await fetchCovering(ctx, ghUrl, link.defaultBranch, trunkSha, "x-access-token", ghToken);
  if (!trunkSha) {
    // No `main` yet (GitHub's default branch has another name): alias it.
    const writeToken = await mintTrunkToken(deps, link.repo, "write");
    await pushTo(ctx, trunkUrl, githubSha, `refs/heads/${TRUNK_BRANCH}`, false, "x", writeToken);
    return { status: "seeded", detail: `trunk main created at GitHub ${link.defaultBranch}`, githubSha };
  }
  if ((await hasCommit(ctx, trunkSha)) && (await descends(ctx, githubSha, trunkSha))) {
    const writeToken = await mintTrunkToken(deps, link.repo, "write");
    // Non-force: a train landing at the same moment wins or loses the
    // CAS cleanly, never both.
    await pushTo(ctx, trunkUrl, githubSha, `refs/heads/${TRUNK_BRANCH}`, false, "x", writeToken);
    return { status: "fast-forwarded", detail: `trunk main ${trunkSha.slice(0, 12)} -> ${githubSha.slice(0, 12)}`, githubSha, trunkSha };
  }
  await fetchCovering(ctx, trunkUrl, TRUNK_BRANCH, githubSha, "x", readToken);
  if (await descends(ctx, trunkSha, githubSha)) {
    return { status: "ahead", detail: "trunk has landed work GitHub does not have yet (push sync delivers it)", githubSha, trunkSha };
  }
  return {
    status: "diverged",
    detail: `GitHub ${link.defaultBranch} and trunk main diverged: merge the sync PR (or the trunk branch) on GitHub, and the merge fast-forwards back in`,
    githubSha,
    trunkSha,
  };
}

// ---------------------------------------------------------------------------
// Push: trunk main -> GitHub
// ---------------------------------------------------------------------------

export interface PushResult {
  status: "off" | "noop" | "pushed" | "pr-opened" | "pr-updated" | "diverged" | "failed";
  detail: string;
  trunkSha?: string;
  prNumber?: number | null;
  prUrl?: string;
}

export async function syncToGithub(deps: BridgeDeps, repo: string): Promise<PushResult> {
  const link = await getGithubLink(deps.db, repo);
  if (!link) return { status: "failed", detail: "no GitHub link for this trunk" };
  if (link.syncMode === "off") return { status: "off", detail: "sync_mode is off" };
  if (link.status !== "ready") return { status: "failed", detail: `link is ${link.status}` };
  const trunkUrl = deps.remoteFor(repo);
  if (!trunkUrl || !deps.artifacts) return { status: "failed", detail: "artifacts unconfigured" };
  const out = await pushOnce(deps, link, trunkUrl).catch((err: unknown): PushResult => ({ status: "failed", detail: redact(err) }));
  await patchGithubLink(deps.db, repo, {
    lastSyncAt: nowIso(),
    ...(out.trunkSha && out.status !== "failed" && out.status !== "diverged" ? { lastPushedSha: out.trunkSha } : {}),
    ...(out.prNumber ? { prNumber: out.prNumber } : {}),
    detail: out.status === "failed" || out.status === "diverged" ? `push: ${out.detail}` : "",
  });
  if (out.status !== "noop") {
    await audit(deps.db, "forge-github", `forge.github.push.${out.status}`, `${repo} -> ${link.githubRepo} ${out.trunkSha?.slice(0, 12) ?? ""}`).catch(() => undefined);
  }
  return out;
}

async function pushOnce(deps: BridgeDeps, link: GithubLink, trunkUrl: string): Promise<PushResult> {
  const ghToken = await githubToken(deps, link);
  if (!ghToken) {
    return { status: "failed", detail: `install the Flare GitHub App on ${link.githubRepo} (contents:write, pull_requests:write) to push landed work back` };
  }
  const readToken = await mintTrunkToken(deps, link.repo, "read");
  const ctx = await openCtx(deps);
  const ghUrl = githubUrl(deps, link.githubRepo);
  const trunkSha = await serverRef(ctx, trunkUrl, `refs/heads/${TRUNK_BRANCH}`, "x", readToken);
  if (!trunkSha) return { status: "noop", detail: "trunk has no main yet" };
  const githubSha = await serverRef(ctx, ghUrl, `refs/heads/${link.defaultBranch}`, "x-access-token", ghToken);
  if (githubSha === trunkSha) return { status: "noop", detail: "GitHub already has the trunk head", trunkSha };

  await fetchCovering(ctx, trunkUrl, TRUNK_BRANCH, githubSha, "x", readToken);
  if (githubSha) {
    if (!(await hasCommit(ctx, githubSha))) {
      // GitHub moved past trunk: bring its branch in to find the base.
      await fetchCovering(ctx, ghUrl, link.defaultBranch, trunkSha, "x-access-token", ghToken);
    }
    if (await descends(ctx, githubSha, trunkSha)) {
      return { status: "noop", detail: "GitHub already contains the trunk head (pull sync fast-forwards trunk)", trunkSha };
    }
    const bases = await ctx.deps.git.findMergeBase({ fs: ctx.fs, gitdir: GITDIR, oids: [trunkSha, githubSha] }).catch(() => [] as string[]);
    if (!bases.length) return { status: "failed", detail: "no shared history with GitHub within 1000 commits", trunkSha };
  }

  if (link.syncMode === "direct") {
    if (githubSha && !(await descends(ctx, trunkSha, githubSha))) {
      return { status: "diverged", detail: `GitHub ${link.defaultBranch} moved: pull sync first (direct mode never force-pushes)`, trunkSha };
    }
    await pushTo(ctx, ghUrl, trunkSha, `refs/heads/${link.defaultBranch}`, false, "x-access-token", ghToken);
    return { status: "pushed", detail: `fast-forwarded GitHub ${link.defaultBranch}`, trunkSha };
  }

  // branch / pr: the sync branch is ours alone, so it may be forced.
  await pushTo(ctx, ghUrl, trunkSha, `refs/heads/${link.syncBranch}`, true, "x-access-token", ghToken);
  if (link.syncMode === "branch") return { status: "pushed", detail: `updated ${link.syncBranch}`, trunkSha };

  const body = prBody({ trunk: link.repo, trunkSha, intents: await landedIntents(deps.db, link.repo), dashboardUrl: deps.dashboardUrl });
  const owner = link.githubRepo.split("/")[0];
  const existing = await deps.github.findOpenPr(link.githubRepo, ghToken, `${owner}:${link.syncBranch}`, link.defaultBranch).catch(() => null);
  if (existing) {
    await deps.github.updatePr(link.githubRepo, ghToken, existing, body).catch(() => false);
    return { status: "pr-updated", detail: `updated PR #${existing}`, trunkSha, prNumber: existing, prUrl: `https://github.com/${link.githubRepo}/pull/${existing}` };
  }
  const opened = await deps.github.openPr(link.githubRepo, ghToken, { head: link.syncBranch, base: link.defaultBranch, title: prTitle(link.repo), body });
  if (!opened) return { status: "pushed", detail: `updated ${link.syncBranch}; the PR could not be opened (needs pull_requests:write)`, trunkSha };
  return { status: "pr-opened", detail: `opened PR #${opened}`, trunkSha, prNumber: opened, prUrl: `https://github.com/${link.githubRepo}/pull/${opened}` };
}

// ---------------------------------------------------------------------------
// GitHub REST port (real)
// ---------------------------------------------------------------------------

export interface GithubRestOptions {
  // App JWT for installation lookups; null when no App is configured.
  appJwt: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

const UA = "flare-forge-bridge";

export function githubRestPort(opts: GithubRestOptions): GithubPort {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? "https://api.github.com";
  const call = async (path: string, token: string | null, init: { method?: string; body?: unknown; bearer?: boolean } = {}): Promise<Response> => {
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    return f(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  };
  const record = async (res: Response): Promise<Record<string, unknown> | null> => {
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  };
  return {
    async installationFor(githubRepo) {
      const jwt = await opts.appJwt().catch(() => null);
      if (!jwt) return null;
      const body = await record(await call(`/repos/${githubRepo}/installation`, jwt));
      return typeof body?.id === "number" ? body.id : null;
    },
    async installationToken(installationId) {
      const jwt = await opts.appJwt().catch(() => null);
      if (!jwt) return null;
      const body = await record(await call(`/app/installations/${installationId}/access_tokens`, jwt, { method: "POST" }));
      return typeof body?.token === "string" ? body.token : null;
    },
    async repoInfo(githubRepo, token) {
      const body = await record(await call(`/repos/${githubRepo}`, token));
      if (!body || typeof body.default_branch !== "string") return null;
      return { defaultBranch: body.default_branch, isPrivate: body.private === true };
    },
    async findOpenPr(githubRepo, token, head, baseBranch) {
      const q = `?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(baseBranch)}&per_page=1`;
      const res = await call(`/repos/${githubRepo}/pulls${q}`, token);
      if (!res.ok) return null;
      const list: unknown = await res.json().catch(() => null);
      if (!Array.isArray(list) || !list.length) return null;
      const first: unknown = list[0];
      return typeof first === "object" && first !== null && typeof (first as { number?: unknown }).number === "number" ? (first as { number: number }).number : null;
    },
    async openPr(githubRepo, token, pr) {
      const body = await record(await call(`/repos/${githubRepo}/pulls`, token, { method: "POST", body: { ...pr, maintainer_can_modify: true } }));
      return typeof body?.number === "number" ? body.number : null;
    },
    async updatePr(githubRepo, token, prNumber, body) {
      const res = await call(`/repos/${githubRepo}/pulls/${prNumber}`, token, { method: "PATCH", body: { body } });
      return res.ok;
    },
  };
}
