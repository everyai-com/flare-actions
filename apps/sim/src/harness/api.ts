// The live harness's view of the Forge REST API (stream B, `/v1/forge/*`).
// Coded against the contract in COMPETITION-PLAN §3.3 + FORGE.md
// (intents.ts): goal -> declare -> claim (fork remote + token) -> git
// push -> report push -> ready, plus heartbeat and whats_happening. The
// route table and response field names are isolated here so the
// integrator can adjust them in one place; the pool logic only sees
// `ForgeApi`, which tests replace with a fake.

export type ForgeOp = "goal" | "declare" | "claim" | "heartbeat" | "whats_happening" | "git_push" | "push" | "ready";

export const FORGE_OPS: readonly ForgeOp[] = [
  "goal",
  "declare",
  "claim",
  "heartbeat",
  "whats_happening",
  "git_push",
  "push",
  "ready",
];

export interface ApiOk<T> {
  ok: true;
  status: number;
  value: T;
  ms: number;
}

export interface ApiErr {
  ok: false;
  status: number; // 0 = network error / timeout
  code: string;
  rateLimited: boolean;
  retryable: boolean;
  retryAfterMs: number | null;
  ms: number;
}

export type ApiResult<T> = ApiOk<T> | ApiErr;

export interface ForgeApi {
  createGoal(input: { repo: string; text: string; agent: string }): Promise<ApiResult<{ id: string }>>;
  declareIntent(input: {
    repo: string;
    goalId: string | null;
    agent: string;
    title: string;
    reasoning: string;
    accept: string;
    footprint: string[];
  }): Promise<ApiResult<{ id: string; overlaps: number }>>;
  claimIntent(input: { id: string; agent: string }): Promise<ApiResult<{ forkRepo: string; remote: string; token: string }>>;
  heartbeat(input: { id: string; agent: string }): Promise<ApiResult<{ inbox: number }>>;
  whatsHappening(input: { repo: string; paths: string[]; agent: string }): Promise<ApiResult<{ live: number }>>;
  reportPush(input: { id: string; agent: string; sha: string; files: string[] }): Promise<ApiResult<{ drift: number }>>;
  markReady(input: { id: string; agent: string }): Promise<ApiResult<{ risk: number | null }>>;
}

// Route table relative to the prefix (default `/v1/forge`).
export const FORGE_ROUTES = {
  goals: (): string => "/goals",
  intents: (): string => "/intents",
  claim: (id: string): string => `/intents/${encodeURIComponent(id)}/claim`,
  heartbeat: (id: string): string => `/intents/${encodeURIComponent(id)}/heartbeat`,
  push: (id: string): string => `/intents/${encodeURIComponent(id)}/push`,
  ready: (id: string): string => `/intents/${encodeURIComponent(id)}/ready`,
  whatsHappening: (): string => "/whats-happening",
};

// Artifacts surfaces rate limiting as `rateLimited`-style error codes;
// the API may relay it in the body with any status. 429 always counts.
const RATE_LIMIT_RE = /rate[\s_-]?limit/i;

export function classifyError(status: number, body: unknown): { code: string; rateLimited: boolean; retryable: boolean } {
  let code = status === 0 ? "network" : `http_${status}`;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const c = typeof b.code === "string" ? b.code : typeof b.error === "string" ? b.error : null;
    if (c) code = c.slice(0, 64);
  }
  const rateLimited = status === 429 || RATE_LIMIT_RE.test(code);
  const retryable = rateLimited || status === 0 || status >= 500 || status === 408;
  return { code, rateLimited, retryable };
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120_000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - now, 120_000));
  return null;
}

// Read a field by trying several dotted paths (snake + camel tolerant).
export function pick(obj: unknown, paths: readonly string[]): unknown {
  for (const p of paths) {
    let cur: unknown = obj;
    for (const seg of p.split(".")) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const count = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === "number" ? v : 0);

export interface HttpForgeApiOptions {
  baseUrl: string;
  token: string;
  prefix?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export function createHttpForgeApi(opts: HttpForgeApiOptions): ForgeApi {
  const base = opts.baseUrl.replace(/\/+$/, "") + (opts.prefix ?? "/v1/forge");
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    agent: string,
    body: unknown,
    parse: (json: unknown) => T | null,
  ): Promise<ApiResult<T>> {
    const t0 = now();
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
          "X-Flare-Agent": agent,
          "X-Flare-Sim": "1",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_err) {
      return { ok: false, status: 0, code: "network", rateLimited: false, retryable: true, retryAfterMs: null, ms: now() - t0 };
    }
    const json: unknown = await res.json().catch(() => null);
    const ms = now() - t0;
    if (!res.ok) {
      const c = classifyError(res.status, json);
      return { ok: false, status: res.status, ...c, retryAfterMs: parseRetryAfter(res.headers.get("Retry-After"), now()), ms };
    }
    const value = parse(json);
    if (value === null) {
      return { ok: false, status: res.status, code: "bad_response", rateLimited: false, retryable: false, retryAfterMs: null, ms };
    }
    return { ok: true, status: res.status, value, ms };
  }

  return {
    createGoal: (i) =>
      call("POST", FORGE_ROUTES.goals(), i.agent, { repo: i.repo, text: i.text }, (j) => {
        const id = str(pick(j, ["goal.id", "id"]));
        return id ? { id } : null;
      }),
    declareIntent: (i) =>
      call(
        "POST",
        FORGE_ROUTES.intents(),
        i.agent,
        {
          repo: i.repo,
          goal_id: i.goalId ?? undefined,
          agent: i.agent,
          title: i.title,
          reasoning: i.reasoning,
          accept: i.accept,
          footprint: { paths: i.footprint },
        },
        (j) => {
          const id = str(pick(j, ["intent.id", "id"]));
          return id ? { id, overlaps: count(pick(j, ["overlaps"])) } : null;
        },
      ),
    claimIntent: (i) =>
      call("POST", FORGE_ROUTES.claim(i.id), i.agent, { agent: i.agent }, (j) => {
        const forkRepo = str(pick(j, ["fork_repo", "forkRepo", "intent.fork_repo", "intent.forkRepo"]));
        const remote = str(pick(j, ["fork_remote", "remote", "forkRemote"]));
        const token = str(pick(j, ["token"]));
        return forkRepo && remote && token ? { forkRepo, remote, token } : null;
      }),
    heartbeat: (i) =>
      call("POST", FORGE_ROUTES.heartbeat(i.id), i.agent, { agent: i.agent }, (j) => ({
        inbox: count(pick(j, ["inbox"])),
      })),
    whatsHappening: (i) =>
      call(
        "GET",
        `${FORGE_ROUTES.whatsHappening()}?repo=${encodeURIComponent(i.repo)}&paths=${encodeURIComponent(i.paths.join(","))}`,
        i.agent,
        undefined,
        (j) => ({ live: count(pick(j, ["intents", "live", "items"])) }),
      ),
    reportPush: (i) =>
      call("POST", FORGE_ROUTES.push(i.id), i.agent, { agent: i.agent, sha: i.sha, files: i.files }, (j) => ({
        drift: count(pick(j, ["drift"])),
      })),
    markReady: (i) =>
      call("POST", FORGE_ROUTES.ready(i.id), i.agent, { agent: i.agent }, (j) => {
        const risk = pick(j, ["risk", "intent.risk"]);
        return { risk: typeof risk === "number" ? risk : null };
      }),
  };
}
