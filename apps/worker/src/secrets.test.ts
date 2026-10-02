import { describe, expect, it } from "vitest";
import { setRepoSecret, type Db, type RepoSecretRow } from "./db";
import {
  decryptSecretValue,
  encryptSecretValue,
  getDecryptedRepoSecrets,
  resolveSecretsKey,
  validateSecretName,
  validateSecretValue,
} from "./secrets";
import { SETTING_KEYS } from "./settings";

class MemDb implements Db {
  settings = new Map<string, string>();
  secrets: RepoSecretRow[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT repo, name, iv, ciphertext, updated_at FROM repo_secrets")) {
            return { results: this.secrets.filter((s) => s.repo === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
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
          if (norm.startsWith("INSERT INTO repo_secrets")) {
            const [repo, name, iv, ciphertext, updated_at] = values as string[];
            this.secrets = this.secrets.filter((s) => !(s.repo === repo && s.name === name));
            this.secrets.push({ repo, name, iv, ciphertext, updated_at });
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

const KEY_B64 = Buffer.from("0".repeat(32)).toString("base64");

describe("validateSecretName", () => {
  it("accepts shell-style names", () => {
    expect(validateSecretName("TOKEN")).toBeNull();
    expect(validateSecretName("_private1")).toBeNull();
  });

  it("rejects bad names", () => {
    expect(validateSecretName("has-dash")).not.toBeNull();
    expect(validateSecretName("9lives")).not.toBeNull();
    expect(validateSecretName("")).not.toBeNull();
    expect(validateSecretName("x".repeat(65))).not.toBeNull();
    expect(validateSecretName(42)).not.toBeNull();
  });
});

describe("validateSecretValue", () => {
  it("requires a non-empty value under 64KB", () => {
    expect(validateSecretValue("s3cret")).toBeNull();
    expect(validateSecretValue("")).not.toBeNull();
    expect(validateSecretValue("x".repeat(65537))).not.toBeNull();
  });
});

describe("secrets crypto", () => {
  it("round-trips through AES-GCM", async () => {
    const db = new MemDb();
    const key = await resolveSecretsKey(db, KEY_B64);
    const enc = await encryptSecretValue(key, "top secret value");
    expect(enc.iv).not.toBe("");
    expect(enc.data).not.toContain("top secret");
    expect(await decryptSecretValue(key, enc.iv, enc.data)).toBe("top secret value");
  });

  it("generates and persists a D1 key when env is absent", async () => {
    const db = new MemDb();
    const key = await resolveSecretsKey(db, undefined);
    const stored = db.settings.get(SETTING_KEYS.secretsKey);
    expect(stored).toBeTruthy();
    const again = await resolveSecretsKey(db, undefined);
    const enc = await encryptSecretValue(key, "stable");
    expect(await decryptSecretValue(again, enc.iv, enc.data)).toBe("stable");
  });

  it("ignores a malformed env key and falls back to D1", async () => {
    const db = new MemDb();
    const key = await resolveSecretsKey(db, "not-base64!!!");
    const enc = await encryptSecretValue(key, "fallback");
    expect(await decryptSecretValue(key, enc.iv, enc.data)).toBe("fallback");
  });
});

describe("getDecryptedRepoSecrets", () => {
  it("returns empty for repos without secrets", async () => {
    expect(await getDecryptedRepoSecrets(new MemDb(), KEY_B64, "o/r")).toEqual({});
  });

  it("round-trips stored rows", async () => {
    const db = new MemDb();
    const key = await resolveSecretsKey(db, KEY_B64);
    for (const [name, value] of [["A", "1"], ["B", "2"]]) {
      const enc = await encryptSecretValue(key, value);
      await setRepoSecret(db, "o/r", name, enc.iv, enc.data);
    }
    expect(await getDecryptedRepoSecrets(db, KEY_B64, "o/r")).toEqual({ A: "1", B: "2" });
    expect(await getDecryptedRepoSecrets(db, KEY_B64, "other/r")).toEqual({});
  });
});
