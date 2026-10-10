// `cli doctor` (alias `whoami`): the first command to run. Walks the
// setup chain in order (.env → URL → reachable → token → valid + scope →
// runners → this repo's runs) and prints one checklist with a one-line
// fix per failure. Read-only GETs only; every request is time-bounded.
// Dependencies are injected so the whole flow is unit-testable.

import { describeEnvLocation, resolveToken, type EnvLocation } from "./hints.ts";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  id: "env" | "url" | "reachable" | "token" | "auth" | "scope" | "runners" | "repo";
  label: string;
  status: CheckStatus;
  critical: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  baseUrl: string | null;
  envPath: string | null;
  admin: boolean | null;
  repo: string | null;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  envLocation: EnvLocation;
  // The caller already copied FLARE_TOKEN into RUNNER_TOKEN.
  tokenFromAlias?: boolean;
  fetchFn?: typeof fetch;
  // `git remote get-url origin` in the working tree; null when not a repo
  // or no origin.
  gitOrigin: () => string | null;
  timeoutMs?: number;
}

const LOGIN_FIX = "run `npm run cli -- login` (pair with a code from dashboard Settings) or `npm run setup`";

// owner/name from a GitHub-style remote (https, ssh, scp-like), else null.
export function repoFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

interface Fetched {
  status: number;
  body: unknown;
  error?: string;
}

