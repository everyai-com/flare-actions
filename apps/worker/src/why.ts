// `flare why file:line` (§3.1 Why record, §9 Q4): bounded blame over
// the Artifacts binding, then the provenance chain
//   commit -> trailers -> why note -> intent -> goal -> ledger
//   -> conflicts / alternatives (incl. tournaments) -> CI evidence
//   -> train + review policy -> session
// with graceful degradation at every hop: a commit without trailers or
// a note reads as "human or pre-forge", a missing D1 row falls back to
// the note, and any failed hop becomes a warning, never a 500.
//
// Runtime-free: the binding and D1 ride injected interfaces.
import { type Db, getRun } from "./db";
import {
  parseTrailers,
  type ProvenanceTrailers,
  type RiskTerm,
  type WhyNote,
} from "./intents-core";
import { getGoal, getIntent, getTrain, listForgeLedger, type ForgeLedgerRow } from "./intents";
import { createWhyNoteReader, latestNotesTip, type WhyNoteBlob, type WhyStorage } from "./provenance";
import { normalizeRepoPath, validateRef, type ReposCommit } from "./repos";
import { SESSION_BRANCH } from "./session";

export const BLAME_MAX_COMMITS = 50;
export const BLAME_MAX_BYTES = 256 * 1024;
// Myers trace memory is ~D² ints; 2000 edits ≈ 16 MB worst case.
export const DIFF_MAX_EDITS = 2000;
const MAX_LINE = 1_000_000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------------------------------------------------------------------------
// Line diff (Myers O(ND), bounded)
// ---------------------------------------------------------------------------

// Map each line of `b` to its matching line in `a` (LCS alignment), or
// -1 when the line is new in `b`. Null when the edit distance exceeds
// `maxEdits` (callers treat that as "changed here, approximately").
export function diffLineMap(a: readonly string[], b: readonly string[], maxEdits = DIFF_MAX_EDITS): Int32Array | null {
  const map = new Int32Array(b.length).fill(-1);
  const ids = new Map<string, number>();
  const id = (s: string): number => {
    let v = ids.get(s);
    if (v === undefined) {
      v = ids.size;
      ids.set(s, v);
    }
    return v;
  };
  const A = Int32Array.from(a, id);
  const B = Int32Array.from(b, id);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) {
    map[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) {
    map[B.length - 1 - suf] = A.length - 1 - suf;
    suf++;
  }
  const x0 = pre;
  const n = A.length - pre - suf;
  const m = B.length - pre - suf;
  if (n === 0 || m === 0) return map;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    // Snapshot v over k ∈ [-(d+1), d+1] (what step d reads).
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x0 + x] === B[x0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snap = trace[d];
    const at = (k: number): number => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      map[x0 + y - 1] = x0 + x - 1;
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    map[x0 + y - 1] = x0 + x - 1;
    x--;
    y--;
  }
  return map;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Bounded blame
// ---------------------------------------------------------------------------

export interface BlameRepo {
  // First-parent history, newest first (the binding's documented order).
  log(opts?: { ref?: string; limit?: number }): Promise<ReposCommit[]>;
  readCommit(hash: string): Promise<ReposCommit | null>;
  readFile(args: { ref: string; path: string }): Promise<WhyNoteBlob | null>;
}

export interface BlameResult {
  sha: string;
  author: { name: string; email: string };
  message: string;
  committedAt: number;
  // 1-based line number of the content in `sha`.
  line: number;
  text: string;
  tip: string;
  // The first-parent (trunk) merge commit the line landed through, when
  // the introducing commit sits on a merged side branch.
  landedVia: string | null;
  depth: number;
  truncated: boolean;
  approximate: boolean;
}

export type BlameErrorCode = "ref-not-found" | "path-not-found" | "too-large" | "binary" | "line-out-of-range" | "invalid-input";
export interface BlameError {
  error: BlameErrorCode;
  message: string;
}

export function isBlameError(v: unknown): v is BlameError {
  return typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string";
}

type FileRead = { kind: "ok"; text: string; lines: string[] } | { kind: "absent" } | { kind: "too-large" } | { kind: "binary" };

