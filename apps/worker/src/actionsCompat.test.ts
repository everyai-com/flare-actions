import { describe, expect, it, vi } from "vitest";
import {
  buildCompatJobs,
  evaluateCommonCondition,
  fetchWorkflowFiles,
  mapGithubExpressions,
  matchBranchGlob,
  matchesWorkflowEvent,
  mergeWorkflows,
  translateWorkflow,
  type WorkflowFile,
} from "./actionsCompat";

const NODE_CI = `
name: Node CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ["18", "20"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: actions/cache@v4
        with: { path: node_modules, key: "node-\${{ runner.os }}" }
      - run: npm ci
      - run: echo "\${{ github.sha }}" > sha.txt
      - uses: actions/upload-artifact@v4
        with: { name: cov, path: coverage }
`;

describe("matchBranchGlob", () => {
  it("keeps * within a path segment and lets ** cross", () => {
    expect(matchBranchGlob("main", "main")).toBe(true);
    expect(matchBranchGlob("release/*", "release/1.0")).toBe(true);
    expect(matchBranchGlob("release/*", "release/1.0/hotfix")).toBe(false);
    expect(matchBranchGlob("release/**", "release/1.0/hotfix")).toBe(true);
    expect(matchBranchGlob("v?.*", "v1.2")).toBe(true);
    expect(matchBranchGlob("main", "Main")).toBe(false);
  });
});

describe("matchesWorkflowEvent", () => {
  const push = { event: "push", branch: "main" };
  it("normalizes scalar, array, and map on: forms", () => {
    expect(matchesWorkflowEvent("push", push)).toBe(true);
    expect(matchesWorkflowEvent(["push", "pull_request"], push)).toBe(true);
    expect(matchesWorkflowEvent({ push: null }, push)).toBe(true);
    expect(matchesWorkflowEvent("schedule", push)).toBe(false);
    expect(matchesWorkflowEvent(undefined, push)).toBe(false);
  });

  it("applies push branch filters with negation", () => {
    expect(matchesWorkflowEvent({ push: { branches: ["main"] } }, push)).toBe(true);
    expect(matchesWorkflowEvent({ push: { branches: ["dev"] } }, push)).toBe(false);
    expect(matchesWorkflowEvent({ push: { branches: ["**", "!release/**"] } }, { event: "push", branch: "release/1" })).toBe(false);
    expect(matchesWorkflowEvent({ push: { "branches-ignore": ["dependabot/**"] } }, { event: "push", branch: "dependabot/npm" })).toBe(false);
  });

  it("decides tag pushes by tags filters only", () => {
    const tag = { event: "push", branch: "", tag: "v1.2.3" };
    expect(matchesWorkflowEvent({ push: { tags: ["v*"] } }, tag)).toBe(true);
    expect(matchesWorkflowEvent({ push: { tags: ["release-*"] } }, tag)).toBe(false);
    expect(matchesWorkflowEvent({ push: { branches: ["main"] } }, tag)).toBe(false);
    expect(matchesWorkflowEvent("push", tag)).toBe(true);
  });

  it("matches PR branches against the base ref", () => {
    const pr = { event: "pull_request", branch: "feature/x", baseBranch: "main" };
    expect(matchesWorkflowEvent({ pull_request: { branches: ["main"] } }, pr)).toBe(true);
    expect(matchesWorkflowEvent({ pull_request: { branches: ["release"] } }, pr)).toBe(false);
    expect(matchesWorkflowEvent({ push: null }, pr)).toBe(false);
  });

  it("maps workflow_dispatch and schedule with cron equality", () => {
    expect(matchesWorkflowEvent({ workflow_dispatch: null }, { event: "dispatch" })).toBe(true);
    expect(matchesWorkflowEvent({ push: null }, { event: "dispatch" })).toBe(false);
    expect(matchesWorkflowEvent({ schedule: [{ cron: "0 3 * * *" }] }, { event: "schedule", cron: "0  3 * * *" })).toBe(true);
    expect(matchesWorkflowEvent({ schedule: [{ cron: "0 3 * * *" }] }, { event: "schedule", cron: "0 4 * * *" })).toBe(false);
    expect(matchesWorkflowEvent({ schedule: [{ cron: "0 3 * * *" }] }, { event: "schedule" })).toBe(true);
    expect(matchesWorkflowEvent({ push: null }, { event: "schedule", cron: "0 3 * * *" })).toBe(false);
  });

  it("applies paths filters only when changed files are known", () => {
    const pushMain = { event: "push", branch: "main" };
    const onPaths = { push: { paths: ["src/**", "lib/*.ts"] } };
    expect(matchesWorkflowEvent(onPaths, pushMain)).toBe(true); // unknown → conservative
    expect(matchesWorkflowEvent(onPaths, { ...pushMain, changedFiles: ["src/a.ts"] })).toBe(true);
    expect(matchesWorkflowEvent(onPaths, { ...pushMain, changedFiles: ["lib/x.ts"] })).toBe(true);
    expect(matchesWorkflowEvent(onPaths, { ...pushMain, changedFiles: ["lib/nested/x.ts"] })).toBe(false);
    expect(matchesWorkflowEvent(onPaths, { ...pushMain, changedFiles: ["docs/a.md"] })).toBe(false);
    const onIgnore = { push: { "paths-ignore": ["docs/**", "*.md"] } };
    expect(matchesWorkflowEvent(onIgnore, { ...pushMain, changedFiles: ["README.md"] })).toBe(false);
    expect(matchesWorkflowEvent(onIgnore, { ...pushMain, changedFiles: ["docs/x/y.md"] })).toBe(false);
    expect(matchesWorkflowEvent(onIgnore, { ...pushMain, changedFiles: ["src/a.ts"] })).toBe(true);
    const pr = { event: "pull_request", baseBranch: "main", changedFiles: ["src/x.ts"] };
    expect(matchesWorkflowEvent({ pull_request: { paths: ["src/**"] } }, pr)).toBe(true);
    expect(matchesWorkflowEvent({ pull_request: { paths: ["pkg/**"] } }, pr)).toBe(false);
  });
});

