import { describe, expect, it } from "vitest";
import {
  addAllowedUser,
  beginOAuth,
  buildAuthorizeUrl,
  claimAdmin,
  consumeOAuthState,
  decideLogin,
  exchangeOAuthCode,
  fetchGithubLogin,
  listAllowedUsers,
  parseSessionCookie,
  removeAllowedUser,
  sessionClearCookie,
  sessionSetCookie,
  validateGithubLogin,
} from "./oauth";
import { createSession, deleteSession, getSession, type Db } from "./db";

class MemAuth implements Db {
  settings = new Map<string, string>();
  sessions = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => ({ results: [] as T[] }),
        first: async <T,>() => {
          if (norm.startsWith("SELECT value FROM app_settings")) {
            const v = this.settings.get(values[0] as string);
            return (v === undefined ? null : { value: v }) as T | null;
          }
          if (norm.startsWith("SELECT * FROM sessions")) {
            return ((this.sessions.get(values[0] as string) as T | undefined) ?? null) as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO app_settings")) {
            this.settings.set(values[0] as string, values[1] as string);
            return {};
          }
          if (norm.startsWith("DELETE FROM app_settings")) {
            this.settings.delete(values[0] as string);
            return {};
          }
          if (norm.startsWith("INSERT INTO sessions")) {
            this.sessions.set(values[0] as string, {
              id: values[0],
              github_user: values[1],
              is_admin: values[2],
              created_at: values[3],
              expires_at: values[4],
            });
            return {};
          }
          if (norm.startsWith("DELETE FROM sessions")) {
            this.sessions.delete(values[0] as string);
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

describe("oauth", () => {
  it("validates GitHub usernames", () => {
    expect(validateGithubLogin("octocat")).toBeNull();
    expect(validateGithubLogin("a-b-1")).toBeNull();
    expect(validateGithubLogin("")).not.toBeNull();
    expect(validateGithubLogin("has space")).not.toBeNull();
    expect(validateGithubLogin("-lead")).not.toBeNull();
    expect(validateGithubLogin("trail-")).not.toBeNull();
    expect(validateGithubLogin("x".repeat(40))).not.toBeNull();
    expect(validateGithubLogin(42)).not.toBeNull();
  });

  it("builds the authorize URL", () => {
    const u = new URL(buildAuthorizeUrl("Iv1.abc", "https://ci.example.com/cb", "st-1"));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(u.searchParams.get("redirect_uri")).toBe("https://ci.example.com/cb");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("scope")).toBe("read:user");
  });

  it("exchanges codes and fetches the login, failing closed", async () => {
    const seen: { url?: string; body?: string } = {};
    const tok = await exchangeOAuthCode(
      { clientId: "id", clientSecret: "sec", code: "c", redirectUri: "https://x/cb" },
      async (url, init) => {
        seen.url = url;
        seen.body = init?.body;
        return resp(true, { access_token: "ghu_123" });
      },
    );
    expect(tok).toBe("ghu_123");
    expect(seen.url).toBe("https://github.com/login/oauth/access_token");
    expect(seen.body).toContain("sec");
    await expect(
      exchangeOAuthCode({ clientId: "i", clientSecret: "s", code: "c", redirectUri: "u" }, async () => resp(false, {})),
    ).resolves.toBeNull();
    await expect(
      exchangeOAuthCode({ clientId: "i", clientSecret: "s", code: "c", redirectUri: "u" }, async () => resp(true, { error: "bad" })),
    ).resolves.toBeNull();

    await expect(fetchGithubLogin("t", async () => resp(true, { login: "octocat" }))).resolves.toBe("octocat");
    await expect(fetchGithubLogin("t", async () => resp(true, { login: "bad login" }))).resolves.toBeNull();
    await expect(fetchGithubLogin("t", async () => resp(false, {}))).resolves.toBeNull();
    await expect(
      fetchGithubLogin("t", async () => {
        throw new Error("down");
      }),
    ).resolves.toBeNull();
  });

  it("issues single-use OAuth states", async () => {
    const db = new MemAuth();
    const state = await beginOAuth(db);
    await expect(consumeOAuthState(db, state)).resolves.toBe(true);
    await expect(consumeOAuthState(db, state)).resolves.toBe(false);
    const stale = await beginOAuth(db);
    db.settings.set(`github_oauth_${stale}`, new Date(Date.now() - 3600000).toISOString());
    await expect(consumeOAuthState(db, stale)).resolves.toBe(false);
  });

  it("first login claims admin; then admin plus allow-list only", async () => {
    const db = new MemAuth();
    await expect(decideLogin(db, "octocat")).resolves.toEqual({ allowed: true, isAdmin: true, claimed: false });
    await claimAdmin(db, "octocat");
    await expect(decideLogin(db, "OctoCat")).resolves.toEqual({ allowed: true, isAdmin: true, claimed: true });
    await expect(decideLogin(db, "stranger")).resolves.toEqual({ allowed: false, isAdmin: false, claimed: true });
    await addAllowedUser(db, "teammate");
    await expect(decideLogin(db, "TeamMate")).resolves.toEqual({ allowed: true, isAdmin: false, claimed: true });
    await removeAllowedUser(db, "TEAMMATE");
    await expect(decideLogin(db, "teammate")).resolves.toEqual({ allowed: false, isAdmin: false, claimed: true });
  });

  it("manages the allow-list without duplicates", async () => {
    const db = new MemAuth();
    await expect(listAllowedUsers(db)).resolves.toEqual([]);
    await addAllowedUser(db, "a");
    await addAllowedUser(db, "A");
    await addAllowedUser(db, "b");
    await expect(listAllowedUsers(db)).resolves.toEqual(["a", "b"]);
    await removeAllowedUser(db, "a");
    await expect(listAllowedUsers(db)).resolves.toEqual(["b"]);
  });

  it("round-trips sessions", async () => {
    const db = new MemAuth();
    await createSession(db, { id: "s1", githubUser: "octocat", isAdmin: true, expiresAt: "2030-01-01T00:00:00Z" });
    const row = await getSession(db, "s1");
    expect(row?.github_user).toBe("octocat");
    expect(row?.is_admin).toBe(1);
    await deleteSession(db, "s1");
    await expect(getSession(db, "s1")).resolves.toBeNull();
  });

  it("parses and mints session cookies", () => {
    const req = (cookie: string | null): Request =>
      new Request("https://x/", cookie ? { headers: { Cookie: cookie } } : {});
    expect(parseSessionCookie(req("flare_session=abc-123; other=1"))).toBe("abc-123");
    expect(parseSessionCookie(req("other=1"))).toBeNull();
    expect(parseSessionCookie(req(null))).toBeNull();
    expect(parseSessionCookie(req("flare_session=ev il"))).toBeNull();
    const set = sessionSetCookie("abc-123", true);
    expect(set).toContain("flare_session=abc-123");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Secure");
    expect(sessionSetCookie("abc-123", false)).not.toContain("Secure");
    expect(sessionClearCookie(true)).toContain("Max-Age=0");
  });
});