// Find the newest commit that introduced the current content of
// `line` in `path` at `ref`: walk first-parent history (≤ maxCommits
// commits), tracking the line's index through each parent diff. When a
// first-parent step loses the line at a merge, the walk dives into the
// merged side (the agent's commit carries the trailers); the trunk
// merge is reported as `landedVia`.
export async function blameLine(
  repo: BlameRepo,
  input: { ref: string; path: string; line: number; maxCommits?: number; maxBytes?: number; maxEdits?: number },
): Promise<BlameResult | BlameError> {
  const maxCommits = Math.min(Math.max(input.maxCommits ?? BLAME_MAX_COMMITS, 1), BLAME_MAX_COMMITS);
  const maxBytes = Math.min(input.maxBytes ?? BLAME_MAX_BYTES, BLAME_MAX_BYTES);
  if (!Number.isInteger(input.line) || input.line < 1 || input.line > MAX_LINE) {
    return { error: "invalid-input", message: "line must be a positive integer" };
  }
  const history = await repo.log({ ref: input.ref, limit: maxCommits });
  const tip = history[0];
  if (!tip) return { error: "ref-not-found", message: `ref ${input.ref} not found` };
  const commits = new Map<string, ReposCommit>(history.map((c) => [c.hash, c]));
  const files = new Map<string, FileRead>();

  const commitOf = async (hash: string): Promise<ReposCommit | null> => {
    const known = commits.get(hash);
    if (known) return known;
    const c = await repo.readCommit(hash);
    if (c) commits.set(hash, c);
    return c;
  };
  const fileAt = async (hash: string): Promise<FileRead> => {
    const cached = files.get(hash);
    if (cached) return cached;
    let out: FileRead;
    const blob = await repo.readFile({ ref: hash, path: input.path }).catch(() => null);
    if (!blob) out = { kind: "absent" };
    else if (blob.size > maxBytes) out = { kind: "too-large" };
    else {
      const text = await blob.text();
      if (text.length > maxBytes) out = { kind: "too-large" };
      else if (text.includes("\0")) out = { kind: "binary" };
      else out = { kind: "ok", text, lines: splitLines(text) };
    }
    files.set(hash, out);
    return out;
  };

  const head = await fileAt(tip.hash);
  if (head.kind === "absent") return { error: "path-not-found", message: `${input.path} not found at ${input.ref}` };
  if (head.kind === "too-large") return { error: "too-large", message: `file exceeds ${maxBytes} bytes` };
  if (head.kind === "binary") return { error: "binary", message: "binary file" };
  if (input.line > head.lines.length) {
    return { error: "line-out-of-range", message: `${input.path} has ${head.lines.length} lines` };
  }
  const text = head.lines[input.line - 1];

  let cur = tip;
  let curFile = head;
  let idx = input.line - 1;
  let depth = 1;
  let landedVia: string | null = null;
  let truncated = false;
  let approximate = false;

  // Where does line `idx` of `curFile` live in `parent`? -1 = not there.
  const traceInto = async (parent: string): Promise<{ idx: number; file: FileRead & { kind: "ok" } } | null> => {
    const pf = await fileAt(parent);
    if (pf.kind !== "ok") return null;
    if (pf.text === curFile.text) return { idx, file: pf };
    const map = diffLineMap(pf.lines, curFile.lines, input.maxEdits ?? DIFF_MAX_EDITS);
    if (!map) {
      approximate = true;
      return null;
    }
    const at = map[idx];
    return at >= 0 ? { idx: at, file: pf } : null;
  };

  for (;;) {
    if (cur.parents.length === 0) break;
    if (depth >= maxCommits) {
      truncated = true;
      break;
    }
    let moved = false;
    for (let p = 0; p < cur.parents.length; p++) {
      const hit = await traceInto(cur.parents[p]);
      if (!hit) continue;
      const next = await commitOf(cur.parents[p]);
      if (!next) break;
      if (p > 0 && landedVia === null) landedVia = cur.hash;
      cur = next;
      curFile = hit.file;
      idx = hit.idx;
      depth++;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return {
    sha: cur.hash,
    author: { name: cur.author.name, email: cur.author.email },
    message: cur.message,
    committedAt: cur.committedAt,
    line: idx + 1,
    text,
    tip: tip.hash,
    landedVia,
    depth,
    truncated,
    approximate,
  };
}

// ---------------------------------------------------------------------------
// Why chain
// ---------------------------------------------------------------------------

export interface WhyRepoHandle extends BlameRepo {
  readonly [Symbol.dispose]?: () => void;
}

export interface WhyArtifacts {
  get(name: string): Promise<WhyRepoHandle>;
}

export interface WhyDeps {
  db: Db;
  artifacts: WhyArtifacts;
  // Where to look for why notes; "auto" = notes, then flare/why.
  storage?: WhyStorage | "auto";
  maxCommits?: number;
}

export interface WhyInput {
  repo: string;
  path: string;
  line: number;
  ref?: string;
}

export interface WhyLedgerEntry {
  kind: string;
  body: string;
  actor: string;
  at: string;
}

export interface WhyAlternative {
  source: "note" | "ledger" | "tournament";
  text: string;
  agent?: string;
  runId?: string | null;
}

export interface WhyConflict {
  id: string;
  withIntent: string;
  files: string[];
  state: string;
  resolverAgent: string | null;
  resolutionSha: string | null;
  decision: string | null;
}

export interface WhyChain {
  repo: string;
  path: string;
  line: number;
  ref: string;
  // Set when the line could not be traced (stream B maps to 4xx).
  error: { code: string; message: string } | null;
  // forge = trailers or a note; human = neither (human or pre-forge).
  origin: "forge" | "human" | "unknown";
  commit: {
    sha: string;
    author: { name: string; email: string };
    committedAt: number;
    subject: string;
    message: string;
    lineText: string;
    lineInCommit: number;
    landedVia: string | null;
    depth: number;
    truncated: boolean;
    approximate: boolean;
  } | null;
  trailers: Partial<ProvenanceTrailers> | null;
  note: WhyNote | null;
  noteSource: WhyStorage | null;
  noteSha: string | null;
  goal: { id: string; text: string; state: string | null } | null;
  intent: {
    id: string;
    title: string;
    reasoning: string;
    accept: string;
    agent: string;
    state: string | null;
    risk: number | null;
    riskTerms: RiskTerm[];
    forkRepo: string | null;
    trainId: string | null;
    landedSha: string | null;
    planApprovedBy: string | null;
  } | null;
  decisions: WhyLedgerEntry[];
  alternatives: WhyAlternative[];
  conflicts: WhyConflict[];
  review: { decision: string; by: string; policy: string; source: "note" | "ledger" } | null;
  evidence: { runId: string; sha: string; status: string; source: "note" | "train" } | null;
  train: { id: string; state: string; lane: number; runId: string | null; headSha: string } | null;
  session: { repo: string; branch: string } | null;
  timeline: WhyLedgerEntry[];
  narrative: string;
  warnings: string[];
}

const DECISION_KIND = /^(decision|decided|chose|choice|plan)/i;
const ALTERNATIVE_KIND = /^(alternative|rejected)/i;
const REVIEW_KIND = /^(review|routed|route|audit|approved|plan_approved|landed|land)/i;
const TOURNAMENT_KIND = /^(tournament|race)/i;

function entry(r: ForgeLedgerRow): WhyLedgerEntry {
  return { kind: r.kind, body: r.body, actor: r.actor, at: r.created_at };
}

function emptyChain(input: { repo: string; path: string; line: number; ref: string }): WhyChain {
  return {
    ...input,
    error: null,
    origin: "unknown",
    commit: null,
    trailers: null,
    note: null,
    noteSource: null,
    noteSha: null,
    goal: null,
    intent: null,
    decisions: [],
    alternatives: [],
    conflicts: [],
    review: null,
    evidence: null,
    train: null,
    session: null,
    timeline: [],
    narrative: "",
    warnings: [],
  };
}

function short(v: string, n = 8): string {
  return v.slice(0, n);
}

function clip(v: string, n: number): string {
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Human narrative: one paragraph, every clause backed by a chain field.
export function narrateWhy(c: WhyChain): string {
  if (c.error) return `Could not trace ${c.path}:${c.line} at ${c.ref}: ${c.error.message}.`;
  if (!c.commit) return `No commit found for ${c.path}:${c.line}.`;
  const at = `${c.path}:${c.line}`;
  const commitRef = `${short(c.commit.sha, 7)} ("${clip(c.commit.subject, 80)}")`;
  if (c.origin !== "forge") {
    return (
      `${at} was last changed in ${commitRef} by ${c.commit.author.name || "unknown"}. ` +
      "That commit carries no Flare trailers and no why note: a human or pre-forge commit."
    );
  }
  const parts: string[] = [];
  const title = c.intent?.title ?? c.note?.intent.title ?? "an untitled intent";
  if (c.goal) parts.push(`This line exists because of the goal "${clip(c.goal.text, 200)}".`);
  else parts.push(`This line exists because of intent "${clip(title, 120)}".`);
  const agent = c.intent?.agent || c.note?.agent || c.trailers?.agent || "an agent";
  const reasoning = c.intent?.reasoning || c.note?.intent.reasoning || "";
  parts.push(`${agent} took intent "${clip(title, 120)}"${reasoning ? ` because ${clip(reasoning, 240)}` : ""}.`);
  const chose = c.decisions.filter((d) => DECISION_KIND.test(d.kind)).map((d) => clip(d.body, 160)).filter(Boolean);
  if (chose.length) parts.push(`Decided: ${chose.slice(0, 3).join("; ")}.`);
  if (c.alternatives.length) {
    parts.push(`Rejected: ${c.alternatives.slice(0, 3).map((a) => clip(a.text, 120)).join("; ")}.`);
  }
  for (const cf of c.conflicts.slice(0, 2)) {
    if (cf.decision) parts.push(`Resolved a conflict with intent ${short(cf.withIntent)}: ${clip(cf.decision, 160)}.`);
    else parts.push(`Conflicted with intent ${short(cf.withIntent)} (${cf.state}).`);
  }
  if (c.evidence) {
    parts.push(`Verified by run ${short(c.evidence.runId)} (${c.evidence.status}) on ${short(c.evidence.sha, 7)}.`);
  }
  if (c.train || c.review) {
    const train = c.train ? `train ${short(c.train.id)}` : "a train";
    const policy = c.review ? ` under policy ${c.review.decision}${c.review.policy ? ` (${clip(c.review.policy, 80)})` : ""}` : "";
    parts.push(`Landed by ${train}${policy}.`);
  }
  if (c.session) parts.push(`Session: ${c.session.repo} (${c.session.branch}).`);
  return parts.join(" ");
}

async function tournamentAlternatives(db: Db, tournamentId: string): Promise<WhyAlternative[]> {
  const verdict = await db
    .prepare("SELECT rationale FROM verdicts WHERE tournament_id = ?")
    .bind(tournamentId)
    .first<{ rationale: string }>();
  const rows = await db
    .prepare(
      "SELECT agent, run_id, verdict_rank FROM attempts WHERE tournament_id = ? AND (verdict_rank IS NULL OR verdict_rank > 1) ORDER BY verdict_rank ASC LIMIT 5",
    )
    .bind(tournamentId)
    .all<{ agent: string; run_id: string | null; verdict_rank: number | null }>();
  const why = verdict?.rationale ? `: ${clip(verdict.rationale, 200)}` : "";
  return rows.results.map((r) => ({
    source: "tournament" as const,
    agent: r.agent,
    runId: r.run_id,
    text: `${r.agent}'s attempt ranked ${r.verdict_rank ?? "unranked"} in tournament ${short(tournamentId)}${why}`,
  }));
}

// The WhyPort read: blame + chain assembly. Never throws for a missing
// hop; the outer try only guards the binding itself.
export async function why(deps: WhyDeps, input: WhyInput): Promise<WhyChain> {
  const ref = validateRef(input.ref, "main") ?? "";
  const path = normalizeRepoPath(input.path) ?? "";
  const chain = emptyChain({ repo: input.repo, path, line: input.line, ref });
  if (!ref || !path || !Number.isInteger(input.line) || input.line < 1 || input.line > MAX_LINE) {
    chain.error = { code: "invalid-input", message: "repo, path, positive line and a valid ref are required" };
    chain.narrative = narrateWhy(chain);
    return chain;
  }
  const warn = (hop: string, err: unknown): void => {
    chain.warnings.push(`${hop}: ${clip(String(err instanceof Error ? err.message : err), 200)}`);
  };

  let handle: WhyRepoHandle | null = null;
  try {
    handle = await deps.artifacts.get(input.repo);
    const blamed = await blameLine(handle, { ref, path, line: input.line, maxCommits: deps.maxCommits });
    if (isBlameError(blamed)) {
      chain.error = { code: blamed.error, message: blamed.message };
      chain.narrative = narrateWhy(chain);
      return chain;
    }
    chain.commit = {
      sha: blamed.sha,
      author: blamed.author,
      committedAt: blamed.committedAt,
      subject: blamed.message.split("\n", 1)[0] ?? "",
      message: blamed.message.slice(0, 4000),
      lineText: blamed.text.slice(0, 1000),
      lineInCommit: blamed.line,
      landedVia: blamed.landedVia,
      depth: blamed.depth,
      truncated: blamed.truncated,
      approximate: blamed.approximate,
    };
    if (blamed.truncated) chain.warnings.push(`blame: stopped after ${blamed.depth} commits; the line may be older`);
    if (blamed.approximate) chain.warnings.push("blame: a diff exceeded the edit budget; attribution is approximate");
    chain.trailers = parseTrailers(blamed.message);

    // Note: on the introducing commit first, then the trunk merge.
    let knownTip: string | null = null;
    try {
      knownTip = await latestNotesTip(deps.db, input.repo);
    } catch (err) {
      warn("notes tip", err);
    }
    const reader = createWhyNoteReader(handle, deps.storage ?? "auto", knownTip);
    for (const sha of [blamed.sha, blamed.landedVia]) {
      if (!sha || chain.note) continue;
      try {
        const hit = await reader.read(sha);
        if (hit) {
          chain.note = hit.note;
          chain.noteSource = hit.source;
          chain.noteSha = sha;
        }
      } catch (err) {
        warn("note", err);
      }
    }
  } catch (err) {
    chain.error = { code: "artifacts-unavailable", message: clip(String(err instanceof Error ? err.message : err), 200) };
    chain.narrative = narrateWhy(chain);
    return chain;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail a read.
    }
  }

  const note = chain.note;
  const intentId = chain.trailers?.intent ?? note?.intent.id ?? null;
  chain.origin = intentId ? "forge" : "human";
  if (!intentId) {
    chain.narrative = narrateWhy(chain);
    return chain;
  }

  // Intent (D1 first; the note is the durable fallback). Trailers are
  // plain commit text anyone can write, so every D1 row they point at
  // must belong to THIS repo: a cross-repo intent/goal/ledger/train is
  // dropped with a warning, never shown as this line's provenance.
  let rowGoalId: string | null = null;
  let foreign = false;
  try {
    const row = await getIntent(deps.db, intentId);
    if (row && row.repo !== input.repo) {
      foreign = true;
      chain.warnings.push(`intent ${intentId} belongs to another repo; its intent, goal, ledger and conflicts were not used`);
    } else if (row) {
      rowGoalId = row.goalId;
      chain.intent = {
        id: row.id,
        title: row.title,
        reasoning: row.reasoning,
        accept: row.accept,
        agent: row.agent,
        state: row.state,
        risk: row.risk,
        riskTerms: row.riskTerms,
        forkRepo: row.forkRepo,
        trainId: row.trainId,
        landedSha: row.landedSha,
        planApprovedBy: row.planApprovedBy,
      };
    }
  } catch (err) {
    warn("intent", err);
  }
  if (!chain.intent && note) {
    chain.intent = {
      id: note.intent.id,
      title: note.intent.title,
      reasoning: note.intent.reasoning,
      accept: note.intent.accept,
      agent: note.agent,
      state: null,
      risk: null,
      riskTerms: [],
      forkRepo: note.session_repo || null,
      trainId: note.train_id || null,
      landedSha: null,
      planApprovedBy: null,
    };
  }
  if (!chain.intent && !foreign) chain.warnings.push(`intent ${intentId} not found in D1 and no why note`);

  // Goal.
  const goalId = rowGoalId ?? chain.trailers?.goal ?? note?.goal?.id ?? null;
  if (goalId) {
    try {
      const g = await getGoal(deps.db, goalId);
      if (g && g.repo !== input.repo) chain.warnings.push(`goal ${goalId} belongs to another repo; ignored`);
      else if (g) chain.goal = { id: g.id, text: g.text, state: g.state };
    } catch (err) {
      warn("goal", err);
    }
  }
  if (!chain.goal && note?.goal) chain.goal = { id: note.goal.id, text: note.goal.text, state: null };

  // Ledger: decisions, alternatives, review, tournaments.
  const tournamentIds = new Set<string>();
  try {
    const rows = foreign ? [] : (await listForgeLedger(deps.db, "intent", intentId, 100)).filter((r) => r.repo === input.repo);
    chain.timeline = rows.map(entry);
    for (const r of rows) {
      if (DECISION_KIND.test(r.kind)) chain.decisions.push(entry(r));
      if (ALTERNATIVE_KIND.test(r.kind) && r.body) chain.alternatives.push({ source: "ledger", text: r.body, agent: r.actor || undefined });
      if (REVIEW_KIND.test(r.kind) && !chain.review && r.kind !== "plan_approved") {
        chain.review = { decision: r.kind, by: r.actor, policy: r.body, source: "ledger" };
      }
      if (TOURNAMENT_KIND.test(r.kind)) {
        const m = UUID_RE.exec(r.body);
        if (m) tournamentIds.add(m[0].toLowerCase());
      }
    }
  } catch (err) {
    warn("ledger", err);
  }
  for (const alt of note?.alternatives_rejected ?? []) {
    if (!chain.alternatives.some((a) => a.text === alt)) chain.alternatives.push({ source: "note", text: alt });
  }
  if (note) chain.review = { ...note.review, source: "note" };

  // Conflicts this intent was part of (+ the note's decisions).
  try {
    const res = await deps.db
      .prepare(
        "SELECT id, intent_a, intent_b, files_json, state, resolver_agent, resolution_sha FROM conflicts WHERE repo = ? AND (intent_a = ? OR intent_b = ?) ORDER BY created_at ASC LIMIT 20",
      )
      .bind(foreign ? "" : input.repo, intentId, intentId)
      .all<{
        id: string;
        intent_a: string;
        intent_b: string;
        files_json: string;
        state: string;
        resolver_agent: string | null;
        resolution_sha: string | null;
      }>();
    for (const r of res.results) {
      let files: string[] = [];
      try {
        const parsed: unknown = JSON.parse(r.files_json);
        if (Array.isArray(parsed)) files = parsed.filter((f): f is string => typeof f === "string").slice(0, 20);
      } catch {
        files = [];
      }
      const decision = note?.conflict_decisions.find((d) => d.conflict_id === r.id)?.decision ?? null;
      chain.conflicts.push({
        id: r.id,
        withIntent: r.intent_a === intentId ? r.intent_b : r.intent_a,
        files,
        state: r.state,
        resolverAgent: r.resolver_agent,
        resolutionSha: r.resolution_sha,
        decision,
      });
      try {
        for (const l of await listForgeLedger(deps.db, "conflict", r.id, 50)) {
          if (l.repo !== input.repo) continue;
          if (TOURNAMENT_KIND.test(l.kind)) {
            const m = UUID_RE.exec(l.body);
            if (m) tournamentIds.add(m[0].toLowerCase());
          }
        }
      } catch (err) {
        warn("conflict ledger", err);
      }
    }
  } catch (err) {
    warn("conflicts", err);
  }
  for (const d of note?.conflict_decisions ?? []) {
    if (!chain.conflicts.some((c) => c.id === d.conflict_id)) {
      chain.conflicts.push({
        id: d.conflict_id,
        withIntent: d.with_intent,
        files: [],
        state: "resolved",
        resolverAgent: null,
        resolutionSha: null,
        decision: d.decision,
      });
    }
  }
  for (const tid of [...tournamentIds].slice(0, 3)) {
    try {
      chain.alternatives.push(...(await tournamentAlternatives(deps.db, tid)));
    } catch (err) {
      warn("tournament", err);
    }
  }

  // Train + evidence.
  const trainId = chain.intent?.trainId ?? note?.train_id ?? null;
  if (trainId) {
    try {
      const t = await getTrain(deps.db, trainId);
      if (t && t.repo !== input.repo) chain.warnings.push(`train ${trainId} belongs to another repo; ignored`);
      else if (t) chain.train = { id: t.id, state: t.state, lane: t.lane, runId: t.runId, headSha: t.headSha };
      if (!chain.review && (!t || t.repo === input.repo)) {
        const landed = (await listForgeLedger(deps.db, "train", trainId, 50)).find((r) => r.repo === input.repo && REVIEW_KIND.test(r.kind));
        if (landed) chain.review = { decision: landed.kind, by: landed.actor, policy: landed.body, source: "ledger" };
      }
    } catch (err) {
      warn("train", err);
    }
  }
  const evidenceRun = note?.evidence.run_id || chain.train?.runId || null;
  if (evidenceRun) {
    const source = note?.evidence.run_id ? "note" : "train";
    try {
      const run = await getRun(deps.db, evidenceRun);
      if (run) chain.evidence = { runId: run.id, sha: run.sha, status: run.status, source };
    } catch (err) {
      warn("evidence", err);
    }
    if (!chain.evidence && note) {
      chain.evidence = { runId: note.evidence.run_id, sha: note.evidence.sha, status: note.evidence.status, source: "note" };
    }
  }

  const sessionRepo = note?.session_repo || chain.trailers?.session || chain.intent?.forkRepo || null;
  if (sessionRepo) chain.session = { repo: sessionRepo, branch: SESSION_BRANCH };
  if (!note) chain.warnings.push("no why note on this commit (not landed by a train yet, or written before notes)");

  chain.narrative = narrateWhy(chain);
  return chain;
}
