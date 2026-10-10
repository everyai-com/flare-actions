// Page-size contract shared by every list endpoint.
//
// Contract: a route's default page size must be servable, i.e.
// DEFAULT_PAGE_SIZE (owned by each route) <= MAX_PAGE_SIZE (owned here).
// test/pagination.test.ts pins it.

export const MAX_PAGE_SIZE = 50;

/** Parse `?limit=`, falling back to `fallback`, clamped to [1, MAX_PAGE_SIZE]. */
export function parseLimit(raw: string | null, fallback: number): number {
  const n = raw === null || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(n)) return Math.min(fallback, MAX_PAGE_SIZE);
  return Math.max(1, Math.min(Math.floor(n), MAX_PAGE_SIZE));
}

/** Opaque cursor = base-10 offset. Invalid cursors restart at 0. */
export function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
