import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifactFiles, collectTestReportXml, runJob, sanitizeArtifactName, type JobClient } from "./job";

function fakeClient(store = new Map<string, Uint8Array>()): JobClient & { store: Map<string, Uint8Array>; artifacts: Map<string, Uint8Array>; reports: string[] } {
  const artifacts = new Map<string, Uint8Array>();
  const reports: string[] = [];
  return {
    store,
    artifacts,
    reports,
    getCache: async (k: string) => store.get(k) ?? null,
    putCache: async (k: string, v: Uint8Array) => {
      store.set(k, v);
    },
    uploadArtifact: async (_job: string, name: string, v: Uint8Array) => {
      artifacts.set(name, v);
    },
    uploadTestReport: async (_job: string, xml: string) => {
      reports.push(xml);
      return { total: 1, passed: 1, failed: 0, errors: 0, skipped: 0, truncated: false };
    },
  };
}

const fakeCtl = (available: boolean, events: string[] = []) => ({
  available: async () => available,
  start: async (_job: string, svcs: Record<string, unknown>) => {
    events.push(`start:${Object.keys(svcs).join(",")}`);
    return Object.keys(svcs).map((name) => ({ name, containerName: `c-${name}` }));
  },
  stop: async () => {
    events.push("stop");
  },
});

