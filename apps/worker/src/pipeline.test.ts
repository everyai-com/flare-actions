import { describe, expect, it } from "vitest";
import {
  cellLabels,
  defaultPipeline,
  emptyProfiles,
  expandMatrixAxes,
  interpolateRun,
  MAX_DEFINITION_BYTES,
  parsePipeline,
  parsePipelineWithProfiles,
  parseProfileName,
  readJobSpec,
  readRetryPolicy,
  seatEligible,
  selectProfileJobs,
  serializeDefinition,
} from "./pipeline";

describe("parsePipeline", () => {
  it("parses jobs with steps", () => {
    const jobs = parsePipeline("jobs:\n  test:\n    steps:\n      - run: node --version\n      - run: npm test\n  lint:\n    steps:\n      - run: npm run lint\n");
    expect(jobs).toEqual([
      { name: "test", steps: [{ run: "node --version" }, { run: "npm test" }] },
      { name: "lint", steps: [{ run: "npm run lint" }] },
    ]);
  });

  it("trims commands", () => {
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: '  echo hi  '\n")).toEqual([
      { name: "a", steps: [{ run: "echo hi" }] },
    ]);
  });

  it("rejects invalid documents", () => {
    expect(parsePipeline("")).toBeNull();
    expect(parsePipeline("just a string")).toBeNull();
    expect(parsePipeline("jobs: []")).toBeNull();
    expect(parsePipeline("jobs: {}")).toBeNull();
    expect(parsePipeline("jobs:\n  a: 42\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps: []\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: ''\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: 42\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - shell: bash\n")).toBeNull();
    expect(parsePipeline("{{{not yaml")).toBeNull();
  });

  it("enforces caps", () => {
    const manyJobs = "jobs:\n" + Array.from({ length: 33 }, (_, i) => `  j${i}:\n    steps:\n      - run: echo\n`).join("");
    expect(parsePipeline(manyJobs)).toBeNull();
    const manySteps = "jobs:\n  a:\n    steps:\n" + "      - run: echo\n".repeat(101);
    expect(parsePipeline(manySteps)).toBeNull();
    expect(parsePipeline("x".repeat(MAX_DEFINITION_BYTES + 1))).toBeNull();
  });
});

describe("defaultPipeline", () => {
  it("returns one echo job", () => {
    expect(defaultPipeline()).toEqual([{ name: "main", steps: [{ run: "echo hello from flare-actions" }] }]);
  });
});

