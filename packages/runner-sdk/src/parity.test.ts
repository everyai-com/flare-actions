import { describe, expect, it } from "vitest";
import {
  buildFlareEnv,
  cacheObjectKey,
  checkJobParity,
  describeStepImage,
  envParityRows,
  isMutableImageTag,
  isValidCacheKey,
  normalizeImageRef,
  resolveStepImage,
  type ParityContext,
} from "./parity";

function ctx(over: Partial<ParityContext> = {}): ParityContext {
  const localFlare = buildFlareEnv({
    repo: "local",
    sha: "local",
    runId: "local",
    jobId: "build",
    ref: "main",
    changedFiles: "",
    selectionMode: "off",
    selectedTests: "",
  });
  const cloudFlare = buildFlareEnv({
    repo: "o/r",
    sha: "abc",
    runId: "run-1",
    jobId: "job-1",
    ref: "main",
    changedFiles: "",
    selectionMode: "off",
    selectedTests: "",
  });
  return { lane: "seats", hostPlatform: "darwin/arm64", localFlare, cloudFlare, extraHostKeys: [], ...over };
}

describe("cache keys", () => {
  it("accepts the same shapes the worker API serves", () => {
    expect(isValidCacheKey("node-abc123")).toBe(true);
    expect(isValidCacheKey("org/repo/main")).toBe(true);
    expect(isValidCacheKey("a")).toBe(true);
    expect(isValidCacheKey("../escape")).toBe(false);
    expect(isValidCacheKey("")).toBe(false);
    expect(isValidCacheKey("has space")).toBe(false);
  });

  it("maps keys onto the shared R2 object path", () => {
    expect(cacheObjectKey("node-abc")).toBe("cache/node-abc");
  });
});

describe("image resolution", () => {
  it("prefers the container ref, else the host platform", () => {
    expect(resolveStepImage("node:20", "darwin/arm64")).toEqual({ kind: "container", image: "node:20" });
    expect(resolveStepImage("  node:20  ", "darwin/arm64")).toEqual({ kind: "container", image: "node:20" });
    expect(resolveStepImage(undefined, "darwin/arm64")).toEqual({ kind: "host", platform: "darwin/arm64" });
    expect(resolveStepImage("   ", "linux/amd64")).toEqual({ kind: "host", platform: "linux/amd64" });
  });

  it("normalizes blank refs to null", () => {
    expect(normalizeImageRef("node:20")).toBe("node:20");
    expect(normalizeImageRef("   ")).toBeNull();
  });

  it("flags mutable tags that can drift between pulls", () => {
    expect(isMutableImageTag("node")).toBe(true);
    expect(isMutableImageTag("node:latest")).toBe(true);
    expect(isMutableImageTag("registry.example.com:5000/img:LATEST")).toBe(true);
    expect(isMutableImageTag("node:20")).toBe(false);
    expect(isMutableImageTag("node:20.11.0")).toBe(false);
    expect(isMutableImageTag("node@sha256:abc123")).toBe(false);
    expect(isMutableImageTag("node:latest@sha256:abc123")).toBe(false);
  });

  it("describes images for comparison", () => {
    expect(describeStepImage({ kind: "container", image: "node:20" })).toBe("container:node:20");
    expect(describeStepImage({ kind: "host", platform: "linux/amd64" })).toBe("host:linux/amd64");
  });
});

describe("buildFlareEnv", () => {
  it("builds the curated keys in one shared shape", () => {
    expect(
      buildFlareEnv({
        repo: "o/r",
        sha: "abc",
        runId: "r1",
        jobId: "j1",
        ref: "main",
        changedFiles: "a.ts",
        selectionMode: "full",
        selectedTests: "",
      }),
    ).toEqual({
      FLARE_REPO: "o/r",
      FLARE_SHA: "abc",
      FLARE_RUN_ID: "r1",
      FLARE_JOB_ID: "j1",
      FLARE_REF: "main",
      FLARE_CHANGED_FILES: "a.ts",
      CI: "true",
      FLARE_TEST_SELECTION: "full",
      FLARE_SELECTED_TESTS: "",
    });
  });
});

