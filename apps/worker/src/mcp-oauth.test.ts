/// <reference types="node" />
import { describe, expect, it } from "vitest";
import type { AuthRequest, ClientInfo, CompleteAuthorizationOptions } from "@cloudflare/workers-oauth-provider";
import type { Db } from "./db";
import {
  authServerOptions,
  canWriteFromScope,
  denyRedirect,
  grantedScope,
  handleAuthorizeGet,
  handleAuthorizePost,
  listOAuthGrants,
  MCP_OAUTH_SCOPE_OFFLINE,
  MCP_OAUTH_SCOPE_READ,
  MCP_OAUTH_SCOPE_RUN,
  mcpResourceUrl,
  oauthProps,
  oauthUserId,
  parseGrantRecord,
  principalFromApiToken,
  principalFromCtx,
  principalFromSession,
  resourceServerConfig,
  type AuthorizeApi,
  type AuthorizeContext,
} from "./mcp-oauth";
import { D1KV } from "./oauth-kv";
import { hashToken } from "./tokens";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE oauth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
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

function tokenDb(row: Record<string, unknown> | null): Db {
  return {
    prepare(_sql: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            all: async <T,>() => ({ results: [] as T[] }),
            first: async <T,>() => (row ?? null) as T | null,
            run: async () => ({}),
          };
        },
      };
    },
  };
}

const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://app.example/callback",
  scope: [MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN],
  state: "state-1",
  issuer: "https://flare.example",
};

const CLIENT: ClientInfo = {
  clientId: "client-1",
  redirectUris: ["https://app.example/callback"],
  clientName: "Example App",
  clientUri: "https://app.example",
  tokenEndpointAuthMethod: "none",
};

function fakeApi(over: Partial<AuthorizeApi> = {}, completed: CompleteAuthorizationOptions[] = []): AuthorizeApi {
  return {
    parseAuthRequest: async () => AUTH_REQUEST,
    lookupClient: async () => CLIENT,
    completeAuthorization: async (options) => {
      completed.push(options);
      return { redirectTo: "https://app.example/callback?code=abc&state=state-1" };
    },
    ...over,
  };
}

function ctx(over: Partial<AuthorizeContext> = {}, completed: CompleteAuthorizationOptions[] = []): AuthorizeContext {
  const audits: [string, string][] = [];
  return {
    api: fakeApi({}, completed),
    session: { userId: "github/alice", login: "alice", actor: "github:alice", isAdmin: true },
    audit: async (action, target) => {
      audits.push([action, target]);
    },
    ...over,
  };
}

