import { describe, expect, it } from "vitest";
import { cpusFromProbe, effectiveCpus } from "./cpus.ts";
import { detectCpus } from "./resources.ts";

describe("effectiveCpus", () => {
  it("caps visible cores at the cgroup quota", () => {
    expect(effectiveCpus(8, "200000 100000")).toBe(2);
    expect(effectiveCpus(8, "400000 100000\n")).toBe(4);
  });

  it("rounds fractional quotas down, never below one", () => {
    expect(effectiveCpus(8, "150000 100000")).toBe(1);
    expect(effectiveCpus(8, "6250 100000")).toBe(1); // 1/16 vCPU
  });

  it("falls back to visible cores without a usable limit", () => {
    expect(effectiveCpus(8, "max 100000")).toBe(8); // cgroup v2, unlimited
    expect(effectiveCpus(8, "-1 100000")).toBe(8); // cgroup v1, unlimited
    expect(effectiveCpus(8, null)).toBe(8);
    expect(effectiveCpus(8, "garbage")).toBe(8);
    // A quota above the visible cores cannot add cores.
    expect(effectiveCpus(2, "800000 100000")).toBe(2);
    expect(effectiveCpus(Number.NaN, null)).toBe(1);
  });
});

describe("cpusFromProbe", () => {
  it("reads nproc then the cpu.max line", () => {
    expect(cpusFromProbe("8\n200000 100000\n")).toBe(2);
    expect(cpusFromProbe("4\nmax 100000\n")).toBe(4);
    expect(cpusFromProbe("4\n \n")).toBe(4); // v1 files missing
    expect(cpusFromProbe("")).toBe(1);
  });
});

describe("detectCpus", () => {
  it("reports a whole number of CPUs on this machine", () => {
    const n = detectCpus();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
