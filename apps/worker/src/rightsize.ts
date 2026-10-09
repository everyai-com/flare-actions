// Right-sizing: peak RSS → size class + label hint. Both executors
// report peakRssBytes in result JSON (seats via cgroupfs, BYO via ps
// sampling); the digest and dashboard turn it into an actionable
// label suggestion for fleet segmentation. Thresholds + blurbs are
// mirrored in dashboard.ts (sizeClassForPeak / SIZE_CLASS_BLURB) —
// keep them in sync.
export type SizeClass = "s" | "m" | "l" | "xl";

export function sizeClassForPeakRss(peakRssBytes: number): SizeClass {
  if (!Number.isFinite(peakRssBytes) || peakRssBytes < 512 * 1024 * 1024) return "s";
  if (peakRssBytes < 2 * 1024 * 1024 * 1024) return "m";
  if (peakRssBytes < 8 * 1024 * 1024 * 1024) return "l";
  return "xl";
}

export function sizeLabelForPeakRss(peakRssBytes: number): string {
  return `size-${sizeClassForPeakRss(peakRssBytes)}`;
}

export const SIZE_CLASS_BLURB: Record<SizeClass, string> = {
  s: "fits small runners",
  m: "fits standard runners",
  l: "needs 8gb+ runners — tag labels: [size-l] to segment the fleet",
  xl: "needs 16gb+ runners — tag labels: [size-xl] to segment the fleet",
};

// Tolerant result-JSON read: legacy/foreign results yield null, never
// throw (digest + dashboard call this on every job row).
export function parsePeakRssBytes(result: string): number | null {
  try {
    const parsed = JSON.parse(result) as { peakRssBytes?: unknown };
    if (typeof parsed?.peakRssBytes !== "number") return null;
    if (!Number.isFinite(parsed.peakRssBytes) || parsed.peakRssBytes <= 0) return null;
    return Math.floor(parsed.peakRssBytes);
  } catch {
    return null;
  }
}
