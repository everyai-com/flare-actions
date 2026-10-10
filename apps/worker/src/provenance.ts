// Why-record storage (§3.1 "Why record", invariant 3): every trunk
// commit carries a WhyNote, written by the train (the single writer).
//
// Two git-native strategies behind one interface:
//   notes  — `refs/notes/why` (git notes; `git log --notes=why` shows
//            them). Default: spike S1 (2026-10-10) confirmed Artifacts
//            accepts push + fetch of the notes ref from both the git
//            CLI and isomorphic-git, and forks copy it.
//   branch — JSON files `why/<sha>.json` on an orphan `flare/why`
//            branch. Fallback for hosts that refuse non-branch refs.
//
// Writers run in a Worker over an isomorphic-git MemoryFS repo (as
// promote.ts does); readers run either over that repo (tests, trains)
// or over the Artifacts binding (the `why` read path, zero git traffic).
//
// Push cost: both refs only reach note blobs/trees (never trunk
// commits), so even the first push of a brand-new ref is small — the
// "new ref uploads the whole history" trap (spike S5) does not apply.
// Concurrent writers lose with a non-fast-forward rejection; the writer
// refetches and replays its entries (bounded attempts).
import type * as IsoGit from "isomorphic-git";
import type { FsClient, HttpClient, TreeEntry } from "isomorphic-git";
import { parseWhyNote, serializeWhyNote, WHY_NOTE_MAX_BYTES, type WhyNote } from "./intents-core";

export type WhyStorage = "notes" | "branch";
export const WHY_STORAGES: readonly WhyStorage[] = ["notes", "branch"];
// Spike S1: notes push/fetch work on Artifacts, so notes are primary.
export const DEFAULT_WHY_STORAGE: WhyStorage = "notes";

export const WHY_NOTES_REF = "refs/notes/why";
export const WHY_BRANCH = "flare/why";
export const WHY_BRANCH_REF = "refs/heads/flare/why";
export const WHY_BRANCH_DIR = "why";
export const WHY_MAX_ENTRIES_PER_WRITE = 200;
export const WHY_DEFAULT_PUSH_ATTEMPTS = 3;

const SHA_RE = /^[0-9a-f]{40}$/;

export function whyBranchPath(sha: string): string {
  return `${WHY_BRANCH_DIR}/${sha}.json`;
}

export function whyRefFor(strategy: WhyStorage): string {
  return strategy === "notes" ? WHY_NOTES_REF : WHY_BRANCH_REF;
}

export function isWhyStorage(v: unknown): v is WhyStorage {
  return v === "notes" || v === "branch";
}

// The isomorphic-git surface the writer/reader use (pass the default
// export of "isomorphic-git"; tests pass the same).
export type ProvenanceGit = Pick<
  typeof IsoGit,
  "addNote" | "readNote" | "writeRef" | "resolveRef" | "fetch" | "push" | "writeBlob" | "writeTree" | "writeCommit" | "readTree" | "readBlob"
>;

export interface WhyRemote {
  // Remote name already added to the repo (git.addRemote).
  name: string;
  http: HttpClient;
  onAuth: () => { username: string; password: string };
}

export interface WriteWhyOptions {
  strategy?: WhyStorage;
  // Absent = local write only (no fetch, no push).
  remote?: WhyRemote;
  author?: { name: string; email: string };
  maxAttempts?: number;
}

export interface WriteWhyResult {
  strategy: WhyStorage;
  ref: string;
  written: string[];
  skipped: Array<{ sha: string; reason: "invalid-sha" | "too-large" }>;
  head: string | null;
  pushed: boolean;
  attempts: number;
}

const DEFAULT_AUTHOR = { name: "Flare Train", email: "train@flare.invalid" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
    .replace(/art_v2_\S+/g, "art_v2_[redacted]")
    .slice(0, 300);
}

function isRejection(err: unknown): boolean {
  const code = errCode(err);
  if (code === "PushRejectedError" || code === "GitPushError") return true;
  // Artifacts says "not-fast-forward"; stock receive-pack reports a lost
  // compare-and-swap as "failed to update ref". Replay is idempotent.
  return /fast-forward|fetch first|stale info|rejected|failed to update ref|failed to lock/i.test(errText(err));
}

function isMissingRef(err: unknown): boolean {
  const code = errCode(err);
  return code === "NotFoundError" || /could not find|not found|no such ref/i.test(errText(err));
}

// Pull the remote ref into the local repo. Returns the remote tip (null
// when the ref does not exist yet). The local ref is forced to it:
// isomorphic-git fetch of a non-branch ref returns fetchHead without
// writing a local ref (spike S1 gotcha).
async function syncFromRemote(
  git: ProvenanceGit,
  fs: FsClient,
  dir: string,
  remote: WhyRemote,
  ref: string,
): Promise<string | null> {
  let fetchHead: string | null = null;
  try {
    const res = await git.fetch({
      fs,
      http: remote.http,
      dir,
      remote: remote.name,
      ref,
      remoteRef: ref,
      singleBranch: true,
      tags: false,
      depth: 1,
      onAuth: remote.onAuth,
    });
    fetchHead = res.fetchHead;
  } catch (err) {
    if (!isMissingRef(err)) throw err;
    fetchHead = null;
  }
  if (fetchHead) {
    await git.writeRef({ fs, dir, ref, value: fetchHead, force: true });
  }
  return fetchHead;
}