describe("runJob", () => {
  it("runs steps with env and matrix propagation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-"));
    try {
      const res = await runJob(
        { steps: [{ run: "echo $TAG-$FLARE_MATRIX_NODE" }], env: { TAG: "v1" }, matrix: { node: "20" } },
        { cwd: dir, env: { ...process.env }, client: fakeClient(), jobId: "j1" },
      );
      expect(res.success).toBe(true);
      expect(res.log).toContain("v1-20");
      expect(JSON.parse(res.resultJson).steps).toHaveLength(1);
      expect(res.artifacts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves cache on success only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-cache-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "f"), "v");
      const client = fakeClient();
      const ok = await runJob(
        { steps: [{ run: "echo hi" }], cache: { key: "k", paths: ["data"] } },
        { cwd: dir, env: { ...process.env }, client, jobId: "j1" },
      );
      expect(ok.success).toBe(true);
      expect(ok.cacheHit).toBe(false);
      expect(client.store.has("k")).toBe(true);
      const again = await runJob(
        { steps: [{ run: "exit 1" }], cache: { key: "k2", paths: ["data"] } },
        { cwd: dir, env: { ...process.env }, client, jobId: "j2" },
      );
      expect(again.success).toBe(false);
      expect(client.store.has("k2")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads single files raw and bundles the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-art-"));
    try {
      writeFileSync(join(dir, "report.txt"), "r");
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "a.js"), "a");
      writeFileSync(join(dir, "dist", "b.js"), "b");
      const client = fakeClient();
      const single = await runJob(
        { steps: [{ run: "echo hi" }], artifacts: { paths: ["report.txt"] } },
        { cwd: dir, env: { ...process.env }, client, jobId: "j1" },
      );
      expect(single.artifacts).toEqual(["report.txt"]);
      expect(client.artifacts.get("report.txt")?.byteLength).toBe(1);
      const bundle = await runJob(
        { steps: [{ run: "echo hi" }], artifacts: { name: "build", paths: ["dist"] } },
        { cwd: dir, env: { ...process.env }, client, jobId: "j2" },
      );
      expect(bundle.artifacts).toEqual(["build.tar.gz"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts and stops services, failing clearly without docker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-svc-"));
    try {
      const events: string[] = [];
      const ok = await runJob(
        { steps: [{ run: "echo hi" }], services: { db: { image: "postgres:16" } } },
        { cwd: dir, env: { ...process.env }, client: fakeClient(), jobId: "j1", servicesCtl: fakeCtl(true, events) },
      );
      expect(ok.success).toBe(true);
      expect(events).toEqual(["start:db", "stop"]);
      const noDocker = await runJob(
        { steps: [{ run: "echo hi" }], services: { db: { image: "postgres:16" } } },
        { cwd: dir, env: { ...process.env }, client: fakeClient(), jobId: "j2", servicesCtl: fakeCtl(false) },
      );
      expect(noDocker.success).toBe(false);
      expect(noDocker.log).toContain("docker is not available");
      const noContainer = await runJob(
        { steps: [{ run: "echo hi" }], container: "node:20" },
        { cwd: dir, env: { ...process.env }, client: fakeClient(), jobId: "j3", servicesCtl: fakeCtl(false) },
      );
      expect(noContainer.success).toBe(false);
      expect(noContainer.log).toContain("docker is not available");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on browser-checks (seats-only, never silently skipped)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-browser-"));
    try {
      const out = await runJob(
        {
          steps: [{ run: "echo hi" }],
          browserChecks: [{ name: "home", url: "https://example.com/", expectTitle: "Example" }],
        },
        { cwd: dir, env: { ...process.env }, client: fakeClient(), jobId: "j1" },
      );
      expect(out.success).toBe(false);
      expect(out.log).toContain("browser-checks need managed seats");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out long jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-timeout-"));
    try {
      const res = await runJob(
        { steps: [{ run: "sleep 30" }] },
        { cwd: dir, env: { ...process.env }, client: fakeClient(), jobId: "j1", timeoutMs: 300 },
      );
      expect(res.success).toBe(false);
      expect(JSON.parse(res.resultJson).timedOut).toBe(true);
      expect(res.log).toContain("[timeout]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runJob CI env", () => {
  it("sets CI=true for steps like GitHub Actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-ci-"));
    const env = { ...process.env };
    delete env.CI;
    try {
      const res = await runJob(
        { steps: [{ run: "echo ci-is-$CI" }] },
        { cwd: dir, env, client: fakeClient(), jobId: "j1" },
      );
      expect(res.success).toBe(true);
      expect(res.log).toContain("ci-is-true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runJob secrets", () => {
  it("interpolates secrets into steps and env, then masks them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-secrets-"));
    try {
      const res = await runJob(
        {
          steps: [{ run: "echo ${{ secrets.TOKEN }}-$FROM_ENV" }],
          env: { FROM_ENV: "${{ secrets.SUFFIX }}" },
        },
        {
          cwd: dir,
          env: { ...process.env },
          client: fakeClient(),
          jobId: "j1",
          secrets: { TOKEN: "s3cret-value", SUFFIX: "sfx" },
        },
      );
      expect(res.success).toBe(true);
      expect(res.log).toContain("***-***");
      expect(res.log).not.toContain("s3cret-value");
      expect(res.log).not.toContain("sfx");
      expect(res.resultJson).not.toContain("s3cret-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when secrets failed to decrypt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-secerr-"));
    try {
      const res = await runJob(
        { steps: [{ run: "echo hi" }] },
        { cwd: dir, env: { ...process.env }, client: fakeClient(), jobId: "j1", secretsError: true },
      );
      expect(res.success).toBe(true);
      expect(res.log).toContain("secrets unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("artifact helpers", () => {
  it("sanitizes names to the server alphabet", () => {
    expect(sanitizeArtifactName("a/b c")).toBe("a-b-c");
    expect(sanitizeArtifactName("...")).toBe("artifact");
    expect(sanitizeArtifactName("ok.tar.gz")).toBe("ok.tar.gz");
  });

  it("collects within cwd only", () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-collect-"));
    try {
      writeFileSync(join(dir, "f"), "x");
      expect(collectArtifactFiles(dir, ["f"]).files).toHaveLength(1);
      expect(collectArtifactFiles(dir, ["../escape"]).files).toHaveLength(0);
      expect(collectArtifactFiles(dir, ["missing"]).files).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const JUNIT = `<testsuite name="s"><testcase name="t" time="0.1"/></testsuite>`;

describe("collectTestReportXml", () => {
  it("collects explicit paths and conventional defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-tests-"));
    try {
      mkdirSync(join(dir, "custom"), { recursive: true });
      writeFileSync(join(dir, "custom", "out.xml"), JUNIT);
      writeFileSync(join(dir, "junit.xml"), JUNIT);
      writeFileSync(join(dir, "notes.xml"), "<note>not junit</note>");
      writeFileSync(join(dir, "junit.txt"), JUNIT);
      const { xml, files } = collectTestReportXml(dir, ["custom/out.xml", "notes.xml"]);
      expect(files.sort()).toEqual(["custom/out.xml", "junit.xml"]);
      expect(xml).toContain('<testsuite name="s">');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans directories for xml and rejects traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-tests-"));
    try {
      mkdirSync(join(dir, "reports"), { recursive: true });
      writeFileSync(join(dir, "reports", "a.xml"), JUNIT);
      writeFileSync(join(dir, "reports", "b.json"), "{}");
      const { files } = collectTestReportXml(dir, ["reports", "../escape", "missing.xml"]);
      expect(files).toEqual(["reports/a.xml"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when nothing matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-tests-"));
    try {
      expect(collectTestReportXml(dir, undefined)).toEqual({ xml: "", files: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runJob test reports", () => {
  it("uploads discovered reports on success and failure", async () => {
    for (const cmd of ["true", "false"]) {
      const dir = mkdtempSync(join(tmpdir(), "flare-job-testup-"));
      try {
        writeFileSync(join(dir, "junit.xml"), JUNIT);
        const client = fakeClient();
        const res = await runJob({ steps: [{ run: cmd }] }, { cwd: dir, env: { ...process.env }, client, jobId: "j1" });
        expect(res.success).toBe(cmd === "true");
        expect(client.reports).toHaveLength(1);
        expect(client.reports[0]).toContain("testsuite");
        expect(res.log).toContain("[tests] uploaded 1 report(s)");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("uploads nothing and stays quiet without reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flare-job-testup-"));
    try {
      const client = fakeClient();
      const res = await runJob({ steps: [{ run: "true" }] }, { cwd: dir, env: { ...process.env }, client, jobId: "j1" });
      expect(client.reports).toHaveLength(0);
      expect(res.log).not.toContain("[tests]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