describe("envParityRows", () => {
  it("marks identity placeholders expected and real diffs diff", () => {
    const c = ctx();
    const rows = envParityRows(c.localFlare, c.cloudFlare);
    const byKey = new Map(rows.map((r) => [r.key, r.status]));
    expect(byKey.get("FLARE_REPO")).toBe("expected");
    expect(byKey.get("FLARE_SHA")).toBe("expected");
    expect(byKey.get("FLARE_RUN_ID")).toBe("expected");
    expect(byKey.get("FLARE_JOB_ID")).toBe("expected");
    expect(byKey.get("FLARE_REF")).toBe("same");
    expect(byKey.get("FLARE_CHANGED_FILES")).toBe("same");
    expect(byKey.get("CI")).toBe("same");
    const dirty = envParityRows({ ...c.localFlare, CI: "false" }, c.cloudFlare);
    expect(dirty.find((r) => r.key === "CI")?.status).toBe("diff");
  });
});

describe("checkJobParity", () => {
  it("matches container images on both sides", () => {
    const result = checkJobParity({ container: "node:20" }, { ...ctx(), lane: "byo" });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ area: "image", severity: "info" });
    expect(result.image).toEqual({ local: "container:node:20", cloud: "container:node:20" });
    expect(result.cache).toBeNull();
  });

  it("warns on mutable container tags", () => {
    const result = checkJobParity({ container: "node:latest" }, { ...ctx(), lane: "byo" });
    expect(result.findings.some((f) => f.severity === "warn" && f.note.includes("mutable"))).toBe(true);
  });

  it("warns when host execution crosses kernels to seats", () => {
    const result = checkJobParity({}, ctx());
    const image = result.findings.find((f) => f.area === "image");
    expect(image?.severity).toBe("warn");
    expect(image?.cloud).toBe("seat:linux/amd64 managed");
    expect(result.image.cloud).toBe("seat:linux/amd64 managed");
  });

  it("is quiet when Linux local meets seats", () => {
    const result = checkJobParity({}, ctx({ hostPlatform: "linux/amd64" }));
    expect(result.findings.find((f) => f.area === "image")?.severity).toBe("info");
  });

  it("reports cache keys with the scope split", () => {
    const result = checkJobParity({ cache: { key: "node-abc" } }, ctx({ hostPlatform: "linux/amd64" }));
    const cache = result.findings.find((f) => f.area === "cache");
    expect(cache?.severity).toBe("info");
    expect(cache?.cloud).toBe("cache/node-abc");
    expect(result.cache).toEqual({ key: "node-abc", local: "local file (directory-scoped)", cloud: "cache/node-abc" });
  });

  it("warns on keys the cloud would reject", () => {
    const result = checkJobParity({ cache: { key: "../evil" } }, ctx());
    expect(result.findings.find((f) => f.area === "cache")?.severity).toBe("warn");
    expect(result.cache?.cloud).toBe("rejected");
  });

  it("flags host env leakage against the seats lane", () => {
    const result = checkJobParity(
      {},
      ctx({ hostPlatform: "linux/amd64", extraHostKeys: ["HOME", "PATH", "npm_config_x", "zzz"] }),
    );
    const leak = result.findings.find((f) => f.key === "host environment");
    expect(leak?.severity).toBe("info");
    expect(leak?.local).toBe("4 extra vars");
  });

  it("warns when CI diverges", () => {
    const c = ctx({ hostPlatform: "linux/amd64" });
    const result = checkJobParity({}, { ...c, localFlare: { ...c.localFlare, CI: "false" } });
    expect(result.findings.find((f) => f.key === "CI")?.severity).toBe("warn");
  });
});
