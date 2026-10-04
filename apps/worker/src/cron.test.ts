import { describe, expect, it } from "vitest";
import { cronMatches, validateCron } from "./cron";

describe("validateCron", () => {
  it("accepts standard 5-field expressions", () => {
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("*/15 * * * *")).toBeNull();
    expect(validateCron("0 3 * * *")).toBeNull();
    expect(validateCron("30 8,20 * * *")).toBeNull();
    expect(validateCron("0 0 1 1 *")).toBeNull();
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("0 0 * * 7")).toBeNull();
    expect(validateCron(" 0  12  *  *  0 ")).toBeNull();
    expect(validateCron("0-30/5 6 * * *")).toBeNull();
  });

  it("rejects malformed expressions with a field name", () => {
    expect(validateCron("* * * *")).toContain("5 fields");
    expect(validateCron("* * * * * *")).toContain("5 fields");
    expect(validateCron("60 * * * *")).toContain("minute");
    expect(validateCron("0 24 * * *")).toContain("hour");
    expect(validateCron("0 0 0 * *")).toContain("day-of-month");
    expect(validateCron("0 0 * 13 *")).toContain("month");
    expect(validateCron("0 0 * * 8")).toContain("day-of-week");
    expect(validateCron("*/0 * * * *")).toContain("minute");
    expect(validateCron("5/2 * * * *")).toContain("minute");
    expect(validateCron("a b c d e")).toContain("minute");
    expect(validateCron(42)).not.toBeNull();
    expect(validateCron("x".repeat(129))).not.toBeNull();
  });
});

describe("cronMatches", () => {
  // 2026-01-01 is a Thursday; 2026-01-02 Friday; 2026-01-04 Sunday.
  it("matches minute and hour in UTC", () => {
    expect(cronMatches("30 10 * * *", new Date("2026-01-01T10:30:00.000Z"))).toBe(true);
    expect(cronMatches("30 10 * * *", new Date("2026-01-01T10:31:00.000Z"))).toBe(false);
    expect(cronMatches("30 10 * * *", new Date("2026-01-01T11:30:00.000Z"))).toBe(false);
  });

  it("handles steps and lists", () => {
    for (const m of [0, 15, 30, 45]) {
      expect(cronMatches("*/15 * * * *", new Date(`2026-01-01T10:${String(m).padStart(2, "0")}:00.000Z`))).toBe(true);
    }
    expect(cronMatches("*/15 * * * *", new Date("2026-01-01T10:16:00.000Z"))).toBe(false);
    expect(cronMatches("0 8,20 * * *", new Date("2026-01-01T20:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 8,20 * * *", new Date("2026-01-01T09:00:00.000Z"))).toBe(false);
  });

  it("matches weekdays, including the Sunday 7 alias", () => {
    expect(cronMatches("0 12 * * 4", new Date("2026-01-01T12:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 12 * * 5", new Date("2026-01-01T12:00:00.000Z"))).toBe(false);
    expect(cronMatches("0 12 * * 7", new Date("2026-01-04T12:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 12 * * 0", new Date("2026-01-04T12:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 12 * * 1-5", new Date("2026-01-02T12:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 12 * * 1-5", new Date("2026-01-03T12:00:00.000Z"))).toBe(false);
  });

  it("uses OR when both day fields are restricted", () => {
    // dom=1 OR Friday: the 1st matches even though it is a Thursday...
    expect(cronMatches("0 12 1 * 5", new Date("2026-01-01T12:00:00.000Z"))).toBe(true);
    // ...and Friday the 2nd matches on the weekday.
    expect(cronMatches("0 12 1 * 5", new Date("2026-01-02T12:00:00.000Z"))).toBe(true);
    // Saturday the 3rd matches neither.
    expect(cronMatches("0 12 1 * 5", new Date("2026-01-03T12:00:00.000Z"))).toBe(false);
  });

  it("returns false for malformed expressions", () => {
    expect(cronMatches("nonsense", new Date())).toBe(false);
    expect(cronMatches("60 * * * *", new Date())).toBe(false);
  });
});