async function localTip(git: ProvenanceGit, fs: FsClient, dir: string, ref: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref });
  } catch {
    return null;
  }
}

async function applyNotes(
  git: ProvenanceGit,
  fs: FsClient,
  dir: string,
  entries: Array<{ sha: string; text: string }>,
  author: { name: string; email: string },
): Promise<void> {
  for (const e of entries) {
    await git.addNote({ fs, dir, ref: WHY_NOTES_REF, oid: e.sha, note: e.text, force: true, author, committer: author });
  }
}

// One commit on `flare/why` updating why/<sha>.json for every entry.
// Pure object writes: no worktree, no index, no checkout.
async function applyBranch(
  git: ProvenanceGit,
  fs: FsClient,
  dir: string,
  entries: Array<{ sha: string; text: string }>,
  author: { name: string; email: string },
): Promise<void> {
  const parent = await localTip(git, fs, dir, WHY_BRANCH_REF);
  let rootEntries: TreeEntry[] = [];
  let whyEntries: TreeEntry[] = [];
  if (parent) {
    rootEntries = (await git.readTree({ fs, dir, oid: parent })).tree;
    const sub = rootEntries.find((e) => e.path === WHY_BRANCH_DIR && e.type === "tree");
    if (sub) whyEntries = (await git.readTree({ fs, dir, oid: sub.oid })).tree;
  }
  const byName = new Map(whyEntries.map((e) => [e.path, e]));
  for (const e of entries) {
    const oid = await git.writeBlob({ fs, dir, blob: encoder.encode(e.text) });
    byName.set(`${e.sha}.json`, { mode: "100644", path: `${e.sha}.json`, oid, type: "blob" });
  }
  const whyTree = await git.writeTree({ fs, dir, tree: [...byName.values()] });
  const root = rootEntries.filter((e) => e.path !== WHY_BRANCH_DIR);
  root.push({ mode: "040000", path: WHY_BRANCH_DIR, oid: whyTree, type: "tree" });
  const tree = await git.writeTree({ fs, dir, tree: root });
  const ts = Math.floor(Date.now() / 1000);
  const who = { ...author, timestamp: ts, timezoneOffset: 0 };
  const commit = await git.writeCommit({
    fs,
    dir,
    commit: {
      message: `why: ${entries.length} note${entries.length === 1 ? "" : "s"}\n`,
      tree,
      parent: parent ? [parent] : [],
      author: who,
      committer: who,
    },
  });
  await git.writeRef({ fs, dir, ref: WHY_BRANCH_REF, value: commit, force: true });
}

// Write (or overwrite) the why note of each landed commit, then push
// the ref when a remote is given. Single-writer assumption: only the
// train writes; a lost race (non-fast-forward) refetches and replays.
export async function writeWhyNotes(
  git: ProvenanceGit,
  fs: FsClient,
  dir: string,
  entries: Array<{ sha: string; note: WhyNote }>,
  opts: WriteWhyOptions = {},
): Promise<WriteWhyResult> {
  const strategy = opts.strategy ?? DEFAULT_WHY_STORAGE;
  const ref = whyRefFor(strategy);
  const author = opts.author ?? DEFAULT_AUTHOR;
  const skipped: WriteWhyResult["skipped"] = [];
  const bySha = new Map<string, string>();
  for (const e of entries.slice(0, WHY_MAX_ENTRIES_PER_WRITE)) {
    const sha = typeof e.sha === "string" ? e.sha.toLowerCase() : "";
    if (!SHA_RE.test(sha)) {
      skipped.push({ sha: String(e.sha).slice(0, 64), reason: "invalid-sha" });
      continue;
    }
    const text = serializeWhyNote(e.note);
    if (encoder.encode(text).byteLength > WHY_NOTE_MAX_BYTES) {
      skipped.push({ sha, reason: "too-large" });
      continue;
    }
    bySha.set(sha, `${text}\n`);
  }
  const list = [...bySha.entries()].map(([sha, text]) => ({ sha, text }));
  const result: WriteWhyResult = { strategy, ref, written: [], skipped, head: null, pushed: false, attempts: 0 };
  if (list.length === 0) {
    result.head = await localTip(git, fs, dir, ref);
    return result;
  }
  const apply = (): Promise<void> =>
    strategy === "notes" ? applyNotes(git, fs, dir, list, author) : applyBranch(git, fs, dir, list, author);

  if (!opts.remote) {
    result.attempts = 1;
    await apply();
    result.written = list.map((e) => e.sha);
    result.head = await localTip(git, fs, dir, ref);
    return result;
  }
  const remote = opts.remote;
  const max = Math.min(Math.max(opts.maxAttempts ?? WHY_DEFAULT_PUSH_ATTEMPTS, 1), 10);
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    result.attempts = attempt;
    await syncFromRemote(git, fs, dir, remote, ref);
    await apply();
    try {
      const pushed = await git.push({
        fs,
        http: remote.http,
        dir,
        remote: remote.name,
        ref,
        remoteRef: ref,
        onAuth: remote.onAuth,
      });
      const status = pushed.refs?.[ref];
      if (pushed.ok && (!status || status.ok)) {
        result.written = list.map((e) => e.sha);
        result.head = await localTip(git, fs, dir, ref);
        result.pushed = true;
        return result;
      }
      lastErr = new Error(status?.error ?? pushed.error ?? "push rejected");
      if (!isRejection(lastErr)) break;
    } catch (err) {
      lastErr = err;
      if (!isRejection(err)) break;
    }
  }
  throw new Error(`why ${strategy} push failed after ${result.attempts} attempt(s): ${errText(lastErr)}`);
}

