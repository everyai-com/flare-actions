// $GITHUB_ENV / $GITHUB_PATH / $GITHUB_STEP_SUMMARY folding rules
// shared by BYO runners and seats.
import { describe, expect, it } from "vitest";
import {
  MAX_JOB_ENV_VARS,
  MAX_SUMMARY_BYTES,
  applyEnvFile,
  applyPathFile,
  envFileLogLines,
  isAllowedEnvName,
  newEnvFileState,
  prependedPath,
  stepFileEnv,
  stepFilePaths,
  takeSummary,
} from "./envfiles";

describe("envfiles", () => {
  it("parses NAME=value and heredoc forms, later assignments win", () => {
    const st = newEnvFileState();
    const r = applyEnvFile(st, "A=1\nMULTI<<EOF\nline one\nline=two\nEOF\nA=2\n");
    expect(st.env).toEqual({ A: "2", MULTI: "line one\nline=two" });
    expect(r.set).toEqual(["A", "MULTI"]);
  });

  it("ignores denylisted and invalid names", () => {
    const st = newEnvFileState();
    const r = applyEnvFile(
      st,
      "NODE_OPTIONS=--require /x\nnode_options=x\nPATH=/evil\nLD_PRELOAD=/x.so\nFLARE_OUTPUT=/x\nGITHUB_SHA=x\nRUNNER_TEMP=x\nDYLD_INSERT_LIBRARIES=x\nbad-name=1\nOK=1\n",
    );
    expect(st.env).toEqual({ OK: "1" });
    expect(r.ignored).toContain("NODE_OPTIONS");
    expect(r.ignored).toContain("bad-name");
    expect(isAllowedEnvName("MY_VAR")).toBe(true);
    expect(isAllowedEnvName("9X")).toBe(false);
  });

  it("caps distinct names per job", () => {
    const st = newEnvFileState();
    const lines = Array.from({ length: MAX_JOB_ENV_VARS + 5 }, (_, i) => `V${i}=x`).join("\n");
    const r = applyEnvFile(st, lines);
    expect(Object.keys(st.env)).toHaveLength(MAX_JOB_ENV_VARS);
    expect(r.ignored).toHaveLength(5);
  });

  it("prepends PATH entries with later lines and later steps first", () => {
    const st = newEnvFileState();
    expect(applyPathFile(st, "/a\n\n/b\n")).toEqual(["/a", "/b"]);
    applyPathFile(st, "/c\n");
    expect(prependedPath(st, "/usr/bin:/bin")).toBe("/c:/b:/a:/usr/bin:/bin");
    expect(prependedPath(newEnvFileState(), "/usr/bin")).toBe("/usr/bin");
  });

  it("bounds step summaries per job", () => {
    const st = newEnvFileState();
    expect(takeSummary(st, "  \n")).toBeNull();
    const first = takeSummary(st, "x".repeat(MAX_SUMMARY_BYTES - 10));
    expect(first).toHaveLength(MAX_SUMMARY_BYTES - 10);
    const second = takeSummary(st, "y".repeat(100));
    expect(second).toContain("y".repeat(10));
    expect(second).not.toContain("y".repeat(11));
    expect(second).toContain("step summary truncated");
    expect(takeSummary(st, "more")).toBeNull();
    expect(st.summaryTruncated).toBe(true);
  });

  it("renders log lines with names only and a summary header", () => {
    const st = newEnvFileState();
    const env = applyEnvFile(st, "TOKEN=hunter2\nNODE_OPTIONS=x\n");
    const lines = envFileLogLines("build", env, ["/opt/bin"], "## Results");
    const text = lines.join("\n");
    expect(text).toContain("[env] step build: set TOKEN");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("ignored (reserved or invalid names): NODE_OPTIONS");
    expect(text).toContain("[path] step build: prepended /opt/bin");
    expect(text).toContain("── step summary ── (build)\n## Results");
  });

  it("names step files consistently with FLARE_ aliases", () => {
    const paths = stepFilePaths("/tmp", 2, false);
    expect(paths.output).toBe("/tmp/flare-output-2");
    expect(stepFilePaths("/w", 0, true).env).toBe("/w/.flare-env-0");
    const env = stepFileEnv(paths);
    expect(env.GITHUB_ENV).toBe(env.FLARE_ENV);
    expect(env.GITHUB_PATH).toBe("/tmp/flare-path-2");
    expect(env.GITHUB_STEP_SUMMARY).toBe(env.FLARE_STEP_SUMMARY);
  });
});
