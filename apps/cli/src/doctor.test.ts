import { describe, expect, it } from "vitest";
import { doctorNext, formatDoctor, repoFromRemote, runDoctor, type DoctorCheck } from "./doctor.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Route = (auth: string | null) => Response;

function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const route = routes[u.pathname];
    if (!route) return jsonResponse(404, { error: "not found" });
    return route(headers["Authorization"] ?? null);
  }) as typeof fetch;
}

const healthy: Record<string, Route> = {
  "/v1/admin/status": (auth) => jsonResponse(200, { claimed: true, user: auth ? { actor: "token:ci", admin: false } : null }),
  "/v1/runs": (auth) => (auth === "Bearer good" ? jsonResponse(200, { runs: [{ repo: "o/r" }, { repo: "x/y" }] }) : jsonResponse(401, { error: "unauthorized" })),
  "/v1/setup": () => jsonResponse(200, { executorSeen: true, waitingForComputer: false }),
};

describe("repoFromRemote", () => {
  it("parses common GitHub remotes", () => {
    expect(repoFromRemote("https://github.com/o/r.git")).toBe("o/r");
    expect(repoFromRemote("git@github.com:o/r.git")).toBe("o/r");
    expect(repoFromRemote("ssh://git@github.com/o/r")).toBe("o/r");
    expect(repoFromRemote(null)).toBeNull();
  });
});

describe("runDoctor", () => {
  it("passes a healthy setup and reports scope + repo runs", async () => {
    const report = await runDoctor({
      env: { FLARE_ACTIONS_URL: "https://w.example/", FLARE_TOKEN: "good" },
      envLocation: { path: "/repo/.env", searchedFrom: "/repo" },
      fetchFn: fakeFetch(healthy),
      gitOrigin: () => "git@github.com:o/r.git",
    });
    expect(report.ok).toBe(true);
    expect(report.admin).toBe(false);
    expect(report.repo).toBe("o/r");
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["env", "pass"],
      ["url", "pass"],
      ["reachable", "pass"],
      ["token", "pass"],
      ["auth", "pass"],
      ["scope", "pass"],
      ["runners", "pass"],
      ["repo", "pass"],
    ]);
    expect(report.checks.find((c) => c.id === "token")?.detail).toContain("FLARE_TOKEN");
    expect(formatDoctor(report)).toContain("✓ token valid");
  });

  it("fails on a rejected token with a login fix", async () => {
    const report = await runDoctor({
      env: { FLARE_ACTIONS_URL: "https://w.example", RUNNER_TOKEN: "bad" },
      envLocation: { path: null, searchedFrom: "/x" },
      fetchFn: fakeFetch(healthy),
      gitOrigin: () => null,
    });
    expect(report.ok).toBe(false);
    const auth = report.checks.find((c) => c.id === "auth");
    expect(auth?.status).toBe("fail");
    expect(auth?.fix).toContain("npm run cli -- login");
    expect(formatDoctor(report)).toContain("✗ token valid");
  });

  it("fails without config and skips network checks", async () => {
    let called = 0;
    const report = await runDoctor({
      env: {},
      envLocation: { path: null, searchedFrom: "/x" },
      fetchFn: (async () => {
        called += 1;
        return jsonResponse(200, {});
      }) as typeof fetch,
      gitOrigin: () => null,
    });
    expect(called).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "url")?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "env")?.detail).toContain("/x");
  });

  it("flags an unreachable deployment", async () => {
    const report = await runDoctor({
      env: { FLARE_ACTIONS_URL: "https://down.example", RUNNER_TOKEN: "good" },
      envLocation: { path: "/r/.env", searchedFrom: "/r" },
      fetchFn: (async () => {
        throw new Error("ENOTFOUND");
      }) as typeof fetch,
      gitOrigin: () => null,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "reachable")?.detail).toContain("ENOTFOUND");
  });

  it("warns (non-critical) when this repo has no runs and no runner was seen", async () => {
    const report = await runDoctor({
      env: { FLARE_ACTIONS_URL: "https://w.example", RUNNER_TOKEN: "good" },
      envLocation: { path: "/r/.env", searchedFrom: "/r" },
      fetchFn: fakeFetch({ ...healthy, "/v1/setup": () => jsonResponse(200, { executorSeen: false }) }),
      gitOrigin: () => "https://github.com/a/b",
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "repo")?.status).toBe("warn");
    expect(report.checks.find((c) => c.id === "runners")?.status).toBe("warn");
  });
});