describe("parsePipeline v2 keys", () => {
  it("parses test-selection opt-in and rejects malformed shapes", () => {
    const jobs = parsePipeline(
      "jobs:\n  a:\n    test-selection: true\n    steps:\n      - run: echo\n  b:\n    test-selection:\n      tests: [tests/**/*.test.ts]\n      full-on-profiles: [full]\n      full-on-branches: [main]\n      history-days: 14\n    steps:\n      - run: echo\n",
    );
    expect(jobs?.[0].testSelection).toEqual({});
    expect(jobs?.[1].testSelection).toEqual({
      tests: ["tests/**/*.test.ts"],
      fullOnProfiles: ["full"],
      fullOnBranches: ["main"],
      historyDays: 14,
    });
    expect(parsePipeline("jobs:\n  a:\n    test-selection: false\n    steps:\n      - run: echo\n")?.[0].testSelection).toBeUndefined();
    expect(parsePipeline("jobs:\n  a:\n    test-selection: sometimes\n    steps:\n      - run: echo\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    test-selection:\n      history-days: 99\n    steps:\n      - run: echo\n")).toBeNull();
  });

  it("serializes test-selection into job definitions", () => {
    const jobs = parsePipeline("jobs:\n  a:\n    test-selection: true\n    steps:\n      - run: echo\n");
    expect(jobs).not.toBeNull();
    if (!jobs) throw new Error("parse failed");
    expect(JSON.parse(serializeDefinition(jobs[0], "a")).testSelection).toEqual({});
    const plain = parsePipeline("jobs:\n  a:\n    steps:\n      - run: echo\n");
    if (!plain) throw new Error("parse failed");
    expect("testSelection" in JSON.parse(serializeDefinition(plain[0], "a"))).toBe(false);
  });

  it("parses runs-on labels", () => {
    const jobs = parsePipeline("jobs:\n  a:\n    runs-on: macos\n    steps:\n      - run: echo\n  b:\n    runs-on: [linux, docker]\n    steps:\n      - run: echo\n");
    expect(jobs?.[0].labels).toEqual(["macos"]);
    expect(jobs?.[1].labels).toEqual(["linux", "docker"]);
    expect(parsePipeline("jobs:\n  a:\n    runs-on: 42\n    steps:\n      - run: echo\n")).toBeNull();
  });

  it("expands matrices and interpolates", () => {
    const jobs = parsePipeline(
      "jobs:\n  test:\n    strategy:\n      matrix:\n        node: [18, 20]\n        os: [linux]\n    steps:\n      - run: node-${{ matrix.node }} on ${{ matrix.os }} with ${{ env.TAG }}\n",
    );
    expect(jobs?.map((j) => j.name)).toEqual(["test (node=18, os=linux)", "test (node=20, os=linux)"]);
    expect(jobs?.[0].matrix).toEqual({ node: "18", os: "linux" });
    expect(jobs?.[0].steps[0].run).toBe("node-18 on linux with ${{ env.TAG }}");
    expect(jobs?.[1].steps[0].run).toBe("node-20 on linux with ${{ env.TAG }}");
  });

  it("caps matrix expansion", () => {
    const vals = Array.from({ length: 9 }, (_, i) => i).join(", ");
    expect(
      parsePipeline(`jobs:\n  a:\n    strategy:\n      matrix:\n        x: [${vals}]\n        y: [${vals}]\n    steps:\n      - run: echo\n`),
    ).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    strategy:\n      matrix: []\n    steps:\n      - run: echo\n")).toBeNull();
  });

  it("expands shards with FLARE_SHARD_* env", () => {
    const jobs = parsePipeline("jobs:\n  test:\n    shards: 4\n    steps:\n      - run: npx vitest run --shard=$FLARE_SHARD_INDEX/$FLARE_SHARD_TOTAL\n");
    expect(jobs?.map((j) => j.name)).toEqual(["test (shard=1/4)", "test (shard=2/4)", "test (shard=3/4)", "test (shard=4/4)"]);
    expect(jobs?.[0].base).toBe("test");
    expect(jobs?.[2].env).toEqual({ FLARE_SHARD_INDEX: "3", FLARE_SHARD_TOTAL: "4" });
    expect(jobs?.[0].matrix).toBeUndefined();
  });

  it("multiplies shards with a matrix and enforces the caps", () => {
    const jobs = parsePipeline(
      "jobs:\n  test:\n    shards: 2\n    strategy:\n      matrix:\n        node: [18, 20]\n    env:\n      TAG: ci\n    steps:\n      - run: echo ${{ matrix.node }}\n",
    );
    expect(jobs?.map((j) => j.name)).toEqual([
      "test (node=18, shard=1/2)",
      "test (node=18, shard=2/2)",
      "test (node=20, shard=1/2)",
      "test (node=20, shard=2/2)",
    ]);
    expect(jobs?.[0].env).toEqual({ TAG: "ci", FLARE_SHARD_INDEX: "1", FLARE_SHARD_TOTAL: "2" });
    expect(parsePipeline("jobs:\n  a:\n    shards: 1\n    steps:\n      - run: echo\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    shards: 9\n    steps:\n      - run: echo\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    shards: 2.5\n    steps:\n      - run: echo\n")).toBeNull();
  });

  it("validates needs references and cycles", () => {
    const ok = parsePipeline("jobs:\n  a:\n    steps:\n      - run: echo\n  b:\n    needs: a\n    steps:\n      - run: echo\n");
    expect(ok?.[1].needs).toEqual(["a"]);
    expect(parsePipeline("jobs:\n  a:\n    needs: ghost\n    steps:\n      - run: echo\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    needs: a\n    steps:\n      - run: echo\n")).toBeNull();
    expect(
      parsePipeline("jobs:\n  a:\n    needs: b\n    steps:\n      - run: echo\n  b:\n    needs: a\n    steps:\n      - run: echo\n"),
    ).toBeNull();
  });

  it("parses and serializes the retry policy", () => {
    const jobs = parsePipeline("jobs:\n  a:\n    retry: 2\n    steps:\n      - run: x\n");
    expect(jobs?.[0].retry).toBe(2);
    expect(parsePipeline("jobs:\n  a:\n    retry: 0\n    steps:\n      - run: x\n")?.[0].retry).toBe(0);
    expect(parsePipeline("jobs:\n  a:\n    retry: 9\n    steps:\n      - run: x\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    retry: 1.5\n    steps:\n      - run: x\n")).toBeNull();
    const def = serializeDefinition({ name: "a", steps: [{ run: "x" }], retry: 2 }, "a");
    expect(JSON.parse(def).retry).toBe(2);
    expect(readRetryPolicy(def)).toBe(2);
    expect(readRetryPolicy(JSON.stringify({ steps: [] }))).toBe(0);
    expect(readRetryPolicy("junk")).toBe(0);
  });

  it("parses per-step timeout/shell and job-level conditions", () => {
    const jobs = parsePipeline(
      "jobs:\n  a:\n    if: always()\n    steps:\n      - run: x\n        timeout-minutes: 5\n        shell: bash\n",
    );
    expect(jobs?.[0].if).toBe("always()");
    expect(jobs?.[0].steps[0]).toEqual({ run: "x", timeoutMinutes: 5, shell: "bash" });
    expect(parsePipeline("jobs:\n  a:\n    if: github.ref == 'x'\n    steps:\n      - run: x\n")).toBeNull();
    const rich = parsePipeline("jobs:\n  a:\n    if: failure() && needs.build.result == 'success'\n    steps:\n      - run: x\n");
    expect(rich?.[0].if).toBe("failure() && needs.build.result == 'success'");
    expect(parsePipeline("jobs:\n  a:\n    if: steps.prep.outputs.sha == 'a'\n    steps:\n      - run: x\n")).toBeNull();
    const stepRef = parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        if: steps.prep.outputs.sha == 'a'\n");
    expect(stepRef?.[0].steps[0].if).toBe("steps.prep.outputs.sha == 'a'");
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        timeout-minutes: 0\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        shell: 'sh -c evil'\n")).toBeNull();
    const def = serializeDefinition({ name: "a", steps: [{ run: "x" }], if: "failure()" }, "a");
    expect(readJobSpec(def, "a").if).toBe("failure()");
    expect(readJobSpec("junk", "a").if).toBeUndefined();
  });

  it("parses step conditions and rejects expression soup", () => {
    const ok = parsePipeline("jobs:\n  a:\n    steps:\n      - run: clean\n        if: always()\n      - run: notify\n        if: failure()\n");
    expect(ok?.[0].steps).toEqual([
      { run: "clean", if: "always()" },
      { run: "notify", if: "failure()" },
    ]);
    const matrix = parsePipeline(
      "jobs:\n  a:\n    strategy:\n      matrix:\n        n: [1]\n    steps:\n      - run: clean-${{ matrix.n }}\n        if: ALWAYS()\n",
    );
    expect(matrix?.[0].steps[0]).toEqual({ run: "clean-1", if: "ALWAYS()" });
    expect(
      parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        if: github.event_name == 'push'\n"),
    ).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        if: 42\n")).toBeNull();
  });

  it("parses continue-on-error and preserves it through interpolation", () => {
    const jobs = parsePipeline(
      "jobs:\n  a:\n    strategy:\n      matrix:\n        n: [1]\n    steps:\n      - run: flaky-${{ matrix.n }}\n        continue-on-error: true\n      - run: hard\n",
    );
    expect(jobs?.[0].steps[0]).toEqual({ run: "flaky-1", continueOnError: true });
    expect(jobs?.[0].steps[1].continueOnError).toBeUndefined();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        continue-on-error: maybe\n")).toBeNull();
  });

  it("parses concurrency, container, services, cache, artifacts, env, timeout", () => {
    const jobs = parsePipeline(
      "jobs:\n  a:\n    concurrency:\n      group: main\n      cancel-in-progress: true\n    container: node:20\n" +
        "    services:\n      db:\n        image: postgres:16\n        ports: ['5432:5432']\n" +
        "    cache:\n      key: node-modules\n      paths: [node_modules]\n" +
        "    artifacts:\n      name: dist\n      paths: [dist]\n" +
        "    env:\n      TAG: v1\n    timeout-minutes: 30\n    steps:\n      - run: echo $TAG\n",
    );
    expect(jobs?.[0].group).toBe("main");
    expect(jobs?.[0].cancelInProgress).toBe(true);
    expect(jobs?.[0].container).toBe("node:20");
    expect(jobs?.[0].services).toEqual({ db: { image: "postgres:16", ports: ["5432:5432"] } });
    expect(jobs?.[0].cache).toEqual({ key: "node-modules", paths: ["node_modules"] });
    expect(jobs?.[0].artifacts).toEqual({ name: "dist", paths: ["dist"] });
    expect(jobs?.[0].env).toEqual({ TAG: "v1" });
    expect(jobs?.[0].timeoutMinutes).toBe(30);
    const flat = parsePipeline("jobs:\n  a:\n    concurrency: main\n    steps:\n      - run: echo\n");
    expect(flat?.[0].group).toBe("main");
    expect(flat?.[0].cancelInProgress).toBeUndefined();
    expect(parsePipeline("jobs:\n  a:\n    cache:\n      key: '../x'\n      paths: [y]\n    steps:\n      - run: echo\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    timeout-minutes: 0\n    steps:\n      - run: echo\n")).toBeNull();
  });

  it("parses step ids and job outputs with refs", () => {
    const jobs = parsePipeline(
      "jobs:\n  a:\n    outputs:\n      image: build.tag\n    steps:\n      - run: echo x\n        id: build\n",
    );
    expect(jobs?.[0].steps).toEqual([{ run: "echo x", id: "build" }]);
    expect(jobs?.[0].outputs).toEqual({ image: "build.tag" });
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        id: 9bad\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: x\n        id: dup\n      - run: y\n        id: dup\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    outputs:\n      bad: no-dot\n    steps:\n      - run: x\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    outputs: {}\n    steps:\n      - run: x\n")).toBeNull();
  });

  it("parses cache restore-keys (list or single string) with a cap", () => {
    const list = parsePipeline(
      "jobs:\n  a:\n    cache:\n      key: node-abc\n      paths: [node_modules]\n      restore-keys: [node-, npm-]\n    steps:\n      - run: echo\n",
    );
    expect(list?.[0].cache).toEqual({ key: "node-abc", paths: ["node_modules"], restoreKeys: ["node-", "npm-"] });
    const single = parsePipeline(
      "jobs:\n  a:\n    cache:\n      key: node-abc\n      paths: [node_modules]\n      restore-keys: node-\n    steps:\n      - run: echo\n",
    );
    expect(single?.[0].cache).toEqual({ key: "node-abc", paths: ["node_modules"], restoreKeys: ["node-"] });
    const many = Array.from({ length: 11 }, (_, i) => `p${i}-`).join(", ");
    expect(
      parsePipeline(`jobs:\n  a:\n    cache:\n      key: k\n      paths: [y]\n      restore-keys: [${many}]\n    steps:\n      - run: echo\n`),
    ).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    cache:\n      key: k\n      paths: [y]\n      restore-keys: ['../x']\n    steps:\n      - run: echo\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    cache:\n      key: k\n      paths: [y]\n      restore-keys: []\n    steps:\n      - run: echo\n")).toBeNull();
  });

  it("parses test-reports paths and rejects bad shapes", () => {
    const jobs = parsePipeline(
      "jobs:\n  a:\n    test-reports:\n      paths: [junit.xml, reports]\n    steps:\n      - run: echo\n",
    );
    expect(jobs?.[0].testReports).toEqual({ paths: ["junit.xml", "reports"] });
    expect(parsePipeline("jobs:\n  a:\n    test-reports:\n      paths: []\n    steps:\n      - run: echo\n")).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    test-reports: junit.xml\n    steps:\n      - run: echo\n")).toBeNull();
  });
});

