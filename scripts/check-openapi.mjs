#!/usr/bin/env node
// Coverage gate for openapi.yaml: every route in
// apps/worker/src/index.ts must have a spec path entry, every local
// $ref must resolve, and operationIds must be unique. Usage:
// npm run check:openapi (also runs in CI verify).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (msg) => failures.push(msg);

const spec = loadYaml(readFileSync(join(root, "openapi.yaml"), "utf8"));
if (spec?.openapi !== "3.0.3") fail(`expected openapi 3.0.3, got ${spec?.openapi}`);
const specPaths = Object.keys(spec?.paths ?? {});

// Static $ref check: every local ref target exists.
const seen = new Set();
function walk(node) {
  if (Array.isArray(node)) {
    for (const v of node) walk(v);
    return;
  }
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/")) {
        fail(`external $ref not allowed: ${ref}`);
      } else if (!seen.has(ref)) {
        seen.add(ref);
        const parts = ref.slice(2).split("/");
        let cur = spec;
        for (const p of parts) cur = cur?.[p];
        if (cur === undefined) fail(`dangling $ref: ${ref}`);
      }
    }
    for (const v of Object.values(node)) walk(v);
  }
}
walk(spec);

// operationId uniqueness.
const opIds = new Map();
for (const [path, item] of Object.entries(spec?.paths ?? {})) {
  for (const [method, op] of Object.entries(item)) {
    if (!op || typeof op !== "object" || !op.operationId) continue;
    const prev = opIds.get(op.operationId);
    if (prev) fail(`duplicate operationId ${op.operationId} (${prev} and ${method} ${path})`);
    else opIds.set(op.operationId, `${method} ${path}`);
  }
}

// Route coverage: literals + regex matchers + startsWith prefixes in
// the worker must each map to a spec path template.
// index.ts plus the routers it delegates to with a single line.
const src = ["apps/worker/src/index.ts", "apps/worker/src/forge-routes.ts", "apps/worker/src/forge-public.ts"]
  .map((f) => readFileSync(join(root, f), "utf8"))
  .join("\n");
const literals = [...src.matchAll(/url\.pathname === "([^"]+)"/g)].map((m) => m[1]);
const regexes = [...src.matchAll(/\/\^([^\n]*?)\$\/\.exec/g)].map((m) => m[1]);

function regexToTemplate(re) {
  // /^\/v1\/runs\/([^/]+)$/ -> /v1/runs/{p0}; (.+) likewise.
  let out = re.replace(/\\\//g, "/");
  let i = 0;
  out = out.replace(/\(\[\^\/\]\+\)|\(\.\+\)/g, () => `{p${i++}}`);
  return out;
}

function specCovers(template) {
  // Exact match, or a spec path with the same static segments where
  // every {param} aligns (names need not match).
  const tSegs = template.split("/");
  return specPaths.some((p) => {
    const sSegs = p.split("/");
    if (sSegs.length !== tSegs.length) return false;
    return sSegs.every((s, i) => s.startsWith("{") || s === tSegs[i]);
  });
}

for (const lit of new Set(literals)) {
  if (!specCovers(lit)) fail(`spec misses literal route ${lit}`);
}
for (const re of new Set(regexes)) {
  // Only route matchers (anchored ^...$ on url.pathname); skip other regexes.
  if (!re.startsWith("\\/v1\\/") && !re.startsWith("\\/")) continue;
  const template = regexToTemplate(re);
  if (template.includes("(")) continue; // alternations etc. — hand-checked
  if (!specCovers(template)) fail(`spec misses regex route ${re} (as ${template})`);
}
// startsWith sub-paths (protected-resource metadata variants).
for (const m of src.matchAll(/url\.pathname\.startsWith\("([^"]+)"\)/g)) {
  const prefix = m[1];
  const covered = specPaths.some((p) => p === prefix.replace(/\/$/, "") || p.startsWith(prefix));
  if (!covered) fail(`spec misses startsWith prefix ${prefix}`);
}

// Reverse direction: no stale spec paths (every spec path must match
// a code route, modulo {param} names).
const codeTemplates = [
  ...new Set(literals),
  ...[...new Set(regexes)]
    .filter((re) => re.startsWith("\\/v1\\/") || re.startsWith("\\/"))
    .map(regexToTemplate)
    .filter((t) => !t.includes("(")),
];
for (const p of specPaths) {
  const pSegs = p.split("/");
  const known = codeTemplates.some((t) => {
    const tSegs = t.split("/");
    if (sSegsLen(tSegs) !== pSegs.length) return false;
    return pSegs.every((s, i) => s.startsWith("{") || s === tSegs[i]);
  });
  const prefixCovered = [...src.matchAll(/url\.pathname\.startsWith\("([^"]+)"\)/g)].some((m) =>
    p.startsWith(m[1]),
  );
  if (!known && !prefixCovered) fail(`spec path has no code route: ${p}`);
}
function sSegsLen(a) {
  return a.length;
}

if (failures.length > 0) {
  console.error(`openapi coverage failed (${failures.length}):`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`openapi.yaml OK: ${specPaths.length} paths, ${opIds.size} operations, all $refs resolve`);
