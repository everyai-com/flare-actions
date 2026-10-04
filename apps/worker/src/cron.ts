// Minimal POSIX-style 5-field cron for scheduled runs (minute hour
// day-of-month month day-of-week, evaluated in UTC). Supported per
// field: `*`, `a`, `a-b`, `*/n`, `a-b/n`, and comma lists. Day
// matching follows Vixie cron: when both day fields are restricted, a
// match on either one fires; otherwise both must match (`*` matches
// everything). Names (JAN) and @macros are deliberately unsupported.

const FIELD_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 = Sunday alias)
];

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;

function parseField(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const seg = part.trim();
    if (!seg) return null;
    const slash = seg.indexOf("/");
    const rangePart = slash === -1 ? seg : seg.slice(0, slash);
    const stepPart = slash === -1 ? null : seg.slice(slash + 1);
    if (stepPart !== null && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) return null;
    const step = stepPart === null ? 1 : Number(stepPart);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
      if (!m) return null;
      if (stepPart !== null && m[2] === undefined) return null; // "5/2" is ambiguous; require a range
      lo = Number(m[1]);
      hi = m[2] === undefined ? lo : Number(m[2]);
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

export function validateCron(expr: unknown): string | null {
  if (typeof expr !== "string" || expr.length > 128) return "cron must be a string (max 128 chars)";
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return "cron must have exactly 5 fields (minute hour day-of-month month day-of-week)";
  }
  for (let i = 0; i < 5; i++) {
    const [min, max] = FIELD_BOUNDS[i];
    if (!parseField(fields[i] ?? "", min, max)) return `invalid ${FIELD_NAMES[i]} field: ${fields[i]}`;
  }
  return null;
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const minute = parseField(fields[0] ?? "", 0, 59);
  const hour = parseField(fields[1] ?? "", 0, 23);
  const dom = parseField(fields[2] ?? "", 1, 31);
  const month = parseField(fields[3] ?? "", 1, 12);
  const dow = parseField(fields[4] ?? "", 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return false;
  if (!minute.has(date.getUTCMinutes())) return false;
  if (!hour.has(date.getUTCHours())) return false;
  if (!month.has(date.getUTCMonth() + 1)) return false;
  const domStar = fields[2] === "*";
  const dowStar = fields[4] === "*";
  const domMatch = dom.has(date.getUTCDate());
  const day = date.getUTCDay();
  const dowMatch = dow.has(day) || (day === 0 && dow.has(7));
  if (!domStar && !dowStar) return domMatch || dowMatch;
  return domMatch && dowMatch;
}
