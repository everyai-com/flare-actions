import { describe, expect, it } from "vitest";
import {
  consumeInvite,
  createInvite,
  dummyPasswordHash,
  hashPassword,
  listInvites,
  normalizeEmail,
  peekInvite,
  validateEmail,
  validatePassword,
  verifyPassword,
} from "./email";
import { createUser, deleteUser, deleteUserSessions, getUser, listUsers, type Db } from "./db";

class MemEmail implements Db {
  settings = new Map<string, string>();
  users = new Map<string, Record<string, unknown>>();
  sessions: Record<string, unknown>[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT value FROM app_settings WHERE key LIKE")) {
            return { results: [...this.settings.entries()].filter(([k]) => k.startsWith("email_invite_")).map(([, value]) => ({ value })) as T[] };
          }
          if (norm.startsWith("SELECT * FROM users ORDER BY")) {
            return { results: [...this.users.values()] as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (norm.startsWith("SELECT value FROM app_settings")) {
            const v = this.settings.get(values[0] as string);
            return (v === undefined ? null : { value: v }) as T | null;
          }
          if (norm.startsWith("SELECT * FROM users WHERE email")) {
            return ((this.users.get(values[0] as string) as T | undefined) ?? null) as T | null;
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
          if (norm.startsWith("INSERT INTO users")) {
            this.users.set(values[0] as string, { email: values[0], password_hash: values[1], is_admin: values[2], created_at: values[3] });
            return {};
          }
          if (norm.startsWith("DELETE FROM users")) {
            this.users.delete(values[0] as string);
            return {};
          }
          if (norm.startsWith("DELETE FROM sessions WHERE kind")) {
            this.sessions = this.sessions.filter((s) => !(s.kind === values[0] && s.github_user === values[1]));
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("email auth", () => {
  it("validates and normalizes emails", () => {
    expect(validateEmail("Boss@Example.COM")).toBeNull();
    expect(normalizeEmail("  Boss@Example.COM ")).toBe("boss@example.com");
    expect(validateEmail("nope")).not.toBeNull();
    expect(validateEmail("a@b")).not.toBeNull();
    expect(validateEmail("")).not.toBeNull();
    expect(validateEmail(42)).not.toBeNull();
  });

  it("validates passwords", () => {
    expect(validatePassword("12345678")).toBeNull();
    expect(validatePassword("short")).not.toBeNull();
    expect(validatePassword("x".repeat(257))).not.toBeNull();
    expect(validatePassword(undefined)).not.toBeNull();
  });

  it("hashes with unique salts and verifies", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pbkdf2\$100000\$/);
    await expect(verifyPassword("correct horse", a)).resolves.toBe(true);
    await expect(verifyPassword("wrong horse", a)).resolves.toBe(false);
    await expect(verifyPassword("correct horse", "junk")).resolves.toBe(false);
    await expect(verifyPassword("correct horse", "pbkdf2$10$00$00")).resolves.toBe(false);
    // Dummy hash is shape-valid but never matches.
    await expect(verifyPassword("anything", dummyPasswordHash())).resolves.toBe(false);
  });

  it("issues single-use invites with a 24h horizon", async () => {
    const db = new MemEmail();
    const { token, invite } = await createInvite(db, "Teammate@Example.com");
    expect(invite.email).toBe("teammate@example.com");
    await expect(peekInvite(db, token)).resolves.toEqual(invite);
    // Peek does not consume.
    await expect(peekInvite(db, token)).resolves.toEqual(invite);
    await expect(consumeInvite(db, token)).resolves.toEqual(invite);
    await expect(peekInvite(db, token)).resolves.toBeNull();
    await expect(peekInvite(db, "nope")).resolves.toBeNull();
    await expect(peekInvite(db, "bad token!")).resolves.toBeNull();

    const { token: stale } = await createInvite(db, "old@example.com");
    db.settings.set(`email_invite_${stale}`, JSON.stringify({ email: "old@example.com", expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await expect(consumeInvite(db, stale)).resolves.toBeNull();
  });

  it("lists live invites and round-trips users", async () => {
    const db = new MemEmail();
    await createInvite(db, "live@example.com");
    const { token: stale } = await createInvite(db, "dead@example.com");
    db.settings.set(`email_invite_${stale}`, JSON.stringify({ email: "dead@example.com", expiresAt: "2000-01-01T00:00:00Z" }));
    await expect(listInvites(db)).resolves.toEqual([
      { email: "live@example.com", expiresAt: expect.any(String) },
    ]);

    await createUser(db, { email: "boss@example.com", passwordHash: "h", isAdmin: true });
    await createUser(db, { email: "dev@example.com", passwordHash: "h", isAdmin: false });
    expect((await getUser(db, "boss@example.com"))?.is_admin).toBe(1);
    expect((await listUsers(db)).map((u) => u.email)).toEqual(["boss@example.com", "dev@example.com"]);
    db.sessions = [
      { kind: "email", github_user: "dev@example.com" },
      { kind: "email", github_user: "boss@example.com" },
      { kind: "github", github_user: "dev@example.com" },
    ];
    await deleteUser(db, "dev@example.com");
    await deleteUserSessions(db, "email", "dev@example.com");
    await expect(getUser(db, "dev@example.com")).resolves.toBeNull();
    expect(db.sessions).toEqual([
      { kind: "email", github_user: "boss@example.com" },
      { kind: "github", github_user: "dev@example.com" },
    ]);
  });
});
