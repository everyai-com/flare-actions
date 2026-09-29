import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifactFiles, runJob, sanitizeArtifactName, type JobClient } from "./job";

function fakeClient(store = new Map<string, Uint8Array>()): JobClient & { store: Map<string, Uint8Array>; artifacts: Map<string, Uint8Array> } {
  const artifacts = new Map<string, Uint8Array>();
  return {
    store,
    artifacts,
    getCache: async (k: string) => store.get(k) ?? null,
    putCache: async (k: string, v: Uint8Array) => {
      store.set(k, v);
    },
    uploadArtifact: async (_job: string, name: string, v: Uint8Array) => {
      artifacts.set(name, v);
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
