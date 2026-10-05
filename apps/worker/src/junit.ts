// Tolerant JUnit XML parser: no DOM in Workers, so attribute scanning
// over testsuite/testcase elements. Accepts single-suite and
// multi-suite (testsuites wrapper, nested suites) documents from the
// common emitters (pytest, jest-junit, vitest, surefire, go-junit).
// Bounded: oversized documents and case lists fail closed instead of
// burning isolate memory.

export const MAX_JUNIT_BYTES = 1024 * 1024;
export const MAX_JUNIT_CASES = 2000;
export const MAX_JUNIT_MESSAGE = 500;

export type TestCaseStatus = "passed" | "failed" | "error" | "skipped";

export interface ParsedTestCase {
  suite: string;
  name: string;
  classname: string;
  status: TestCaseStatus;
  durationMs: number | null;
  message: string;
}

export interface ParsedTestReport {
  suites: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  durationMs: number;
  cases: ParsedTestCase[];
  truncated: boolean;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n) || 0, 0x10ffff)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16) || 0, 0x10ffff)))
    .replace(/&amp;/g, "&");
}

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

function parseDurationSec(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 86400) return null;
  return Math.round(n * 1000);
}

function childMessage(body: string, tag: "failure" | "error" | "skipped"): string | null {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)(?:</${tag}>|$)`, "i");
  const selfClosing = new RegExp(`<${tag}(\\s[^>]*)?/>`, "i");
  let m = open.exec(body);
  if (!m) m = selfClosing.exec(body);
  if (!m) return null;
  const attrs = parseAttrs(m[1] ?? "");
  const text = (m[2] ?? "").trim();
  const msg = attrs["message"] || text;
  return decodeEntities(msg).slice(0, MAX_JUNIT_MESSAGE);
}

export function parseJUnit(xml: string): ParsedTestReport | { error: string } {
  if (xml.length > MAX_JUNIT_BYTES) return { error: `junit xml too large (max ${MAX_JUNIT_BYTES} bytes)` };
  if (!/<testsuite[\s>]|<\?xml/i.test(xml)) return { error: "not a junit document" };
  // Strip comments and CDATA wrappers (keep CDATA text).
  const clean = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  if (!/<testsuite[\s>]/.test(clean)) return { error: "no testsuite elements found" };

  const cases: ParsedTestCase[] = [];
  let truncated = false;
  let suiteCount = 0;
  // Each <testsuite> open starts a section; nested suites just start a
  // new section (their cases keep the innermost suite name).
  const suiteRe = /<testsuite(\s[^>]*)?>/gi;
  const sections: { attrs: Record<string, string>; body: string }[] = [];
  let sm: RegExpExecArray | null;
  const opens: { index: number; attrs: Record<string, string> }[] = [];
  while ((sm = suiteRe.exec(clean)) !== null) {
    opens.push({ index: sm.index, attrs: parseAttrs(sm[1] ?? "") });
  }
  for (let i = 0; i < opens.length; i++) {
    const end = i + 1 < opens.length ? opens[i + 1].index : clean.length;
    sections.push({ attrs: opens[i].attrs, body: clean.slice(opens[i].index, end) });
  }
  suiteCount = opens.length;

  for (const section of sections) {
    const suiteName = (section.attrs["name"] ?? "").slice(0, 256);
    const openRe = /<testcase\b[^>]*>/gi;
    let om: RegExpExecArray | null;
    while ((om = openRe.exec(section.body)) !== null) {
      if (cases.length >= MAX_JUNIT_CASES) {
        truncated = true;
        break;
      }
      const tag = om[0];
      const attrs = parseAttrs(tag);
      let body = "";
      if (!/\/>$/.test(tag)) {
        const start = om.index + tag.length;
        const close = section.body.indexOf("</testcase>", start);
        const nextOpen = section.body.indexOf("<testcase", start);
        // Malformed (no close, or another case opens first): empty body.
        if (close !== -1 && (nextOpen === -1 || close < nextOpen)) {
          body = section.body.slice(start, close);
          openRe.lastIndex = close + "</testcase>".length;
        }
      }
      let status: TestCaseStatus = "passed";
      let message = "";
      const skipped = childMessage(body, "skipped");
      const failure = skipped === null ? childMessage(body, "failure") : null;
      const error = failure === null && skipped === null ? childMessage(body, "error") : null;
      if (skipped !== null) {
        status = "skipped";
        message = skipped;
      } else if (error !== null) {
        status = "error";
        message = error;
      } else if (failure !== null) {
        status = "failed";
        message = failure;
      }
      cases.push({
        suite: suiteName,
        name: (attrs["name"] ?? "unnamed").slice(0, 256),
        classname: (attrs["classname"] ?? attrs["class"] ?? "").slice(0, 256),
        status,
        durationMs: parseDurationSec(attrs["time"]),
        message,
      });
    }
    if (truncated) break;
  }

  let passed = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  let durationMs = 0;
  for (const c of cases) {
    if (c.status === "passed") passed++;
    else if (c.status === "failed") failed++;
    else if (c.status === "error") errors++;
    else skipped++;
    durationMs += c.durationMs ?? 0;
  }
  return { suites: suiteCount, total: cases.length, passed, failed, errors, skipped, durationMs, cases, truncated };
}
