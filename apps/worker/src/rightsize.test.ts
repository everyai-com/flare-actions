import { describe, expect, it } from "vitest";
import { parsePeakRssBytes, SIZE_CLASS_BLURB, sizeClassForPeakRss, sizeLabelForPeakRss } from "./rightsize";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("sizeClassForPeakRss", () => {
  it("bands peaks into s/m/l/xl at 512MB/2GB/8GB", () => {
    expect(sizeClassForPeakRss(0)).toBe("s");
    expect(sizeClassForPeakRss(512 * MB - 1)).toBe("s");
    expect(sizeClassForPeakRss(512 * MB)).toBe("m");
    expect(sizeClassForPeakRss(2 * GB - 1)).toBe("m");
    expect(sizeClassForPeakRss(2 * GB)).toBe("l");
    expect(sizeClassForPeakRss(8 * GB - 1)).toBe("l");
    expect(sizeClassForPeakRss(8 * GB)).toBe("xl");
    expect(sizeClassForPeakRss(64 * GB)).toBe("xl");
  });

  it("treats garbage as small rather than throwing", () => {
    expect(sizeClassForPeakRss(Number.NaN)).toBe("s");
    expect(sizeClassForPeakRss(-5)).toBe("s");
  });

  it("labels and blurbs cover every class", () => {
    expect(sizeLabelForPeakRss(GB)).toBe("size-m");
    expect(sizeLabelForPeakRss(3 * GB)).toBe("size-l");
    for (const cls of ["s", "m", "l", "xl"] as const) {
      expect(SIZE_CLASS_BLURB[cls].length).toBeGreaterThan(10);
    }
    expect(SIZE_CLASS_BLURB.l).toContain("size-l");
    expect(SIZE_CLASS_BLURB.xl).toContain("size-xl");
  });
});

describe("parsePeakRssBytes", () => {
  it("reads peaks from both executors' result JSON", () => {
    expect(parsePeakRssBytes(JSON.stringify({ steps: [], peakRssBytes: 123456 }))).toBe(123456);
    expect(parsePeakRssBytes(JSON.stringify({ steps: [], peakRssBytes: 99.9, executor: "seat" }))).toBe(99);
  });

  it("returns null for legacy, foreign, and corrupt results", () => {
    expect(parsePeakRssBytes(JSON.stringify({ steps: [] }))).toBeNull();
    expect(parsePeakRssBytes(JSON.stringify({ peakRssBytes: "1GB" }))).toBeNull();
    expect(parsePeakRssBytes(JSON.stringify({ peakRssBytes: -1 }))).toBeNull();
    expect(parsePeakRssBytes(JSON.stringify({ peakRssBytes: 0 }))).toBeNull();
    expect(parsePeakRssBytes("not json")).toBeNull();
    expect(parsePeakRssBytes("")).toBeNull();
  });
});