describe("mapGithubExpressions", () => {
  it("maps supported builtins onto FLARE_* and keeps secrets", () => {
    const res = mapGithubExpressions(
      "echo ${{ github.sha }} ${{ github.repository }} ${{ github.ref_name }} ${{ github.run_id }} ${{ secrets.TOKEN }}",
    );
    expect(res.text).toBe("echo ${FLARE_SHA} ${FLARE_REPO} ${FLARE_REF} ${FLARE_RUN_ID} ${{ secrets.TOKEN }}");
    expect(res.dropped).toEqual([]);
  });

  it("scrubs unknown expressions and reports them", () => {
    const res = mapGithubExpressions("echo ${{ needs.build.outputs.x }}");
    expect(res.text).toBe("echo ");
    expect(res.dropped).toEqual(["needs.build.outputs.x"]);
  });
});

describe("translateWorkflow", () => {
  it("translates a real-world node workflow with matrix, cache, and artifacts", () => {
    const res = translateWorkflow(NODE_CI, "ci");
    expect(res.name).toBe("Node CI");
    expect(res.jobs).not.toBeNull();
    const jobs = res.jobs as NonNullable<typeof res.jobs>;
    expect(jobs.map((j) => j.name)).toEqual(["test (node=18)", "test (node=20)"]);
    expect(jobs[0].base).toBe("test");
    expect(jobs[0].matrix).toEqual({ node: "18" });
    expect(jobs[0].cache).toEqual({ key: "node-expr", paths: ["node_modules"] });
    expect(jobs[0].artifacts).toEqual({ name: "cov", paths: ["coverage"] });
    const shaStep = jobs[0].steps.find((s) => s.run.includes("sha.txt"));
    expect(shaStep?.run).toContain("${FLARE_SHA}");
    expect(res.warnings.join("\n")).toContain("checkout");
  });

  it("skips invalid YAML and workflows with no convertible jobs", () => {
    expect(translateWorkflow("jobs: {", "bad").jobs).toBeNull();
    const usesOnly = translateWorkflow(
      "on: [push]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
      "uses-only",
    );
    expect(usesOnly.jobs).toBeNull();
    expect(usesOnly.warnings.join("\n")).toContain("no convertible jobs");
  });

  it("drops steps whose run was only unsupported expressions", () => {
    const res = translateWorkflow(
      "on: [push]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${{ needs.a.outputs.b }}\n      - run: echo ok\n",
      "expr",
    );
    expect(res.jobs).not.toBeNull();
    expect((res.jobs as NonNullable<typeof res.jobs>)[0].steps).toHaveLength(1);
    expect(res.warnings.join("\n")).toContain("unsupported expressions");
  });
});

