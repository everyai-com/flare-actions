// Per-repo CI secrets (${{ secrets.NAME }}): AES-GCM at rest, plaintext
// only inside authenticated job claims and executor memory.
//
// Threat model, stated plainly: the data key lives in SECRETS_KEY env
// when set (real at-rest protection — a DB leak alone exposes nothing),
// else an auto-generated D1 key (works out of the box; protects only
// against casual reads, not a full DB compromise). Production guidance
// is to set SECRETS_KEY. No API ever returns a value — names only.

import { getRepoSecretRows, getSetting, setSetting, type Db } from "./db";
import { SETTING_KEYS } from "./settings";

export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function validateSecretName(name: unknown): string | null {
  if (typeof name !== "string" || !SECRET_NAME_PATTERN.test(name)) {
    return "name must match [A-Za-z_][A-Za-z0-9_]* (1-64 chars)";
  }
  return null;
}

export function validateSecretValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "value is required";
  if (new TextEncoder().encode(value).byteLength > MAX_SECRET_VALUE_BYTES) {
    return "value exceeds 64KB";
  }
  return null;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isValidKeyMaterial(raw: Uint8Array): boolean {
  return raw.byteLength === 32;
}

// Env wins; D1 fills the gap (auto-generated once, then stable).
export async function resolveSecretsKey(db: Db, envKey: string | undefined): Promise<CryptoKey> {
  let raw: Uint8Array | null = null;
  if (envKey) {
    try {
      const decoded = b64ToBytes(envKey);
      if (isValidKeyMaterial(decoded)) raw = decoded;
    } catch {
      raw = null;
    }
  }
  if (!raw) {
    const stored = await getSetting(db, SETTING_KEYS.secretsKey);
    if (stored) {
      try {
        const decoded = b64ToBytes(stored);
        if (isValidKeyMaterial(decoded)) raw = decoded;
      } catch {
        raw = null;
      }
    }
  }
  if (!raw) {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await setSetting(db, SETTING_KEYS.secretsKey, bytesToB64(raw));
  }
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptedSecret {
  iv: string;
  data: string;
}

export async function encryptSecretValue(key: CryptoKey, plaintext: string): Promise<EncryptedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) };
}

export async function getDecryptedRepoSecrets(
  db: Db,
  envKey: string | undefined,
  repo: string,
): Promise<Record<string, string>> {
  const rows = await getRepoSecretRows(db, repo);
  if (rows.length === 0) return {};
  const key = await resolveSecretsKey(db, envKey);
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.name] = await decryptSecretValue(key, row.iv, row.ciphertext);
  }
  return out;
}

export async function decryptSecretValue(key: CryptoKey, iv: string, data: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(iv).buffer as ArrayBuffer },
    key,
    b64ToBytes(data).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(pt);
}

// Settings at rest (GitHub App private key, OAuth client secret,
// webhook secret) use the same data key as repo secrets, tagged with a
// version prefix: values written before encryption existed carry no
// prefix and read as plaintext, then get encrypted on the next write.
// A D1 dump alone exposes nothing once those paths are rewritten.
const SETTING_PREFIX = "enc1:";

export async function encryptSettingValue(key: CryptoKey, plaintext: string): Promise<string> {
  const enc = await encryptSecretValue(key, plaintext);
  return `${SETTING_PREFIX}${enc.iv}:${enc.data}`;
}

export async function decryptSettingValue(key: CryptoKey, value: string): Promise<string> {
  if (!value.startsWith(SETTING_PREFIX)) return value;
  const [iv, data] = value.slice(SETTING_PREFIX.length).split(":");
  if (!iv || !data) throw new Error("malformed encrypted setting");
  return decryptSecretValue(key, iv, data);
}