describe("matrix include/exclude", () => {
  it("expands include/exclude with GitHub semantics and interpolates include-only keys", () => {
    const jobs = parsePipeline(
      "jobs:\n  test:\n    strategy:\n      matrix:\n        os: [linux]\n        node: [18, 20]\n        include:\n          - node: 20\n            npm: 10\n          - node: 22\n            experimental: true\n        exclude:\n          - node: 18\n    steps:\n      - run: echo ${{ matrix.node }} ${{ matrix.npm }} ${{ matrix.experimental }}\n",
    );
    expect(jobs?.map((j) => j.name)).toEqual(["test (os=linux, node=20, npm=10)", "test (node=22, experimental=true)"]);
    expect(jobs?.map((j) => j.matrix)).toEqual([
      { os: "linux", node: "20", npm: "10" },
      { node: "22", experimental: "true" },
    ]);
    // A key this cell lacks is "" (Actions semantics; a literal ${{ }} breaks sh).
    expect(jobs?.[0].steps[0].run).toBe("echo 20 10 ");
    expect(jobs?.[1].steps[0].run).toBe("echo 22  true");
    expect(jobs?.every((j) => j.base === "test")).toBe(true);
  });

  it("accepts include-only matrices and rejects invalid include/exclude", () => {
    const only = parsePipeline("jobs:\n  a:\n    strategy:\n      matrix:\n        include:\n          - t: x\n          - t: y\n    steps:\n      - run: echo ${{ matrix.t }}\n");
    expect(only?.map((j) => j.steps[0].run)).toEqual(["echo x", "echo y"]);
    const bad = (m: string) => parsePipeline(`jobs:\n  a:\n    strategy:\n      matrix:\n${m}    steps:\n      - run: echo\n`);
    expect(bad("        n: [1]\n        exclude:\n          - other: 1\n")).toBeNull();
    expect(bad("        n: [1]\n        exclude:\n          - n: 1\n")).toBeNull();
    expect(bad("        n: [1]\n        include: nope\n")).toBeNull();
    expect(bad("        n: [1]\n        include:\n          - v: [1]\n")).toBeNull();
  });
});

