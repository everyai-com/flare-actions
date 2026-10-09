import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { countActiveJobs, rollupRunStatus } from "./db";
import { validateCloudEntitlements, validateCloudMetering } from "./settings";
import {
  cloudMetering,
  creditBalance,
  grantCredits,
  hostedMode,
  parseCloudEntitlements,
  recentLedger,
  recordRunSpend,
  runComputeMs,
  runSpendCents,
  x402Quote,
} from "./cloud";

// Ledger + settings + jobs fake: UNIQUE ref on INSERT OR IGNORE,
// exact balance math, exact active-job count.
class CloudDb implements Db {
  settings = new Map<string, string>();
  ledger: { kind: string; amountCents: number; memo: string; ref: string }[] = [];
  jobs: { run_id: string; status: string; started_at: string | null; finished_at: string | null }[] = [];
  runStatus = "";

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: this.jobs.filter((j) => j.run_id === values[0]) as T[] };
          }
          if (norm.startsWith("SELECT id, kind, amount_cents")) {
            const rows = [...this.ledger]
              .reverse()
              .slice(0, values[0] as number)
              .map((r, i) => ({ id: this.ledger.length - i, kind: r.kind, amountCents: r.amountCents, memo: r.memo, ref: r.ref, createdAt: "" }));
            return { results: rows as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          if (norm.startsWith("SELECT value FROM app_settings")) {
            const v = this.settings.get(values[0] as string);
            return ((v === undefined ? null : { value: v }) as unknown as T | null);
          }
          if (norm.startsWith("SELECT COALESCE(SUM(CASE WHEN kind")) {
            const balance = this.ledger.reduce((s, r) => s + (r.kind === "grant" ? r.amountCents : -r.amountCents), 0);
            return { balance } as unknown as T;
          }
          if (norm.startsWith("SELECT COUNT(*) AS n FROM jobs")) {
            const n = this.jobs.filter((j) => j.status === "queued" || j.status === "running" || j.status === "blocked").length;
            return { n } as unknown as T;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async (): Promise<unknown> => {
          if (norm.startsWith("INSERT OR IGNORE INTO credit_ledger")) {
            const [amountCents, memo, ref] = values as [number, string, string];
            const kind = norm.includes("VALUES ('grant'") ? "grant" : "spend";
            if (!this.ledger.some((r) => r.ref === ref)) this.ledger.push({ kind, amountCents, memo, ref });
            return {};
          }
          if (norm.startsWith("UPDATE runs SET status")) {
            this.runStatus = values[0] as string;
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

const stamp = (s: string, f: string) => ({ started_at: s, finished_at: f });

describe("hostedMode", () => {
  it("is env-only: only FLARE_CLOUD=1 opts in", () => {
    expect(hostedMode({ FLARE_CLOUD: "1" })).toBe(true);
    expect(hostedMode({})).toBe(false);
    expect(hostedMode({ FLARE_CLOUD: "0" })).toBe(false);
    expect(hostedMode({ FLARE_CLOUD: "true" })).toBe(false);
    expect(cloudMetering({ FLARE_CLOUD: "1" })).toEqual({ hosted: true });
    expect(cloudMetering({})).toEqual({ hosted: false });
  });
});

describe("parseCloudEntitlements", () => {
  it("parses a cap and ignores unknown keys", () => {
    expect(parseCloudEntitlements('{"maxConcurrentJobs": 4, "seats": true}')).toEqual({ maxConcurrentJobs: 4 });
  });
  it("degrades to unlimited on anything unparseable", () => {
    for (const raw of [null, "", "not json", "[]", "4", '"x"', '{"maxConcurrentJobs": 0}', '{"maxConcurrentJobs": -2}', '{"maxConcurrentJobs": 1.5}', '{"maxConcurrentJobs": "4"}', '{"maxConcurrentJobs": 10001}', "{}"]) {
      expect(parseCloudEntitlements(raw)).toEqual({ maxConcurrentJobs: null });
    }
  });
});

describe("runComputeMs / runSpendCents", () => {
  it("sums per-job durations (parallel jobs both count)", () => {
    const jobs = [stamp("2026-10-09T00:00:00Z", "2026-10-09T00:01:00Z"), stamp("2026-10-09T00:00:30Z", "2026-10-09T00:01:30Z")];
    expect(runComputeMs(jobs)).toBe(120000);
    expect(runSpendCents(jobs)).toBe(2);
  });
  it("rounds up to a full minute, zero when nothing ran", () => {
    expect(runSpendCents([stamp("2026-10-09T00:00:00Z", "2026-10-09T00:00:05Z")])).toBe(1);
    expect(runSpendCents([stamp("2026-10-09T00:00:00Z", "2026-10-09T00:01:00Z")])).toBe(1);
    expect(runSpendCents([stamp("2026-10-09T00:00:00Z", "2026-10-09T00:01:01Z")])).toBe(2);
    expect(runSpendCents([])).toBe(0);
    expect(runSpendCents([{ started_at: null, finished_at: null }])).toBe(0);
  });
  it("skips corrupt stamps", () => {
    expect(runComputeMs([{ started_at: "junk", finished_at: "2026-10-09T00:01:00Z" }, stamp("2026-10-09T00:01:00Z", "2026-10-09T00:00:00Z")])).toBe(0);
  });
});

describe("credit ledger", () => {
  it("grants add, spends subtract, empty is zero", async () => {
    const db = new CloudDb();
    expect(await creditBalance(db)).toBe(0);
    expect(await grantCredits(db, 500, "top-up", "grant:1")).toEqual({ ok: true });
    await recordRunSpend(db, "r1", [stamp("2026-10-09T00:00:00Z", "2026-10-09T00:02:00Z")]);
    expect(await creditBalance(db)).toBe(498);
  });
  it("rejects bad grants without writing", async () => {
    const db = new CloudDb();
    for (const cents of [0, -5, 1.5, Number.NaN, 1_000_000_001]) {
      expect((await grantCredits(db, cents, "", "g")).ok).toBe(false);
    }
    expect((await grantCredits(db, 5, "x".repeat(281), "g")).ok).toBe(false);
    expect((await grantCredits(db, 5, "", "")).ok).toBe(false);
    expect(db.ledger).toEqual([]);
  });
  it("grants are idempotent on ref (retried billing webhooks)", async () => {
    const db = new CloudDb();
    await grantCredits(db, 100, "", "grant:dup");
    await grantCredits(db, 100, "", "grant:dup");
    expect(await creditBalance(db)).toBe(100);
  });
  it("recentLedger is newest-first and capped", async () => {
    const db = new CloudDb();
    await grantCredits(db, 10, "first", "g1");
    await grantCredits(db, 20, "second", "g2");
    const rows = await recentLedger(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].memo).toBe("second");
    expect((await recentLedger(db, 1000)).length).toBe(2);
  });
  it("recordRunSpend is exactly-once per run and skips zero spend", async () => {
    const db = new CloudDb();
    const jobs = [stamp("2026-10-09T00:00:00Z", "2026-10-09T00:03:00Z")];
    await recordRunSpend(db, "r9", jobs);
    await recordRunSpend(db, "r9", jobs);
    expect(db.ledger.filter((r) => r.ref === "run:r9")).toHaveLength(1);
    expect(db.ledger[0].amountCents).toBe(3);
    await recordRunSpend(db, "r0", []);
    expect(db.ledger.some((r) => r.ref === "run:r0")).toBe(false);
  });
});

describe("countActiveJobs", () => {
  it("counts queued + running + blocked only", async () => {
    const db = new CloudDb();
    db.jobs = (["queued", "running", "blocked", "success", "failure", "cancelled"] as string[]).map((status) => ({
      run_id: "r", status, started_at: null, finished_at: null,
    }));
    expect(await countActiveJobs(db)).toBe(3);
  });
});

describe("rollup metering gate", () => {
  const cancelledRun = (db: CloudDb) => {
    db.jobs = [{ run_id: "r", status: "cancelled", started_at: "2026-10-09T00:00:00Z", finished_at: "2026-10-09T00:02:00Z" }];
  };
  it("records spend when hosted and metered", async () => {
    const db = new CloudDb();
    cancelledRun(db);
    db.settings.set("cloud_metering", "on");
    expect(await rollupRunStatus(db, "r", undefined, undefined, { hosted: true })).toBe("cancelled");
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ kind: "spend", amountCents: 2, ref: "run:r" });
  });
  it("writes nothing when unmetered, off, or OSS", async () => {
    const cases: { hosted: boolean; metering?: string }[] = [
      { hosted: true },
      { hosted: true, metering: "off" },
      { hosted: false, metering: "on" },
    ];
    for (const { hosted, metering } of cases) {
      const db = new CloudDb();
      cancelledRun(db);
      if (metering) db.settings.set("cloud_metering", metering);
      await rollupRunStatus(db, "r", undefined, undefined, hosted ? { hosted } : undefined);
      expect(db.ledger).toEqual([]);
    }
  });
});

describe("cloud settings validators", () => {
  it("accepts caps and rejects garbage", () => {
    expect(validateCloudEntitlements('{"maxConcurrentJobs": 4}')).toBeNull();
    expect(validateCloudEntitlements("{}")).toBeNull();
    expect(validateCloudEntitlements("nope")).not.toBeNull();
    expect(validateCloudEntitlements("[1]")).not.toBeNull();
    expect(validateCloudEntitlements('{"maxConcurrentJobs": 0}')).not.toBeNull();
    expect(validateCloudEntitlements('{"maxConcurrentJobs": 10001}')).not.toBeNull();
    expect(validateCloudEntitlements(4)).not.toBeNull();
    expect(validateCloudMetering("on")).toBeNull();
    expect(validateCloudMetering("off")).toBeNull();
    expect(validateCloudMetering("yes")).not.toBeNull();
  });
});

describe("x402Quote", () => {
  it("prices whole runner-months at the $49 founding rate", () => {
    const out = x402Quote(3);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.quote).toMatchObject({ runners: 3, amountCents: 14700, asset: "USDC", network: "base", payTo: null });
    expect(Date.parse(out.quote.expiresAt) - Date.now()).toBeGreaterThan(14 * 60000);
  });
  it("rejects non-positive and absurd runner counts", () => {
    for (const runners of [0, -1, 1.5, 1001, Number.NaN]) {
      expect(x402Quote(runners).ok).toBe(false);
    }
    expect(x402Quote(1).ok).toBe(true);
    expect(x402Quote(1000).ok).toBe(true);
  });
});
