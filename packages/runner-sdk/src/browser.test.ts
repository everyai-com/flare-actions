import { describe, expect, it } from "vitest";
import { resolveCheckUrl, resolvePreviewTemplate, validatePreviewTemplate } from "./browser";

const CTX = { branch: "feat-x", prNumber: 42, sha: "abc123def456" };

describe("resolvePreviewTemplate", () => {
  it("substitutes every variable raw", () => {
    expect(
      resolvePreviewTemplate("https://app-git-{branch}.example.com/{pr}/{sha}/{short_sha}", CTX),
    ).toEqual({ url: "https://app-git-feat-x.example.com/42/abc123def456/abc123d" });
  });

  it("leaves plain URLs untouched", () => {
    expect(resolvePreviewTemplate("https://example.com/a?b=c", CTX)).toEqual({ url: "https://example.com/a?b=c" });
  });

  it("unescapes doubled braces and never interprets them", () => {
    expect(resolvePreviewTemplate("https://example.com/{{branch}}/{branch}", CTX)).toEqual({
      url: "https://example.com/{branch}/feat-x",
    });
  });

  it("passes secrets placeholders through verbatim for the later pass", () => {
    expect(resolvePreviewTemplate("https://example.com/?token=${{ secrets.DEMO_PW }}", CTX)).toEqual({
      url: "https://example.com/?token=${{ secrets.DEMO_PW }}",
    });
    expect(resolvePreviewTemplate("https://{branch}.example.com/${{ secrets.X }}", CTX)).toEqual({
      url: "https://feat-x.example.com/${{ secrets.X }}",
    });
    expect(resolvePreviewTemplate("https://example.com/${{ secrets.X", CTX)).toHaveProperty("error");
  });

  it("slugifies branches so fork names cannot break out of the URL", () => {
    const ctx = (branch: string) => ({ branch, prNumber: 1, sha: "abc123" });
    expect(resolvePreviewTemplate("https://{branch}.example.com/", ctx("feat/login"))).toEqual({
      url: "https://feat-login.example.com/",
    });
    expect(resolvePreviewTemplate("https://{branch}.example.com/", ctx("a...b__c--d"))).toEqual({
      url: "https://a-b__c--d.example.com/",
    });
    // Host breakout, query breakout, credential smuggling: all dead.
    expect(resolvePreviewTemplate("https://preview-{branch}.x.io/?t=${{ secrets.T }}", ctx("a.x.io/?t=hack#"))).toEqual({
      url: "https://preview-a-x-io-t-hack-.x.io/?t=${{ secrets.T }}",
    });
    expect(resolvePreviewTemplate("https://{branch}.example.com/", ctx("a@b:c"))).toEqual({
      url: "https://a-b-c.example.com/",
    });
  });

  it("rejects unknown variables with the allowed list", () => {
    const r = resolvePreviewTemplate("https://{repo}.example.com/", CTX);
    expect("error" in r && r.error).toContain("unknown preview URL variable {repo}");
    expect("error" in r && r.error).toContain("{branch}, {pr}, {sha}, {short_sha}");
  });

  it("rejects malformed braces", () => {
    expect(resolvePreviewTemplate("https://example.com/{branch", CTX)).toHaveProperty("error");
    expect(resolvePreviewTemplate("https://example.com/branch}", CTX)).toHaveProperty("error");
    expect(resolvePreviewTemplate("https://example.com/{}", CTX)).toHaveProperty("error");
  });

  it("fails loud when the run context lacks a used variable", () => {
    expect(resolvePreviewTemplate("https://{branch}.example.com/", { branch: "", prNumber: 1, sha: "s" })).toHaveProperty(
      "error",
    );
    expect(resolvePreviewTemplate("https://{pr}.example.com/", { branch: "b", prNumber: null, sha: "s" })).toHaveProperty(
      "error",
    );
    expect(resolvePreviewTemplate("https://{sha}.example.com/", { branch: "b", prNumber: 1, sha: "" })).toHaveProperty(
      "error",
    );
    // Unused missing vars stay silent.
    expect(resolvePreviewTemplate("https://example.com/", { branch: "", prNumber: null, sha: "" })).toEqual({
      url: "https://example.com/",
    });
  });
});

describe("resolveCheckUrl", () => {
  it("resolves placeholders, then secrets, then re-validates https", () => {
    expect(
      resolveCheckUrl("https://app-git-{branch}.example.com/?t=${{ secrets.T }}", CTX, { T: "tok" }),
    ).toEqual({ url: "https://app-git-feat-x.example.com/?t=tok" });
  });

  it("never scans secret values for placeholders", () => {
    // A value containing {branch} substitutes verbatim (garbage in the
    // URL, caught by the re-validation — never interpreted).
    const r = resolveCheckUrl("https://example.com/?t=${{ secrets.T }}", CTX, { T: "{branch}" });
    expect(r).toEqual({ url: "https://example.com/?t={branch}" });
  });

  it("rejects resolved URLs that do not parse or downgrade the scheme", () => {
    expect(resolveCheckUrl("https://example.com/?t=${{ secrets.T }}", CTX, { T: "has space" })).toEqual({
      url: "https://example.com/?t=has space",
    });
    const badHost = resolveCheckUrl("https://${{ secrets.H }}.example.com/", CTX, { H: "has space" });
    expect("error" in badHost && badHost.error).toContain("does not parse");
    const downgrade = resolveCheckUrl("http://example.com/", CTX, {});
    expect("error" in downgrade && downgrade.error).toContain("not https");
    const unknown = resolveCheckUrl("https://{nope}.example.com/", CTX, {});
    expect("error" in unknown && unknown.error).toContain("unknown preview URL variable");
    const empty = resolveCheckUrl("https://{branch}.example.com/", { branch: "", prNumber: 1, sha: "s" }, {});
    expect("error" in empty && empty.error).toContain("{branch}");
  });
});

describe("validatePreviewTemplate", () => {
  it("accepts the four variables and escapes, rejects the rest", () => {
    expect(validatePreviewTemplate("https://{branch}-{pr}-{sha}-{short_sha}.example.com/")).toBeNull();
    expect(validatePreviewTemplate("https://example.com/{{literal}}")).toBeNull();
    expect(validatePreviewTemplate("https://{repo}.example.com/")).toContain("unknown preview URL variable");
    expect(validatePreviewTemplate("https://example.com/{oops}")).toContain("unknown preview URL variable");
    expect(validatePreviewTemplate("https://example.com/a{b}")).toContain("unknown preview URL variable");
  });
});
