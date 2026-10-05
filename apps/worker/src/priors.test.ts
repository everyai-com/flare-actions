import { describe, expect, it } from "vitest";
import { lookupPriorMs, priorHour, recordRuntimePrior } from "./priors";
import type { Db } from "./db";

class MemDb implements Db {
  priors = new Map<string, { samples: number; avg_ms: number }>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (norm.startsWith("SELECT avg_ms FROM job_runtime_priors")) {
            const [repo, name, hour] = values as [string, string, number];
            const exact = this.priors.get(`${repo}\n${name}\n${hour}`);
            if (exact) return { avg_ms: exact.avg_ms } as T;
            let best: { samples: number; avg_ms: number } | null = null;
            for (const [k, v] of this.priors) {
              const [r, n] = k.split("\n");
              if (r === repo && n === name && (!best || v.samples > best.samples)) best = v;
            }
            return (best ? { avg_ms: best.avg_ms } : null) as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO job_runtime_priors")) {
            const [repo, name, hour, avgMs] = values as [string, string, number, number];
            const k = `${repo}\n${name}\n${hour}`;
            const prev = this.priors.get(k);
            if (!prev) this.priors.set(k, { samples: 1, avg_ms: avgMs });
            else this.priors.set(k, { samples: prev.samples + 1, avg_ms: Math.floor(prev.avg_ms * 0.75 + avgMs * 0.25) });
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("priorHour", () => {
  it("buckets by UTC hour", () => {
    expect(priorHour("2026-10-05T03:29:43.703Z")).toBe(3);
    expect(priorHour("not-a-date")).toBeGreaterThanOrEqual(0);
  });
});

describe("record + lookup", () => {
  it("learns an EMA and prefers the hour bucket", async () => {
    const db = new MemDb();
    expect(await lookupPriorMs(db, "o/r", "test")).toBe(0);
    await recordRuntimePrior(db, { repo: "o/r", name: "test", finishedAt: "2026-10-05T03:00:00.000Z", durationMs: 1000 });
    await recordRuntimePrior(db, { repo: "o/r", name: "test", finishedAt: "2026-10-05T03:10:00.000Z", durationMs: 2000 });
    // EMA: 1000 -> 1000*0.75 + 2000*0.25 = 1250
    expect(await lookupPriorMs(db, "o/r", "test", "2026-10-05T03:59:00.000Z")).toBe(1250);
    // Other hours fall back to the repo+name average.
    expect(await lookupPriorMs(db, "o/r", "test", "2026-10-05T15:00:00.000Z")).toBe(1250);
    expect(await lookupPriorMs(db, "o/r", "other")).toBe(0);
  });
  it("ignores empty or absurd samples", async () => {
    const db = new MemDb();
    await recordRuntimePrior(db, { repo: "", name: "t", finishedAt: "2026-10-05T03:00:00.000Z", durationMs: 500 });
    await recordRuntimePrior(db, { repo: "o/r", name: "t", finishedAt: "2026-10-05T03:00:00.000Z", durationMs: 0 });
    await recordRuntimePrior(db, { repo: "o/r", name: "t", finishedAt: "2026-10-05T03:00:00.000Z", durationMs: 1e12 });
    expect(db.priors.size).toBe(0);
  });
});
