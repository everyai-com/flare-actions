import { describe, expect, it } from "vitest";
import { MAX_JUNIT_BYTES, parseJUnit } from "./junit";

const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="3" failures="1" errors="0" skipped="1" time="4.2">
    <testcase classname="test_auth" name="test_login" time="1.1" />
    <testcase classname="test_auth" name="test_logout" time="0.4">
      <failure message="assert False">traceback here</failure>
    </testcase>
    <testcase classname="test_billing" name="test_invoice" time="2.7">
      <skipped message="needs stripe key" />
    </testcase>
  </testsuite>
</testsuites>`;

const SUREFIRE = `<testsuite name="com.acme.BillingTest" tests="2" errors="1">
  <testcase name="charges" classname="com.acme.BillingTest" time="0.2">
    <error message="NullPointer &amp; friends"><![CDATA[stack &lt;trace&gt;]]></error>
  </testcase>
  <testcase name="refunds" classname="com.acme.BillingTest" time="0.1"/>
</testsuite>`;

describe("parseJUnit", () => {
  it("parses pytest-style suites with failure and skipped cases", () => {
    const out = parseJUnit(PYTEST);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.suites).toBe(1);
    expect(out.total).toBe(3);
    expect(out.passed).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.durationMs).toBe(4200);
    expect(out.cases[1]).toMatchObject({ suite: "pytest", name: "test_logout", classname: "test_auth", status: "failed" });
    expect(out.cases[1]?.message).toBe("assert False");
    expect(out.cases[2]).toMatchObject({ status: "skipped", message: "needs stripe key" });
  });

  it("parses single-suite documents and decodes entities and CDATA", () => {
    const out = parseJUnit(SUREFIRE);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.suites).toBe(1);
    expect(out.errors).toBe(1);
    expect(out.passed).toBe(1);
    expect(out.cases[0]).toMatchObject({ suite: "com.acme.BillingTest", status: "error" });
    expect(out.cases[0]?.message).toBe("NullPointer & friends");
  });

  it("falls back to element text when message attr is missing", () => {
    const out = parseJUnit(`<testsuite name="s"><testcase name="t"><failure>boom &lt;detail&gt;</failure></testcase></testsuite>`);
    if ("error" in out) throw new Error("unexpected parse error");
    expect(out.cases[0]?.message).toBe("boom <detail>");
  });

  it("handles nested suites and jest-style single quotes", () => {
    const xml = `<testsuites><testsuite name='outer'><testsuite name='inner'><testcase name='t' classname='c' time='1'/></testsuite></testsuite></testsuites>`;
    const out = parseJUnit(xml);
    if ("error" in out) throw new Error("unexpected parse error");
    expect(out.total).toBe(1);
    expect(out.cases[0]?.suite).toBe("inner");
  });

  it("ignores comments and bogus durations", () => {
    const xml = `<!-- <testcase name="ghost"/> --><testsuite name="s"><testcase name="t" time="nan"/><testcase name="t2" time="999999"/></testsuite>`;
    const out = parseJUnit(xml);
    if ("error" in out) throw new Error("unexpected parse error");
    expect(out.total).toBe(2);
    expect(out.durationMs).toBe(0);
  });

  it("rejects non-junit input and oversized documents", () => {
    expect(parseJUnit("<html>nope</html>")).toEqual({ error: "not a junit document" });
    expect(parseJUnit("<?xml version=\"1.0\"?><root/>")).toEqual({ error: "no testsuite elements found" });
    expect(parseJUnit("x".repeat(MAX_JUNIT_BYTES + 1))).toMatchObject({ error: expect.stringContaining("too large") });
  });

  it("truncates giant case lists instead of failing", () => {
    const one = `<testcase name="t" time="0.01"/>`;
    const out = parseJUnit(`<testsuite name="s">${one.repeat(2500)}</testsuite>`);
    if ("error" in out) throw new Error("unexpected parse error");
    expect(out.total).toBe(2000);
    expect(out.truncated).toBe(true);
  });
});
