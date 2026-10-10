// Intent sessions (§2 A3, §3.1): every intent fork carries a
// `flare/session` branch with `plan.md` and an append-only `log.jsonl`
// of steps ({ts, kind, text}). Agents write it with the SDK helper
// (packages/runner-sdk/src/provenance.ts); the Worker only reads it
// (dashboard Why panel) and forks it (`fork_session`: a new agent
// continues from that exact context in its own repo).
//
// Runtime-free: the binding rides injected interfaces.
import type { Db } from "./db";
import { intentForkName, validateAgent } from "./intents-core";
import { appendForgeLedger, FORK_TOKEN_TTL_SECONDS, getIntent, type ForgeError } from "./intents";

export const SESSION_BRANCH = "flare/session";
export const SESSION_PLAN_PATH = "plan.md";
export const SESSION_LOG_PATH = "log.jsonl";
export const SESSION_STEP_KINDS = ["prompt", "reason", "tool", "decision", "note"] as const;
export type SessionStepKind = (typeof SESSION_STEP_KINDS)[number];
export const SESSION_STEP_MAX_TEXT = 4000;
export const SESSION_MAX_BYTES = 512 * 1024;
export const SESSION_PLAN_MAX_BYTES = 64 * 1024;
export const SESSION_DEFAULT_STEPS = 200;
export const SESSION_MAX_STEPS = 1000;

export interface SessionStep {
  ts: string;
  kind: SessionStepKind;
  text: string;
}

export function isSessionStepKind(v: unknown): v is SessionStepKind {
  return typeof v === "string" && (SESSION_STEP_KINDS as readonly string[]).includes(v);
}

// One JSONL line (no trailing newline). Stable key order; bounded text.
export function formatSessionStep(step: { ts?: string; kind: SessionStepKind; text: string }): string {
  const ts = step.ts && !Number.isNaN(Date.parse(step.ts)) ? step.ts : new Date().toISOString();
  return JSON.stringify({ ts, kind: step.kind, text: step.text.slice(0, SESSION_STEP_MAX_TEXT) });
}

// Parse log.jsonl leniently: malformed lines are counted, not fatal (a
// session is an agent's notebook; one bad line must not hide the rest).
// Keeps the last `limit` steps.
export function parseSessionLog(
  text: string,
  limit = SESSION_DEFAULT_STEPS,
): { steps: SessionStep[]; total: number; skipped: number } {
  const cap = Math.min(Math.max(limit, 1), SESSION_MAX_STEPS);
  const steps: SessionStep[] = [];
  let skipped = 0;
  let total = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    total++;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      const o = v as Record<string, unknown>;
      if (typeof o.ts !== "string" || !isSessionStepKind(o.kind) || typeof o.text !== "string") throw new Error("shape");
      steps.push({ ts: o.ts.slice(0, 40), kind: o.kind, text: o.text.slice(0, SESSION_STEP_MAX_TEXT) });
    } catch {
      skipped++;
    }
  }
  return { steps: steps.slice(-cap), total, skipped };
}

// ---------------------------------------------------------------------------
// Reader (dashboard)
// ---------------------------------------------------------------------------

export interface SessionRepoHandle {
  readFile(args: { ref: string; path: string }): Promise<{ readonly size: number; text(): Promise<string> } | null>;
  log(opts?: { ref?: string; limit?: number }): Promise<Array<{ hash: string; committedAt: number }>>;
  readonly [Symbol.dispose]?: () => void;
}

export interface SessionArtifacts {
  get(name: string): Promise<SessionRepoHandle>;
}

export interface SessionView {
  repo: string;
  branch: string;
  head: { sha: string; committedAt: number } | null;
  plan: string | null;
  planTruncated: boolean;
  steps: SessionStep[];
  totalSteps: number;
  skippedLines: number;
  logTruncated: boolean;
}

async function readBounded(
  handle: SessionRepoHandle,
  ref: string,
  path: string,
  max: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const blob = await handle.readFile({ ref, path }).catch(() => null);
  if (!blob) return null;
  if (blob.size > max * 4) return { text: "", truncated: true };
  const text = await blob.text();
  return text.length > max ? { text: text.slice(text.length - max), truncated: true } : { text, truncated: false };
}

// Null when the repo or the session branch does not exist.
export async function readSession(
  deps: { artifacts: SessionArtifacts },
  forkRepo: string,
  opts: { limit?: number } = {},
): Promise<SessionView | null> {
  let handle: SessionRepoHandle | null = null;
  try {
    handle = await deps.artifacts.get(forkRepo);
    const [tip] = await handle.log({ ref: SESSION_BRANCH, limit: 1 }).catch(() => []);
    if (!tip) return null;
    // Read by commit id so plan + log come from the same snapshot.
    const plan = await readBounded(handle, tip.hash, SESSION_PLAN_PATH, SESSION_PLAN_MAX_BYTES);
    const log = await readBounded(handle, tip.hash, SESSION_LOG_PATH, SESSION_MAX_BYTES);
    let parsed = { steps: [] as SessionStep[], total: 0, skipped: 0 };
    if (log) {
      // A tail-truncated log may start mid-line: drop the partial line.
      const text = log.truncated ? log.text.slice(log.text.indexOf("\n") + 1) : log.text;
      parsed = parseSessionLog(text, opts.limit ?? SESSION_DEFAULT_STEPS);
    }
    return {
      repo: forkRepo,
      branch: SESSION_BRANCH,
      head: { sha: tip.hash, committedAt: tip.committedAt },
      plan: plan?.text ?? null,
      planTruncated: plan?.truncated ?? false,
      steps: parsed.steps,
      totalSteps: parsed.total,
      skippedLines: parsed.skipped,
      logTruncated: log?.truncated ?? false,
    };
  } catch {
    return null;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail a read.
    }
  }
}

