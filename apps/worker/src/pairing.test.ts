import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { creditBalance } from "./cloud";
import {
  createPairingCode,
  createTopupLink,
  exchangePairingCode,
  newPairingCode,
  previewTopupLink,
  redeemTopupLink,
  validPairingCodeFormat,
} from "./pairing";

class PairDb implements Db {
  codes = new Map<string, { created_by: string; created_at: string; expires_at: string }>();
  topups = new Map<string, { amount_cents: number; memo: string; created_by: string; created_at: string; expires_at: string }>();
  grants = new Map<string, number>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          if (norm.startsWith("DELETE FROM pairing_codes WHERE code_hash = ? RETURNING")) {
            const row = this.codes.get(values[0] as string) ?? null;
            this.codes.delete(values[0] as string);
            return row as T | null;
          }
          if (norm.startsWith("SELECT amount_cents, memo, expires_at FROM topup_links")) {
            const row = this.topups.get(values[0] as string) ?? null;
            return row as T | null;
          }
          if (norm.startsWith("DELETE FROM topup_links WHERE code_hash = ? RETURNING")) {
            const row = this.topups.get(values[0] as string) ?? null;
            this.topups.delete(values[0] as string);
            return (row ? { code_hash: values[0] } : null) as T | null;
          }
          if (norm.startsWith("SELECT COALESCE(SUM(CASE WHEN kind")) {
            let balance = 0;
            for (const cents of this.grants.values()) balance += cents;
            return { balance } as unknown as T;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async (): Promise<unknown> => {
          if (norm.startsWith("DELETE FROM pairing_codes WHERE expires_at < ?")) {
            const cutoff = values[0] as string;
            let n = 0;
            for (const [hash, row] of this.codes) {
              if (row.expires_at < cutoff && n < (values[1] as number)) {
                this.codes.delete(hash);
                n += 1;
              }
            }
            return { meta: { changes: n } };
          }
          if (norm.startsWith("INSERT INTO pairing_codes")) {
            this.codes.set(values[0] as string, {
              created_by: values[1] as string,
              created_at: values[2] as string,
              expires_at: values[3] as string,
            });
            return { meta: { changes: 1 } };
          }
          if (norm.startsWith("DELETE FROM topup_links WHERE expires_at < ?")) {
            const cutoff = values[0] as string;
            let n = 0;
            for (const [hash, row] of this.topups) {
              if (row.expires_at < cutoff && n < (values[1] as number)) {
                this.topups.delete(hash);
                n += 1;
              }
            }
            return { meta: { changes: n } };
          }
          if (norm.startsWith("INSERT INTO topup_links")) {
            this.topups.set(values[0] as string, {
              amount_cents: values[1] as number,
              memo: values[2] as string,
              created_by: values[3] as string,
              created_at: values[4] as string,
              expires_at: values[5] as string,
            });
            return { meta: { changes: 1 } };
          }
          if (norm.startsWith("DELETE FROM topup_links WHERE code_hash = ?")) {
            this.topups.delete(values[0] as string);
            return { meta: { changes: 1 } };
          }
          if (norm.startsWith("INSERT OR IGNORE INTO credit_ledger")) {
            const ref = values[2] as string;
            if (!this.grants.has(ref)) this.grants.set(ref, values[0] as number);
            return { meta: { changes: 1 } };
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("pairing codes", () => {
  it("mints typable codes in XXXX-XXXX form", () => {
    for (let i = 0; i < 25; i++) {
      const code = newPairingCode();
      expect(validPairingCodeFormat(code)).toBe(true);
      expect(code).not.toMatch(/[01ILO]/);
    }
    expect(new Set([newPairingCode(), newPairingCode(), newPairingCode()]).size).toBe(3);
    expect(validPairingCodeFormat("nope")).toBe(false);
    expect(validPairingCodeFormat("abcd-efgh")).toBe(false);
    expect(validPairingCodeFormat(null)).toBe(false);
  });

  it("round-trips: create then exchange once", async () => {
    const db = new PairDb();
    const { code, expiresAt } = await createPairingCode(db, "admin:me");
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60000);
    // Only the hash rests in D1 — never the code itself.
    expect(JSON.stringify([...db.codes.keys()])).not.toContain(code);
    expect(await exchangePairingCode(db, code)).toEqual({ ok: true, createdBy: "admin:me" });
    // Single-use: the replay finds no row.
    expect(await exchangePairingCode(db, code)).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects malformed, unknown, and expired codes", async () => {
    const db = new PairDb();
    expect(await exchangePairingCode(db, "bogus")).toEqual({ ok: false, reason: "unknown" });
    expect(await exchangePairingCode(db, "AAAA-BBBB")).toEqual({ ok: false, reason: "unknown" });
    const { code } = await createPairingCode(db, "admin:me");
    for (const row of db.codes.values()) row.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await exchangePairingCode(db, code)).toEqual({ ok: false, reason: "expired" });
  });

  it("prunes expired rows on create", async () => {
    const db = new PairDb();
    db.codes.set("old", { created_by: "", created_at: "", expires_at: new Date(Date.now() - 1000).toISOString() });
    await createPairingCode(db, "admin:me");
    expect(db.codes.has("old")).toBe(false);
    expect(db.codes.size).toBe(1);
  });
});

describe("top-up links", () => {
  const mint = (db: PairDb, over: { amountCents?: number; memo?: string; ttlHours?: number } = {}) =>
    createTopupLink(db, {
      amountCents: over.amountCents ?? 500,
      memo: over.memo ?? "Q4 budget",
      ttlHours: over.ttlHours ?? 72,
      createdBy: "admin:me",
      origin: "https://cloud.example",
    });

  it("mints a code + approval link, hash-only in D1", async () => {
    const db = new PairDb();
    const out = await mint(db);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(validPairingCodeFormat(out.link.code)).toBe(true);
    expect(out.link.link).toBe(`https://cloud.example/v1/cloud/topup-links/redeem?code=${out.link.code}`);
    expect(out.link.amountCents).toBe(500);
    expect(Date.parse(out.link.expiresAt) - Date.now()).toBeGreaterThan(71 * 3600000);
    expect(JSON.stringify([...db.topups.keys()])).not.toContain(out.link.code);
  });

  it("rejects bad mints without writing", async () => {
    const db = new PairDb();
    expect((await mint(db, { amountCents: 0 })).ok).toBe(false);
    expect((await mint(db, { amountCents: 1.5 })).ok).toBe(false);
    expect((await mint(db, { memo: "x".repeat(281) })).ok).toBe(false);
    expect((await mint(db, { ttlHours: 0 })).ok).toBe(false);
    expect((await mint(db, { ttlHours: 721 })).ok).toBe(false);
    expect(db.topups.size).toBe(0);
  });

  it("preview shows the offer without consuming", async () => {
    const db = new PairDb();
    const out = await mint(db);
    if (!out.ok) throw new Error("mint failed");
    const preview = await previewTopupLink(db, out.link.code);
    expect(preview).toEqual({ ok: true, amountCents: 500, memo: "Q4 budget", expiresAt: out.link.expiresAt });
    // Still redeemable after any number of previews (unfurlers safe).
    await previewTopupLink(db, out.link.code);
    expect((await redeemTopupLink(db, out.link.code)).ok).toBe(true);
  });

  it("redeems once: grants the ledger, then the code is dead", async () => {
    const db = new PairDb();
    const out = await mint(db);
    if (!out.ok) throw new Error("mint failed");
    expect(await redeemTopupLink(db, out.link.code)).toEqual({ ok: true, amountCents: 500, memo: "Q4 budget" });
    expect(await creditBalance(db)).toBe(500);
    expect(await redeemTopupLink(db, out.link.code)).toEqual({ ok: false, reason: "unknown" });
    expect(await previewTopupLink(db, out.link.code)).toEqual({ ok: false, reason: "unknown" });
    expect(await creditBalance(db)).toBe(500);
  });

  it("rejects malformed, unknown, and expired codes", async () => {
    const db = new PairDb();
    expect(await redeemTopupLink(db, "bogus")).toEqual({ ok: false, reason: "unknown" });
    expect(await redeemTopupLink(db, "AAAA-BBBB")).toEqual({ ok: false, reason: "unknown" });
    expect(await previewTopupLink(db, "bogus")).toEqual({ ok: false, reason: "unknown" });
    const out = await mint(db);
    if (!out.ok) throw new Error("mint failed");
    for (const row of db.topups.values()) row.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await previewTopupLink(db, out.link.code)).toEqual({ ok: false, reason: "expired" });
    expect(await redeemTopupLink(db, out.link.code)).toEqual({ ok: false, reason: "expired" });
    expect(await creditBalance(db)).toBe(0);
  });
});