describe("matrix helpers", () => {
  it("expands axes cartesianly", () => {
    expect(expandMatrixAxes({ a: ["1", "2"], b: ["x"] })).toEqual([
      { a: "1", b: "x" },
      { a: "2", b: "x" },
    ]);
  });

  it("interpolates known expressions only", () => {
    expect(interpolateRun("echo ${{ matrix.v }} ${{ env.K }} ${{ secrets.T }} $HOME", { v: "1" }, { K: "k" })).toBe(
      "echo 1 k ${{ secrets.T }} $HOME",
    );
  });
});

describe("job definition serialization", () => {
  it("round-trips scheduling fields", () => {
    const def = serializeDefinition(
      { name: "b (x=1)", steps: [{ run: "echo" }], needs: ["a"], group: "g" },
      "b",
    );
    expect(readJobSpec(def, "b (x=1)")).toEqual({ base: "b", needs: ["a"], group: "g" });
  });

  it("tolerates legacy definitions", () => {
    expect(readJobSpec(JSON.stringify({ steps: [{ run: "echo" }] }), "main")).toEqual({ base: "main", needs: [] });
    expect(readJobSpec("bogus", "main")).toEqual({ base: "main", needs: [] });
  });

  it("serializes test-reports into the definition", () => {
    const def = serializeDefinition(
      { name: "a", steps: [{ run: "echo" }], testReports: { paths: ["junit.xml"] } },
      "a",
    );
    expect(JSON.parse(def).testReports).toEqual({ paths: ["junit.xml"] });
  });

  it("parses retain-on-failure and serializes it into the definition", () => {
    const jobs = parsePipeline("jobs:\n  a:\n    retain-on-failure: true\n    steps:\n      - run: echo\n");
    expect(jobs?.[0].retainOnFailure).toBe(true);
    expect(parsePipeline("jobs:\n  a:\n    retain-on-failure: yes-please\n    steps:\n      - run: echo\n")).toBeNull();
    const def = serializeDefinition({ name: "a", steps: [{ run: "echo" }], retainOnFailure: true }, "a");
    expect(JSON.parse(def).retainOnFailure).toBe(true);
  });

  it("parses browser-checks and serializes them into the definition", () => {
    const yaml =
      "jobs:\n  a:\n    steps:\n      - run: echo\n    browser-checks:\n" +
      "      - name: home\n        url: https://example.com/\n        expect-title: Example\n        screenshot: false\n";
    const jobs = parsePipeline(yaml);
    expect(jobs?.[0].browserChecks).toEqual([
      { name: "home", url: "https://example.com/", expectTitle: "Example", screenshot: false },
    ]);
    const def = serializeDefinition(
      {
        name: "a",
        steps: [{ run: "echo" }],
        browserChecks: [{ name: "home", url: "https://example.com/", expectText: "x" }],
      },
      "a",
    );
    expect(JSON.parse(def).browserChecks).toEqual([{ name: "home", url: "https://example.com/", expectText: "x" }]);
  });

  it("parses egress allowlists and serializes them into the definition", () => {
    const yaml =
      "jobs:\n  a:\n    steps:\n      - run: echo\n    egress:\n      allow:\n        - Example.COM\n        - api.example.com\n";
    const jobs = parsePipeline(yaml);
    expect(jobs?.[0].egress).toEqual({ allow: ["example.com", "api.example.com"] });
    const def = serializeDefinition({ name: "a", steps: [{ run: "echo" }], egress: { allow: ["example.com"] } }, "a");
    expect(JSON.parse(def).egress).toEqual({ allow: ["example.com"] });
  });

  it("rejects malformed egress allowlists", () => {
    const bad = (allow: string) => parsePipeline(`jobs:\n  a:\n    steps:\n      - run: echo\n    egress:\n${allow}\n`);
    expect(bad("      allow: notalist")).toBeNull();
    expect(bad("      allow: []")).toBeNull();
    expect(bad("      allow:\n        - https://example.com/")).toBeNull();
    expect(bad("      allow:\n        - bad_domain!")).toBeNull();
    expect(bad("      allow:\n        - dup.com\n        - dup.com")).toBeNull();
    expect(bad(`      allow:\n${Array.from({ length: 33 }, (_, i) => `        - h${i}.example.com`).join("\n")}`)).toBeNull();
    expect(parsePipeline("jobs:\n  a:\n    steps:\n      - run: echo\n    egress: allowlist")).toBeNull();
  });

  it("rejects malformed browser-checks", () => {
    const bad = (checks: string) => parsePipeline(`jobs:\n  a:\n    steps:\n      - run: echo\n    browser-checks:\n${checks}\n`);
    expect(bad("      - name: home\n        url: http://example.com/\n        expect-title: x\n")).toBeNull();
    expect(bad("      - name: home\n        url: https://example.com/\n")).toBeNull();
    expect(bad("      - name: home\n        url: not-a-url\n        expect-title: x\n")).toBeNull();
    expect(bad("      - name: BAD NAME\n        url: https://example.com/\n        expect-title: x\n")).toBeNull();
    expect(
      bad(
        "      - name: a\n        url: https://example.com/\n        expect-title: x\n      - name: a\n        url: https://example.com/\n        expect-title: x\n",
      ),
    ).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => `      - name: c${i}\n        url: https://example.com/\n        expect-title: x\n`).join(
      "",
    );
    expect(bad(eleven)).toBeNull();
  });

  it("parses check actions and serializes them into the definition", () => {
    const yaml =
      "jobs:\n  a:\n    steps:\n      - run: echo\n    browser-checks:\n" +
      "      - name: login\n        url: https://example.com/login\n        actions:\n" +
      "          - type: '#user'\n            text: demo@example.com\n" +
      "          - click: '#submit'\n" +
      "          - wait: '#dashboard'\n" +
      "          - wait-text: Welcome\n" +
      "        expect-text: Welcome\n";
    const checks = parsePipeline(yaml)?.[0].browserChecks;
    expect(checks).toEqual([
      {
        name: "login",
        url: "https://example.com/login",
        expectText: "Welcome",
        actions: [
          { kind: "type", selector: "#user", text: "demo@example.com" },
          { kind: "click", selector: "#submit" },
          { kind: "wait", selector: "#dashboard" },
          { kind: "wait-text", text: "Welcome" },
        ],
      },
    ]);
    const def = serializeDefinition({ name: "a", steps: [{ run: "echo" }], browserChecks: checks }, "a");
    expect(JSON.parse(def).browserChecks[0].actions).toHaveLength(4);
  });

  it("rejects malformed check actions", () => {
    const bad = (actions: string) =>
      parsePipeline(
        `jobs:\n  a:\n    steps:\n      - run: echo\n    browser-checks:\n      - name: x\n        url: https://example.com/\n        expect-text: y\n${actions}\n`,
      );
    expect(bad("        actions: []")).toBeNull();
    expect(bad("        actions: notalist")).toBeNull();
    expect(bad("        actions:\n          - clik: '#x'")).toBeNull();
    expect(bad("        actions:\n          - click: '#x'\n            wait: '#y'")).toBeNull();
    expect(bad("        actions:\n          - type: '#x'")).toBeNull();
    expect(bad("        actions:\n          - click: '#x'\n            text: stray")).toBeNull();
    expect(bad("        actions:\n          - wait-text: ok\n            text: stray")).toBeNull();
    expect(bad("        actions:\n          - click: ''")).toBeNull();
    expect(bad("        actions:\n          - click: 42")).toBeNull();
    expect(bad("        actions:\n          - wait-text: ''")).toBeNull();
    const eleven = Array.from({ length: 11 }, () => "          - click: '#x'").join("\n");
    expect(bad(`        actions:\n${eleven}`)).toBeNull();
  });

  it("accepts preview-URL templates and rejects bad placeholders", () => {
    const good = (url: string) =>
      parsePipeline(`jobs:\n  a:\n    steps:\n      - run: echo\n    browser-checks:\n      - name: x\n        url: ${url}\n        expect-text: y\n`);
    expect(good("https://app-git-{branch}.example.com/")?.[0].browserChecks?.[0].url).toBe(
      "https://app-git-{branch}.example.com/",
    );
    expect(good("https://example.com/{pr}/{sha}/{short_sha}")?.[0].browserChecks).toHaveLength(1);
    const bad = (url: string) =>
      parsePipeline(`jobs:\n  a:\n    steps:\n      - run: echo\n    browser-checks:\n      - name: x\n        url: '${url}'\n        expect-text: y\n`);
    expect(bad("https://{repo}.example.com/")).toBeNull();
    expect(bad("https://example.com/{branch")).toBeNull();
    expect(bad("https://example.com/x}")).toBeNull();
  });
});