describe("mcp-oauth", () => {
  it("builds per-origin server options", () => {
    const opts = authServerOptions("https://flare.example");
    expect(opts.issuer).toBe("https://flare.example");
    expect(opts.resources).toEqual(["https://flare.example/mcp"]);
    expect(opts.defaultResource).toBe("https://flare.example/mcp");
    expect(opts.authorizeEndpoint).toBe("https://flare.example/authorize");
    expect(opts.tokenEndpoint).toBe("https://flare.example/oauth/token");
    expect(opts.clientRegistrationEndpoint).toBe("https://flare.example/oauth/register");
    expect(opts.scopesSupported).toContain(MCP_OAUTH_SCOPE_RUN);
    expect(mcpResourceUrl("https://flare.example")).toBe("https://flare.example/mcp");
    const cfg = resourceServerConfig("https://flare.example");
    expect(cfg.resource).toBe("https://flare.example/mcp");
    expect(cfg.authorizationServers).toEqual(["https://flare.example"]);
    expect(cfg.requiredScopes).toEqual([MCP_OAUTH_SCOPE_READ]);
  });

  it("rejects non-https origins except loopback", () => {
    expect(() => authServerOptions("http://localhost:8787")).not.toThrow();
    expect(() => authServerOptions("http://127.0.0.1:8787")).not.toThrow();
    expect(() => authServerOptions("http://flare.example")).toThrow("https");
    expect(() => authServerOptions("not a url")).toThrow("invalid origin");
    expect(() => resourceServerConfig("http://flare.example")).toThrow("https");
  });

  it("caps granted scopes by role", () => {
    expect(grantedScope([MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN], true)).toEqual([MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN]);
    expect(grantedScope([MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN], false)).toEqual([MCP_OAUTH_SCOPE_READ]);
    expect(grantedScope([MCP_OAUTH_SCOPE_RUN, MCP_OAUTH_SCOPE_OFFLINE], false)).toEqual([MCP_OAUTH_SCOPE_OFFLINE]);
    expect(grantedScope(["bogus", MCP_OAUTH_SCOPE_READ], true)).toEqual([MCP_OAUTH_SCOPE_READ]);
    expect(grantedScope([], true)).toEqual([]);
  });

  it("maps principals and write scope", () => {
    expect(oauthProps("alice")).toEqual({ actor: "oauth:alice", repos: [] });
    expect(oauthUserId("email", "a@b.c")).toBe("email/a@b.c");
    expect(canWriteFromScope([MCP_OAUTH_SCOPE_READ])).toBe(false);
    expect(canWriteFromScope([MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN])).toBe(true);
    expect(principalFromCtx({ props: oauthProps("alice"), auth: { scope: [MCP_OAUTH_SCOPE_READ] } })).toEqual({
      props: oauthProps("alice"),
      canWrite: false,
    });
    expect(principalFromSession({ userId: "github/alice", login: "alice", actor: "github:alice", isAdmin: true })).toEqual({
      props: { actor: "github:alice", repos: [] },
      canWrite: true,
    });
    expect(principalFromSession({ userId: "github/bob", login: "bob", actor: "github:bob", isAdmin: false })).toEqual({
      props: { actor: "github:bob", repos: [] },
      canWrite: false,
    });
  });

  it("falls back to legacy API tokens", async () => {
    const resource = "https://flare.example/mcp";
    const admin = await principalFromApiToken("break", { db: tokenDb(null), adminToken: "break", runnerToken: "run" }, resource);
    expect(admin?.scope).toEqual([MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN]);
    expect(admin?.props.actor).toBe("break-glass");
    const runner = await principalFromApiToken("run", { db: tokenDb(null), adminToken: "break", runnerToken: "run" }, resource);
    expect(runner?.scope).toEqual([MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN]);
    const row = {
      id: "tok-1",
      name: "t",
      token_hash: await hashToken("secret"),
      scopes: "readonly",
      repos: "o/r",
      created_at: "",
      revoked_at: null,
    };
    const readonly = await principalFromApiToken("secret", { db: tokenDb(row) }, resource);
    expect(readonly?.scope).toEqual([MCP_OAUTH_SCOPE_READ]);
    expect(readonly?.props).toEqual({ actor: "token:tok-1", repos: ["o/r"] });
    expect(readonly?.audience).toBe(resource);
    expect(await principalFromApiToken("nope", { db: tokenDb(null) }, resource)).toBeNull();
  });

  it("serves login and consent pages on GET", async () => {
    const loggedOut = await handleAuthorizeGet(
      new Request("https://flare.example/authorize?client_id=c"),
      ctx({ session: null }),
    );
    expect(await loggedOut.text()).toContain("Log in");
    const consent = await handleAuthorizeGet(
      new Request("https://flare.example/authorize?client_id=client-1&scope=flare%3Aread"),
      ctx(),
    );
    const html = await consent.text();
    expect(html).toContain("Example App");
    expect(html).toContain("flare:read");
    expect(html).toContain('action="/authorize?client_id=client-1&amp;scope=flare%3Aread"');
    expect(html).toContain("alice");
  });

  it("escapes client-controlled strings", async () => {
    const evil: ClientInfo = { ...CLIENT, clientName: "<script>alert(1)</script>", clientUri: "https://x/?a=\"b" };
    const res = await handleAuthorizeGet(
      new Request("https://flare.example/authorize?x=1"),
      ctx({ api: fakeApi({ lookupClient: async () => evil }) }),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('a="b');
  });

  it("rejects invalid authorize requests", async () => {
    const bad = await handleAuthorizeGet(
      new Request("https://flare.example/authorize"),
      ctx({ api: fakeApi({ parseAuthRequest: async () => { throw new Error("bad"); } }) }),
    );
    expect(await bad.text()).toContain("invalid or expired");
    const unknown = await handleAuthorizeGet(
      new Request("https://flare.example/authorize"),
      ctx({ api: fakeApi({ lookupClient: async () => null }) }),
    );
    expect(await unknown.text()).toContain("Unknown app");
  });

  it("denies back to the registered redirect only", async () => {
    const audits: [string, string][] = [];
    const post = (decision: string) =>
      new Request("https://flare.example/authorize?client_id=client-1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `decision=${decision}`,
      });
    const denied = await handleAuthorizePost(
      post("deny"),
      ctx({ audit: async (a, t) => { audits.push([a, t]); } }),
    );
    expect(denied.status).toBe(302);
    const location = denied.headers.get("location") ?? "";
    expect(location).toContain("https://app.example/callback?error=access_denied");
    expect(location).toContain("state=state-1");
    expect(location).toContain("iss=");
    expect(audits).toEqual([["oauth.deny", "client-1"]]);
    // Unregistered redirect: no redirect, nothing granted.
    const evil = await handleAuthorizePost(
      post("deny"),
      ctx({ api: fakeApi({ lookupClient: async () => ({ ...CLIENT, redirectUris: ["https://other/cb"] }) }) }),
    );
    expect(evil.status).toBe(200);
    expect(evil.headers.get("location")).toBeNull();
    expect(await evil.text()).toContain("nothing was granted");
  });

  it("completes grants with capped scopes", async () => {
    const completed: CompleteAuthorizationOptions[] = [];
    const audits: [string, string][] = [];
    const post = () =>
      new Request("https://flare.example/authorize?client_id=client-1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "decision=allow",
      });
    const res = await handleAuthorizePost(
      post(),
      ctx({ audit: async (a, t) => { audits.push([a, t]); } }, completed),
    );
    expect(res.status).toBe(302);
    expect(completed).toHaveLength(1);
    expect(completed[0].userId).toBe("github/alice");
    expect(completed[0].scope).toEqual([MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN]);
    expect(completed[0].props).toEqual({ actor: "oauth:alice", repos: [] });
    expect(audits[0][0]).toBe("oauth.grant");
    // Non-admin asking run-only: nothing grantable.
    const narrow: CompleteAuthorizationOptions[] = [];
    const res2 = await handleAuthorizePost(
      post(),
      {
        api: fakeApi({ parseAuthRequest: async () => ({ ...AUTH_REQUEST, scope: [MCP_OAUTH_SCOPE_RUN] }) }, narrow),
        session: { userId: "github/bob", login: "bob", actor: "github:bob", isAdmin: false },
        audit: async () => undefined,
      },
    );
    expect(res2.status).toBe(200);
    expect(narrow).toHaveLength(0);
    expect(await res2.text()).toContain("only grant read access");
    // Missing decision is not consent.
    const res3 = await handleAuthorizePost(
      new Request("https://flare.example/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "decision=maybe",
      }),
      ctx({}, narrow),
    );
    expect(await res3.text()).toContain("Allow or Deny");
  });

  it("builds deny redirects safely", () => {
    const url = denyRedirect(CLIENT, AUTH_REQUEST);
    expect(url).toContain("error=access_denied");
    expect(denyRedirect({ ...CLIENT, redirectUris: [] }, AUTH_REQUEST)).toBeNull();
    const noState = denyRedirect(CLIENT, { ...AUTH_REQUEST, state: "", issuer: undefined });
    expect(noState).not.toContain("state=");
    expect(noState).not.toContain("iss=");
  });

  it("parses grant records, skipping corrupt rows", () => {
    expect(parseGrantRecord("grant:a/b:g1", { id: "g1", userId: "a/b", clientId: "c", scope: ["flare:read"], createdAt: 7 })).toEqual({
      grantId: "g1",
      userId: "a/b",
      clientId: "c",
      scope: ["flare:read"],
      createdAt: 7,
    });
    expect(parseGrantRecord("token:a", { id: "g1", userId: "u", clientId: "c", scope: [] })).toBeNull();
    expect(parseGrantRecord("grant:u:g", null)).toBeNull();
    expect(parseGrantRecord("grant:u:g", { id: "g1", userId: "u", clientId: "c", scope: "nope" })).toBeNull();
    expect(parseGrantRecord("grant:u:g", { id: "g1" })).toBeNull();
  });

  it("lists grants from the store", async () => {
    const kv = new D1KV(sqliteDb());
    await kv.put("grant:github/alice:g1", JSON.stringify({ id: "g1", userId: "github/alice", clientId: "c1", scope: ["flare:read"], createdAt: 1 }));
    await kv.put("grant:github/alice:g2", JSON.stringify({ id: "g2", userId: "github/alice", clientId: "c2", scope: ["flare:run"] }));
    await kv.put("grant:bogus", "{corrupt");
    await kv.put("client:c1", "{}");
    const page = await listOAuthGrants(kv, {});
    expect(page.list_complete).toBe(true);
    expect(page.grants.map((g) => g.grantId).sort()).toEqual(["g1", "g2"]);
    expect(page.grants.find((g) => g.grantId === "g2")?.createdAt).toBeNull();
    // Paging applies to raw keys: the first two are the corrupt row
    // (skipped) and g1.
    const one = await listOAuthGrants(kv, { limit: 2 });
    expect(one.grants.map((g) => g.grantId)).toEqual(["g1"]);
    expect(one.list_complete).toBe(false);
    expect(typeof one.cursor).toBe("string");
  });
});