// Local read over an isomorphic-git repo (trains, tests).
export async function readWhyNoteLocal(
  git: ProvenanceGit,
  fs: FsClient,
  dir: string,
  sha: string,
  strategy: WhyStorage = DEFAULT_WHY_STORAGE,
): Promise<WhyNote | null> {
  const oid = sha.toLowerCase();
  if (!SHA_RE.test(oid)) return null;
  try {
    if (strategy === "notes") {
      const bytes = await git.readNote({ fs, dir, ref: WHY_NOTES_REF, oid });
      return parseWhyNote(decoder.decode(bytes));
    }
    const tip = await localTip(git, fs, dir, WHY_BRANCH_REF);
    if (!tip) return null;
    const blob = await git.readBlob({ fs, dir, oid: tip, filepath: whyBranchPath(oid) });
    return parseWhyNote(decoder.decode(blob.blob));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Binding-side reader (the `why` read path)
// ---------------------------------------------------------------------------

export interface WhyNoteBlob {
  readonly size: number;
  text(): Promise<string>;
}

// The slice of the Artifacts repo handle the reader needs.
export interface WhyNoteRepo {
  readFile(args: { ref: string; path: string }): Promise<WhyNoteBlob | null>;
  log(opts?: { ref?: string; limit?: number }): Promise<Array<{ hash: string }>>;
}

export interface WhyNoteHit {
  note: WhyNote;
  source: WhyStorage;
}

export interface WhyNoteReader {
  read(sha: string): Promise<WhyNoteHit | null>;
}

async function readText(repo: WhyNoteRepo, ref: string, path: string): Promise<string | null> {
  try {
    const blob = await repo.readFile({ ref, path });
    if (!blob || blob.size > WHY_NOTE_MAX_BYTES * 2) return null;
    return await blob.text();
  } catch {
    return null;
  }
}

// Git notes trees fan out (`ab/cdef…`, `ab/cd/ef…`) once they grow; try
// the flat name first (isomorphic-git writes flat), then the fanouts.
function notePaths(sha: string): string[] {
  return [sha, `${sha.slice(0, 2)}/${sha.slice(2)}`, `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha.slice(4)}`];
}

// Reader over the Artifacts binding. `"auto"` tries notes, then the
// branch. Tip resolution is cached for the reader's lifetime (one
// request), so a chain lookup of N shas costs ~N reads, not 2N.
export function createWhyNoteReader(repo: WhyNoteRepo, storage: WhyStorage | "auto" = "auto"): WhyNoteReader {
  let notesTip: Promise<string | null> | null = null;
  const resolveNotesTip = (): Promise<string | null> => {
    notesTip ??= (async () => {
      try {
        const [tip] = await repo.log({ ref: WHY_NOTES_REF, limit: 1 });
        return tip?.hash ?? null;
      } catch {
        return null;
      }
    })();
    return notesTip;
  };
  const viaNotes = async (sha: string): Promise<WhyNote | null> => {
    // The tip commit id is the portable form (the binding documents
    // branch/tag/commit refs; refs/notes/* may not resolve by name).
    const ref = (await resolveNotesTip()) ?? WHY_NOTES_REF;
    for (const path of notePaths(sha)) {
      const text = await readText(repo, ref, path);
      if (text !== null) return parseWhyNote(text);
    }
    return null;
  };
  const viaBranch = async (sha: string): Promise<WhyNote | null> => {
    const text = await readText(repo, WHY_BRANCH, whyBranchPath(sha));
    return text === null ? null : parseWhyNote(text);
  };
  return {
    async read(sha: string): Promise<WhyNoteHit | null> {
      const oid = sha.toLowerCase();
      if (!SHA_RE.test(oid)) return null;
      if (storage === "notes" || storage === "auto") {
        const note = await viaNotes(oid);
        if (note) return { note, source: "notes" };
      }
      if (storage === "branch" || storage === "auto") {
        const note = await viaBranch(oid);
        if (note) return { note, source: "branch" };
      }
      return null;
    },
  };
}
