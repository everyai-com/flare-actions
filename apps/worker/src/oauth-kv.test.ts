/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import { D1KV } from "./oauth-kv";

// node:sqlite via getBuiltinModule: vite-node's import analysis predates
// the specifier, but the runtime resolves it fine.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

// Real SQL semantics (LIKE escaping, ordering, limits) via an in-memory
// SQLite database behind the Db interface.
function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE oauth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          // oauth-kv only binds text, integers, and null.
          const params = values as (string | number | null)[];
          return {
            all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
            first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
            run: async () => {
              raw.prepare(query).run(...params);
              return {};
            },
          };
        },
      };
    },
  };
}

describe("oauth-kv", () => {
  it("stores and reads text and json", async () => {
    const kv = new D1KV(sqliteDb());
    expect(await kv.get("missing")).toBeNull();
    await kv.put("a", "hello");
    expect(await kv.get("a")).toBe("hello");
    await kv.put("b", JSON.stringify({ n: 1 }));
    expect(await kv.get("b", { type: "json" })).toEqual({ n: 1 });
    await kv.put("a", "again");
    expect(await kv.get("a")).toBe("again");
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  it("expires rows by ttl and absolute time", async () => {
    const kv = new D1KV(sqliteDb());
    await kv.put("short", "x", { expirationTtl: 3600 });
    expect(await kv.get("short")).toBe("x");
    await kv.put("dead", "x", { expirationTtl: 0 });
    expect(await kv.get("dead")).toBeNull();
    const past = Math.floor(Date.now() / 1000) - 10;
    await kv.put("old", "x", { expiration: past });
    expect(await kv.get("old")).toBeNull();
    const listed = await kv.list({});
    expect(listed.keys.map((k) => k.name)).toEqual(["short"]);
    expect(listed.keys[0].expiration).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("fails closed on corrupt json", async () => {
    const kv = new D1KV(sqliteDb());
    await kv.put("c", "{oops");
    expect(await kv.get("c", { type: "json" })).toBeNull();
    expect(await kv.get("c")).toBe("{oops");
  });

  it("lists by prefix with limit and cursor pages", async () => {
    const kv = new D1KV(sqliteDb());
    for (let i = 0; i < 5; i++) await kv.put(`grant:u:${i}`, "{}");
    await kv.put("client:x", "{}");
    const p1 = await kv.list({ prefix: "grant:", limit: 2 });
    expect(p1.list_complete).toBe(false);
    expect(p1.keys.map((k) => k.name)).toEqual(["grant:u:0", "grant:u:1"]);
    expect(typeof p1.cursor).toBe("string");
    const p2 = await kv.list({ prefix: "grant:", limit: 2, cursor: p1.cursor });
    expect(p2.keys.map((k) => k.name)).toEqual(["grant:u:2", "grant:u:3"]);
    const p3 = await kv.list({ prefix: "grant:", limit: 2, cursor: p2.cursor });
    expect(p3.keys.map((k) => k.name)).toEqual(["grant:u:4"]);
    expect(p3.list_complete).toBe(true);
    await expect(kv.list({ cursor: "bogus" })).rejects.toThrow("invalid cursor");
  });

  it("treats prefix wildcards literally", async () => {
    const kv = new D1KV(sqliteDb());
    await kv.put("grant_", "x");
    await kv.put("grant:1", "y");
    const res = await kv.list({ prefix: "grant_" });
    expect(res.keys.map((k) => k.name)).toEqual(["grant_"]);
    const pct = await kv.list({ prefix: "grant%" });
    expect(pct.keys).toEqual([]);
  });
});
