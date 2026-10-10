// Forge push reconciliation (runtime-free): the namespace-wide
// `cf.artifacts.repo.pushed` trigger is the PRIMARY live-footprint
// signal (fires ~3 s after any push, brand-new forks included); the
// agent's own report_push is the fast path and fallback. Both converge
// on the Coordinator's reportPush, which dedupes on (intent, sha) — a
// fork maps 1:1 to an intent, so that is the (repo, after) key.
//
// Flow: parse the event -> keep branch pushes only (refs/notes/why,
// tags, deletes and `flare/*` session/lane branches skip) -> fork name
// -> intent (getIntentByFork) -> changed files between the intent's
// base (or the push's `before`) and `after` via a bounded tree diff ->
// compact to <= 200 footprint entries -> coordinator.reportPush.
import type { Db } from "./db";
import { getIntentByFork } from "./intents";
import { LIMITS, PUSHABLE_INTENT_STATES, type Intent } from "./intents-core";

export interface ForgePush {
  namespace: string;
  repo: string;
  ref: string;
  before: string;
  after: string;
}

const NAME_RE = /^[\w.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{4,64}$/i;
const ZERO_RE = /^0+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Accepts the event envelope ({type, source, payload}) or the same with
// the payload fields flattened next to `source` (workflow event payload
// shape varies by delivery path). Null for anything that is not a
// valid push of a branch to a still-existing ref.
export function parseForgePush(raw: unknown): ForgePush | null {
  if (!isRecord(raw)) return null;
  if (raw["type"] !== undefined && raw["type"] !== "cf.artifacts.repo.pushed") return null;
  const source = raw["source"];
  if (!isRecord(source)) return null;
  const body = isRecord(raw["payload"]) ? raw["payload"] : raw;
  const namespace = source["namespace"];
  const repo = source["repoName"];
  const ref = body["ref"];
  const before = body["before"];
  const after = body["after"];
  if (typeof namespace !== "string" || !NAME_RE.test(namespace)) return null;
  if (typeof repo !== "string" || !NAME_RE.test(repo)) return null;
  if (typeof ref !== "string" || ref.length > 300) return null;
  if (typeof before !== "string" || !(SHA_RE.test(before) || before === "")) return null;
  if (typeof after !== "string" || !SHA_RE.test(after) || ZERO_RE.test(after)) return null;
  return { namespace, repo, ref, before: before.toLowerCase(), after: after.toLowerCase() };
}

// Code pushes only: branches, minus Forge's own bookkeeping refs.
export function isCodeRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") && !ref.startsWith("refs/heads/flare/") && !ref.startsWith("refs/heads/forge/");
}

// ---------------------------------------------------------------------------
// Tree diff over the ARTIFACTS binding (readCommit + readTree)
// ---------------------------------------------------------------------------

export interface TreeEntryLike {
  name: string;
  mode: string;
  hash: string;
  type?: string;
}

export interface TreeReader {
  readCommit(hash: string): Promise<{ treeHash: string } | null>;
  readTree(hash: string): Promise<TreeEntryLike[] | null>;
}

export const DIFF_LIMITS = { treeReads: 400, files: 2000 } as const;

function isTree(e: TreeEntryLike): boolean {
  return e.type === "tree" || e.mode === "40000" || e.mode === "040000";
}

// Files whose blob differs between two commits. Unchanged subtrees are
// skipped by hash. A subtree that is added/removed wholesale is walked
// while the read budget lasts; past it, the directory path itself is
// recorded (a literal directory entry covers its subtree). Null when a
// commit cannot be read.
export async function changedFiles(
  reader: TreeReader,
  baseSha: string,
  headSha: string,
  limits: { treeReads: number; files: number } = DIFF_LIMITS,
): Promise<{ files: string[]; truncated: boolean } | null> {
  const [base, head] = await Promise.all([reader.readCommit(baseSha), reader.readCommit(headSha)]);
  if (!base || !head) return null;
  const files: string[] = [];
  let reads = 0;
  let truncated = false;
  const read = async (hash: string): Promise<TreeEntryLike[] | null> => {
    if (reads >= limits.treeReads) return null;
    reads++;
    return reader.readTree(hash);
  };
  const push = (path: string): boolean => {
    if (files.length >= limits.files) {
      truncated = true;
      return false;
    }
    files.push(path);
    return true;
  };
  // Every file under one side's subtree (added or removed directory).
  const walk = async (hash: string, prefix: string): Promise<void> => {
    const entries = await read(hash);
    if (!entries) {
      truncated = true;
      push(prefix);
      return;
    }
    for (const e of entries) {
      const p = `${prefix}/${e.name}`;
      if (isTree(e)) await walk(e.hash, p);
      else if (!push(p)) return;
    }
  };
  const diff = async (a: string | null, b: string | null, prefix: string): Promise<void> => {
    const [ea, eb] = await Promise.all([a ? read(a) : Promise.resolve([]), b ? read(b) : Promise.resolve([])]);
    if (ea === null || eb === null) {
      truncated = true;
      if (prefix) push(prefix);
      return;
    }
    const left = new Map(ea.map((e) => [e.name, e]));
    const right = new Map(eb.map((e) => [e.name, e]));
    const names = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const name of names) {
      if (files.length >= limits.files) {
        truncated = true;
        return;
      }
      const l = left.get(name);
      const r = right.get(name);
      if (l && r && l.hash === r.hash && l.mode === r.mode) continue;
      const p = prefix ? `${prefix}/${name}` : name;
      const lt = l ? isTree(l) : false;
      const rt = r ? isTree(r) : false;
      if (lt && rt && l && r) await diff(l.hash, r.hash, p);
      else if (lt || rt) {
        // Tree replaced by a blob (or vice versa), added, or removed.
        if ((l && !lt) || (r && !rt)) push(p);
        const tree = lt ? l : r;
        if (tree) await walk(tree.hash, p);
      } else push(p);
    }
  };
  await diff(base.treeHash, head.treeHash, "");
  return { files: [...new Set(files)].sort(), truncated };
}

