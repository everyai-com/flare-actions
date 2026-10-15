// Guided setup for the dashboard Home screen: which of the few steps
// between "deployed" and "my tests ran green" are done, plus the repos
// the GitHub App can see (so "Run my tests" is a pick-list, not a typed
// owner/repo). `setupSteps` is pure; `loadSetup` reads D1 and makes at
// most a handful of bounded, best-effort GitHub calls — any GitHub
// failure degrades to `repos: null`, never a 5xx.
import { repoAllowSql, type Db } from "./db";
import { mintAppJwt } from "./github";
import { reposAllow } from "./tokens";

export const SETUP_MAX_INSTALLS = 5;
export const SETUP_MAX_REPOS = 100;
// A queued job older than this with nothing picking it up means "no
// computer is running your tests" — the most common silent stall.
export const SETUP_WAITING_MS = 90_000;

export interface SetupRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface SetupRun {
  id: string;
  repo: string;
  branch: string;
  status: string;
  createdAt: string;
}

export interface SetupFacts {
  githubConnected: boolean;
  repos: SetupRepo[] | null; // null = unknown (no App creds or GitHub unreachable)
  webhookSeen: boolean;
  runs: number;
  passed: number;
  latest: SetupRun | null;
  // Oldest still-queued job's age, when one exists.
  queuedForMs: number | null;
  executorSeen: boolean;
}

export type SetupStepId = "account" | "github" | "repos" | "first_run" | "green";

export interface SetupStep {
  id: SetupStepId;
  done: boolean;
}

export interface SetupState {
  steps: SetupStep[];
  done: number;
  total: number;
  complete: boolean;
  // The first unfinished step (what the big button should do).
  next: SetupStepId | null;
  // Jobs are queued but nothing has picked them up for a while.
  waitingForComputer: boolean;
}

export function setupSteps(f: SetupFacts): SetupState {
  const reposKnown = f.repos !== null && f.repos.length > 0;
  const steps: SetupStep[] = [
    { id: "account", done: true },
    { id: "github", done: f.githubConnected },
    { id: "repos", done: reposKnown || f.webhookSeen || f.runs > 0 },
    { id: "first_run", done: f.runs > 0 },
    { id: "green", done: f.passed > 0 },
  ];
  // Monotone: a later step done implies the earlier ones are too (an
  // env-managed App with no D1 creds still runs pushes, for example).
  for (let i = steps.length - 2; i >= 0; i--) if (steps[i + 1].done) steps[i].done = true;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id ?? null;
  return {
    steps,
    done,
    total: steps.length,
    complete: next === null,
    next,
    waitingForComputer: f.queuedForMs !== null && f.queuedForMs >= SETUP_WAITING_MS,
  };
}

interface GhInstallation {
  id?: number;
}
interface GhRepo {
  full_name?: string;
  default_branch?: string;
  private?: boolean;
  archived?: boolean;
}

async function ghJson<T>(url: string, token: string, signal: AbortSignal, method: "GET" | "POST" = "GET"): Promise<T | null> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "flare-actions" },
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

// Installation token minting under the same abort signal as every other
// call here (github.ts's getInstallationToken takes no signal), so one
// slow token POST cannot outlive the setup deadline.
async function installationToken(jwt: string, installationId: number, signal: AbortSignal): Promise<string | null> {
  const data = await ghJson<{ token?: unknown }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    signal,
    "POST",
  );
  return typeof data?.token === "string" && data.token ? data.token : null;
}

// Repos the App is installed on (newest installs first, bounded). One
// deadline covers every GitHub call, token minting included.
export async function listAppRepos(creds: { appId: string; privateKey: string }, timeoutMs = 5000): Promise<SetupRepo[] | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const jwt = await mintAppJwt(creds.appId, creds.privateKey);
    const installs = await ghJson<GhInstallation[]>(`https://api.github.com/app/installations?per_page=${SETUP_MAX_INSTALLS}`, jwt, ctl.signal);
    if (!installs) return null;
    const out: SetupRepo[] = [];
    for (const inst of installs.slice(0, SETUP_MAX_INSTALLS)) {
      if (typeof inst.id !== "number") continue;
      const tok = await installationToken(jwt, inst.id, ctl.signal);
      if (!tok) continue;
      const page = await ghJson<{ repositories?: GhRepo[] }>("https://api.github.com/installation/repositories?per_page=100", tok, ctl.signal);
      for (const r of page?.repositories ?? []) {
        if (!r.full_name || r.archived) continue;
        out.push({ fullName: r.full_name, defaultBranch: r.default_branch || "main", private: r.private === true });
        if (out.length >= SETUP_MAX_REPOS) break;
      }
      if (out.length >= SETUP_MAX_REPOS) break;
    }
    out.sort((a, b) => a.fullName.localeCompare(b.fullName));
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadSetupFacts(
  db: Db,
  opts: {
    githubConnected: boolean;
    allowedRepos: string[];
    appRepos: () => Promise<SetupRepo[] | null>;
    now?: number;
  },
): Promise<SetupFacts> {
  const scope = repoAllowSql(opts.allowedRepos, "r.repo");
  const where = scope.clause ? `WHERE ${scope.clause}` : "";
  const and = scope.clause ? `AND ${scope.clause}` : "";
  const [counts, latest, queued, executor, hook, repos] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS ok FROM runs r ${where}`)
      .bind(...scope.binds)
      .first<{ n: number; ok: number | null }>(),
    db
      .prepare(`SELECT r.id, r.repo, r.branch, r.status, r.created_at FROM runs r ${where} ORDER BY r.created_at DESC LIMIT 1`)
      .bind(...scope.binds)
      .first<{ id: string; repo: string; branch: string | null; status: string; created_at: string }>(),
    db
      .prepare(`SELECT MIN(j.created_at) AS at FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.status = 'queued' ${and}`)
      .bind(...scope.binds)
      .first<{ at: string | null }>(),
    db.prepare("SELECT 1 AS x FROM jobs WHERE started_at IS NOT NULL LIMIT 1").bind().first<{ x: number }>(),
    db.prepare("SELECT 1 AS x FROM webhook_deliveries LIMIT 1").bind().first<{ x: number }>(),
    opts.githubConnected ? opts.appRepos().catch(() => null) : Promise.resolve(null),
  ]);
  const now = opts.now ?? Date.now();
  const queuedAt = queued?.at ? Date.parse(queued.at) : NaN;
  return {
    githubConnected: opts.githubConnected,
    repos: repos === null ? null : repos.filter((r) => reposAllow(opts.allowedRepos, r.fullName)),
    webhookSeen: hook !== null,
    runs: counts?.n ?? 0,
    passed: counts?.ok ?? 0,
    latest: latest
      ? { id: latest.id, repo: latest.repo, branch: latest.branch ?? "", status: latest.status, createdAt: latest.created_at }
      : null,
    queuedForMs: Number.isFinite(queuedAt) ? Math.max(0, now - queuedAt) : null,
    executorSeen: executor !== null,
  };
}
