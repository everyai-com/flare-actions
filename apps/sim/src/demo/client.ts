// The demo loop's view of the Forge REST API (`/v1/forge/*`). One method
// per verb the scripted Bookshelf agents use; every call carries the
// acting agent name (X-Flare-Agent + body `agent`). Errors throw
// DemoApiError with the stable `code` from the API so the loop can tell
// "already done" from "retry later". Tests replace this with a fake.

export class DemoApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DemoApiError";
    this.status = status;
    this.code = code;
  }
}

export interface DemoIntent {
  id: string;
  agent: string;
  state: string;
  title: string;
  forkRepo: string | null;
  goalId: string | null;
}

export interface DemoConflict {
  id: string;
  intentA: string;
  intentB: string;
  state: string;
  files: string[];
}

export interface DemoClaim {
  forkRepo: string;
  remote: string;
  token: string;
  goalId: string | null;
}

export interface DemoForgeApi {
  createGoal(repo: string, text: string, agent: string): Promise<{ id: string }>;
  declare(input: { repo: string; goalId: string | null; agent: string; title: string; reasoning: string; accept: string; footprint: string[] }): Promise<{ intent: DemoIntent; overlaps: Array<{ intentId: string }> }>;
  sendNote(toIntent: string, fromIntent: string, agent: string, text: string): Promise<void>;
  claim(intentId: string, agent: string): Promise<DemoClaim>;
  reportPush(intentId: string, agent: string, sha: string): Promise<{ drift: string[] }>;
  markReady(intentId: string, agent: string): Promise<{ route: string }>;
  abandon(intentId: string, agent: string): Promise<void>;
  listIntents(repo: string, state?: string): Promise<DemoIntent[]>;
  listConflicts(repo: string, state: string): Promise<DemoConflict[]>;
  claimConflict(conflictId: string, agent: string): Promise<{ intentId: string; forkRepo: string; remote: string; token: string }>;
  resolveConflict(conflictId: string, agent: string, sha: string): Promise<void>;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toIntent(v: unknown): DemoIntent {
  const r = rec(v);
  return {
    id: s(r.id),
    agent: s(r.agent),
    state: s(r.state),
    title: s(r.title),
    forkRepo: typeof r.forkRepo === "string" ? r.forkRepo : null,
    goalId: typeof r.goalId === "string" ? r.goalId : null,
  };
}

export function createDemoForgeApi(opts: { baseUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number }): DemoForgeApi {
  const base = `${opts.baseUrl.replace(/\/+$/, "")}/v1/forge`;
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function call(method: "GET" | "POST", path: string, agent: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json", "X-Flare-Agent": agent, "X-Flare-Demo": "1" },
        body: body === undefined ? undefined : JSON.stringify({ agent, ...body }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new DemoApiError(0, "network", `network: ${String(err).slice(0, 120)}`);
    }
    const json = rec(await res.json().catch(() => ({})));
    if (!res.ok) throw new DemoApiError(res.status, s(json.code) || `http_${res.status}`, s(json.error).slice(0, 200) || `HTTP ${res.status}`);
    return json;
  }

  return {
    async createGoal(repo, text, agent) {
      const j = await call("POST", "/goals", agent, { repo, text });
      return { id: s(rec(j.goal).id) };
    },
    async declare(i) {
      const j = await call("POST", "/intents", i.agent, { repo: i.repo, goalId: i.goalId ?? undefined, title: i.title, reasoning: i.reasoning, accept: i.accept, footprint: i.footprint });
      const overlaps = Array.isArray(j.overlaps) ? j.overlaps.map((o) => ({ intentId: s(rec(o).intentId) })).filter((o) => o.intentId) : [];
      return { intent: toIntent(j.intent), overlaps };
    },
    async sendNote(toIntent, fromIntent, agent, text) {
      await call("POST", `/intents/${encodeURIComponent(toIntent)}/messages`, agent, { fromIntent, text });
    },
    async claim(intentId, agent) {
      const j = await call("POST", `/intents/${encodeURIComponent(intentId)}/claim`, agent, { leaseTtlSeconds: 3600 });
      return { forkRepo: s(j.forkRepo), remote: s(j.forkRemote), token: s(j.token), goalId: toIntent(j.intent).goalId };
    },
    async reportPush(intentId, agent, sha) {
      const j = await call("POST", `/intents/${encodeURIComponent(intentId)}/push`, agent, { sha });
      return { drift: Array.isArray(j.drift) ? j.drift.map(s) : [] };
    },
    async markReady(intentId, agent) {
      const j = await call("POST", `/intents/${encodeURIComponent(intentId)}/ready`, agent, {});
      return { route: s(j.route) };
    },
    async abandon(intentId, agent) {
      await call("POST", `/intents/${encodeURIComponent(intentId)}/abandon`, agent, {});
    },
    async listIntents(repo, state) {
      const q = new URLSearchParams({ repo, limit: "200" });
      if (state) q.set("state", state);
      const j = await call("GET", `/intents?${q}`, "demo-loop");
      return Array.isArray(j.intents) ? j.intents.map(toIntent) : [];
    },
    async listConflicts(repo, state) {
      const j = await call("GET", `/conflicts?${new URLSearchParams({ repo, state })}`, "demo-loop");
      return (Array.isArray(j.conflicts) ? j.conflicts : []).map((c) => {
        const r = rec(c);
        return { id: s(r.id), intentA: s(r.intentA), intentB: s(r.intentB), state: s(r.state), files: Array.isArray(r.files) ? r.files.map(s) : [] };
      });
    },
    async claimConflict(conflictId, agent) {
      const j = await call("POST", `/conflicts/${encodeURIComponent(conflictId)}/claim`, agent, {});
      const r = rec(j.replay);
      return { intentId: s(r.intentId), forkRepo: s(r.forkRepo), remote: s(r.forkRemote), token: s(r.token) };
    },
    async resolveConflict(conflictId, agent, sha) {
      await call("POST", `/conflicts/${encodeURIComponent(conflictId)}/resolve`, agent, { sha });
    },
  };
}