describe("seatEligible", () => {
  const def = (extra = {}) => JSON.stringify({ steps: [{ run: "echo" }], base: "a", ...extra });
  it("accepts plain and linux-labeled jobs", () => {
    expect(seatEligible(def())).toBe(true);
    expect(seatEligible(def({ labels: ["linux"] }))).toBe(true);
    expect(seatEligible(JSON.stringify({ steps: [{ run: "echo" }] }))).toBe(true);
    expect(seatEligible("bogus")).toBe(true);
  });

  it("rejects docker and special-label jobs", () => {
    expect(seatEligible(def({ container: "node:20" }))).toBe(false);
    expect(seatEligible(def({ services: { db: { image: "pg" } } }))).toBe(false);
    expect(seatEligible(def({ labels: ["macos"] }))).toBe(false);
    expect(seatEligible(def({ labels: ["linux", "gpu"] }))).toBe(false);
    expect(seatEligible(def({ labels: "linux" }))).toBe(false);
  });
});

describe("parseProfileName", () => {
  it("accepts slugs and rejects everything else", () => {
    expect(parseProfileName("smoke")).toEqual({ profile: "smoke" });
    expect(parseProfileName("full.2-nightly_x")).toEqual({ profile: "full.2-nightly_x" });
    expect(parseProfileName("")).toHaveProperty("error");
    expect(parseProfileName("has space")).toHaveProperty("error");
    expect(parseProfileName("x".repeat(65))).toHaveProperty("error");
    expect(parseProfileName(42)).toHaveProperty("error");
  });
});