async function getJson(fetchFn: typeof fetch, url: string, token: string | null, timeoutMs: number): Promise<Fetched> {
  try {
    const res = await fetchFn(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10000;
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck): DoctorCheck => {
    checks.push(c);
    return c;
  };
  const rawUrl = (deps.env["FLARE_ACTIONS_URL"] ?? "").trim();
  const baseUrl = rawUrl ? rawUrl.replace(/\/+$/, "") : null;
  const token = resolveToken(deps.env) ?? null;
  const viaAlias = !!token && (deps.tokenFromAlias === true || !(deps.env["RUNNER_TOKEN"] ?? "").trim());
  let admin: boolean | null = null;

  add(
    deps.envLocation.path
      ? { id: "env", label: ".env found", status: "pass", critical: false, detail: deps.envLocation.path }
      : {
          id: "env",
          label: ".env found",
          status: baseUrl && token ? "pass" : "warn",
          critical: false,
          detail: baseUrl && token ? "none (using exported variables)" : describeEnvLocation(deps.envLocation).replace(/^\.env: /, ""),
          ...(baseUrl && token ? {} : { fix: LOGIN_FIX }),
        },
  );

  add(
    baseUrl
      ? { id: "url", label: "FLARE_ACTIONS_URL set", status: "pass", critical: true, detail: baseUrl }
      : { id: "url", label: "FLARE_ACTIONS_URL set", status: "fail", critical: true, detail: "not set", fix: LOGIN_FIX },
  );

  let reachable = false;
  if (!baseUrl) {
    add({ id: "reachable", label: "deployment reachable", status: "skip", critical: true, detail: "no URL" });
  } else {
    const r = await getJson(fetchFn, `${baseUrl}/v1/admin/status`, null, timeoutMs);
    reachable = r.status >= 200 && r.status < 300 && isRecord(r.body);
    add(
      reachable
        ? { id: "reachable", label: "deployment reachable", status: "pass", critical: true, detail: `GET /v1/admin/status → ${r.status}` }
        : {
            id: "reachable",
            label: "deployment reachable",
            status: "fail",
            critical: true,
            detail: r.error ? `GET /v1/admin/status failed: ${r.error}` : `GET /v1/admin/status → HTTP ${r.status} (not a Flare deployment?)`,
            fix: "check FLARE_ACTIONS_URL (open it in a browser), or redeploy with `npm run deploy`",
          },
    );
  }

  add(
    token
      ? { id: "token", label: "token present", status: "pass", critical: true, detail: viaAlias ? "FLARE_TOKEN (alias for RUNNER_TOKEN)" : "RUNNER_TOKEN" }
      : { id: "token", label: "token present", status: "fail", critical: true, detail: "RUNNER_TOKEN / FLARE_TOKEN not set", fix: LOGIN_FIX },
  );

  let runs: { repo: string }[] | null = null;
  if (!baseUrl || !token || !reachable) {
    add({ id: "auth", label: "token valid", status: "skip", critical: true, detail: "needs a reachable URL and a token" });
    add({ id: "scope", label: "token scope", status: "skip", critical: false, detail: "needs a valid token" });
  } else {
    const r = await getJson(fetchFn, `${baseUrl}/v1/runs?limit=100`, token, timeoutMs);
    if (r.status === 200 && isRecord(r.body) && Array.isArray(r.body["runs"])) {
      runs = r.body["runs"].filter(isRecord).map((x) => ({ repo: typeof x["repo"] === "string" ? x["repo"] : "" }));
      add({ id: "auth", label: "token valid", status: "pass", critical: true, detail: "GET /v1/runs → 200" });
      const s = await getJson(fetchFn, `${baseUrl}/v1/admin/status`, token, timeoutMs);
      const user = isRecord(s.body) && isRecord(s.body["user"]) ? s.body["user"] : null;
      if (user && typeof user["admin"] === "boolean") {
        admin = user["admin"];
        const actor = typeof user["actor"] === "string" ? user["actor"] : "token";
        add({
          id: "scope",
          label: "token scope",
          status: "pass",
          critical: false,
          detail: admin ? `admin (${actor})` : `runner or readonly (${actor}) — admin commands (queue, cache, paused) will 401`,
        });
      } else {
        add({ id: "scope", label: "token scope", status: "warn", critical: false, detail: "could not determine (older deployment?)" });
      }
    } else {
      const why = r.error ? r.error : `HTTP ${r.status}`;
      add({
        id: "auth",
        label: "token valid",
        status: "fail",
        critical: true,
        detail: `GET /v1/runs → ${why}`,
        fix:
          r.status === 401 || r.status === 403
            ? "token rejected (revoked, or from another deployment): " + LOGIN_FIX
            : "the deployment answered unexpectedly; retry, or check `npx wrangler tail`",
      });
      add({ id: "scope", label: "token scope", status: "skip", critical: false, detail: "needs a valid token" });
    }
  }

  if (!runs || !baseUrl || !token) {
    add({ id: "runners", label: "runners online", status: "skip", critical: false, detail: "needs a valid token" });
  } else {
    const s = await getJson(fetchFn, `${baseUrl}/v1/setup`, token, timeoutMs);
    if (s.status === 200 && isRecord(s.body) && typeof s.body["executorSeen"] === "boolean") {
      const seen = s.body["executorSeen"];
      const waiting = s.body["waitingForComputer"] === true;
      add(
        seen && !waiting
          ? { id: "runners", label: "runners online", status: "pass", critical: false, detail: "an executor has claimed jobs" }
          : {
              id: "runners",
              label: "runners online",
              status: "warn",
              critical: false,
              detail: waiting ? "jobs are queued but nothing is picking them up" : "no runner or seat has claimed a job yet",
              fix: "start one: `npm run runner` (or pair a machine: dashboard Settings → Pair a runner)",
            },
      );
    } else {
      add({ id: "runners", label: "runners online", status: "skip", critical: false, detail: `GET /v1/setup → HTTP ${s.status || s.error}` });
    }
  }

  const repo = repoFromRemote(deps.gitOrigin());
  if (!repo) {
    add({ id: "repo", label: "this repo has runs", status: "skip", critical: false, detail: "not in a git repo with an origin remote" });
  } else if (!runs) {
    add({ id: "repo", label: "this repo has runs", status: "skip", critical: false, detail: `${repo} (needs a valid token)` });
  } else {
    const n = runs.filter((r) => r.repo.toLowerCase() === repo.toLowerCase()).length;
    add(
      n > 0
        ? { id: "repo", label: "this repo has runs", status: "pass", critical: false, detail: `${repo}: ${n} recent run${n === 1 ? "" : "s"}` }
        : {
            id: "repo",
            label: "this repo has runs",
            status: "warn",
            critical: false,
            detail: `${repo}: no recent runs`,
            fix: `wire it: \`npm run cli -- connect\`, or try one now: \`npm run cli -- run ${repo} HEAD\``,
          },
    );
  }

  const ok = checks.every((c) => !c.critical || c.status === "pass");
  return { ok, baseUrl, envPath: deps.envLocation.path, admin, repo, checks };
}

const MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "-" };

export function formatDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.label.length));
  const lines: string[] = [];
  const shown = new Set<string>();
  for (const c of report.checks) {
    lines.push(`${MARK[c.status]} ${c.label.padEnd(width)}  ${c.detail}`);
    // One fix line per distinct fix (missing URL + token share one).
    if (c.fix && (c.status === "fail" || c.status === "warn") && !shown.has(c.fix)) {
      shown.add(c.fix);
      lines.push(`  ${" ".repeat(width)}  → ${c.fix}`);
    }
  }
  const next = report.checks.find((c) => c.status === "fail" && c.fix) ?? report.checks.find((c) => c.status === "warn" && c.fix);
  lines.push("");
  if (report.ok) lines.push(next ? `ready. next: ${next.fix}` : "ready. try: `npm run cli -- runs`");
  else lines.push(`not ready. fix first: ${next?.fix ?? LOGIN_FIX}`);
  return lines.join("\n");
}
