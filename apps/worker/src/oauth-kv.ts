import type { Db } from "./db";

// D1-backed key-value store with the KV surface the MCP OAuth provider
// uses (get/put/delete/list). A D1 table instead of a KV namespace so
// one-click deploys need no extra provisioning: OAuth works on a fresh
// fork with zero wrangler config. Expiry is lazy (reads filter expired
// rows) plus the provider's scheduled purge.
//
// This is deliberately NOT a full KVNamespace: bulk get, streams, and
// metadata are absent because the provider never calls them (verified
// against workers-oauth-provider 1.2.1). The provider's Env generic is
// instantiated with this class directly, so no cast is needed.

export interface D1KVGetOptions {
  type?: "text" | "json";
}

export interface D1KVPutOptions {
  expirationTtl?: number;
  expiration?: number;
}

export interface D1KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface D1KVListResult {
  keys: { name: string; expiration?: number }[];
  list_complete: boolean;
  cursor?: string;
}

interface OAuthKVRow {
  value: string;
  expires_at: number | null;
}

interface OAuthKVKeyRow {
  key: string;
  expires_at: number | null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid cursor");
  }
  if (!/^o\d+$/.test(raw)) throw new Error("invalid cursor");
  return Number(raw.slice(1));
}

function escapeLike(prefix: string): string {
  return prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class D1KV {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async get(key: string, type: "json"): Promise<unknown>;
  async get(key: string, options: D1KVGetOptions & { type: "json" }): Promise<unknown>;
  async get(key: string, type?: "text" | D1KVGetOptions): Promise<string | null>;
  async get(key: string, type?: "text" | "json" | D1KVGetOptions): Promise<string | unknown | null> {
    const want = typeof type === "string" ? type : (type?.type ?? "text");
    const row = await this.db.prepare("SELECT value, expires_at FROM oauth_kv WHERE key = ?").bind(key).first<OAuthKVRow>();
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= nowSec()) {
      await this.delete(key).catch(() => undefined);
      return null;
    }
    if (want === "json") {
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        // Corrupt records fail closed as missing.
        return null;
      }
    }
    return row.value;
  }

  async put(key: string, value: string, options?: D1KVPutOptions): Promise<void> {
    let expiresAt: number | null = null;
    if (options?.expirationTtl !== undefined) {
      expiresAt = nowSec() + Math.max(0, Math.floor(options.expirationTtl));
    } else if (options?.expiration !== undefined) {
      expiresAt = Math.floor(options.expiration);
    }
    await this.db
      .prepare("INSERT OR REPLACE INTO oauth_kv (key, value, expires_at) VALUES (?, ?, ?)")
      .bind(key, value, expiresAt)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM oauth_kv WHERE key = ?").bind(key).run();
  }

  async list(options?: D1KVListOptions): Promise<D1KVListResult> {
    const limit = Math.min(1000, Math.max(1, Math.floor(options?.limit ?? 1000)));
    const offset = options?.cursor !== undefined ? decodeCursor(options.cursor) : 0;
    const now = nowSec();
    const rows = (
      await this.db
        .prepare(
          "SELECT key, expires_at FROM oauth_kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ? OFFSET ?",
        )
        .bind(`${escapeLike(options?.prefix ?? "")}%`, now, limit, offset)
        .all<OAuthKVKeyRow>()
    ).results;
    const keys = rows.map((r) => (r.expires_at === null ? { name: r.key } : { name: r.key, expiration: r.expires_at }));
    if (rows.length < limit) return { keys, list_complete: true };
    return { keys, list_complete: false, cursor: encodeCursor(offset + rows.length) };
  }
}
