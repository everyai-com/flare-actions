// Agent-side provenance helpers (Flare Forge, docs/FORGE.md
// "Provenance"): commit with Flare-* trailers, and append steps to the
// intent fork's `flare/session` branch (plan.md + log.jsonl) without
// touching the agent's working tree or index.
//
// Plain git CLI via child_process (like checkout.ts). Strip-types safe:
// no enums, no parameter properties, `.ts` relative imports only.
import { execFile } from "node:child_process";

export interface ProvenanceTrailers {
  goal: string;
  intent: string;
  agent: string;
  session: string;
}

// Must match apps/worker/src/intents-core.ts TRAILER_KEYS (the Worker
// parses what agents write; provenance.test.ts pins the parity).
export const TRAILER_KEYS = {
  goal: "Flare-Goal",
  intent: "Flare-Intent",
  agent: "Flare-Agent",
  session: "Flare-Session",
} as const;

export const SESSION_BRANCH = "flare/session";
export const SESSION_REF = "refs/heads/flare/session";
export const SESSION_PLAN_PATH = "plan.md";
export const SESSION_LOG_PATH = "log.jsonl";
export const SESSION_STEP_KINDS = ["prompt", "reason", "tool", "decision", "note"] as const;
export type SessionStepKind = (typeof SESSION_STEP_KINDS)[number];
export const SESSION_STEP_MAX_TEXT = 4000;

const GIT_TIMEOUT_MS = 60000;

function trailerValue(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
}

export function formatTrailers(t: Partial<ProvenanceTrailers>): string {
  const lines: string[] = [];
  for (const key of ["goal", "intent", "agent", "session"] as const) {
    const v = t[key];
    if (typeof v === "string" && trailerValue(v)) lines.push(`${TRAILER_KEYS[key]}: ${trailerValue(v)}`);
  }
  return lines.join("\n");
}

export function appendTrailers(message: string, t: Partial<ProvenanceTrailers>): string {
  const block = formatTrailers(t);
  if (!block) return message;
  return `${message.replace(/\s+$/, "")}\n\n${block}\n`;
}

// Trailers from FLARE_* env (set by `flare` CLI / MCP claim output):
// FLARE_GOAL, FLARE_INTENT, FLARE_AGENT, FLARE_SESSION.
export function trailersFromEnv(env: Record<string, string | undefined> = process.env): Partial<ProvenanceTrailers> {
  const out: Partial<ProvenanceTrailers> = {};
  if (env.FLARE_GOAL) out.goal = env.FLARE_GOAL;
  if (env.FLARE_INTENT) out.intent = env.FLARE_INTENT;
  if (env.FLARE_AGENT) out.agent = env.FLARE_AGENT;
  if (env.FLARE_SESSION) out.session = env.FLARE_SESSION;
  return out;
}

interface GitOut {
  stdout: string;
}

function git(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Remote URLs may embed tokens; scrub before surfacing.
          const detail = String(stderr || error.message)
            .replace(/\/\/[^@/\s]+@/g, "//[redacted]@")
            .replace(/art_v2_\S+/g, "art_v2_[redacted]")
            .slice(0, 500);
          reject(new Error(`git ${args[0]} failed: ${detail}`));
          return;
        }
        resolve({ stdout: String(stdout) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).stdout;
  } catch {
    return null;
  }
}

// Agents in fresh sandboxes often have no git identity; fall back to a
// labelled bot identity only when none is configured.
async function identityEnv(cwd: string, agent?: string): Promise<Record<string, string>> {
  const email = (await tryGit(cwd, ["config", "user.email"]))?.trim();
  if (email || process.env.GIT_AUTHOR_EMAIL) return {};
  const name = agent ? `flare-agent ${trailerValue(agent)}` : "flare-agent";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: "agent@flare.invalid",
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: "agent@flare.invalid",
  };
}

export interface CommitWithTrailersOptions {
  cwd: string;
  message: string;
  // Explicit values win over FLARE_* env.
  trailers?: Partial<ProvenanceTrailers>;
  // `git commit -a` (stage tracked modifications).
  all?: boolean;
  allowEmpty?: boolean;
}

// `git commit` with the Flare trailer block as the message's final
// paragraph. Returns the new commit sha.
export async function commitWithTrailers(opts: CommitWithTrailersOptions): Promise<{ sha: string; message: string }> {
  const trailers = { ...trailersFromEnv(), ...opts.trailers };
  const message = appendTrailers(opts.message, trailers);
  const args = ["commit", "-q", "--file=-"];
  if (opts.all) args.push("-a");
  if (opts.allowEmpty) args.push("--allow-empty");
  await git(opts.cwd, args, { input: message, env: await identityEnv(opts.cwd, trailers.agent) });
  const sha = (await git(opts.cwd, ["rev-parse", "HEAD"])).stdout.trim();
  return { sha, message };
}

export interface SessionStepInput {
  kind: SessionStepKind;
  text: string;
  ts?: string;
}