describe("evaluateCommonCondition", () => {
  const push = { event: "push", branch: "main", repo: "o/r" };
  it("decides event_name, ref, ref_name, and repository guards", () => {
    expect(evaluateCommonCondition("github.event_name == 'pull_request'", push)).toBe(false);
    expect(evaluateCommonCondition("github.event_name == 'push'", push)).toBe(true);
    expect(evaluateCommonCondition("github.event_name == 'workflow_dispatch'", { event: "dispatch" })).toBe(true);
    expect(evaluateCommonCondition("${{ github.ref == 'refs/heads/main' }}", push)).toBe(true);
    expect(evaluateCommonCondition("github.ref != 'refs/heads/main'", push)).toBe(false);
    expect(evaluateCommonCondition("github.ref_name == 'main'", push)).toBe(true);
    expect(evaluateCommonCondition("github.repository == 'o/r'", push)).toBe(true);
    expect(evaluateCommonCondition("github.repository == 'other/r'", push)).toBe(false);
    expect(evaluateCommonCondition("!github.event_name == 'schedule'", push)).toBe(true);
  });
  it("leaves shapes outside the subset undecided", () => {
    expect(evaluateCommonCondition("needs.build.result == 'success'", push)).toBeUndefined();
    expect(evaluateCommonCondition("github.event_name == 'push' && github.ref == 'refs/heads/main'", push)).toBeUndefined();
    expect(evaluateCommonCondition(undefined, push)).toBeUndefined();
  });
});

describe("translateWorkflow job guards", () => {
  const GUARDED = `
name: Guarded
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo verify
  preview:
    needs: verify
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: echo preview
`;

  it("skips jobs whose guard is false for this event", () => {
    const pushed = translateWorkflow(GUARDED, "guarded", { event: "push", branch: "main" });
    expect(pushed.jobs?.map((j) => j.name)).toEqual(["verify"]);
    expect(pushed.warnings.join("\n")).toContain("preview skipped");
    const pr = translateWorkflow(GUARDED, "guarded", { event: "pull_request", branch: "feat", baseBranch: "main" });
    expect(pr.jobs?.map((j) => j.name)).toEqual(["verify", "preview"]);
  });

  it("keeps undeciable guards with the translator's warning", () => {
    const text = GUARDED.replace("github.event_name == 'pull_request'", "${{ needs.verify.result == 'success' }}");
    const pushed = translateWorkflow(text, "guarded", { event: "push", branch: "main" });
    expect(pushed.jobs?.map((j) => j.name)).toEqual(["verify", "preview"]);
    expect(pushed.warnings.join("\n")).toContain("unsupported job condition");
  });
});