// ---------------------------------------------------------------------------
// fork_session
// ---------------------------------------------------------------------------

export interface SessionForkHandle {
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<{ name: string; remote: string; token?: string }>;
  readonly [Symbol.dispose]?: () => void;
}

export interface SessionTokenHandle {
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<{ plaintext: string; expiresAt?: string } | string>;
  revokeToken?(tokenOrId: string): Promise<boolean>;
  readonly [Symbol.dispose]?: () => void;
}

export interface ForkSessionArtifacts {
  get(name: string): Promise<SessionForkHandle & SessionTokenHandle>;
}

export interface ForkSessionDeps {
  db: Db;
  artifacts: ForkSessionArtifacts;
  // Injected for tests (fork name suffix).
  random?: () => string;
}

export interface ForkSessionResult {
  forkRepo: string;
  remote: string;
  token: string;
  tokenExpiresAt: string;
  sourceRepo: string;
  branch: string;
  intentId: string;
}

// `s-<intent short>-<agent>-<rand>`: unique per fork, valid Artifacts
// name (^[a-zA-Z0-9][a-zA-Z0-9._-]*$), ≤ 100 chars.
export function sessionForkName(intentId: string, agent: string, suffix: string): string {
  const base = intentForkName(intentId).slice(2);
  const slug = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "0";
  return `s-${base}-${slug}-${tail}`.slice(0, 100);
}

function dispose(h: { readonly [Symbol.dispose]?: () => void } | null): void {
  try {
    h?.[Symbol.dispose]?.();
  } catch {
    // Disposal must never fail the fork.
  }
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6);
}

// Fork an intent's fork (code + flare/session + notes: all branches) into
// a new repo the caller's agent owns, mint a 1 h fork-scoped write token
// (never a trunk token, invariant 1), and record `session.forked`.
// Awaits the fork (4-10 s measured, spike S3): the caller gets a usable
// remote on return. The fork's own 24 h creation token is revoked
// best-effort so only the 1 h token remains live.
export async function forkSession(
  deps: ForkSessionDeps,
  input: { intentId: string; agent: string },
): Promise<ForkSessionResult | ForgeError> {
  const a = validateAgent(input.agent);
  if (!a.ok) return { error: "invalid-agent", message: a.error };
  const intent = await getIntent(deps.db, input.intentId);
  if (!intent) return { error: "not-found", message: "intent not found" };
  if (!intent.forkRepo) return { error: "no-session", message: "intent has no fork yet (never claimed)" };
  const name = sessionForkName(intent.id, a.value, (deps.random ?? randomSuffix)());

  let source: (SessionForkHandle & SessionTokenHandle) | null = null;
  let remote = "";
  let creationToken = "";
  try {
    source = await deps.artifacts.get(intent.forkRepo);
    const forked = await source.fork(name, {
      defaultBranchOnly: false,
      description: `session fork of ${intent.forkRepo} for ${a.value}`.slice(0, 200),
    });
    remote = forked.remote;
    creationToken = typeof forked.token === "string" ? forked.token : "";
  } catch {
    return { error: "fork-failed", message: "could not fork the session" };
  } finally {
    dispose(source);
  }

  let token = "";
  let expiresAt = new Date(Date.now() + FORK_TOKEN_TTL_SECONDS * 1000).toISOString();
  let target: (SessionForkHandle & SessionTokenHandle) | null = null;
  try {
    target = await deps.artifacts.get(name);
    const out = await target.createToken("write", FORK_TOKEN_TTL_SECONDS);
    if (typeof out === "string") token = out;
    else {
      token = typeof out.plaintext === "string" ? out.plaintext : "";
      if (out.expiresAt) expiresAt = out.expiresAt;
    }
    if (token && creationToken && target.revokeToken) {
      await target.revokeToken(creationToken).catch(() => false);
    }
  } catch {
    token = "";
  } finally {
    dispose(target);
  }
  if (!token) return { error: "token-failed", message: "forked, but could not mint a write token" };

  await appendForgeLedger(deps.db, {
    repo: intent.repo,
    subjectKind: "intent",
    subjectId: intent.id,
    kind: "session.forked",
    body: `${a.value} forked ${intent.forkRepo} -> ${name}`,
    actor: a.value,
  });
  return {
    forkRepo: name,
    remote,
    token,
    tokenExpiresAt: expiresAt,
    sourceRepo: intent.forkRepo,
    branch: SESSION_BRANCH,
    intentId: intent.id,
  };
}