export function formatSessionStep(step: SessionStepInput): string {
  const ts = step.ts && !Number.isNaN(Date.parse(step.ts)) ? step.ts : new Date().toISOString();
  return JSON.stringify({ ts, kind: step.kind, text: step.text.slice(0, SESSION_STEP_MAX_TEXT) });
}

export interface SessionWriteOptions {
  cwd: string;
  // Push to this remote after committing (default: no push).
  push?: { remote?: string };
  agent?: string;
}

export interface SessionWriteResult {
  sha: string;
  pushed: boolean;
}

// The commit to build on (local branch first, else the remote-tracking
// copy) and the local ref's current value for the update-ref CAS.
async function sessionParent(
  cwd: string,
  remote: string | null,
): Promise<{ parent: string | null; localOld: string }> {
  const zero = "0".repeat(40);
  const local = (await tryGit(cwd, ["rev-parse", "--verify", "-q", `${SESSION_REF}^{commit}`]))?.trim();
  if (local) return { parent: local, localOld: local };
  if (remote) {
    const tracking = (
      await tryGit(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${SESSION_BRANCH}^{commit}`])
    )?.trim();
    if (tracking) return { parent: tracking, localOld: zero };
  }
  return { parent: null, localOld: zero };
}

// Rewrite plan.md and/or log.jsonl on flare/session as one commit, using
// plumbing only (hash-object, mktree, commit-tree, update-ref with CAS):
// the agent's checkout, index and HEAD are never touched.
async function updateSession(
  opts: SessionWriteOptions,
  edit: (current: { plan: string | null; log: string | null }) => { plan?: string; log?: string },
  message: string,
): Promise<SessionWriteResult> {
  const remote = opts.push ? opts.push.remote ?? "origin" : null;
  if (remote) {
    // Pick up a session that exists only remotely (e.g. a forked session).
    await tryGit(opts.cwd, ["fetch", "-q", remote, `+${SESSION_REF}:refs/remotes/${remote}/${SESSION_BRANCH}`]);
  }
  const { parent, localOld } = await sessionParent(opts.cwd, remote);
  const readAt = async (path: string): Promise<string | null> =>
    parent ? await tryGit(opts.cwd, ["show", `${parent}:${path}`]) : null;
  const current = { plan: await readAt(SESSION_PLAN_PATH), log: await readAt(SESSION_LOG_PATH) };
  const next = edit(current);

  // Start from the parent's tree so unrelated files survive.
  const entries = new Map<string, string>();
  if (parent) {
    const listing = (await git(opts.cwd, ["ls-tree", parent])).stdout;
    for (const line of listing.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) entries.set(line.slice(tab + 1), line.slice(0, tab));
    }
  }
  for (const [path, text] of [
    [SESSION_PLAN_PATH, next.plan],
    [SESSION_LOG_PATH, next.log],
  ] as const) {
    if (text === undefined) continue;
    const oid = (await git(opts.cwd, ["hash-object", "-w", "--stdin"], { input: text })).stdout.trim();
    entries.set(path, `100644 blob ${oid}`);
  }
  const mktree = [...entries.entries()].map(([path, meta]) => `${meta}\t${path}`).join("\n") + "\n";
  const tree = (await git(opts.cwd, ["mktree"], { input: mktree })).stdout.trim();
  const commitArgs = ["commit-tree", tree, "-F", "-"];
  if (parent) commitArgs.push("-p", parent);
  const sha = (await git(opts.cwd, commitArgs, { input: message, env: await identityEnv(opts.cwd, opts.agent) })).stdout.trim();
  // Compare-and-swap: a concurrent local writer makes this fail loudly.
  await git(opts.cwd, ["update-ref", SESSION_REF, sha, localOld]);
  let pushed = false;
  if (remote) {
    await git(opts.cwd, ["push", "-q", remote, `${SESSION_REF}:${SESSION_REF}`]);
    pushed = true;
  }
  return { sha, pushed };
}

// Append one step to log.jsonl (append-only: existing lines are kept
// byte-for-byte; a missing trailing newline is repaired).
export async function appendSessionStep(opts: SessionWriteOptions & { step: SessionStepInput }): Promise<SessionWriteResult> {
  if (!(SESSION_STEP_KINDS as readonly string[]).includes(opts.step.kind)) {
    throw new Error(`unknown session step kind: ${String(opts.step.kind)}`);
  }
  const line = formatSessionStep(opts.step);
  return updateSession(
    opts,
    (cur) => {
      const prev = cur.log ?? "";
      const sep = prev && !prev.endsWith("\n") ? "\n" : "";
      return { log: `${prev}${sep}${line}\n` };
    },
    `session: ${opts.step.kind}\n`,
  );
}

// Replace plan.md (the plan is a living document; history keeps every
// revision on the branch).
export async function writeSessionPlan(opts: SessionWriteOptions & { plan: string }): Promise<SessionWriteResult> {
  return updateSession(opts, () => ({ plan: opts.plan.endsWith("\n") ? opts.plan : `${opts.plan}\n` }), "session: plan\n");
}