describe("pipeline profiles", () => {
  const doc = (profiles: string) =>
    "jobs:\n" +
    "  lint:\n    tags: [fast]\n    steps:\n      - run: npm run lint\n" +
    "  unit:\n    tags: [fast]\n    steps:\n      - run: npm test\n" +
    "  e2e:\n    needs: [unit]\n    steps:\n      - run: ./e2e.sh\n" +
    profiles;

  it("parses job tags and serializes them into the definition", () => {
    const jobs = parsePipeline(doc(""));
    expect(jobs?.[0].tags).toEqual(["fast"]);
    expect(jobs?.[2].tags).toBeUndefined();
    const def = serializeDefinition({ name: "a", steps: [{ run: "echo" }], tags: ["smoke"] }, "a");
    expect(JSON.parse(def).tags).toEqual(["smoke"]);
    expect(JSON.parse(serializeDefinition({ name: "a", steps: [{ run: "echo" }] }, "a")).tags).toBeUndefined();
  });

  it("rejects malformed tags", () => {
    expect(parsePipeline(doc("").replace("tags: [fast]", "tags: fast!"))).toBeNull();
    expect(parsePipeline(doc("").replace("tags: [fast]", "tags: []"))).toBeNull();
    expect(parsePipeline(doc("").replace("tags: [fast]", "tags: [has space]"))).toBeNull();
  });

  it("parses the profiles block with per-event defaults", () => {
    const parsed = parsePipelineWithProfiles(
      doc("profiles:\n  smoke:\n    include: [fast]\n    exclude: [e2e]\n  full: {}\n  defaults:\n    push: smoke\n    schedule: full\n"),
    );
    expect(parsed?.profiles).toEqual({
      profiles: { smoke: { include: ["fast"], exclude: ["e2e"] }, full: {} },
      defaults: { push: "smoke", schedule: "full" },
    });
    // parsePipeline still returns jobs only.
    expect(parsePipeline(doc("profiles:\n  smoke:\n    include: [fast]\n"))?.map((j) => j.name)).toEqual([
      "lint",
      "unit",
      "e2e",
    ]);
  });

  it("treats a bare profile key as select-all", () => {
    const parsed = parsePipelineWithProfiles(doc("profiles:\n  full:\n"));
    expect(parsed?.profiles.profiles).toEqual({ full: {} });
  });

  it("rejects malformed profiles blocks", () => {
    expect(parsePipelineWithProfiles(doc("profiles: [smoke]"))).toBeNull();
    expect(parsePipelineWithProfiles(doc("profiles:\n  bad name:\n    include: [lint]\n"))).toBeNull();
    expect(parsePipelineWithProfiles(doc("profiles:\n  smoke: fast\n"))).toBeNull();
    expect(parsePipelineWithProfiles(doc("profiles:\n  smoke:\n    include: []\n"))).toBeNull();
    expect(parsePipelineWithProfiles(doc("profiles:\n  smoke:\n    include: 42\n"))).toBeNull();
    // A bare string is one entry, like `needs:` and `runs-on:`.
    expect(
      parsePipelineWithProfiles(doc("profiles:\n  smoke:\n    include: fast\n"))?.profiles.profiles,
    ).toEqual({ smoke: { include: ["fast"] } });
    expect(parsePipelineWithProfiles(doc("profiles:\n  smoke:\n    include: [lint]\n  defaults: smoke\n"))).toBeNull();
    expect(parsePipelineWithProfiles(doc("profiles:\n  smoke:\n    include: [lint]\n  defaults:\n    deploy: smoke\n"))).toBeNull();
    expect(parsePipelineWithProfiles(doc("profiles:\n  smoke:\n    include: [lint]\n  defaults:\n    push: missing\n"))).toBeNull();
    // The whole file fails closed, through both entry points.
    expect(parsePipeline(doc("profiles:\n  smoke:\n    include: []\n"))).toBeNull();
  });

  it("returns empty profiles when the block is absent", () => {
    expect(parsePipelineWithProfiles(doc(""))?.profiles).toEqual(emptyProfiles());
  });
});