describe("doctor next move", () => {
  const lastLine = (text: string): string => text.split("\n").pop() ?? "";
  const base = { envLocation: { path: "/r/.env", searchedFrom: "/r" }, cli: "npx flare-forge" };

  it("not configured → login", async () => {
    const report = await runDoctor({ ...base, env: {}, gitOrigin: () => null, fetchFn: (async () => jsonResponse(200, {})) as typeof fetch });
    expect(report.next.command).toBe("npx flare-forge login");
    expect(lastLine(formatDoctor(report))).toBe("next: npx flare-forge login");
  });

  it("unreachable → log in with the right URL", async () => {
    const report = await runDoctor({
      ...base,
      env: { FLARE_ACTIONS_URL: "https://down.example", RUNNER_TOKEN: "good" },
      gitOrigin: () => null,
      fetchFn: (async () => {
        throw new Error("ENOTFOUND");
      }) as typeof fetch,
    });
    expect(report.next.command).toBe("npx flare-forge login --url https://<your-worker>.workers.dev");
    expect(report.next.why).toContain("https://down.example");
  });

  it("rejected token → login", async () => {
    const report = await runDoctor({ ...base, env: { FLARE_ACTIONS_URL: "https://w.example", RUNNER_TOKEN: "bad" }, gitOrigin: () => null, fetchFn: fakeFetch(healthy) });
    expect(report.next.command).toBe("npx flare-forge login");
    expect(report.next.why).toMatch(/rejected/);
  });

  it("no runner online → start one", async () => {
    const report = await runDoctor({
      ...base,
      env: { FLARE_ACTIONS_URL: "https://w.example", RUNNER_TOKEN: "good" },
      gitOrigin: () => "https://github.com/a/b",
      fetchFn: fakeFetch({ ...healthy, "/v1/setup": () => jsonResponse(200, { executorSeen: false }) }),
    });
    expect(report.next.command).toBe("npm run runner");
    expect(lastLine(formatDoctor(report))).toBe("next: npm run runner");
  });

  it("repo with no runs → connect", async () => {
    const report = await runDoctor({ ...base, env: { FLARE_ACTIONS_URL: "https://w.example", RUNNER_TOKEN: "good" }, gitOrigin: () => "https://github.com/a/b", fetchFn: fakeFetch(healthy) });
    expect(report.next.command).toBe("npx flare-forge connect");
  });

  it("all good → run HEAD (or list runs outside a repo)", async () => {
    const report = await runDoctor({ ...base, env: { FLARE_ACTIONS_URL: "https://w.example", RUNNER_TOKEN: "good" }, gitOrigin: () => "git@github.com:o/r.git", fetchFn: fakeFetch(healthy) });
    expect(report.ok).toBe(true);
    expect(lastLine(formatDoctor(report))).toBe("next: npx flare-forge run o/r HEAD");
    const pass = (id: DoctorCheck["id"]): DoctorCheck => ({ id, label: id, status: "pass", critical: true, detail: "" });
    expect(doctorNext([pass("url"), pass("token")], null, "https://w").command).toBe("npm run cli -- runs");
  });

  it("every outcome ends in exactly one next line", async () => {
    const report = await runDoctor({ ...base, env: {}, gitOrigin: () => null, fetchFn: (async () => jsonResponse(200, {})) as typeof fetch });
    const text = formatDoctor(report);
    expect(text.split("\n").filter((l) => l.startsWith("next:"))).toHaveLength(1);
  });
});
