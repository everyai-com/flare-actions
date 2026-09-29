import { describe, expect, it } from "vitest";
import {
  beginConnect,
  buildManifest,
  consumeConnectState,
  exchangeManifestCode,
  installUrl,
  resolveAppCreds,
  storeAppCredentials,
  suggestAppName,
  validateAppName,
} from "./connect";
import type { Db } from "./db";

class MemSettings implements Db {
  store = new Map<string, string>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: [] as T[] }),
        first: async <T,>() => {
          if (!norm.startsWith("SELECT value FROM app_settings")) throw new Error(`unrouted first: ${norm}`);
          const v = this.store.get(values[0] as string);
          return (v === undefined ? null : { value: v }) as T | null;
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO app_settings")) {
            this.store.set(values[0] as string, values[1] as string);
            return {};
          }
          if (norm.startsWith("DELETE FROM app_settings")) {
            this.store.delete(values[0] as string);
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

const resp = (ok: boolean, data: unknown): Response =>
  ({ ok, json: async () => data }) as Response;

describe("connect", () => {
  it("builds a minimal manifest from the request origin", () => {
    const m = buildManifest("flare-actions-a1b2", "https://ci.example.com/");
    expect(m.name).toBe("flare-actions-a1b2");
    expect(m.public).toBe(false);
    expect(m.url).toBe("https://ci.example.com");
    expect(m.setup_url).toBe("https://ci.example.com/dashboard");
    expect(m.redirect_url).toBe("https://ci.example.com/v1/admin/github/callback");
    expect(m.default_permissions).toEqual({ contents: "read", statuses: "write" });
    expect(m.default_events).toEqual(["push", "pull_request"]);
    expect(m.hook_attributes).toEqual({ url: "https://ci.example.com/webhooks/github", active: true });
  });

  it("validates app names and suggests unique defaults", () => {
    expect(validateAppName("flare-actions-a1b2")).toBeNull();
    expect(validateAppName("")).toContain("1-34");
    expect(validateAppName("has space")).toContain("1-34");
    expect(validateAppName("x".repeat(35))).toContain("1-34");
    expect(validateAppName("has/slash")).toContain("1-34");
    expect(suggestAppName("abcdef123456")).toBe("flare-actions-abcd");
  });

  it("issues single-use states with a 15-minute horizon", async () => {
    const db = new MemSettings();
    const state = await beginConnect(db);
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    await expect(consumeConnectState(db, state)).resolves.toBe(true);
    await expect(consumeConnectState(db, state)).resolves.toBe(false);
    await expect(consumeConnectState(db, "nope")).resolves.toBe(false);

    const stale = await beginConnect(db);
    db.store.set(`github_connect_${stale}`, new Date(Date.now() - 3600000).toISOString());
    await expect(consumeConnectState(db, stale)).resolves.toBe(false);
  });

  it("exchanges a manifest code for app credentials", async () => {
    const good = {
      id: 123456,
      slug: "flare-actions-a1b2",
      webhook_secret: "whsec_abc",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----\n",
    };
    await expect(exchangeManifestCode("code", async () => resp(true, good))).resolves.toEqual({
      appId: "123456",
      slug: "flare-actions-a1b2",
      webhookSecret: "whsec_abc",
      privateKey: good.pem,
    });
    await expect(exchangeManifestCode("code", async () => resp(false, {}))).resolves.toBeNull();
    await expect(exchangeManifestCode("code", async () => resp(true, { ...good, pem: "junk" }))).resolves.toBeNull();
    await expect(exchangeManifestCode("code", async () => resp(true, { ...good, id: "123" }))).resolves.toBeNull();
    await expect(
      exchangeManifestCode("code", async () => {
        throw new Error("down");
      }),
    ).resolves.toBeNull();
    expect(installUrl("flare-actions-a1b2")).toBe("https://github.com/apps/flare-actions-a1b2/installations/new");
  });

  it("stores credentials and resolves env-first, D1-second", async () => {
    const db = new MemSettings();
    await storeAppCredentials(db, { appId: "42", slug: "s", webhookSecret: "w", privateKey: "k" });
    expect(db.store.get("github_app_id")).toBe("42");
    expect(db.store.get("github_private_key")).toBe("k");
    expect(db.store.get("github_app_slug")).toBe("s");
    expect(db.store.get("webhook_secret")).toBe("w");

    await expect(resolveAppCreds(db, { appId: "env", privateKey: "envkey" })).resolves.toEqual({
      appId: "env",
      privateKey: "envkey",
    });
    await expect(resolveAppCreds(db, {})).resolves.toEqual({ appId: "42", privateKey: "k" });
    await expect(resolveAppCreds(new MemSettings(), {})).resolves.toBeNull();
    const partial = new MemSettings();
    partial.store.set("github_app_id", "42");
    await expect(resolveAppCreds(partial, {})).resolves.toBeNull();
  });
});
