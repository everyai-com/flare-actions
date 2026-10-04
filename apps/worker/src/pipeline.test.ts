import { describe, expect, it } from "vitest";
import {
  defaultPipeline,
  expandMatrixAxes,
  interpolateRun,
  MAX_DEFINITION_BYTES,
  parsePipeline,
  readJobSpec,
  readRetryPolicy,
  seatEligible,
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