describe("mergeWorkflows", () => {
  const build = (name: string): { name: string; jobs: NonNullable<ReturnType<typeof translateWorkflow>["jobs"]> } => ({
    name,
    jobs: translateWorkflow(`on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${name}\n`, name)
      .jobs as NonNullable<ReturnType<typeof translateWorkflow>["jobs"]>,
  });

  it("prefixes names and needs when merging multiple workflows", () => {
    const left = build("Alpha");
    const right = translateWorkflow(
      "on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo b\n  test:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo t\n",
      "Beta",
    ).jobs as NonNullable<ReturnType<typeof translateWorkflow>["jobs"]>;
    const merged = mergeWorkflows([left, { name: "Beta", jobs: right }]);
    expect(merged.jobs).not.toBeNull();
    const jobs = merged.jobs as NonNullable<typeof merged.jobs>;
    expect(jobs.map((j) => j.name)).toEqual(["Alpha: build", "Beta: build", "Beta: test"]);
    const test = jobs.find((j) => j.name === "Beta: test");
    expect(test?.needs).toEqual(["Beta: build"]);
    expect(test?.env?.FLARE_WORKFLOW).toBe("Beta");
  });

  it("keeps single-workflow names unprefixed but still tags FLARE_WORKFLOW", () => {
    const only = build("Solo");
    const merged = mergeWorkflows([only]);
    expect((merged.jobs as NonNullable<typeof merged.jobs>)[0].name).toBe("build");
    expect((merged.jobs as NonNullable<typeof merged.jobs>)[0].env?.FLARE_WORKFLOW).toBe("Solo");
  });
});

describe("buildCompatJobs", () => {
  const files: WorkflowFile[] = [
    { name: "ci.yml", text: "on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo a\n" },
    { name: "pr.yml", text: "on: [pull_request]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo b\n" },
  ];

  it("selects files by event on the server and runs all files locally", () => {
    const pushed = buildCompatJobs(files, { event: "push", branch: "main" });
    expect(pushed.jobs?.map((j) => j.name)).toEqual(["a"]);
    expect(pushed.used).toEqual(["ci.yml"]);
    const local = buildCompatJobs(files, null);
    expect(local.jobs?.map((j) => j.name)).toEqual(["ci: a", "pr: b"]);
    expect(local.used).toEqual(["ci.yml", "pr.yml"]);
  });

  it("skips eventless files and reports no jobs", () => {
    const out = buildCompatJobs([{ name: "x.yml", text: "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n" }], null);
    expect(out.jobs).toBeNull();
    expect(out.warnings.join("\n")).toContain("no on: triggers");
  });
});

describe("fetchWorkflowFiles", () => {
  const listing = [
    { name: "deploy.yaml", type: "file", download_url: "https://raw.example/deploy.yaml", path: ".github/workflows/deploy.yaml" },
    { name: "ci.yml", type: "file", download_url: "https://raw.example/ci.yml", path: ".github/workflows/ci.yml" },
    { name: "notes.txt", type: "file", download_url: "https://raw.example/notes.txt", path: ".github/workflows/notes.txt" },
  ];

  it("lists and fetches YAML files sorted by name (public path)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/contents/")) return new Response(JSON.stringify(listing), { status: 200 });
      if (url === "https://raw.example/ci.yml" || url === "https://raw.example/deploy.yaml") {
        return new Response(`on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n`, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const out = await fetchWorkflowFiles("o/r", "abc123", null);
      expect(out?.files.map((f) => f.name)).toEqual(["ci.yml", "deploy.yaml"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null for a missing directory and oversized files are skipped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    try {
      expect(await fetchWorkflowFiles("o/r", "abc123", null)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    const big = "x".repeat(70 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/contents/")) {
          return new Response(JSON.stringify([{ name: "big.yml", type: "file", download_url: "https://raw.example/big.yml" }]), {
            status: 200,
          });
        }
        return new Response(big, { status: 200 });
      }),
    );
    try {
      const out = await fetchWorkflowFiles("o/r", "abc123", null);
      expect(out?.files).toEqual([]);
      expect(out?.warnings.join("\n")).toContain("64 KiB");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
