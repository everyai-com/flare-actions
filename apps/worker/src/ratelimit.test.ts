import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "./db";
import {
  AUTH_MAX_FAILURES,
  authThrottleBlocked,
  authThrottleKeys,
  clearAuthFailures,
  recordAuthFailure,
} from "./ratelimit";

interface AttemptRow {
  failures: number;
  window_started_at: string;
  blocked_until: string | null;
}

// Interprets the limiter's SQL against an in-memory map (same semantics
// as the upsert: reset on window expiry, block at the threshold).
class MemDb implements Db {
  attempts = new Map<string, AttemptRow>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: [] as T[] }),
        first: async <T,>(): Promise<T | null> => {
          if (norm.startsWith("SELECT blocked_until FROM auth_attempts")) {
            const row = this.attempts.get(values[0] as string);
            return (row ? { blocked_until: row.blocked_until } : null) as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO auth_attempts")) {
            const [key, windowStart, cutoff, cutoff2, nowIso, cutoff3, maxFailures, blockUntil] = values as [
              string,
              string,
              string,
              string,
              string,
              string,
              number,
              string,
            ];
            const existing = this.attempts.get(key);
            if (!existing || existing.window_started_at < cutoff) {
              this.attempts.set(key, { failures: 1, window_started_at: windowStart, blocked_until: null });
              return {};
            }
            const failures = existing.failures + 1;
            const blocked = failures >= maxFailures ? blockUntil : existing.blocked_until;
            this.attempts.set(key, { failures, window_started_at: existing.window_started_at, blocked_until: blocked });
            void cutoff2;
            void nowIso;
            void cutoff3;
            return {};
          }
          if (norm.startsWith("DELETE FROM auth_attempts WHERE window_started_at")) {
            const [cutoff, nowIso] = values as [string, string];
            for (const [key, row] of this.attempts) {
              if (row.window_started_at < cutoff && (row.blocked_until === null || row.blocked_until < nowIso)) {
                this.attempts.delete(key);
              }
            }
            return {};
          }
          if (norm.startsWith("DELETE FROM auth_attempts WHERE key")) {
            this.attempts.delete(values[0] as string);
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("authThrottleKeys", () => {
  it("includes the email key and a hashed IP key when the header is present", async () => {
    const request = new Request("https://x/v1/admin/login", { headers: { "cf-connecting-ip": "203.0.113.9" } });
    const keys = await authThrottleKeys(request, "a@b.co");
    expect(keys[0]).toBe("email:a@b.co");
    expect(keys[1]).toMatch(/^ip:[0-9a-f]{64}$/);
    expect(keys[1]).not.toContain("203.0.113.9");
  });

  it("omits the IP key when the header is absent", async () => {
    const keys = await authThrottleKeys(new Request("https://x/v1/admin/login"), "a@b.co");
    expect(keys).toEqual(["email:a@b.co"]);
  });
});

describe("recordAuthFailure", () => {
  it("blocks at the threshold and stays blocked inside the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
    const db = new MemDb();
    for (let i = 0; i < AUTH_MAX_FAILURES - 1; i++) {
      await recordAuthFailure(db, "email:a@b.co");
    }
    expect(await authThrottleBlocked(db, ["email:a@b.co"])).toBe(false);
    await recordAuthFailure(db, "email:a@b.co");
    expect(await authThrottleBlocked(db, ["email:a@b.co"])).toBe(true);
  });

  it("unblocks once the block expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
    const db = new MemDb();
    for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
      await recordAuthFailure(db, "email:a@b.co");
    }
    vi.setSystemTime(new Date("2026-10-04T10:16:00.000Z"));
    expect(await authThrottleBlocked(db, ["email:a@b.co"])).toBe(false);
  });

  it("resets the counter once the window slides past the first failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
    const db = new MemDb();
    for (let i = 0; i < AUTH_MAX_FAILURES - 1; i++) {
      await recordAuthFailure(db, "email:a@b.co");
    }
    vi.setSystemTime(new Date("2026-10-04T10:16:00.000Z"));
    await recordAuthFailure(db, "email:a@b.co");
    expect(await authThrottleBlocked(db, ["email:a@b.co"])).toBe(false);
    expect(db.attempts.get("email:a@b.co")?.failures).toBe(1);
  });

  it("clears keys on a successful sign-in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
    const db = new MemDb();
    for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
      await recordAuthFailure(db, "email:a@b.co");
      await recordAuthFailure(db, "ip:abc");
    }
    await clearAuthFailures(db, ["email:a@b.co", "ip:abc"]);
    expect(await authThrottleBlocked(db, ["email:a@b.co", "ip:abc"])).toBe(false);
    expect(db.attempts.size).toBe(0);
  });

  it("prunes closed windows so sprayed keys cannot accumulate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
    const db = new MemDb();
    await recordAuthFailure(db, "email:old@b.co");
    vi.setSystemTime(new Date("2026-10-04T10:30:00.000Z"));
    await recordAuthFailure(db, "email:new@b.co");
    expect(db.attempts.has("email:old@b.co")).toBe(false);
    expect(db.attempts.has("email:new@b.co")).toBe(true);
  });
});
