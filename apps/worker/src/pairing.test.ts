import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  createPairingCode,
  exchangePairingCode,
  newPairingCode,
  validPairingCodeFormat,
} from "./pairing";

class PairDb implements Db {
  codes = new Map<string, { created_by: string; created_at: string; expires_at: string }>();

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