describe("selectProfileJobs", () => {
  const doc = (profiles: string) =>
    "jobs:\n" +
    "  lint:\n    tags: [fast]\n    steps:\n      - run: npm run lint\n" +
    "  unit:\n    tags: [fast]\n    steps:\n      - run: npm test\n" +
    "  e2e:\n    tags: [slow]\n    needs: [unit]\n    steps:\n      - run: ./e2e.sh\n" +
    profiles;
  const parsed = parsePipelineWithProfiles(
    doc("profiles:\n  smoke:\n    include: [fast]\n  nofast:\n    exclude: [fast]\n  full: {}\n  defaults:\n    push: smoke\n    pull_request: smoke\n    schedule: full\n"),
  );
  const jobs = parsed?.jobs ?? [];
  const profiles = parsed?.profiles ?? emptyProfiles();

  it("returns every job untouched when nothing selects a profile", () => {
    const out = selectProfileJobs(jobs, profiles, { event: "dispatch" });
    expect(out).toEqual({ jobs, profile: null });
    const bare = parsePipelineWithProfiles(doc(""));
    const bareOut = selectProfileJobs(bare?.jobs ?? [], bare?.profiles ?? emptyProfiles(), { event: "push" });
    if ("error" in bareOut) throw new Error("unexpected selection error");
    expect(bareOut.profile).toBeNull();
    expect(bareOut.jobs.map((j) => j.name)).toEqual(["lint", "unit", "e2e"]);
  });

  it("selects by job name or tag, excludes after includes", () => {
    const byName = selectProfileJobs(jobs, profiles, { override: "smoke" });
    if ("error" in byName) throw new Error("unexpected selection error");
    expect(byName.profile).toBe("smoke");
    expect(byName.jobs.map((j) => j.name)).toEqual(["lint", "unit"]);
    const excluded = selectProfileJobs(jobs, profiles, { override: "nofast" });
    if ("error" in excluded) throw new Error("unexpected selection error");
    expect(excluded.jobs.map((j) => j.name)).toEqual(["e2e"]);
  });

  it("drops needs edges into excluded jobs", () => {
    const out = selectProfileJobs(jobs, profiles, { override: "nofast" });
    if ("error" in out) throw new Error("unexpected selection error");
    expect(out.jobs[0].needs).toEqual([]);
  });

  it("matches matrix cells by base name", () => {
    const matrixed = parsePipelineWithProfiles(
      "jobs:\n  test:\n    tags: [fast]\n    strategy:\n      matrix:\n        node: [18, 20]\n    steps:\n      - run: npm test\n  e2e:\n    steps:\n      - run: ./e2e.sh\nprofiles:\n  smoke:\n    include: [fast]\n",
    );
    const out = selectProfileJobs(matrixed?.jobs ?? [], matrixed?.profiles ?? emptyProfiles(), { override: "smoke" });
    if ("error" in out) throw new Error("unexpected selection error");
    expect(out.jobs.map((j) => j.name)).toEqual(["test (node=18)", "test (node=20)"]);
  });

  it("resolves override > schedule > event default", () => {
    expect(selectProfileJobs(jobs, profiles, { event: "push" })).toMatchObject({ profile: "smoke" });
    expect(selectProfileJobs(jobs, profiles, { event: "push", scheduleProfile: "full" })).toMatchObject({ profile: "full" });
    expect(selectProfileJobs(jobs, profiles, { event: "push", scheduleProfile: "full", override: "nofast" })).toMatchObject({
      profile: "nofast",
    });
  });

  it("fails closed on unknown or empty selections", () => {
    expect(selectProfileJobs(jobs, profiles, { override: "missing" })).toMatchObject({
      error: expect.stringContaining('unknown profile "missing"'),
    });
    expect(selectProfileJobs(jobs, profiles, { scheduleProfile: "missing" })).toHaveProperty("error");
    expect(selectProfileJobs(jobs, emptyProfiles(), { override: "smoke" })).toMatchObject({
      error: expect.stringContaining("defines no profiles"),
    });
    const narrow = parsePipelineWithProfiles(doc("profiles:\n  none:\n    include: [no-such-tag]\n"));
    expect(
      selectProfileJobs(narrow?.jobs ?? [], narrow?.profiles ?? emptyProfiles(), { override: "none" }),
    ).toMatchObject({ error: expect.stringContaining("selected no jobs") });
  });
});

