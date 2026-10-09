// Smart test selection: map a diff to the tests it can affect.
//
// A reverse import-graph walk (changed file -> importers -> test files)
// plus a recent-failure boost from the server's JUnit history. The core
// is pure, dependency-free, and Node-free: BYO runners feed it workspace
// files, seats feed it container `grep` output, and both share these
// functions. TypeScript/JavaScript ship first; more languages plug in
// through IMPORT_PARSERS (extension -> import-specifier extractor).
//
// Safety posture is conservative: anything the walker cannot map
// (unknown language, deleted file, empty result) falls back to the full
// suite instead of skipping the test that mattered.

// Plain types only (SDK type-stripping rule): no enums or namespaces.

export interface RecentFailure {
  suite: string;
  name: string;
  classname: string;
}

export interface SkippedTest {
  file: string;
  reason: string;
}

export interface TestSelection {
  mode: "select" | "full";
  reason: string;
  selected: string[];
  skipped: SkippedTest[];
  totalTests: number;
}

// A language parser extracts raw import specifiers (relative and bare)
// from one source file; the graph only resolves relative ones.
export type ImportParser = (source: string) => string[];

export const MAX_IMPORTS_PER_FILE = 500;
export const MAX_GRAPH_FILES = 5000;
export const MAX_SELECTION_REASON = 200;

// Conventional test locations; a job's `test-selection.tests` globs
// replace this list wholesale when present.
export const DEFAULT_TEST_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/__tests__/**/*",
  "tests/**/*",
  "test/**/*",
];

export const SELECTED_TESTS_ENV = "FLARE_SELECTED_TESTS";
export const SELECTION_MODE_ENV = "FLARE_TEST_SELECTION";

// Minimal glob: `**` crosses segments, `*` crosses within one, `?` is
// one char. Both sides are repo-relative posix paths (no leading ./).
export function matchGlob(pattern: string, path: string): boolean {
  if (pattern.length === 0 || pattern.length > 256 || path.length === 0 || path.length > 1024) return false;
  const matchSegment = (pat: string, seg: string): boolean => {
    let regex = "^";
    for (const ch of pat) {
      if (ch === "*") regex += ".*";
      else if (ch === "?") regex += ".";
      else regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`${regex}$`).test(seg);
  };
  const matchFrom = (pi: number, si: number, pat: string[], segs: string[]): boolean => {
    if (pi === pat.length) return si === segs.length;
    if (pat[pi] === "**") {
      for (let k = si; k <= segs.length; k++) {
        if (matchFrom(pi + 1, k, pat, segs)) return true;
      }
      return false;
    }
    return si < segs.length && matchSegment(pat[pi], segs[si]) && matchFrom(pi + 1, si + 1, pat, segs);
  };
  return matchFrom(0, 0, pattern.split("/"), path.split("/"));
}

export function isTestFile(path: string, patterns: string[] = DEFAULT_TEST_PATTERNS): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

export function normalizeRepoPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

// TypeScript/JavaScript import extraction: static + side-effect +
// type-only imports, re-exports, require(), and dynamic import().
// Block comments and full-line // comments are stripped first so
// commented-out imports never widen the graph; bare package imports
// are returned like everything else and filtered at resolve time.
export function extractTypeScriptImports(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (spec: string): void => {
    if (out.length >= MAX_IMPORTS_PER_FILE || seen.has(spec)) return;
    seen.add(spec);
    out.push(spec);
  };
  const patterns = [
    /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      if (m[1]) push(m[1]);
      if (out.length >= MAX_IMPORTS_PER_FILE) break;
    }
  }
  return out;
}

// Extension (no dot) -> parser. Adding a language is one entry plus
// listing its extensions here; unlisted extensions are unparseable and
// force the full-suite fallback for diffs that touch them.
export const IMPORT_PARSERS: Record<string, ImportParser> = {
  ts: extractTypeScriptImports,
  tsx: extractTypeScriptImports,
  js: extractTypeScriptImports,
  jsx: extractTypeScriptImports,
  mjs: extractTypeScriptImports,
  cjs: extractTypeScriptImports,
  mts: extractTypeScriptImports,
  cts: extractTypeScriptImports,
};

export function parserForPath(path: string): ImportParser | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return IMPORT_PARSERS[path.slice(dot + 1).toLowerCase()] ?? null;
}

export function canParsePath(path: string): boolean {
  return parserForPath(path) !== null;
}

const RESOLVE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];

// Resolve a relative specifier against the repo listing: exact hit,
// then extension probes, then directory index probes. Bare imports
// (node_modules) and unresolvable paths return null.
export function resolveImport(fromFile: string, spec: string, exists: (path: string) => boolean): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = fromFile.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    else if (seg === "..") base.pop();
    else base.push(seg);
  }
  if (base.some((s) => s === "" || s === "..")) return null;
  const joined = base.join("/");
  if (exists(joined)) return joined;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (exists(`${joined}.${ext}`)) return `${joined}.${ext}`;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (exists(`${joined}/index.${ext}`)) return `${joined}/index.${ext}`;
  }
  return null;
}

