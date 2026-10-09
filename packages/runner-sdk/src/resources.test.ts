import { describe, expect, it } from "vitest";
import {
  formatBytes,
  JobResourceMonitor,
  parsePsOutput,
  psArgs,
  sampleProcessTree,
  sumProcessTree,
} from "./resources";

describe("parsePsOutput", () => {
  it("parses procps-style rows and skips garbage", () => {
    const out = "   100     1  8912  0.0\n   200   100  2048 12.5\n  PID  PPID   RSS %CPU\nnot a row\n   300   200  -5  0.0\n";
    expect(parsePsOutput(out)).toEqual([
      { pid: 100, ppid: 1, rssKb: 8912, cpu: 0 },
      { pid: 200, ppid: 100, rssKb: 2048, cpu: 12.5 },
    ]);
  });

  it("parses BSD-style rows the same way", () => {
    const out = "  501     1     0   0.0\n 1234   501  5120   3.2\n";
    expect(parsePsOutput(out)).toEqual([
      { pid: 501, ppid: 1, rssKb: 0, cpu: 0 },
      { pid: 1234, ppid: 501, rssKb: 5120, cpu: 3.2 },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parsePsOutput("")).toEqual([]);
  });
});

describe("sumProcessTree", () => {
  it("sums multi-level descendants, excluding the root itself", () => {
    const rows = [
      { pid: 1, ppid: 0, rssKb: 1000, cpu: 1 },
      { pid: 100, ppid: 1, rssKb: 5000, cpu: 2 }, // root: excluded
      { pid: 200, ppid: 100, rssKb: 2048, cpu: 12.5 },
      { pid: 201, ppid: 100, rssKb: 1024, cpu: 0.5 },
      { pid: 300, ppid: 200, rssKb: 512, cpu: 100 },
      { pid: 400, ppid: 1, rssKb: 9999, cpu: 50 }, // outside the tree
    ];
    expect(sumProcessTree(rows, 100)).toEqual({ rssBytes: (2048 + 1024 + 512) * 1024, cpuPercent: 113 });
  });

  it("returns zeros for an unknown root and survives pid cycles", () => {
    expect(sumProcessTree([], 999999)).toEqual({ rssBytes: 0, cpuPercent: 0 });
    const rows = [
      { pid: 100, ppid: 101, rssKb: 10, cpu: 1 },
      { pid: 101, ppid: 100, rssKb: 20, cpu: 2 },
    ];
    expect(sumProcessTree(rows, 100)).toEqual({ rssBytes: 20 * 1024, cpuPercent: 2 });
  });
});

describe("psArgs", () => {
  it("selects the platform process-listing flag", () => {
    expect(psArgs()[0]).toBe(process.platform === "darwin" ? "-ax" : "-e");
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("JobResourceMonitor", () => {
  it("keeps peaks across samples and ignores sampler failures", async () => {
    const samples = [
      { rssBytes: 1000, cpuPercent: 5 },
      { rssBytes: 3000, cpuPercent: 2 },
      { rssBytes: 2000, cpuPercent: 9 },
    ];
    let i = 0;
    const monitor = new JobResourceMonitor(1, {
      intervalMs: 5,
      sample: async () => {
        const s = samples[Math.min(i, samples.length - 1)];
        i += 1;
        if (i === 2) throw new Error("ps exploded");
        return s;
      },
    });
    monitor.start();
    await new Promise((r) => setTimeout(r, 40));
    const peaks = await monitor.stop();
    expect(peaks).toEqual({ peakRssBytes: 2000, peakCpuPercent: 9 });
  });

  it("stop is idempotent and safe before start", async () => {
    let calls = 0;
    const monitor = new JobResourceMonitor(1, {
      sample: async () => {
        calls += 1;
        return { rssBytes: 10, cpuPercent: 1 };
      },
    });
    expect(await monitor.stop()).toEqual({ peakRssBytes: 10, peakCpuPercent: 1 });
    expect(await monitor.stop()).toEqual({ peakRssBytes: 10, peakCpuPercent: 1 });
    expect(calls).toBe(1);
  });

  it("start is idempotent", async () => {
    let calls = 0;
    const monitor = new JobResourceMonitor(1, {
      intervalMs: 1000,
      sample: async () => {
        calls += 1;
        return { rssBytes: 0, cpuPercent: 0 };
      },
    });
    monitor.start();
    monitor.start();
    await monitor.stop();
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe("sampleProcessTree (live)", () => {
  it("reads the test runner's own subtree without throwing", async () => {
    const usage = await sampleProcessTree(process.pid);
    expect(Number.isFinite(usage.rssBytes)).toBe(true);
    expect(Number.isFinite(usage.cpuPercent)).toBe(true);
    expect(usage.rssBytes).toBeGreaterThanOrEqual(0);
    expect(usage.cpuPercent).toBeGreaterThanOrEqual(0);
  });
});