describe("matrix runs-on", () => {
  it("resolves ${{ matrix.os }} per cell to portable labels", () => {
    const yml = "jobs:\n  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-14, gpu-box]\n    steps:\n      - run: echo hi\n";
    const jobs = parsePipeline(yml);
    expect(jobs?.map((j) => j.labels)).toEqual([["linux"], ["macos"], ["gpu-box"]]);
  });
  it("keeps literal labels and fails closed on refs that resolve to nothing or to a non-label", () => {
    expect(cellLabels(["self-hosted", "${{ matrix.os }}"], { os: "ubuntu-22.04" })).toEqual(["self-hosted", "linux"]);
    expect(cellLabels(["ubuntu-latest", "${{ matrix.gpu }}"], { os: "x" })).toBeNull();
    expect(cellLabels(["${{ matrix.r }}"], { r: "a,b" })).toBeNull();
    expect(cellLabels(["${{ matrix.r }}"], { r: "x".repeat(65) })).toBeNull();
  });
  it("rejects a matrix whose include-only runner leaves other cells unlabeled", () => {
    const yml = "jobs:\n  t:\n    runs-on: ['${{ matrix.runner }}']\n    strategy:\n      matrix:\n        node: [20, 22]\n        include:\n          - node: 22\n            runner: gpu\n    steps:\n      - run: echo hi\n";
    expect(parsePipeline(yml)).toBeNull();
  });
});

describe("interpolateRun output refs", () => {
  it("rewrites steps/needs output refs to env reads", () => {
    expect(interpolateRun('echo "${{ steps.meta.outputs.tag }}" ${{ needs.build-app.result }}', {}, {})).toBe(
      'echo "${FLARE_STEPS_META_TAG}" ${FLARE_NEEDS_BUILD_APP_RESULT}',
    );
  });
  it("blanks matrix keys a cell lacks, keeps other expressions", () => {
    expect(interpolateRun("[${{ matrix.experimental }}] ${{ github.sha }}", { node: "20" }, {})).toBe("[] ${{ github.sha }}");
    expect(interpolateRun("[${{ matrix.x }}]", {}, {})).toBe("[${{ matrix.x }}]");
  });
});