// Reverse edges: file -> direct importers. `contents` carries source
// (or grep-harvested import lines — extraction works on fragments) for
// the parseable subset; anything unparseable is simply a leaf.
export function buildImporters(allFiles: string[], contents: Map<string, string>): Map<string, Set<string>> {
  const fileSet = new Set(allFiles);
  const importers = new Map<string, Set<string>>();
  const addEdge = (target: string, importer: string): void => {
    let set = importers.get(target);
    if (!set) {
      set = new Set<string>();
      importers.set(target, set);
    }
    set.add(importer);
  };
  let processed = 0;
  for (const [path, source] of contents) {
    if (processed >= MAX_GRAPH_FILES) break;
    if (!fileSet.has(path)) continue;
    const parser = parserForPath(path);
    if (!parser) continue;
    processed++;
    const exists = (p: string): boolean => fileSet.has(p);
    for (const spec of parser(source)) {
      const target = resolveImport(path, spec, exists);
      if (target && target !== path) addEdge(target, path);
    }
  }
  return importers;
}

// JUnit rows carry no file path, but emitters put one in suite or
// classname (vitest/jest: "src/foo.test.ts"). Match on exact path,
// path suffix, or extension-stripped basename.
function stripExt(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

export function failureTouchesFile(failure: RecentFailure, testFile: string): boolean {
  const testBase = stripExt(testFile.split("/").pop() ?? testFile);
  for (const field of [failure.suite, failure.classname]) {
    const norm = normalizeRepoPath(field);
    if (!norm) continue;
    if (norm === testFile || norm.endsWith(`/${testFile}`)) return true;
    if (stripExt(norm.split("/").pop() ?? norm) === testBase) return true;
  }
  return false;
}

// Container grep output (`path:matching line` per line) grouped back
// into per-file import-line bundles for buildImporters.
export function groupGrepLines(output: string, maxFiles = MAX_GRAPH_FILES): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const path = normalizeRepoPath(line.slice(0, colon));
    if (!path || path.includes("\0")) continue;
    let lines = grouped.get(path);
    if (!lines) {
      if (grouped.size >= maxFiles) break;
      lines = [];
      grouped.set(path, lines);
    }
    if (lines.length < MAX_IMPORTS_PER_FILE) lines.push(line.slice(colon + 1));
  }
  const out = new Map<string, string>();
  for (const [path, lines] of grouped) out.set(path, lines.join("\n"));
  return out;
}

export interface SelectTestsInput {
  allFiles: string[];
  contents: Map<string, string>;
  changed: string[];
  failures: RecentFailure[];
  testPatterns?: string[];
}

const BFS_MAX_DEPTH = 30;
const BFS_MAX_NODES = 10000;

function truncateReason(reason: string): string {
  return reason.slice(0, MAX_SELECTION_REASON);
}

// Pure selection: affected tests (changed, importing a change, or
// recently failed) are selected; everything else is skipped with a
// reason. Unmapped changes and empty results fall back to full.
export function selectTests(input: SelectTestsInput): TestSelection {
  const patterns = input.testPatterns ?? DEFAULT_TEST_PATTERNS;
  const allFiles = input.allFiles.map(normalizeRepoPath).filter(Boolean);
  const fileSet = new Set(allFiles);
  const tests = allFiles.filter((f) => isTestFile(f, patterns)).sort();
  if (tests.length === 0) {
    return { mode: "full", reason: "no test files found", selected: [], skipped: [], totalTests: 0 };
  }
  const changed = [...new Set(input.changed.map(normalizeRepoPath).filter(Boolean))].sort();
  for (const c of changed) {
    // A changed test file that no longer exists was deleted: nothing to
    // run. Any other unmapped change (deleted source, unknown language,
    // non-code file) runs everything — the walker must never silently
    // drop a change it cannot see through.
    if (isTestFile(c, patterns)) continue;
    if (!fileSet.has(c) || !canParsePath(c)) {
      return {
        mode: "full",
        reason: truncateReason(`unmapped change: ${c}`),
        selected: [],
        skipped: [],
        totalTests: tests.length,
      };
    }
  }
  const importers = buildImporters(allFiles, input.contents);
  const affected = new Map<string, string>();
  for (const c of changed) {
    if (!isTestFile(c, patterns) || !fileSet.has(c)) continue;
    if (!affected.has(c)) affected.set(c, "changed");
  }
  // One BFS per changed source file so the reason names the change that
  // pulled the test in; first reason wins on overlap.
  for (const c of changed) {
    if (isTestFile(c, patterns)) continue;
    const queue: { file: string; depth: number }[] = [{ file: c, depth: 0 }];
    const seen = new Set<string>([c]);
    let nodes = 0;
    while (queue.length > 0 && nodes < BFS_MAX_NODES) {
      const current = queue.shift();
      if (!current || current.depth >= BFS_MAX_DEPTH) continue;
      nodes++;
      for (const importer of importers.get(current.file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (isTestFile(importer, patterns) && !affected.has(importer)) {
          affected.set(importer, truncateReason(`imports ${c}`));
        }
        queue.push({ file: importer, depth: current.depth + 1 });
      }
    }
  }
  for (const test of tests) {
    if (affected.has(test)) continue;
    const hit = input.failures.find((f) => failureTouchesFile(f, test));
    if (hit) affected.set(test, truncateReason(`failed recently: ${(hit.name || hit.suite || test).slice(0, 80)}`));
  }
  const selected = [...affected.keys()].sort();
  if (selected.length === 0) {
    return {
      mode: "full",
      reason: "no affected tests for this diff",
      selected: [],
      skipped: [],
      totalTests: tests.length,
    };
  }
  const skipped: SkippedTest[] = tests
    .filter((t) => !affected.has(t))
    .map((file) => ({ file, reason: "unaffected by this diff" }));
  return {
    mode: "select",
    reason: `${selected.length}/${tests.length} tests affected`,
    selected,
    skipped,
    totalTests: tests.length,
  };
}
