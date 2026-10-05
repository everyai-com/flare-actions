import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "./db";
import { checkTurnstile, getTurnstileSecret, getTurnstileSiteKey, verifyTurnstileToken } from "./turnstile";

afterEach(() => {
  vi.unstubAllGlobals();
});

class MemDb implements Db {
  settings = new Map<string, string>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: [] as T[] }),
        first: async <T,>() => {
          if (!norm.startsWith("SELECT value FROM app_settings")) throw new Error(`unrouted first: ${norm}`);
          const v = this.settings.get(values[0] as string);
          return (v === undefined ? null : { value: v }) as T | null;
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO app_settings")) {
            this.settings.set(values[0] as string, values[1] as string);
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("verifyTurnstileToken", () => {
  it("accepts success responses and posts the token", async () => {
    let seen = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        seen = String(init.body ?? "");
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }),
    );
    expect(await verifyTurnstileToken("secret", "tok", "1.2.3.4")).toBe(true);
    expect(seen).toContain("secret=secret");
    expect(seen).toContain("response=tok");
    expect(seen).toContain("remoteip=1.2.3.4");
  });

  it("rejects failures, bad json, http errors, and oversized tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));
    expect(await verifyTurnstileToken("secret", "tok")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 200 })));
    expect(await verifyTurnstileToken("secret", "tok")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    expect(await verifyTurnstileToken("secret", "tok")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    expect(await verifyTurnstileToken("secret", "tok")).toBe(false);
    expect(await verifyTurnstileToken("", "tok")).toBe(false);
    expect(await verifyTurnstileToken("secret", "x".repeat(9000))).toBe(false);
  });
});

describe("turnstile config resolution", () => {
  it("prefers env over D1 for both keys", async () => {
    const db = new MemDb();
    db.settings.set("turnstile_site_key", "site-d1");
    expect(await getTurnstileSiteKey(db, { TURNSTILE_SITE_KEY: "site-env" })).toBe("site-env");
    expect(await getTurnstileSiteKey(db, {})).toBe("site-d1");
    expect(await getTurnstileSiteKey(db, { TURNSTILE_SITE_KEY: "  " })).toBe("site-d1");
    expect(await getTurnstileSiteKey(new MemDb(), {})).toBeNull();
    expect(await getTurnstileSecret(db, { TURNSTILE_SECRET_KEY: "secret-env" })).toBe("secret-env");
    expect(await getTurnstileSecret(new MemDb(), {})).toBeNull();
  });

  it("checkTurnstile passes through when unconfigured", async () => {
    expect(await checkTurnstile(new MemDb(), {}, undefined)).toBeNull();
  });

  it("checkTurnstile requires and verifies the token when configured", async () => {
    const db = new MemDb();
    const env = { TURNSTILE_SECRET_KEY: "secret-env" };
    expect(await checkTurnstile(db, env, undefined)).toBe("captcha verification required");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    expect(await checkTurnstile(db, env, "tok", "9.9.9.9")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));
    expect(await checkTurnstile(db, env, "tok")).toBe("captcha verification failed");
  });
});
