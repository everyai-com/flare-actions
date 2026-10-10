import type { ArtifactsFileBlob } from "./artifacts-push";

// Agent-forge repository browsing: read-only views over the ARTIFACTS
// namespace (list, info, tree, file, history). Powers the dashboard
// Repositories surface. Runtime-free: the binding rides an injected
// interface so unit tests drive every path with fakes.

export const REPOS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const REPOS_MAX_DEPTH = 16;
export const REPOS_MAX_ENTRIES = 500;
export const REPOS_MAX_FILE_BYTES = 256 * 1024;
export const REPOS_MAX_LOG = 100;
const REPOS_MAX_PATH_CHARS = 1024;

export interface ReposCommitAuthor {
  name: string;
  email: string;
}

export interface ReposCommit {
  hash: string;
  treeHash: string;
  message: string;
  author: ReposCommitAuthor;
  committer: ReposCommitAuthor;
  parents: string[];
  authoredAt: number;
  committedAt: number;
}

export interface ReposTreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: string;
}

export interface ReposListed {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
}

export interface ReposRepoHandle {
  info(): Promise<ReposListed & { remote: string }>;
  log(opts?: { ref?: string; limit?: number }): Promise<ReposCommit[]>;
  readTree(hash: string): Promise<ReposTreeEntry[] | null>;
  readCommit(hash: string): Promise<ReposCommit | null>;
  readFile(args: { ref: string; path: string }): Promise<ArtifactsFileBlob | null>;
  readonly [Symbol.dispose]?: () => void;
}

export interface ReposArtifacts {
  get(name: string): Promise<ReposRepoHandle>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: ReposListed[]; total: number; cursor?: string }>;
}

export interface RepoSummary {
  name: string;
  defaultBranch: string;
  description: string | null;
  source: string | null;
  readOnly: boolean;
  lastPushAt: string | null;
  updatedAt: string;
}

export interface RepoHead {
  hash: string;
  message: string;
  committedAt: number;
}

export interface RepoDetail extends RepoSummary {
  head: RepoHead | null;
}

export interface TreeEntry {
  name: string;
  type: string;
  hash: string;
}

export interface TreeResult {
  ref: string;
  path: string;
  head: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface BlobResult {
  ref: string;
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  text: string | null;
}

export interface CommitSummary {
  hash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: number;
  parents: string[];
}

function isNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.toUpperCase().includes("NOT_FOUND")) return true;
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && /not.?found/i.test(message)) return true;
  }
  return false;
}

async function withHandle<T>(
  artifacts: ReposArtifacts,
  repo: string,
  fn: (handle: ReposRepoHandle) => Promise<T>,
): Promise<T> {
  let handle: ReposRepoHandle | null = null;
  try {
    handle = await artifacts.get(repo);
    return await fn(handle);
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail a read.
    }
  }
}

export function validateRepoName(repo: unknown): string | null {
  return typeof repo === "string" && REPOS_NAME_RE.test(repo) ? repo : null;
}

export function decodeRepoParam(raw: string): string | null {
  try {
    return validateRepoName(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function validateRef(ref: unknown, fallback: string): string | null {
  if (ref === undefined || ref === null || ref === "") return fallback;
  if (typeof ref !== "string" || ref.length > 128 || /[\s]/.test(ref)) return null;
  return ref;
}

// Repository-relative path: "" is the root. Rejects traversal, empties,
// and over-long segments so binding reads stay inside the tree.
export function normalizeRepoPath(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || raw.length > REPOS_MAX_PATH_CHARS) return null;
  const collapsed = raw.replace(/\/{2,}/g, "/");
  const trimmed = collapsed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split("/");
  if (parts.length > REPOS_MAX_DEPTH) return null;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.length > 200) return null;
  }
  return parts.join("/");
}

function toSummary(r: ReposListed): RepoSummary {
  return {
    name: r.name,
    defaultBranch: r.defaultBranch,
    description: r.description,
    source: r.source,
    readOnly: r.readOnly,
    lastPushAt: r.lastPushAt,
    updatedAt: r.updatedAt,
  };
}

function toCommitSummary(c: ReposCommit): CommitSummary {
  return {
    hash: c.hash,
    message: c.message,
    authorName: c.author.name,
    authorEmail: c.author.email,
    committedAt: c.committedAt,
    parents: c.parents,
  };
}

