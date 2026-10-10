// `strategy.matrix` model shared by the flare.yml parser (worker
// pipeline.ts) and the GitHub Actions importer, so the importer can only
// emit matrices the parser accepts. Pure and dependency-free.
//
// Shape: axis keys map to non-empty scalar lists (cartesian product);
// the reserved `include` / `exclude` keys take lists of key→scalar maps
// and follow GitHub's documented algorithm:
//   1. expand the axes,
//   2. drop every cell matching all keys of some `exclude` entry,
//   3. for each `include` entry: extend every surviving original cell
//      whose original-axis values match the entry's original-axis keys
//      (original axis values are never overwritten; values added by an
//      earlier include may be); an entry that extends no cell becomes a
//      new cell of its own. New cells are never extended.

export const MAX_MATRIX_KEYS = 8;
export const MAX_MATRIX_VALUES = 16;
// include / exclude entries, each.
export const MAX_MATRIX_ENTRIES = 16;
// Axis product ceiling, checked before expanding (GitHub's own limit),
// so a hostile 16^8 matrix never materializes.
export const MAX_MATRIX_PRODUCT = 256;
// Post-include/exclude cells; equals the pipeline's MAX_JOBS.
export const MAX_MATRIX_CELLS = 32;
export const MAX_MATRIX_KEY_LENGTH = 32;
export const MAX_MATRIX_VALUE_LENGTH = 128;
export const MATRIX_KEY_RE = /^[A-Za-z_][\w-]*$/;

export interface MatrixSpec {
  axes: Record<string, string[]>;
  include: Record<string, string>[];
  exclude: Record<string, string>[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isValidMatrixKey(k: string): boolean {
  return MATRIX_KEY_RE.test(k) && k.length <= MAX_MATRIX_KEY_LENGTH && k !== "include" && k !== "exclude";
}

// Scalar → string, or null for objects/lists/empty/oversized values.
export function matrixScalar(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return null;
  const s = String(v);
  if (!s || s.length > MAX_MATRIX_VALUE_LENGTH) return null;
  return s;
}

function parseEntry(v: unknown): Record<string, string> | string {
  if (!isRecord(v)) return "entry is not a map";
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.length > MAX_MATRIX_KEYS) return `entry needs 1-${MAX_MATRIX_KEYS} keys`;
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!isValidMatrixKey(k)) return `invalid key \`${k}\``;
    const s = matrixScalar(v[k]);
    if (s === null) return `key \`${k}\` needs a scalar value`;
    out[k] = s;
  }
  return out;
}

function parseEntries(v: unknown, label: string): Record<string, string>[] | string {
  if (!Array.isArray(v)) return `${label} must be a list of maps`;
  if (v.length > MAX_MATRIX_ENTRIES) return `${label} allows at most ${MAX_MATRIX_ENTRIES} entries`;
  const out: Record<string, string>[] = [];
  for (const e of v) {
    const parsed = parseEntry(e);
    if (typeof parsed === "string") return `${label}: ${parsed}`;
    out.push(parsed);
  }
  return out;
}

// Validate a raw `strategy.matrix` value. Returns the normalized spec,
// or a human-readable reason string when it is outside the bounded model.
export function parseMatrixSpec(v: unknown): MatrixSpec | string {
  if (!isRecord(v)) return "matrix must be a map";
  const axes: Record<string, string[]> = {};
  let include: Record<string, string>[] = [];
  let exclude: Record<string, string>[] = [];
  let product = 1;
  for (const [k, vals] of Object.entries(v)) {
    if (k === "include" || k === "exclude") {
      const parsed = parseEntries(vals, k);
      if (typeof parsed === "string") return parsed;
      if (k === "include") include = parsed;
      else exclude = parsed;
      continue;
    }
    if (!isValidMatrixKey(k)) return `invalid axis key \`${k}\``;
    if (!Array.isArray(vals) || vals.length === 0 || vals.length > MAX_MATRIX_VALUES) {
      return `axis \`${k}\` needs a list of 1-${MAX_MATRIX_VALUES} values`;
    }
    const list: string[] = [];
    for (const val of vals) {
      const s = matrixScalar(val);
      if (s === null) return `axis \`${k}\` values must be non-empty scalars`;
      list.push(s);
    }
    axes[k] = list;
    product *= list.length;
    if (product > MAX_MATRIX_PRODUCT) return `axes expand past ${MAX_MATRIX_PRODUCT} combinations`;
  }
  const axisKeys = Object.keys(axes);
  if (axisKeys.length === 0 && include.length === 0) return "matrix needs at least one axis or include entry";
  const allKeys = new Set(axisKeys);
  for (const e of include) for (const k of Object.keys(e)) allKeys.add(k);
  if (allKeys.size > MAX_MATRIX_KEYS) return `matrix uses more than ${MAX_MATRIX_KEYS} distinct keys`;
  for (const e of exclude) {
    for (const k of Object.keys(e)) {
      if (!(k in axes)) return `exclude key \`${k}\` is not a matrix axis`;
    }
  }
  const spec: MatrixSpec = { axes, include, exclude };
  const cells = expandMatrix(spec);
  if (cells.length === 0) return "matrix expands to zero combinations";
  if (cells.length > MAX_MATRIX_CELLS) return `matrix expands past ${MAX_MATRIX_CELLS} combinations`;
  return spec;
}

// Cartesian product of matrix axes: [{node:'18',os:'linux'}, ...].
export function expandMatrixAxes(axes: Record<string, string[]>): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}

function cellMatches(cell: Record<string, string>, entry: Record<string, string>, keys: string[]): boolean {
  return keys.every((k) => cell[k] === entry[k]);
}

function cellId(cell: Record<string, string>): string {
  return JSON.stringify(Object.entries(cell).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Expand a validated spec into cells (GitHub semantics, see header).
// Callers bound the input via parseMatrixSpec first.
export function expandMatrix(spec: MatrixSpec): Record<string, string>[] {
  const axisKeys = Object.keys(spec.axes);
  const base = axisKeys.length > 0 ? expandMatrixAxes(spec.axes) : [];
  const originals = base.filter((cell) => !spec.exclude.some((e) => cellMatches(cell, e, Object.keys(e))));
  const added: Record<string, string>[] = [];
  for (const entry of spec.include) {
    const matchKeys = Object.keys(entry).filter((k) => k in spec.axes);
    let extended = false;
    for (const cell of originals) {
      if (!cellMatches(cell, entry, matchKeys)) continue;
      extended = true;
      for (const [k, v] of Object.entries(entry)) {
        if (!(k in spec.axes)) cell[k] = v;
      }
    }
    if (!extended) added.push({ ...entry });
  }
  // Identical new cells would collide on job name; keep the first.
  const out: Record<string, string>[] = [];
  const seen = new Set<string>();
  for (const cell of [...originals, ...added]) {
    const id = cellId(cell);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(cell);
  }
  return out;
}