// Collapse a file list to at most `max` entries by replacing the
// deepest paths with their parent directory until it fits (a literal
// directory covers its subtree, so coverage only grows).
export function compactPaths(paths: readonly string[], max: number = LIMITS.footprintEntries): string[] {
  let set = [...new Set(paths.filter((p) => p.length > 0))].sort();
  while (set.length > max) {
    const depth = Math.max(...set.map((p) => p.split("/").length));
    if (depth <= 1) return set.slice(0, max);
    const next = set.map((p) => {
      const segs = p.split("/");
      return segs.length === depth ? segs.slice(0, -1).join("/") : p;
    });
    // Drop entries now covered by a collapsed ancestor.
    const uniq = [...new Set(next)].sort();
    set = uniq.filter((p) => !uniq.some((q) => q !== p && p.startsWith(`${q}/`)));
  }
  return set;
}

// ---------------------------------------------------------------------------
// Reconcile one push
// ---------------------------------------------------------------------------

export interface ForgePushDeps {
  db: Db;
  namespace: string;
  // Opens a fork for reading (ARTIFACTS.get), disposed by the caller.
  openRepo: (name: string) => Promise<TreeReader & { [Symbol.dispose]?: () => void }>;
  // Coordinator reportPush for the intent's trunk repo.
  reportPush: (
    repo: string,
    intentId: string,
    input: { agent: string; headSha: string; actualFootprint: { paths: string[] }; source: "trigger" },
  ) => Promise<{ ok: true; duplicate: boolean; drift: string[] } | { ok: false; error: string; message: string }>;
}

export type ForgePushOutcome =
  | { status: "reported"; intentId: string; files: number; drift: number; duplicate: boolean; truncated: boolean }
  | {
      status: "skipped";
      reason: "invalid" | "other-namespace" | "not-code-ref" | "not-a-fork" | "not-pushable" | "no-base" | "unreadable" | "empty";
    }
  | { status: "failed"; error: string; message: string };

function baseFor(intent: Intent, push: ForgePush): { sha: string; cumulative: boolean } | null {
  if (intent.baseSha) return { sha: intent.baseSha, cumulative: true };
  if (push.before && !ZERO_RE.test(push.before)) return { sha: push.before, cumulative: false };
  return null;
}

export async function handleForgePush(deps: ForgePushDeps, raw: unknown): Promise<ForgePushOutcome> {
  const push = parseForgePush(raw);
  if (!push) return { status: "skipped", reason: "invalid" };
  if (deps.namespace && push.namespace !== deps.namespace) return { status: "skipped", reason: "other-namespace" };
  if (!isCodeRef(push.ref)) return { status: "skipped", reason: "not-code-ref" };
  const intent = await getIntentByFork(deps.db, push.repo);
  if (!intent) return { status: "skipped", reason: "not-a-fork" };
  if (!PUSHABLE_INTENT_STATES.includes(intent.state)) return { status: "skipped", reason: "not-pushable" };
  const base = baseFor(intent, push);
  if (!base) return { status: "skipped", reason: "no-base" };
  let handle: (TreeReader & { [Symbol.dispose]?: () => void }) | null = null;
  let diff: { files: string[]; truncated: boolean } | null = null;
  try {
    handle = await deps.openRepo(push.repo);
    diff = await changedFiles(handle, base.sha, push.after);
  } catch {
    diff = null;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal never fails the trigger.
    }
  }
  if (!diff) return { status: "skipped", reason: "unreadable" };
  // Incremental diffs (no recorded base) accumulate onto what we knew.
  const files = base.cumulative ? diff.files : [...(intent.actualFootprint?.paths ?? []), ...diff.files];
  const paths = compactPaths(files);
  if (!paths.length) return { status: "skipped", reason: "empty" };
  const res = await deps.reportPush(intent.repo, intent.id, {
    agent: intent.agent,
    headSha: push.after,
    actualFootprint: { paths },
    source: "trigger",
  });
  if (!res.ok) return { status: "failed", error: res.error, message: res.message };
  return {
    status: "reported",
    intentId: intent.id,
    files: paths.length,
    drift: res.drift.length,
    duplicate: res.duplicate,
    truncated: diff.truncated,
  };
}
