import { describe, expect, it } from "vitest";
import { badgeColor, badgeLabel, badgeSvg } from "./badge";

describe("badge", () => {
  it("maps statuses to labels and colors", () => {
    expect(badgeLabel("success")).toBe("passing");
    expect(badgeLabel("failure")).toBe("failing");
    expect(badgeLabel("error")).toBe("failing");
    expect(badgeLabel("running")).toBe("running");
    expect(badgeLabel("queued")).toBe("pending");
    expect(badgeLabel(null)).toBe("unknown");
    expect(badgeColor("success")).toBe("#15803d");
    expect(badgeColor("failure")).toBe("#dc2626");
    expect(badgeColor(null)).toBe("#687182");
  });

  it("renders a shield svg", () => {
    const svg = badgeSvg("success");
    expect(svg).toContain("<svg");
    expect(svg).toContain("passing");
    expect(svg).toContain("#15803d");
  });
});