export async function listRepos(
  artifacts: ReposArtifacts,
  limit: number,
  cursor?: string,
): Promise<{ repos: RepoSummary[]; total: number; cursor?: string }> {
  const page = await artifacts.list({
    limit: Math.min(Math.max(limit, 1), 100),
    ...(cursor ? { cursor } : {}),
  });
  return {
    repos: page.repos.map(toSummary),
    total: page.total,
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}

// Allowlist-aware page: scoped tokens filter before paging, refilling
// from later upstream pages (bounded) so a page is never empty while
// more allowed repos follow. Each upstream fetch asks only for the
// slots still open, so the returned cursor never skips a repo. `total`
// is the namespace total when nothing is filtered, else the page size.
export async function listAllowedRepos(
  artifacts: ReposArtifacts,
  limit: number,
  cursor: string | undefined,
  allow: ((name: string) => boolean) | null,
): Promise<{ repos: RepoSummary[]; total: number; cursor?: string }> {
  if (!allow) return listRepos(artifacts, limit, cursor);
  const repos: RepoSummary[] = [];
  let next = cursor;
  for (let pages = 0; pages < 10 && repos.length < limit; pages++) {
    const page = await listRepos(artifacts, limit - repos.length, next);
    repos.push(...page.repos.filter((r) => allow(r.name)));
    next = page.cursor;
    if (!next) break;
  }
  return { repos, total: repos.length, ...(next ? { cursor: next } : {}) };
}

export async function getRepoInfo(artifacts: ReposArtifacts, repo: string): Promise<RepoDetail | null> {
  try {
    return await withHandle(artifacts, repo, async (handle) => {
      const meta = await handle.info();
      let head: RepoHead | null = null;
      try {
        const [tip] = await handle.log({ ref: meta.defaultBranch, limit: 1 });
        if (tip) head = { hash: tip.hash, message: tip.message, committedAt: tip.committedAt };
      } catch {
        head = null;
      }
      return { ...toSummary(meta), head };
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function resolveHeadTree(
  handle: ReposRepoHandle,
  ref: string,
): Promise<{ hash: string; treeHash: string } | null> {
  const [tip] = await handle.log({ ref, limit: 1 });
  if (!tip) return null;
  return { hash: tip.hash, treeHash: tip.treeHash };
}

export async function getRepoTree(
  artifacts: ReposArtifacts,
  repo: string,
  ref: string,
  path: string,
): Promise<TreeResult | null> {
  try {
    return await withHandle(artifacts, repo, async (handle) => {
      const head = await resolveHeadTree(handle, ref);
      if (!head) return null;
      let treeHash = head.treeHash;
      if (path) {
        for (const segment of path.split("/")) {
          const entries = await handle.readTree(treeHash);
          if (!entries) return null;
          const next = entries.find((e) => e.name === segment);
          if (!next || next.type !== "tree") return null;
          treeHash = next.hash;
        }
      }
      const entries = (await handle.readTree(treeHash)) ?? [];
      const mapped = entries.map((e) => ({ name: e.name, type: e.type, hash: e.hash }));
      mapped.sort((a, b) => {
        const ad = a.type === "tree" ? 0 : 1;
        const bd = b.type === "tree" ? 0 : 1;
        return ad - bd || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
      return {
        ref,
        path,
        head: head.hash,
        entries: mapped.slice(0, REPOS_MAX_ENTRIES),
        truncated: mapped.length > REPOS_MAX_ENTRIES,
      };
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function getRepoBlob(
  artifacts: ReposArtifacts,
  repo: string,
  ref: string,
  path: string,
): Promise<BlobResult | null> {
  if (!path) return null;
  try {
    return await withHandle(artifacts, repo, async (handle) => {
      const file = await handle.readFile({ ref, path });
      if (!file) return null;
      const size = file.size;
      if (size > REPOS_MAX_FILE_BYTES * 4) {
        return { ref, path, size, truncated: true, binary: false, text: null };
      }
      const raw = await file.text();
      if (raw.includes("\0")) return { ref, path, size, truncated: false, binary: true, text: null };
      if (size <= REPOS_MAX_FILE_BYTES && raw.length <= REPOS_MAX_FILE_BYTES) {
        return { ref, path, size, truncated: false, binary: false, text: raw };
      }
      return { ref, path, size, truncated: true, binary: false, text: raw.slice(0, REPOS_MAX_FILE_BYTES) };
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function getRepoCommits(
  artifacts: ReposArtifacts,
  repo: string,
  ref: string,
  limit: number,
): Promise<CommitSummary[] | null> {
  try {
    return await withHandle(artifacts, repo, async (handle) => {
      const commits = await handle.log({ ref, limit: Math.min(Math.max(limit, 1), REPOS_MAX_LOG) });
      return commits.map(toCommitSummary);
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
